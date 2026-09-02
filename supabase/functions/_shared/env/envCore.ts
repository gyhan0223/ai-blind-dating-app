/**
 * 서버 환경 판별 핵심 로직 — 순수 모듈 (Deno Edge Function / Node selftest 겸용).
 *
 * 보안 원칙 (Issue #3)
 *   - production 여부는 서버 전용 환경변수(APP_ENV)로만 판단한다.
 *     클라이언트 입력·EXPO_PUBLIC_* 값은 절대 보안 판단에 사용하지 않는다.
 *   - fail-closed: APP_ENV 가 없거나 알 수 없는 값이면 무조건 production 으로 간주한다.
 *     설정 실수/누락 상태에서 개발용 우회 기능이 켜지는 일이 없어야 한다.
 *   - 개발 기능은 explicit opt-in: "명시적 development/staging + 명시적 허용 플래그"
 *     조합에서만 켜진다. production 은 어떤 플래그 조합으로도 켜지지 않는다.
 */

export type AppEnv = 'development' | 'staging' | 'production';

/** APP_ENV 원본 값 → AppEnv. 누락/오타/알 수 없는 값은 항상 production (fail-closed). */
export function resolveAppEnv(raw: string | null | undefined): AppEnv {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'development' || v === 'staging') return v;
  return 'production';
}

export type DevLoginEnv = {
  appEnv: AppEnv;
  /** ALLOW_DEV_LOGIN — dev-login 활성화 opt-in 플래그 ('1' 만 유효) */
  allowDevLogin: string | null | undefined;
  /** DISABLE_DEV_LOGIN — 긴급 kill switch (환경과 무관하게 '1' 이면 차단) */
  disableDevLogin: string | null | undefined;
};

/**
 * dev-login 허용 여부 (allowlist 방식).
 *   development/staging  AND  ALLOW_DEV_LOGIN=1  → 허용
 *   production           → ALLOW_DEV_LOGIN 값과 무관하게 무조건 차단
 *   APP_ENV 누락/invalid → production 취급 → 차단
 */
export function isDevLoginAllowed(env: DevLoginEnv): boolean {
  if (env.appEnv === 'production') return false;
  if (env.disableDevLogin === '1') return false;
  return env.allowDevLogin === '1';
}

// ---------------------------------------------------------------------------
// Provider 선택 (본인확인 IDENTITY_PROVIDER / 얼굴 FACE_VERIFICATION_PROVIDER)
// ---------------------------------------------------------------------------

export type ProviderKindResult =
  | { ok: true; kind: string }
  | { ok: false; reason: 'missing' | 'mock_not_allowed' };

/**
 * provider 환경변수 해석 (fail-closed).
 *   development / staging → 미설정이면 'mock' 기본값 (개발 편의)
 *   production            → 반드시 실제 provider 이름을 명시해야 하며,
 *                           미설정이거나 'mock' 이면 실패 → 함수 기동 거부.
 * 반환된 kind 가 실제 구현된 provider 인지는 각 함수의 factory 가 추가 검증한다
 * (구현되지 않은 이름 → 기동 실패. production 에서 mock 으로 조용히 대체되는 일 없음).
 */
export function resolveProviderKind(
  appEnv: AppEnv,
  raw: string | null | undefined,
): ProviderKindResult {
  const kind = (raw ?? '').trim().toLowerCase();
  if (appEnv === 'production') {
    if (!kind) return { ok: false, reason: 'missing' };
    if (kind === 'mock') return { ok: false, reason: 'mock_not_allowed' };
    return { ok: true, kind };
  }
  // development / staging — 명시 안 하면 mock
  return { ok: true, kind: kind || 'mock' };
}

/** staging/production 에서 요구하는 IDENTITY_HASH_SECRET 최소 길이 (32B hex 권장 = 64자) */
export const IDENTITY_SECRET_MIN_LENGTH = 32;

/** development 에서 secret 을 직접 지정하는 경우의 최소 길이 (기존 정책 유지) */
export const IDENTITY_SECRET_MIN_LENGTH_DEV = 16;

export type IdentitySecretResult =
  | { ok: true; secret: string }
  | { ok: false; reason: 'missing' | 'too_short' | 'dev_default_not_allowed' };

/**
 * IDENTITY_HASH_SECRET 해석.
 *   development           → 미설정이면 개발 fixture secret 으로 fallback (seed 해시와 일치 필요)
 *   staging / production  → 미설정·개발 기본값과 동일·길이 미달이면 실패 (자동 fallback 절대 금지)
 *
 * 반환값 외에 secret 값 자체를 로그/오류 메시지에 절대 포함하지 않는다.
 */
export function resolveIdentitySecret(
  appEnv: AppEnv,
  configured: string | null | undefined,
  devFallbackSecret: string,
): IdentitySecretResult {
  const secret = (configured ?? '').trim() === '' ? null : (configured as string);

  if (appEnv === 'development') {
    if (!secret) return { ok: true, secret: devFallbackSecret };
    if (secret.length < IDENTITY_SECRET_MIN_LENGTH_DEV) return { ok: false, reason: 'too_short' };
    return { ok: true, secret };
  }

  // staging / production — 반드시 실제 고유 secret
  if (!secret) return { ok: false, reason: 'missing' };
  if (secret === devFallbackSecret) return { ok: false, reason: 'dev_default_not_allowed' };
  if (secret.length < IDENTITY_SECRET_MIN_LENGTH) return { ok: false, reason: 'too_short' };
  return { ok: true, secret };
}
