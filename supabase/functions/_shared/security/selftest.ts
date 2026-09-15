/**
 * Edge 남용 방지·베타 강제 순수 로직 selftest (#27/#26) — Node 로 실행 (Supabase 불필요).
 *   cd supabase/functions/_shared/security && node --experimental-strip-types selftest.ts
 */
import { checkRateLimit, decideBetaAccess, decideRateLimit } from './core.ts';

let passes = 0;
let failures = 0;
function check(name: string, ok: boolean) {
  if (ok) passes += 1;
  else {
    failures += 1;
    console.error(`FAIL ${name}`);
  }
}

// rate limit — fail-closed
check('허용', decideRateLimit({ data: { allowed: true, count: 1 }, error: null }).allowed === true);
{
  const d = decideRateLimit({ data: { allowed: false, retry_after_seconds: 42 }, error: null });
  check('거부 + retry', !d.allowed && d.reason === 'rate_limited' && d.retryAfterSeconds === 42);
}
{
  const d = decideRateLimit({ data: { allowed: false, retry_after_seconds: 'x' }, error: null });
  check('retry 값이 이상하면 60초', !d.allowed && d.reason === 'rate_limited' && d.retryAfterSeconds === 60);
}
check('RPC 오류 → unavailable (허용 아님)', decideRateLimit({ data: null, error: { message: 'function does not exist' } }).allowed === false);
check('형식 이상 → unavailable', decideRateLimit({ data: 'yes', error: null }).allowed === false);
check('null data → unavailable', decideRateLimit({ data: null, error: null }).allowed === false);

// checkRateLimit — 예외도 거부
{
  const d = await checkRateLimit(async () => { throw new Error('network'); }, 's', 'k', 1, 60);
  check('RPC throw → unavailable', !d.allowed && d.reason === 'unavailable');
  const calls: unknown[] = [];
  const d2 = await checkRateLimit(async (scope, key, limit, win) => { calls.push([scope, key, limit, win]); return { data: { allowed: true }, error: null }; }, 'verify-identity:request', 'u1', 5, 600);
  check('RPC 인자 전달', d2.allowed && JSON.stringify(calls[0]) === JSON.stringify(['verify-identity:request', 'u1', 5, 600]));
}

// beta access — true 만 허용
check('true → allowed', decideBetaAccess({ data: true, error: null }) === 'allowed');
check('false → denied', decideBetaAccess({ data: false, error: null }) === 'denied');
check('null → unavailable', decideBetaAccess({ data: null, error: null }) === 'unavailable');
check('"true" 문자열 → unavailable', decideBetaAccess({ data: 'true', error: null }) === 'unavailable');
check('오류 → unavailable', decideBetaAccess({ data: true, error: { message: 'x' } }) === 'unavailable');

console.log(`security selftest: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
