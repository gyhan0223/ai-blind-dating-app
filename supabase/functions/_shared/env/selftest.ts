/**
 * 서버 환경 guardrail selftest — Node 로 실행 (Deno 불필요).
 *   node --experimental-strip-types selftest.ts
 *
 * Issue #3 핵심 보장:
 *   - APP_ENV 누락/invalid → production 취급 (fail-closed)
 *   - production 에서는 ALLOW_DEV_LOGIN=1 이어도 dev-login 불허
 *   - staging/production 에서 IDENTITY_HASH_SECRET 누락·개발 기본값·짧은 값 → 실패
 *   - development 에서만 명시적 opt-in 으로 개발 기능 허용
 */
import { DEV_IDENTITY_HASH_SECRET } from '../identity/identityCore.ts';
import {
  IDENTITY_SECRET_MIN_LENGTH,
  isDevLoginAllowed,
  resolveAppEnv,
  resolveIdentitySecret,
} from './envCore.ts';

let passed = 0;
let failed = 0;

function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ── APP_ENV 해석 — 누락/오타는 전부 production (fail-closed) ────────────
eq('env development', resolveAppEnv('development'), 'development');
eq('env staging', resolveAppEnv('staging'), 'staging');
eq('env production', resolveAppEnv('production'), 'production');
eq('env trims/lowercases', resolveAppEnv('  Development '), 'development');
eq('env unset → production', resolveAppEnv(undefined), 'production');
eq('env null → production', resolveAppEnv(null), 'production');
eq('env empty → production', resolveAppEnv(''), 'production');
eq('env typo → production', resolveAppEnv('developement'), 'production');
eq('env unknown → production', resolveAppEnv('dev'), 'production');
eq('env prod alias 미지원 → production', resolveAppEnv('prod'), 'production');

// ── dev-login allowlist — production 은 어떤 조합으로도 false ───────────
const dl = (appEnv: string | undefined, allow?: string, disable?: string) =>
  isDevLoginAllowed({ appEnv: resolveAppEnv(appEnv), allowDevLogin: allow, disableDevLogin: disable });

eq('dev-login: production 무조건 차단', dl('production', '1'), false);
eq('dev-login: production 플래그 없어도 차단', dl('production'), false);
eq('dev-login: APP_ENV 누락 + ALLOW=1 → 차단', dl(undefined, '1'), false);
eq('dev-login: APP_ENV invalid + ALLOW=1 → 차단', dl('dev', '1'), false);
eq('dev-login: development 인데 ALLOW 없음 → 차단 (opt-in)', dl('development'), false);
eq('dev-login: development + ALLOW=0 → 차단', dl('development', '0'), false);
eq('dev-login: development + ALLOW=1 → 허용', dl('development', '1'), true);
eq('dev-login: staging + ALLOW=1 → 허용 (명시적)', dl('staging', '1'), true);
eq('dev-login: staging ALLOW 없음 → 차단', dl('staging'), false);
eq('dev-login: kill switch 우선', dl('development', '1', '1'), false);

// ── IDENTITY_HASH_SECRET — staging/production 자동 fallback 금지 ────────
const GOOD = 'a'.repeat(IDENTITY_SECRET_MIN_LENGTH); // 예시용 — 실제 값 아님
const sec = (appEnv: string | undefined, configured: string | undefined) =>
  resolveIdentitySecret(resolveAppEnv(appEnv), configured, DEV_IDENTITY_HASH_SECRET);

eq('secret: production 미설정 → 실패', sec('production', undefined), { ok: false, reason: 'missing' });
eq('secret: production 빈 값 → 실패', sec('production', '  '), { ok: false, reason: 'missing' });
eq('secret: production 개발 기본값 → 실패', sec('production', DEV_IDENTITY_HASH_SECRET), {
  ok: false,
  reason: 'dev_default_not_allowed',
});
eq('secret: production 짧은 값 → 실패', sec('production', 'short-secret'), {
  ok: false,
  reason: 'too_short',
});
eq('secret: production 정상 값 → 통과', sec('production', GOOD), { ok: true, secret: GOOD });
eq('secret: staging 미설정 → 실패', sec('staging', undefined), { ok: false, reason: 'missing' });
eq('secret: staging 개발 기본값 → 실패', sec('staging', DEV_IDENTITY_HASH_SECRET), {
  ok: false,
  reason: 'dev_default_not_allowed',
});
eq('secret: APP_ENV 누락 + 미설정 → production 취급 실패', sec(undefined, undefined), {
  ok: false,
  reason: 'missing',
});
eq('secret: APP_ENV 누락 + 개발 기본값 → 실패', sec(undefined, DEV_IDENTITY_HASH_SECRET), {
  ok: false,
  reason: 'dev_default_not_allowed',
});
eq('secret: development 미설정 → dev fixture fallback 허용', sec('development', undefined), {
  ok: true,
  secret: DEV_IDENTITY_HASH_SECRET,
});
eq('secret: development 직접 지정(16자 이상) → 사용', sec('development', 'my-local-secret-16b'), {
  ok: true,
  secret: 'my-local-secret-16b',
});
eq('secret: development 짧은 지정 값 → 실패', sec('development', 'tiny'), {
  ok: false,
  reason: 'too_short',
});

console.log(`env selftest: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
