/**
 * identity 핵심 로직 selftest — Node 로 실행 (Deno 불필요).
 *   node --experimental-strip-types selftest.ts
 *
 * verify-identity Edge Function 이 사용하는 순수 로직(전화번호 정규화 · Mock identityKey
 * 매핑 · HMAC · 가입/복구 분기)을 스펙 시나리오 기준으로 검증한다.
 */
import {
  DEV_IDENTITY_HASH_SECRET,
  decideIdentityOutcome,
  hashIdentityKey,
  isAdult,
  maskPhone,
  mockIdentityKeyFor,
  normalizePhoneKR,
} from './identityCore.ts';

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

// ── 전화번호 정규화 (UI 표시는 하이픈, Auth/DB 는 E.164) ─────────────────
eq('normalize hyphen', normalizePhoneKR('010-1234-5678'), '+821012345678');
eq('normalize plain', normalizePhoneKR('01012345678'), '+821012345678');
eq('normalize intl spaces', normalizePhoneKR('+82 10 1234 5678'), '+821012345678');
eq('normalize intl leading zero', normalizePhoneKR('+82010-1234-5678'), '+821012345678');
eq('normalize rejects short', normalizePhoneKR('0101234'), null);
eq('normalize rejects landline', normalizePhoneKR('02-123-4567'), null);
eq('normalize rejects non-KR', normalizePhoneKR('+15551234567'), null);
eq('mask', maskPhone('+821012345678'), '010-****-5678');

// ── Mock identityKey 매핑 (개발 fixture) ────────────────────────────────
const key = (local: string) =>
  mockIdentityKeyFor({ phoneE164: normalizePhoneKR(local), name: '테스트', birthDate: '1996-05-15' });

eq('fixture dev-user-001', key('010-0000-0001'), 'dev-user-001');
eq('fixture distinct 002', key('010-0000-0002'), 'dev-user-002');
eq('fixture duplicate pair', key('010-0000-0011') === key('010-0000-0012'), true);
eq('fixture duplicate value', key('010-0000-0011'), 'duplicate-test-user');
eq('fixture race pair', key('010-0000-0021') === key('010-0000-0022'), true);
eq('fixture banned pair', key('010-0000-0098') === key('010-0000-0099'), true);
eq('fixture banned value', key('010-0000-0099'), 'banned-test-user');
// 일반 번호: 이름+생년월일 기준 결정적 (같은 사람 = 같은 키, 다른 사람 = 다른 키)
eq(
  'general key deterministic',
  mockIdentityKeyFor({ phoneE164: '+821055556666', name: '김본심', birthDate: '1994-01-02' }),
  mockIdentityKeyFor({ phoneE164: '+821077778888', name: '김본심', birthDate: '1994-01-02' }),
);
eq(
  'general key differs by person',
  mockIdentityKeyFor({ phoneE164: '+821055556666', name: '김본심', birthDate: '1994-01-02' }) ===
    mockIdentityKeyFor({ phoneE164: '+821055556666', name: '이본심', birthDate: '1994-01-02' }),
  false,
);

// ── 가입/복구 분기 — 스펙 시나리오 매핑 ─────────────────────────────────
const ME = 'user-me';
const OTHER = 'user-other';

// Test 1: 신규 번호 + 신규 identityKey → 정상 신규 가입
eq('scenario1 new identity', decideIdentityOutcome(null, ME), 'created');
// (재시도 멱등성) 이미 내 계정에 연결된 identity
eq(
  'scenario1b idempotent',
  decideIdentityOutcome({ userId: ME, banned: false, userStatus: 'active' }, ME),
  'already_verified',
);
// Test 3: 새 번호 + 기존 identityKey → 신규 계정 생성 금지, 기존 계정 복구 flow
eq(
  'scenario3 existing account',
  decideIdentityOutcome({ userId: OTHER, banned: false, userStatus: 'active' }, ME),
  'existing_account',
);
// Test 4: 새 번호 + banned identityKey → 가입 차단 (번호를 바꿔도 동일)
eq(
  'scenario4 banned identity',
  decideIdentityOutcome({ userId: OTHER, banned: true, userStatus: 'banned' }, ME),
  'blocked',
);
// banned 계정이 삭제되어 user_id 가 비어도 차단 유지
eq(
  'scenario4b banned retained after delete',
  decideIdentityOutcome({ userId: null, banned: true, userStatus: null }, ME),
  'blocked',
);
// banned 동기화 누락 대비 이중 방어 (users.status 만 banned 인 경우)
eq(
  'scenario4c banned via user status',
  decideIdentityOutcome({ userId: OTHER, banned: false, userStatus: 'banned' }, ME),
  'blocked',
);
// 탈퇴한 계정의 identity → 새 계정에 재연결 (여전히 1 identity 1 계정)
eq(
  'deleted identity relink',
  decideIdentityOutcome({ userId: null, banned: false, userStatus: null }, ME),
  'relinked',
);
// suspended 계정도 새 계정 생성은 금지 (복구 안내)
eq(
  'suspended existing account',
  decideIdentityOutcome({ userId: OTHER, banned: false, userStatus: 'suspended' }, ME),
  'existing_account',
);

// ── 성인 확인 ───────────────────────────────────────────────────────────
const now = new Date('2026-08-27T00:00:00Z');
eq('adult 19', isAdult('2007-08-27', now), true);
eq('minor by one day', isAdult('2007-08-28', now), false);
eq('invalid birth', isAdult('not-a-date', now), false);

// ── HMAC (서버 전용 identity_key_hash) ─────────────────────────────────
const main = async () => {
  const h1 = await hashIdentityKey('banned-test-user', DEV_IDENTITY_HASH_SECRET);
  const h2 = await hashIdentityKey('banned-test-user', DEV_IDENTITY_HASH_SECRET);
  const h3 = await hashIdentityKey('banned-test-user', 'another-secret');
  const h4 = await hashIdentityKey('dev-user-001', DEV_IDENTITY_HASH_SECRET);
  eq('hmac deterministic', h1, h2);
  eq('hmac secret-dependent', h1 === h3, false);
  eq('hmac key-dependent', h1 === h4, false);
  eq('hmac hex length', h1.length, 64);
  // seed.sql 의 pgcrypto hmac 과 같은 메시지 규약(identity: prefix)을 쓰는지 회귀 방지
  const nodeCrypto = await import('node:crypto');
  eq(
    'hmac seed compatibility',
    h1,
    nodeCrypto.createHmac('sha256', DEV_IDENTITY_HASH_SECRET).update('identity:banned-test-user').digest('hex'),
  );

  console.log(`identity selftest: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
};

main();
