/**
 * 관리자 세션 토큰·로그인 제한 selftest (#27) — Node 로 실행 (Next 불필요).
 *   cd apps/admin && node --experimental-strip-types scripts/admin-session-selftest.mjs
 *
 * 로그인 제한은 DB(admin_login_guard RPC)가 상태를 갖는다. 여기서는 같은 규칙의 순수 구현(applyGuardEvent)을 저장소로 삼아
 * 판정 흐름(runLoginGuard)을 검증한다 — RPC 자체는 supabase/tests/admin_login_guard_tests.sql · 동시성 스크립트가 검증한다.
 */
import {
  applyGuardEvent,
  issueSessionToken,
  LOGIN_LOCK_SECONDS,
  LOGIN_MAX_FAILURES,
  loginGuardKey,
  passwordMatches,
  resolveAdminSessionSecret,
  resolveClientIp,
  runLoginGuard,
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

// ── 세션 secret: production 은 명시적 값만 ──────────────────────────────
{
  const long = 'x'.repeat(32);
  check('production 명시 secret 32자+', resolveAdminSessionSecret({ nodeEnv: 'production', sessionSecret: long, password: 'pw' }).ok);
  check('production 짧은 secret 거부', resolveAdminSessionSecret({ nodeEnv: 'production', sessionSecret: 'short-secret-16ch', password: 'pw' }).reason === 'too_short');
  check('production 미설정 → fallback 없음', resolveAdminSessionSecret({ nodeEnv: 'production', sessionSecret: undefined, password: 'pw' }).reason === 'missing_in_production');
  const dev = resolveAdminSessionSecret({ nodeEnv: 'development', sessionSecret: undefined, password: 'pw' });
  check('development 비밀번호 파생 fallback', dev.ok && dev.source === 'derived_dev');
  check('development 비밀번호도 없으면 실패', resolveAdminSessionSecret({ nodeEnv: 'development', sessionSecret: undefined, password: undefined }).reason === 'password_missing');
  check('development 명시 secret 16자+', resolveAdminSessionSecret({ nodeEnv: 'development', sessionSecret: 'sixteen-chars-ok', password: 'pw' }).ok);
  check('secret 결과에 값 없음', !JSON.stringify(resolveAdminSessionSecret({ nodeEnv: 'production', sessionSecret: 'hunter2-value', password: 'pw' })).includes('hunter2'));
}

// ── 클라이언트 키: 프록시 헤더 신뢰 경계 · HMAC ───────────────────────
{
  check('프록시 미신뢰 → 공유 키', resolveClientIp({ trustProxyHeaders: false, xForwardedFor: '1.2.3.4', xRealIp: '5.6.7.8' }) === 'untrusted-client');
  check('프록시 신뢰 → xff 첫 항목', resolveClientIp({ trustProxyHeaders: true, xForwardedFor: '1.2.3.4, 10.0.0.1', xRealIp: null }) === '1.2.3.4');
  check('프록시 신뢰 → x-real-ip fallback', resolveClientIp({ trustProxyHeaders: true, xForwardedFor: null, xRealIp: '5.6.7.8' }) === '5.6.7.8');
  check('프록시 신뢰인데 헤더 없음 → 공유 키', resolveClientIp({ trustProxyHeaders: true, xForwardedFor: '', xRealIp: '' }) === 'untrusted-client');
  const k = loginGuardKey(secret, '1.2.3.4');
  check('키는 HMAC (원문 IP 없음)', !k.includes('1.2.3.4') && k.startsWith('ip:') && k.length >= 8);
  check('다른 secret → 다른 키', loginGuardKey('other', '1.2.3.4') !== k);
  check('같은 입력 → 같은 키 (인스턴스 간 공유 가능)', loginGuardKey(secret, '1.2.3.4') === k);
}

// ── 로그인 제한 규칙 (applyGuardEvent = RPC 규칙) ─────────────────────
{
  let s;
  let r = applyGuardEvent(s, 'check', now);
  check('처음엔 잠기지 않음', !r.hit.locked && r.hit.failures === 0);
  for (let i = 1; i < LOGIN_MAX_FAILURES; i += 1) {
    r = applyGuardEvent(s, 'failure', now);
    s = r.next;
    check(`${i}회 실패는 아직`, !r.hit.locked && r.hit.failures === i);
  }
  r = applyGuardEvent(s, 'failure', now);
  s = r.next;
  check('5회 실패 → 잠금 15분', r.hit.locked && r.hit.lockedSeconds === LOGIN_LOCK_SECONDS);
  r = applyGuardEvent(s, 'check', now + 1000);
  check('잠금 중 check', r.hit.locked && r.hit.lockedSeconds === LOGIN_LOCK_SECONDS - 1);
  r = applyGuardEvent(s, 'failure', now + 1000);
  check('잠금 중 실패는 카운트 안 올리고 잠금 유지', r.hit.locked && r.next.failures === 0);
  r = applyGuardEvent(s, 'check', now + (LOGIN_LOCK_SECONDS + 1) * 1000);
  check('잠금 만료 → 해제', !r.hit.locked);
  r = applyGuardEvent(s, 'failure', now + (LOGIN_LOCK_SECONDS + 1) * 1000);
  check('만료 뒤 실패는 새 창 1회', !r.hit.locked && r.hit.failures === 1);
  r = applyGuardEvent(r.next, 'success', now);
  check('성공하면 초기화', r.next === undefined && !r.hit.locked);
}

// ── 판정 흐름 (runLoginGuard) — 공유 저장소 · 동시 실패 · 잠금 중 올바른 비밀번호 · DB 실패 시 세션 없음 ─
class MemStore {
  constructor() {
    this.state = new Map();
    this.now = now;
    this.down = false;
    this.calls = [];
    this.delayMs = 0;
  }
  async hit(key, event) {
    this.calls.push(event);
    if (this.down) return null;
    if (this.delayMs) await new Promise((res) => setTimeout(res, this.delayMs));
    // 행 잠금처럼 한 번에 하나씩 적용 (JS 단일 스레드 — 갱신은 원자적)
    const r = applyGuardEvent(this.state.get(key), event, this.now);
    if (r.next) this.state.set(key, r.next);
    else this.state.delete(key);
    return r.hit;
  }
}
{
  const store = new MemStore();
  // "인스턴스 A" 와 "인스턴스 B" 는 같은 저장소를 본다
  const key = loginGuardKey(secret, '9.9.9.9');
  const outcomes = [];
  for (let i = 0; i < 3; i += 1) outcomes.push((await runLoginGuard(store, key, () => false)).outcome); // A
  for (let i = 0; i < 2; i += 1) outcomes.push((await runLoginGuard(store, key, () => false)).outcome); // B
  check('다른 인스턴스의 실패가 합산된다 (3+2 → 잠금)', JSON.stringify(outcomes) === JSON.stringify(['bad_password', 'bad_password', 'bad_password', 'bad_password', 'locked']));
  const lockedCorrect = await runLoginGuard(store, key, () => true);
  check('잠금 중 올바른 비밀번호도 거부', lockedCorrect.outcome === 'locked' && lockedCorrect.lockedSeconds > 0);
  check('잠금 중에는 비밀번호를 검사하지 않는다', store.calls.filter((c) => c === 'success').length === 0);
  store.now = now + (LOGIN_LOCK_SECONDS + 1) * 1000;
  const afterExpiry = await runLoginGuard(store, key, () => true);
  check('잠금 만료 뒤 성공 → 초기화', afterExpiry.outcome === 'ok' && !store.state.has(key));
  const other = await runLoginGuard(store, loginGuardKey(secret, '8.8.8.8'), () => true);
  check('다른 키는 영향 없음', other.outcome === 'ok');

  // 동시 실패: 여러 요청이 동시에 들어와도 정확히 5번째에서 잠기고 6번째부터는 잠금 응답
  const store2 = new MemStore();
  const key2 = loginGuardKey(secret, '7.7.7.7');
  const results = await Promise.all(Array.from({ length: 8 }, () => runLoginGuard(store2, key2, () => false)));
  const lockedCount = results.filter((r) => r.outcome === 'locked').length;
  check('동시 8회 실패 → bad_password 4 · locked 4', lockedCount === 4 && results.filter((r) => r.outcome === 'bad_password').length === 4);
  check('동시 실패 후 상태는 잠금 하나', store2.state.get(key2).lockedUntil > store2.now && store2.state.get(key2).failures === 0);

  // 저장소 장애 → 어떤 경우에도 세션 발급 안 함
  const store3 = new MemStore();
  store3.down = true;
  check('DB 장애 + 올바른 비밀번호 → unavailable', (await runLoginGuard(store3, key, () => true)).outcome === 'unavailable');
  check('DB 장애 + 틀린 비밀번호 → unavailable', (await runLoginGuard(store3, key, () => false)).outcome === 'unavailable');
  // 실패 기록 단계에서만 장애
  const store4 = new MemStore();
  const origHit = store4.hit.bind(store4);
  store4.hit = async (k, e) => (e === 'failure' ? null : origHit(k, e));
  check('실패 기록 장애 → unavailable', (await runLoginGuard(store4, key, () => false)).outcome === 'unavailable');
  const store5 = new MemStore();
  const origHit5 = store5.hit.bind(store5);
  store5.hit = async (k, e) => (e === 'success' ? null : origHit5(k, e));
  check('성공 기록 장애 → unavailable (세션 없음)', (await runLoginGuard(store5, key, () => true)).outcome === 'unavailable');
}

console.log(`admin session selftest: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
