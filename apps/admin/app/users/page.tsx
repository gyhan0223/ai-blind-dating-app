import { revalidatePath } from 'next/cache';
import React from 'react';
import { requireAdmin } from '@/lib/adminAuth';
import { adminClient } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

async function setUserStatus(formData: FormData) {
  'use server';
  const { requireAdmin: guard } = await import('@/lib/adminAuth');
  await guard();
  const userId = String(formData.get('userId'));
  const status = String(formData.get('status'));
  if (!['active', 'suspended'].includes(status)) return;
  const db = adminClient();
  await db.from('users').update({ status }).eq('id', userId);
  revalidatePath('/users');
}

export default async function UsersPage() {
  await requireAdmin();
  const db = adminClient();
  const { data: users } = await db
    .from('users')
    .select('id, email, status, onboarding_completed, identity_verified, face_verified, last_active_at, created_at, is_demo')
    .order('created_at', { ascending: false })
    .limit(200);
  const { data: profiles } = await db
    .from('profiles')
    .select('user_id, nickname')
    .in('user_id', (users ?? []).map((u) => u.id));
  const nickname = new Map((profiles ?? []).map((p) => [p.user_id, p.nickname]));

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
              </td>
              <td>{u.onboarding_completed ? '완료' : '진행 중'}</td>
              <td>
                {u.identity_verified ? '본인 ' : ''}
                {u.face_verified ? '얼굴' : ''}
              </td>
              <td>{new Date(u.created_at).toLocaleDateString('ko-KR')}</td>
              <td>
                <form action={setUserStatus}>
                  <input type="hidden" name="userId" value={u.id} />
                  <input type="hidden" name="status" value={u.status === 'suspended' ? 'active' : 'suspended'} />
                  <button className={u.status === 'suspended' ? '' : 'danger'} type="submit">
                    {u.status === 'suspended' ? '정지 해제' : '정지'}
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
