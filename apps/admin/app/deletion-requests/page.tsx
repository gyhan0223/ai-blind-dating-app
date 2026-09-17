import { revalidatePath } from 'next/cache';
import React from 'react';
import { requireAdmin } from '@/lib/adminAuth';
import { maskContact } from '@/lib/adminAuthCore';
import { recordAdminAudit } from '@/lib/audit';
import {
  callAccountPurge,
  type DeletionRequestRow,
  describePurgeFailure,
  findUserByContact,
  loadFailedPurgeJobs,
  PURGE_STAGE_LABEL,
  skipPurgeStage,
} from '@/lib/accountDeletion';
import { adminClient } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

/**
 * 앱 밖 삭제 요청 처리 (#14/#13).
 *  * "완전 삭제": 연락처로 사용자를 찾아 status=deleted 로 바꾼 뒤 account-purge(hard) — 얼굴 자산·PII 삭제 후 auth 계정까지 삭제.
 *  * 사용자를 못 찾거나 여러 명이면 처리하지 않고 운영자가 메모를 남긴다 (연락처가 가입 정보와 다를 수 있다).
 */
async function handleRequest(formData: FormData) {
  'use server';
  const { requireOwner: guard } = await import('@/lib/adminAuth');
  const session = await guard();
  const id = String(formData.get('id'));
  const action = String(formData.get('action'));
  const db = adminClient();
  const { data: req } = await db.from('account_deletion_requests').select('*').eq('id', id).maybeSingle();
  if (!req || req.status !== 'pending') return;

  if (action === 'reject') {
    await db.from('account_deletion_requests').update({ status: 'rejected', handled_at: new Date().toISOString(), admin_note: '본인 확인 불가 또는 계정 없음' }).eq('id', id);
    await recordAdminAudit(session, 'deletion_request_handle', 'deletion_request', id, { action: 'reject' });
    revalidatePath('/deletion-requests');
    return;
  }
  if (action !== 'purge') return;

  const userId = await findUserByContact(db, req.contact as string);
  if (!userId) {
    await db.from('account_deletion_requests').update({ admin_note: '연락처와 일치하는 계정을 찾지 못함 (또는 여러 개)' }).eq('id', id);
    await recordAdminAudit(session, 'deletion_request_handle', 'deletion_request', id, { action: 'purge', result: 'user_not_found' });
    revalidatePath('/deletion-requests');
    return;
  }
  const { data: user } = await db.from('users').select('status').eq('id', userId).maybeSingle();
  if (user && user.status === 'active') {
    await db.from('users').update({ status: 'deleted' }).eq('id', userId);
  }
  const result = await callAccountPurge(userId, true, session.actor);
  // 외부 삭제(Storage·Didit)나 auth 삭제가 실패하면 "완료" 로 기록하지 않는다 — 실패 단계를 메모에 남기고 요청은 pending 으로 둔다 (아래 "미완료 삭제 작업" 에서 재시도)
  await db
    .from('account_deletion_requests')
    .update(
      result.ok
        ? { status: 'done', handled_at: new Date().toISOString(), user_id: null, admin_note: '완전 삭제 완료 (저장소·Didit·DB·계정)' }
        : { user_id: userId, admin_note: `삭제 미완료 (${result.status}): ${result.failedStages.join(', ') || result.error} — 재시도 필요` },
    )
    .eq('id', id);
  await recordAdminAudit(session, 'deletion_request_handle', 'deletion_request', id, {
    action: 'purge',
    ok: result.ok,
    hard: true,
    status: result.status,
    error: result.ok ? undefined : result.error,
    failed_stages: result.ok ? undefined : result.failedStages,
  });
  revalidatePath('/deletion-requests');
  revalidatePath('/users');
}

/** 미완료 삭제 작업 재시도 (완료한 단계는 건너뛴다) / 운영자 확인 후 단계 건너뛰기 (감사 기록) */
async function retryJob(formData: FormData) {
  'use server';
  const { requireOwner: guard } = await import('@/lib/adminAuth');
  const session = await guard();
  const userId = String(formData.get('userId') ?? '');
  const mode = String(formData.get('mode') ?? 'anonymize');
  const action = String(formData.get('action') ?? 'retry');
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return;
  const db = adminClient();
  if (action === 'skip') {
    const stage = String(formData.get('stage') ?? '');
    const note = String(formData.get('note') ?? '').trim().slice(0, 200);
    if (stage !== 'storage' && stage !== 'provider' && stage !== 'auth') return;
    if (!note) return; // 건너뛰기에는 사유가 필요하다
    const res = await skipPurgeStage(db, userId, stage, session.actor, note);
    await recordAdminAudit(session, 'purge_stage_skip', 'user', userId, { stage, ok: res.ok, result: res.ok ? res.status : res.reason });
  } else {
    const res = await callAccountPurge(userId, mode === 'hard', session.actor);
    await recordAdminAudit(session, 'purge_retry', 'user', userId, { ok: res.ok, status: res.status, error: res.ok ? undefined : res.error, failed_stages: res.ok ? undefined : res.failedStages });
    // 이 사용자의 완전 삭제 요청이 pending 이고 작업이 끝났으면 요청도 완료로
    if (res.ok && mode === 'hard') {
      await db
        .from('account_deletion_requests')
        .update({ status: 'done', handled_at: new Date().toISOString(), user_id: null, admin_note: '완전 삭제 완료 (재시도)' })
        .eq('user_id', userId)
        .eq('status', 'pending');
    }
  }
  revalidatePath('/deletion-requests');
  revalidatePath('/users');
}

