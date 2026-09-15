import { revalidatePath } from 'next/cache';
import React from 'react';
import { requireAdmin } from '@/lib/adminAuth';
import { callAccountPurge, type DeletionRequestRow, findUserByContact } from '@/lib/accountDeletion';
import { adminClient } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

/**
 * 앱 밖 삭제 요청 처리 (#14/#13).
 *  * "완전 삭제": 연락처로 사용자를 찾아 status=deleted 로 바꾼 뒤 account-purge(hard) — 얼굴 자산·PII 삭제 후 auth 계정까지 삭제.
 *  * 사용자를 못 찾거나 여러 명이면 처리하지 않고 운영자가 메모를 남긴다 (연락처가 가입 정보와 다를 수 있다).
 */
async function handleRequest(formData: FormData) {
  'use server';
  const { requireAdmin: guard } = await import('@/lib/adminAuth');
  await guard();
  const id = String(formData.get('id'));
  const action = String(formData.get('action'));
  const db = adminClient();
  const { data: req } = await db.from('account_deletion_requests').select('*').eq('id', id).maybeSingle();
  if (!req || req.status !== 'pending') return;

  if (action === 'reject') {
    await db.from('account_deletion_requests').update({ status: 'rejected', handled_at: new Date().toISOString(), admin_note: '본인 확인 불가 또는 계정 없음' }).eq('id', id);
    revalidatePath('/deletion-requests');
    return;
  }
  if (action !== 'purge') return;

  const userId = await findUserByContact(db, req.contact as string);
  if (!userId) {
    await db.from('account_deletion_requests').update({ admin_note: '연락처와 일치하는 계정을 찾지 못함 (또는 여러 개)' }).eq('id', id);
    revalidatePath('/deletion-requests');
    return;
  }
  const { data: user } = await db.from('users').select('status').eq('id', userId).maybeSingle();
  if (user && user.status === 'active') {
    await db.from('users').update({ status: 'deleted' }).eq('id', userId);
  }
  const result = await callAccountPurge(userId, true);
  await db
    .from('account_deletion_requests')
    .update(
      result.ok
        ? { status: 'done', handled_at: new Date().toISOString(), user_id: null, admin_note: '완전 삭제 완료' }
        : { admin_note: `삭제 실패: ${result.error}` },
    )
    .eq('id', id);
  revalidatePath('/deletion-requests');
  revalidatePath('/users');
}

export default async function DeletionRequestsPage() {
  await requireAdmin();
  const db = adminClient();
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
              <td>{r.contact}</td>
              <td style={{ maxWidth: 240 }}>{r.note ?? '—'}</td>
              <td><span className={`badge ${r.status === 'pending' ? 'danger' : r.status === 'done' ? '' : 'muted'}`}>{r.status}</span></td>
              <td style={{ maxWidth: 240 }}>{r.admin_note ?? '—'}</td>
              <td>
                {r.status === 'pending' && (
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
    </div>
  );
}
