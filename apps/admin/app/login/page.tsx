import { redirect } from 'next/navigation';
import React from 'react';
import { currentSession, legacyLoginOpen, loginWithEmailPassword, loginWithLegacyPassword } from '@/lib/adminAuth';

export const dynamic = 'force-dynamic';

async function login(formData: FormData) {
  'use server';
  const res = await loginWithEmailPassword(String(formData.get('email') ?? ''), String(formData.get('password') ?? ''));
  if (res.ok) redirect('/login/mfa');
  if (res.reason === 'locked') redirect(`/login?error=locked&sec=${res.lockedSeconds ?? 0}`);
  redirect(`/login?error=${res.reason}`);
}

async function legacyLogin(formData: FormData) {
  'use server';
  const res = await loginWithLegacyPassword(String(formData.get('password') ?? ''), String(formData.get('actor') ?? ''));
  if (res.ok) redirect('/');
  if (res.reason === 'locked') redirect(`/login?error=locked&sec=${res.lockedSeconds ?? 0}`);
  redirect(`/login?error=${res.reason === 'bad_password' ? 'bad_credentials' : res.reason}`);
}

const ERROR_TEXT: Record<string, string> = {
  bad_credentials: '이메일 또는 비밀번호가 올바르지 않습니다.',
  disabled: '비활성화된 관리자 계정입니다. owner 에게 문의하세요.',
  unavailable: '로그인 제한 또는 인증 서버를 확인할 수 없어 로그인하지 않았습니다 (DB/Auth 연결). 잠시 후 다시 시도하세요.',
  closed: '구 공유 비밀번호 로그인은 더 이상 사용할 수 없습니다. 개인 계정으로 로그인하세요.',
  expired: 'MFA 입력 시간이 지났습니다. 다시 로그인하세요.',
  password_changed: '비밀번호를 바꿨습니다. 새 비밀번호로 다시 로그인하세요.',
};

/**
 * 관리자 로그인 (#27) — 개인 계정(이메일+비밀번호) → MFA(TOTP) → 서버 세션.
 * 실패 5회 → 15분 잠금 (IP 키 + 계정 키, DB 공유). 제한 판정 불가 시 로그인 거부.
 * 구 공유 비밀번호 로그인은 전환 기간(ADMIN_LEGACY_PASSWORD_LOGIN=1 이고 MFA 로 로그인한 관리자가 아직 없음)에만 아래에 나타난다.
 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; sec?: string }> }) {
  if (await currentSession()) redirect('/');
  const params = await searchParams;
  const legacy = await legacyLoginOpen();
  return (
    <div>
      <form className="login-box" action={login}>
        <div>
          <h1 style={{ marginBottom: 4 }}>본심 Admin</h1>
          <p className="muted">관리자 개인 계정으로 로그인하세요. 비밀번호 뒤에 인증 앱(TOTP) 코드가 필요합니다.</p>
        </div>
        <input type="email" name="email" placeholder="이메일" autoComplete="username" required autoFocus />
        <input type="password" name="password" placeholder="비밀번호" autoComplete="current-password" required />
        {params.error === 'locked' && (
          <p className="error">로그인 실패가 많아 잠시 잠겼습니다. 약 {Math.max(1, Math.ceil(Number(params.sec ?? 0) / 60))}분 뒤 다시 시도하세요.</p>
        )}
        {params.error && params.error !== 'locked' && <p className="error">{ERROR_TEXT[params.error] ?? '로그인에 실패했습니다.'}</p>}
        <button className="primary" type="submit">다음 (인증 앱 코드)</button>
      </form>

      {legacy && (
        <form className="login-box" action={legacyLogin} style={{ marginTop: 24 }}>
          <div>
            <h2 style={{ margin: 0 }}>구 공유 비밀번호 로그인 (전환 기간)</h2>
            <p className="muted">첫 관리자가 개인 계정 + MFA 로 로그인하는 순간 이 경로는 자동으로 닫힙니다. 이름은 감사 기록에 "legacy:이름" 으로 남습니다.</p>
          </div>
          <input type="text" name="actor" placeholder="처리자 이름" maxLength={40} autoComplete="off" />
          <input type="password" name="password" placeholder="공유 비밀번호" autoComplete="off" />
          <button type="submit">구 방식으로 로그인</button>
        </form>
      )}
    </div>
  );
}