export default async function DeletionRequestsPage() {
  const session = await requireAdmin();
  const canAct = session.role === 'owner';
  const db = adminClient();
  const failedJobs = await loadFailedPurgeJobs(db);
  const { data } = await db
    .from('account_deletion_requests')
    .select('id, contact, note, status, admin_note, user_id, created_at, handled_at')
    .order('created_at', { ascending: false })
    .limit(200);
  const rows = (data ?? []) as DeletionRequestRow[];

  return (
    <div>
      <h1>계정 삭제 요청</h1>
      <p className="muted">
        앱 밖(/delete-account)에서 들어온 요청입니다. 본인 확인(가입 연락처 일치) 뒤 "완전 삭제" 를 누르면 얼굴 자산·개인정보를 지우고 로그인 계정까지 삭제합니다.
        되돌릴 수 없습니다. 앱 안에서 탈퇴한 계정은 30일 뒤 자동으로 익명화됩니다 (account-purge batch).
      </p>
      {rows.length === 0 && <p className="muted">요청이 없습니다.</p>}
      <table>
        <thead>
          <tr><th>일시</th><th>연락처</th><th>메모</th><th>상태</th><th>처리 메모</th><th></th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.created_at).toLocaleString('ko-KR')}</td>
              <td>{canAct ? r.contact : maskContact(r.contact)}</td>
              <td style={{ maxWidth: 240 }}>{r.note ?? '—'}</td>
              <td><span className={`badge ${r.status === 'pending' ? 'danger' : r.status === 'done' ? '' : 'muted'}`}>{r.status}</span></td>
              <td style={{ maxWidth: 240 }}>{r.admin_note ?? '—'}</td>
              <td>
                {r.status === 'pending' && canAct && (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <form action={handleRequest}>
                      <input type="hidden" name="id" value={r.id} />
                      <input type="hidden" name="action" value="purge" />
                      <button className="danger" type="submit">완전 삭제</button>
                    </form>
                    <form action={handleRequest}>
                      <input type="hidden" name="id" value={r.id} />
                      <input type="hidden" name="action" value="reject" />
                      <button type="submit">처리 불가</button>
                    </form>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ marginTop: 32 }}>미완료 삭제 작업 ({failedJobs.length})</h2>
      <p className="muted">
        저장소 이미지 · Didit 세션 · DB 익명화 · 로그인 계정 중 하나라도 실패하면 삭제는 완료가 아닙니다. 재시도는 완료한 단계를 건너뛰고 실패한 단계부터 이어갑니다
        (매일 배치도 자동 재시도). Didit 404 처럼 "이미 삭제됨" 이 확인된 경우에만 사유를 적고 건너뛰기를 누르세요 — 감사 기록에 남습니다. DB 익명화 단계는 건너뛸 수 없습니다.
      </p>
      {failedJobs.length === 0 && <p className="muted">미완료 작업이 없습니다.</p>}
      {failedJobs.length > 0 && (
        <table>
          <thead>
            <tr><th>사용자</th><th>모드</th><th>시도</th><th>단계</th><th>실패 사유</th><th></th></tr>
          </thead>
          <tbody>
            {failedJobs.map((j) => {
              const failedStage = (['storage', 'provider', 'auth'] as const).find((st) => j[`stage_${st}`] === 'failed');
              return (
                <tr key={j.user_id}>
                  <td><code>{j.user_id.slice(0, 8)}…</code></td>
                  <td>{j.mode === 'hard' ? '완전 삭제' : '익명화'}</td>
                  <td>{j.attempt_count}</td>
                  <td style={{ fontSize: 12 }}>
                    {(['storage', 'provider', 'db', 'auth'] as const).map((st) => (
                      <div key={st}>{PURGE_STAGE_LABEL[st]}: {j[`stage_${st}`]}</div>
                    ))}
                  </td>
                  <td style={{ maxWidth: 320, fontSize: 12 }}>{j.running ? '진행 중' : describePurgeFailure(j).join(' / ') || '—'}</td>
                  <td>
                    {!j.running && canAct && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <form action={retryJob}>
                          <input type="hidden" name="userId" value={j.user_id} />
                          <input type="hidden" name="mode" value={j.mode} />
                          <input type="hidden" name="action" value="retry" />
                          <button className="danger" type="submit">재시도</button>
                        </form>
                        {failedStage && (
                          <form action={retryJob} style={{ display: 'flex', gap: 4 }}>
                            <input type="hidden" name="userId" value={j.user_id} />
                            <input type="hidden" name="mode" value={j.mode} />
                            <input type="hidden" name="action" value="skip" />
                            <input type="hidden" name="stage" value={failedStage} />
                            <input name="note" placeholder="건너뛰기 사유 (필수)" maxLength={200} style={{ width: 160 }} required />
                            <button type="submit">{PURGE_STAGE_LABEL[failedStage]} 건너뛰기</button>
                          </form>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
