import { revalidatePath } from 'next/cache';
import React from 'react';
import { callAccountPurge, describePurgeFailure, loadPurgeJobSummaries } from '@/lib/accountDeletion';
import { requireAdmin } from '@/lib/adminAuth';
import { recordAdminAudit } from '@/lib/audit';
import { moderateUser } from '@/lib/moderation';
import { adminClient } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

async function setUserStatus(formData: FormData) {
  'use server';
  const { requireAdmin: guard } = await import('@/lib/adminAuth');
  const session = await guard();
  const userId = String(formData.get('userId'));
  const status = String(formData.get('status'));
  if (!['active', 'suspended'].includes(status)) return;
  const db = adminClient();
  // 상태 변경은 RPC 로만 (moderation_actions 감사 기록 — #15). 처리자 = 로그인한 운영자 이름 (#27)
  const res = await moderateUser(db, { userId, action: status === 'suspended' ? 'suspend' : 'unsuspend', reason: '사용자 목록에서 수동 조치', reportId: null, actor: session.actor, days: null });
  await recordAdminAudit(session.actor, 'user_status_set', 'user', userId, { status, ok: res.ok });
  revalidatePath('/users');
}

/**
 * 탈퇴(deleted) 계정을 유예를 기다리지 않고 지금 익명화한다 (완전 삭제는 /deletion-requests 에서 본인 확인 뒤).
 * 실패한 작업의 "재시도" 도 같은 경로다 — account-purge 가 완료한 단계는 건너뛰고 실패한 단계부터 이어간다 (#13).
 */
async function purgeNow(formData: FormData) {
  'use server';
  const { requireAdmin: guard } = await import('@/lib/adminAuth');
  const session = await guard();
  const userId = String(formData.get('userId'));
  const res = await callAccountPurge(userId, false, session.actor);
  await recordAdminAudit(session.actor, 'user_purge_now', 'user', userId, {
    ok: res.ok,
    status: res.status,
    error: res.ok ? undefined : res.error,
    failed_stages: res.ok ? undefined : res.failedStages,
  });
  revalidatePath('/users');
}

export default async function UsersPage() {
  await requireAdmin();
  const db = adminClient();
  const { data: users } = await db
    .from('users')
    .select('id, email, status, onboarding_completed, identity_verified, face_verified, last_active_at, created_at, is_demo, deleted_at, purged_at')
    .order('created_at', { ascending: false })
    .limit(200);
  const { data: profiles } = await db
    .from('profiles')
    .select('user_id, nickname')
    .in('user_id', (users ?? []).map((u) => u.id));
  const nickname = new Map((profiles ?? []).map((p) => [p.user_id, p.nickname]));
  const jobs = await loadPurgeJobSummaries(db, (users ?? []).filter((u) => u.status === 'deleted' || u.status === 'banned').map((u) => u.id));

  return (
    <div>
      <h1>사용자</h1>
      <table>
        <thead>
          <tr>
            <th>닉네임</th><th>이메일</th><th>상태</th><th>온보딩</th><th>인증</th><th>가입일</th><th></th>
          </tr>
        </thead>
        <tbody>
          {(users ?? []).map((u) => (
            <tr key={u.id}>
              <td>
                {nickname.get(u.id) ?? '—'}
                {u.is_demo && <span className="badge muted" style={{ marginLeft: 6 }}>demo</span>}
              </td>
              <td>{u.email ?? '—'}</td>
              <td>
                <span className={`badge ${u.status === 'suspended' ? 'danger' : ''}`}>{u.status}</span>
                {u.purged_at && <span className="badge muted" style={{ marginLeft: 6 }}>DB 익명화됨</span>}
                {(() => {
                  const j = jobs.get(u.id);
                  if (!j) return null;
                  if (j.status === 'done') return <span className="badge" style={{ marginLeft: 6 }}>삭제 완료{j.mode === 'hard' ? ' (계정 삭제)' : ''}</span>;
                  if (j.running) return <span className="badge muted" style={{ marginLeft: 6 }}>삭제 진행 중</span>;
                  return (
                    <span className="badge danger" style={{ marginLeft: 6 }} title={describePurgeFailure(j).join(' / ')}>
                      삭제 미완료 ({j.attempt_count}회) — {describePurgeFailure(j).join(' / ') || '재시도 필요'}
                    </span>
                  );
                })()}
              </td>
              <td>{u.onboarding_completed ? '완료' : '진행 중'}</td>
              <td>
                {u.identity_verified ? '본인 ' : ''}
                {u.face_verified ? '얼굴' : ''}
              </td>
              <td>{new Date(u.created_at).toLocaleDateString('ko-KR')}</td>
              <td>
                <div style={{ display: 'flex', gap: 6 }}>
                  {u.status !== 'deleted' && (
                    <form action={setUserStatus}>
                      <input type="hidden" name="userId" value={u.id} />
                      <input type="hidden" name="status" value={u.status === 'suspended' ? 'active' : 'suspended'} />
                      <button className={u.status === 'suspended' ? '' : 'danger'} type="submit">
                        {u.status === 'suspended' ? '정지 해제' : '정지'}
                      </button>
                    </form>
                  )}
                  {(u.status === 'deleted' || u.status === 'banned') && (() => {
                    const j = jobs.get(u.id);
                    if (j?.status === 'done' || j?.running) return null;
                    if (!j && u.purged_at) return null;
                    return (
                      <form action={purgeNow}>
                        <input type="hidden" name="userId" value={u.id} />
                        <button className="danger" type="submit">{j ? '삭제 재시도' : '지금 익명화'}</button>
                      </form>
                    );
                  })()}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
