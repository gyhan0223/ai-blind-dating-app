/**
 * 관리자 세션 토큰·로그인 제한 selftest (#27) — Node 로 실행 (Next 불필요).
 *   cd apps/admin && node --experimental-strip-types scripts/admin-session-selftest.mjs
 */
import {
  issueSessionToken,
  LoginAttemptLimiter,
  passwordMatches,
  sanitizeActor,
  SESSION_TTL_SECONDS,
  verifySessionToken,
} from '../lib/adminSessionCore.ts';

let passed = 0;
let failed = 0;
function check(name, ok) {
  if (ok) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
}

const secret = 'test-secret-0123456789';
const now = 1_800_000_000_000;
const tok = issueSessionToken(secret, '운영자A', now);

check('토큰 형식 p.sig', tok.split('.').length === 2);
const v = verifySessionToken(secret, tok, now + 1000);
check('검증 성공 + actor', v !== null && v.actor === '운영자A');
check('만료 = iat + 12h', v !== null && v.exp - v.iat === SESSION_TTL_SECONDS);
check('만료 뒤 무효', verifySessionToken(secret, tok, now + (SESSION_TTL_SECONDS + 1) * 1000) === null);
check('다른 secret 무효', verifySessionToken('other-secret', tok, now) === null);
check('서명 변조 무효', verifySessionToken(secret, tok.slice(0, -2) + 'zz', now) === null);
{
  // payload 변조(exp 연장) → 서명 불일치
  const [p] = tok.split('.');
  const json = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  json.exp += 99999;
  const forged = Buffer.from(JSON.stringify(json)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  check('payload 변조 무효', verifySessionToken(secret, `${forged}.${tok.split('.')[1]}`, now) === null);
}
check('빈 토큰/쓰레기 무효', verifySessionToken(secret, null, now) === null && verifySessionToken(secret, 'abc', now) === null && verifySessionToken(secret, 'a.b.c', now) === null);
check('secret 없으면 무효', verifySessionToken('', tok, now) === null);
check('예전 고정 sha256 쿠키는 무효', verifySessionToken(secret, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', now) === null);
check('두 토큰은 nonce 로 다르다', issueSessionToken(secret, 'a', now) !== issueSessionToken(secret, 'a', now));

// actor 정리
check('actor 기본값', sanitizeActor('') === 'admin' && sanitizeActor(undefined) === 'admin');
check('actor 길이·개행 제한', sanitizeActor('a\nb'.padEnd(80, 'x')).length === 40 && !sanitizeActor('a\nb').includes('\n'));

// 비밀번호 비교
check('비밀번호 일치', passwordMatches('secret-pw', 'secret-pw'));
check('비밀번호 불일치', !passwordMatches('secret-pX', 'secret-pw') && !passwordMatches('short', 'secret-pw') && !passwordMatches('', 'secret-pw'));
check('기대값 없으면 항상 실패', !passwordMatches('', ''));

// 로그인 제한
{
  const lim = new LoginAttemptLimiter(3, 60);
  check('처음엔 잠기지 않음', lim.lockedFor('ip1', now) === 0);
  lim.recordFailure('ip1', now);
  lim.recordFailure('ip1', now);
  check('2회 실패는 아직', lim.lockedFor('ip1', now) === 0);
  lim.recordFailure('ip1', now);
  check('3회 실패 → 잠금 (1초 지나 59초 남음)', lim.lockedFor('ip1', now + 1000) === 59);
  check('다른 키는 영향 없음', lim.lockedFor('ip2', now) === 0);
  check('잠금 해제 뒤 0', lim.lockedFor('ip1', now + 61_000) === 0);
  lim.recordSuccess('ip1');
  check('성공하면 초기화', lim.lockedFor('ip1', now) === 0);
}

console.log(`admin session selftest: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
