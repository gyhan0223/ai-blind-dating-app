/**
 * 개발 전용 모듈 (#3) — release 번들에 포함되지 않는다.
 *
 * 규칙
 *   - 이 파일은 `@/lib/devTools` 의 `loadDevModules()` 가 `if (__DEV__) require(...)` 로만 불러온다. 다른 곳에서 정적 import 하지 않는다
 *     (scripts/check-release-bundle.mjs 가 소스와 export 산출물 양쪽에서 검사한다).
 *   - Metro 는 production 변환에서 `__DEV__` 를 false 리터럴로 치환하고 도달 불가능한 분기를 제거한 뒤 의존성을 수집하므로,
 *     이 모듈과 여기 있는 문자열(dev-login · complete-face-verification · 시드 비밀번호 · 개발용 버튼 문구)은 release 산출물에 남지 않는다.
 *   - 서버 쪽 방어(dev-login 의 APP_ENV 가드, complete-face-verification 의 mock 전용 기동, production 배포 allowlist)는 그대로 유지된다.
 *     이 모듈이 없어져도 production 서버는 개발 경로를 받지 않는다.
 */
import { supabase } from '@/lib/supabase';

// ---------------------------------------------------------------------------
// 시드 계정 로그인 (welcome 화면) — supabase/seed/seed.sql
// ---------------------------------------------------------------------------

export const DEV_SEED_ACCOUNTS = [
  { label: '테스트 남성 (지훈)', email: 'demo-m1@bonsim.dev' },
  { label: '테스트 여성 (서연)', email: 'demo-f1@bonsim.dev' },
] as const;

// seed.sql 의 개발용 비밀번호 — production DB 에는 시드 계정 자체가 없어야 한다.
const DEV_SEED_PASSWORD = 'bonsim-dev-password';

export async function devSeedLogin(email: string): Promise<{ ok: boolean }> {
  const { error } = await supabase.auth.signInWithPassword({ email, password: DEV_SEED_PASSWORD });
  return { ok: !error };
}

// ---------------------------------------------------------------------------
// 전화번호 기반 개발 로그인 (login 화면) — dev-login Edge Function (development/staging + ALLOW_DEV_LOGIN=1 에서만 동작)
// ---------------------------------------------------------------------------

export type DevLoginResult = { ok: true } | { ok: false; message: string };

export async function devLoginWithPhone(e164: string): Promise<DevLoginResult> {
  const { data, error: fnErr } = await supabase.functions.invoke('dev-login', { body: { phone: e164 } });
  if (fnErr || !data?.email) {
    let detail = fnErr?.message ?? '';
    try {
      // FunctionsHttpError 면 서버가 보낸 안내 메시지를 꺼내 보여준다
      const ctx = await (fnErr as { context?: Response })?.context?.json();
      if (ctx?.message || ctx?.error) detail = ctx.message ?? ctx.error;
    } catch {}
    return { ok: false, message: detail || 'dev-login 함수가 배포되어 있는지 확인해 주세요.' };
  }
  const { error: signErr } = await supabase.auth.signInWithPassword({ email: data.email, password: data.password });
  if (signErr) return { ok: false, message: signErr.message };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 본인확인 개발 통과 (identity 화면) — Mock Provider 는 어떤 6자리 코드든 통과. identityKey 분기는 서버가 실제와 동일하게 판단
// ---------------------------------------------------------------------------

export type DevIdentityPayload = { name: string; birthDate: string; carrier: string };
export type DevIdentityResult =
  | { ok: true; requestId: string; data: Record<string, unknown> | null }
  | { ok: false; stage: 'request' | 'confirm'; requestId: string | null; error: unknown };

export async function devIdentityPass(p: DevIdentityPayload): Promise<DevIdentityResult> {
  const { data: reqData, error: reqErr } = await supabase.functions.invoke('verify-identity', { body: { action: 'request', ...p } });
  if (reqErr || !reqData?.requestId) return { ok: false, stage: 'request', requestId: null, error: reqErr };
  const requestId = String(reqData.requestId);
  const { data, error } = await supabase.functions.invoke('verify-identity', {
    body: { action: 'confirm', requestId, code: '123456', ...p },
  });
  if (error) return { ok: false, stage: 'confirm', requestId, error };
  return { ok: true, requestId, data: (data as Record<string, unknown>) ?? null };
}

// ---------------------------------------------------------------------------
// 얼굴 인증 Mock 승인 (face 화면) — complete-face-verification (FACE_VERIFICATION_PROVIDER=mock 에서만 기동, production 미배포)
// ---------------------------------------------------------------------------

export async function devMockApproveFace(scenario: 'approved' | 'duplicate' = 'approved'): Promise<{ verified: boolean; status: string }> {
  const { data, error } = await supabase.functions.invoke('complete-face-verification', { body: { scenario } });
  if (error) throw new Error('개발용 얼굴 인증 통과에 실패했어요. complete-face-verification 함수와 FACE_VERIFICATION_PROVIDER=mock 설정을 확인하세요.');
  return { verified: data?.verified === true, status: typeof data?.status === 'string' ? data.status : 'unknown' };
}

export const DEV_BUTTON_LABELS = {
  seedLoginPrefix: '',
  phoneLogin: '테스트로 시작하기 (개발용 · SMS 없이 통과)',
  identityPass: '테스트로 통과하기 (개발용)',
  faceMock: '개발 모드: 얼굴 인증 통과 (Mock)',
} as const;
