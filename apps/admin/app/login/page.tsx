import { redirect } from 'next/navigation';
import React from 'react';
import { loginWithPassword } from '@/lib/adminAuth';

async function login(formData: FormData) {
  'use server';
  const res = await loginWithPassword(String(formData.get('password') ?? ''), String(formData.get('actor') ?? ''));
  if (res.ok) redirect('/');
  redirect(res.reason === 'locked' ? `/login?error=locked&sec=${res.lockedSeconds ?? 0}` : '/login?error=1');
}

/** 관리자 로그인 (#27) — 비밀번호 + 처리자 이름(감사 기록용). 실패 5회 → 15분 잠금 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sec?: string }>;
}) {
  const params = await searchParams;
  return (
    <form className="login-box" action={login}>
      <div>
        <h1 style={{ marginBottom: 4 }}>본심 Admin</h1>
        <p className="muted">운영자 비밀번호와 이름을 입력하세요. 이름은 모든 조치의 감사 기록에 남습니다.</p>
      </div>
      <input type="text" name="actor" placeholder="처리자 이름 (예: 홍길동)" maxLength={40} autoComplete="username" />
      <input type="password" name="password" placeholder="비밀번호" autoFocus autoComplete="current-password" />
      {params.error === 'locked' && (
        <p className="error">로그인 실패가 많아 잠시 잠겼습니다. 약 {Math.max(1, Math.ceil(Number(params.sec ?? 0) / 60))}분 뒤 다시 시도하세요.</p>
      )}
      {params.error === '1' && <p className="error">비밀번호가 올바르지 않습니다.</p>}
      <button className="primary" type="submit">로그인</button>
    </form>
  );
}
