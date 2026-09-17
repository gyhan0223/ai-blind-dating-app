import { redirect } from 'next/navigation';
import React from 'react';
import { pendingState, startMfaEnrollment, verifyMfaCode } from '@/lib/adminAuth';

export const dynamic = 'force-dynamic';

async function verify(formData: FormData) {
  'use server';
  const res = await verifyMfaCode(String(formData.get('code') ?? ''));
  if (res.ok) redirect('/');
  if (res.reason === 'no_pending') redirect('/login?error=expired');
  if (res.reason === 'locked') redirect(`/login/mfa?error=locked&sec=${res.lockedSeconds ?? 0}`);
  redirect(`/login/mfa?error=${res.reason}`);
}

const ERROR_TEXT: Record<string, string> = {
  bad_code: '코드가 올바르지 않습니다. 인증 앱의 현재 코드를 입력하세요 (30초마다 바뀝니다).',
  unavailable: '인증 서버 또는 DB 를 확인할 수 없어 진행하지 않았습니다. 잠시 후 다시 시도하세요.',
  not_aal2: '인증 수준이 확인되지 않았습니다. 다시 로그인하세요.',
  not_active: '관리자 계정이 활성 상태가 아닙니다.',
  enroll_failed: 'MFA 등록을 시작할 수 없습니다. 다시 로그인하세요.',
};

/**
 * MFA 단계 (#27) — 비밀번호를 통과한 pending 상태에서만 열린다. 관리자 데이터·조치는 이 단계에서 접근할 수 없다.
 *  * 등록된 factor 가 없으면 TOTP 등록 (QR·secret 은 이 HTML 에만 실린다 — URL·로그·감사 기록 없음)
 *  * 있으면 코드 검증 → 서버가 GoTrue 의 aal2 를 확인한 뒤 세션 발급
 */
export default async function MfaPage({ searchParams }: { searchParams: Promise<{ error?: string; sec?: string }> }) {
  const params = await searchParams;
  const pending = await pendingState();
  if (!pending) redirect('/login?error=expired');

  let enroll: { qrCodeSvg: string; secret: string; uri: string } | null = null;
  if (!pending.hasFactor) {
    const e = await startMfaEnrollment();
    if (!e.ok) redirect(e.reason === 'no_pending' ? '/login?error=expired' : '/login?error=unavailable');
    enroll = { qrCodeSvg: e.qrCodeSvg, secret: e.secret, uri: e.uri };
  }

  return (
    <form className="login-box" action={verify} style={{ maxWidth: 480 }}>
      <div>
        <h1 style={{ marginBottom: 4 }}>{enroll ? '인증 앱 등록' : '인증 앱 코드'}</h1>
        {enroll ? (
          <p className="muted">
            {pending.purpose === 'reenroll' ? '재인증이 끝났습니다. ' : '이 계정은 아직 2단계 인증이 없습니다. '}
            인증 앱(Google Authenticator · 1Password · Authy 등)으로 아래 QR 을 스캔한 뒤 표시되는 6자리 코드를 입력하세요.
            등록이 끝나야 관리자 화면에 들어갈 수 있습니다.
          </p>
        ) : (
          <p className="muted">인증 앱에 표시된 6자리 코드를 입력하세요.</p>
        )}
      </div>
      {enroll && (
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {/* GoTrue 가 주는 QR 은 SVG data URI — 이미지로만 렌더링, 스크립트 없음 */}
          <img src={enroll.qrCodeSvg} alt="TOTP QR" width={180} height={180} style={{ background: '#fff', border: '1px solid var(--line)', borderRadius: 8 }} />
          <div className="muted" style={{ fontSize: 12, wordBreak: 'break-all', maxWidth: 240 }}>
            QR 을 못 읽으면 수동 입력 키:
            <div><code>{enroll.secret}</code></div>
            <div style={{ marginTop: 6 }}>이 키는 지금 화면에만 표시되며 서버 로그·감사 기록에 남지 않습니다. 화면을 새로고침하면 새 키가 발급됩니다.</div>
          </div>
        </div>
      )}
      <input type="text" name="code" inputMode="numeric" pattern="[0-9 ]{6,7}" placeholder="6자리 코드" autoComplete="one-time-code" autoFocus required />
      {params.error === 'locked' && (
        <p className="error">코드 실패가 많아 잠시 잠겼습니다. 약 {Math.max(1, Math.ceil(Number(params.sec ?? 0) / 60))}분 뒤 다시 시도하세요.</p>
      )}
      {params.error && params.error !== 'locked' && <p className="error">{ERROR_TEXT[params.error] ?? '확인에 실패했습니다.'}</p>}
      <button className="primary" type="submit">{enroll ? '등록하고 로그인' : '확인'}</button>
      <p className="muted" style={{ fontSize: 12 }}>
        인증 앱을 잃어버렸다면 다른 owner 에게 MFA 초기화를 요청하세요. owner 가 모두 잠겼다면 서버 전용 bootstrap 스크립트(<code>reset-mfa</code>)로 복구합니다 (docs/security.md).
      </p>
    </form>
  );
}
