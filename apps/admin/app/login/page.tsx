import { redirect } from 'next/navigation';
import React from 'react';
import { loginWithPassword } from '@/lib/adminAuth';

async function login(formData: FormData) {
  'use server';
  const ok = await loginWithPassword(String(formData.get('password') ?? ''));
  redirect(ok ? '/' : '/login?error=1');
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  return (
    <form className="login-box" action={login}>
      <div>
        <h1 style={{ marginBottom: 4 }}>본심 Admin</h1>
        <p className="muted">운영자 비밀번호를 입력하세요.</p>
      </div>
      <input type="password" name="password" placeholder="비밀번호" autoFocus />
      {params.error && <p className="error">비밀번호가 올바르지 않습니다.</p>}
      <button className="primary" type="submit">로그인</button>
    </form>
  );
}
