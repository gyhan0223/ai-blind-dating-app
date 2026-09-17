import { redirect } from 'next/navigation';
import React from 'react';
import { changeOwnPassword, requireAdmin, resetOwnMfa } from '@/lib/adminAuth';
import { ADMIN_PASSWORD_MIN_LENGTH } from '@/lib/adminAuthCore';

export const dynamic = 'force-dynamic';

/** 내 계정 (#27) — 비밀번호 변경 · MFA 재등록. 둘 다 현재 비밀번호 + 현재 인증 앱 코드로 재인증한 뒤에만 진행된다 */
async function changePassword(formData: FormData) {
  'use server';
  const newPassword = String(formData.get('new_password') ?? '');
  if (newPassword !== String(formData.get('new_password2') ?? '')) redirect('/account?error=password_mismatch');
  const res = await changeOwnPassword({ password: String(formData.get('password') ?? ''), code: String(formData.get('code') ?? ''), newPassword });
  if (res.ok) redirect('/login?error=password_changed');
  redirect(`/account?error=${encodeURIComponent(res.reason)}${res.lockedSeconds ? `&sec=${res.lockedSeconds}` : ''}`);
}

async function reenrollMfa(formData: FormData) {
  'use server';
  const res = await resetOwnMfa({ password: String(formData.get('password') ?? ''), code: String(formData.get('code') ?? '') });
  if (res.ok) redirect('/login/mfa');
  redirect(`/account?error=${encodeURIComponent(res.reason)}${res.lockedSeconds ? `&sec=${res.lockedSeconds}` : ''}`);
}

const ERROR_TEXT: Record<string, string> = {
  bad_credentials: '현재 비밀번호 또는 인증 앱 코드가 올바르지 않습니다.',
  locked: '실패가 많아 잠시 잠겼습니다. 잠시 후 다시 시도하세요.',
  unavailable: '인증 서버 또는 DB 를 확인할 수 없어 진행하지 않았습니다.',
  no_factor: '등록된 인증 앱이 없습니다. 다시 로그인해 등록하세요.',
  weak_password: `새 비밀번호는 ${ADMIN_PASSWORD_MIN_LENGTH}자 이상이어야 합니다.`,
  password_mismatch: '새 비밀번호가 서로 다릅니다.',
  rejected: 'Auth 가 새 비밀번호를 거부했습니다 (비밀번호 정책).',
};

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ error?: string; sec?: string }> }) {
  const session = await requireAdmin();
  const params = await searchParams;
  if (session.legacy) {
    return (
      <div>
        <h1>내 계정</h1>
        <p className="muted">구 공유 비밀번호 세션에는 개인 계정이 없습니다. 개인 계정으로 로그인하면 비밀번호·MFA 를 관리할 수 있습니다.</p>
      </div>
    );
  }
  return (
    <div>
      <h1>내 계정</h1>
      <p className="muted">{session.displayName} · 역할 {session.role} · id <code>{session.userId?.slice(0, 8)}</code></p>
      {params.error && <p className="error">{ERROR_TEXT[params.error] ?? `처리 실패: ${params.error}`}</p>}

      <h2>비밀번호 변경</h2>
      <p className="muted">변경하면 이 계정의 모든 세션이 종료되고 다시 로그인해야 합니다.</p>
      <form action={changePassword} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="password" name="password" placeholder="현재 비밀번호" required autoComplete="current-password" style={{ width: 160 }} />
        <input type="text" name="code" placeholder="인증 앱 코드" inputMode="numeric" required autoComplete="one-time-code" style={{ width: 120 }} />
        <input type="password" name="new_password" placeholder="새 비밀번호" required minLength={ADMIN_PASSWORD_MIN_LENGTH} autoComplete="new-password" style={{ width: 160 }} />
        <input type="password" name="new_password2" placeholder="새 비밀번호 확인" required minLength={ADMIN_PASSWORD_MIN_LENGTH} autoComplete="new-password" style={{ width: 160 }} />
        <button type="submit" className="primary">변경</button>
      </form>

      <h2>인증 앱 재등록</h2>
      <p className="muted">기기를 바꿀 때. 현재 비밀번호와 현재 인증 앱 코드로 재인증하면 기존 등록이 삭제되고 새 QR 이 표시됩니다. 다른 세션은 종료됩니다.</p>
      <form action={reenrollMfa} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="password" name="password" placeholder="현재 비밀번호" required autoComplete="current-password" style={{ width: 160 }} />
        <input type="text" name="code" placeholder="현재 인증 앱 코드" inputMode="numeric" required autoComplete="one-time-code" style={{ width: 140 }} />
        <button type="submit" className="danger">기존 등록 삭제 후 재등록</button>
      </form>
    </div>
  );
}
