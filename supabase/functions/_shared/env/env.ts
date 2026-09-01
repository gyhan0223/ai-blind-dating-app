/**
 * Edge Function 용 서버 환경 helper (Deno 전용 — Deno.env 를 읽는 얇은 래퍼).
 * 판별 로직 자체는 envCore.ts(순수 모듈)에 있고 selftest 로 검증한다.
 */
import { DEV_IDENTITY_HASH_SECRET } from '../identity/identityCore.ts';
import {
  type AppEnv,
  isDevLoginAllowed,
  resolveAppEnv,
  resolveIdentitySecret,
} from './envCore.ts';

export type { AppEnv };

/** APP_ENV 서버 환경변수 기준. 누락/알 수 없는 값 → production (fail-closed). */
export function getAppEnv(): AppEnv {
  return resolveAppEnv(Deno.env.get('APP_ENV'));
}

/** dev-login 허용 여부 — production 에서는 어떤 플래그 조합으로도 true 가 되지 않는다. */
export function devLoginAllowed(): boolean {
  return isDevLoginAllowed({
    appEnv: getAppEnv(),
    allowDevLogin: Deno.env.get('ALLOW_DEV_LOGIN'),
    disableDevLogin: Deno.env.get('DISABLE_DEV_LOGIN'),
  });
}

/**
 * IDENTITY_HASH_SECRET 을 검증해 돌려준다. module init(cold start)에서 호출해
 * 잘못된 production/staging 설정이면 함수가 아예 뜨지 않게 한다.
 * 오류 메시지에 secret 값은 절대 포함하지 않는다.
 */
export function requireIdentitySecret(): string {
  const appEnv = getAppEnv();
  const result = resolveIdentitySecret(
    appEnv,
    Deno.env.get('IDENTITY_HASH_SECRET'),
    DEV_IDENTITY_HASH_SECRET,
  );
  if (!result.ok) {
    throw new Error(
      `[env] IDENTITY_HASH_SECRET 설정 오류 (${result.reason}, APP_ENV=${appEnv}). ` +
        'staging/production 에서는 개발 기본값과 다른 32자 이상의 고유 secret 을 반드시 설정하세요. ' +
        '(docs/environments.md 참고)',
    );
  }
  return result.secret;
}
