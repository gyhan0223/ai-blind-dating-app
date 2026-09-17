/**
 * verify-identity 흐름 selftest (#6) — Node 로 실행 (Deno·Supabase 불필요).
 *   node --experimental-strip-types verifyIdentitySelftest.ts
 *
 * runVerifyIdentity 에 제어 가능한 Provider · 인메모리 DB(UNIQUE·cascade·ban 동기화 트리거를 흉내) · Auth · 고정 시계를 주입해
 * "Provider 결과 → 서버 검증 → identity 연결 → 계정 복구" 상태 전이를 시나리오별로 검증한다.
 *
 * 여기서 검증하는 것은 코어 로직이다. 실제 DB 의 UNIQUE/조건부 갱신 동작은 supabase/tests/identity_tests.sql 과
 * identity_concurrency_test.sh(두 연결) 가, 실제 Provider·Auth 연동은 (업체 선정 뒤) E2E 가 검증한다 — 이 테스트가 그것을 대신하지 않는다.
 *
 * TestIdentityProvider 는 이 파일에만 있다. getIdentityProvider('test') 는 실패해야 하며(마지막 검사) production 설정에서 선택될 수 없다.
 */
import { getIdentityProvider, type IdentityRequestInput, type IdentityVerificationProvider, type IdentityVerificationResult } from './IdentityVerificationProvider.ts';
import { DEV_IDENTITY_HASH_SECRET, hashIdentityKey } from './identityCore.ts';
import {
  DEFAULT_MAX_ATTEMPTS,
  type DeviceEventType,
  type IdentityAuth,
  type IdentityDb,
  type IdentityRow,
  runVerifyIdentity,
  type SessionPatch,
  type SessionRow,
  type SessionStatus,
  type VerifyDeps,
  type VerifyResponse,
} from './verifyIdentityCore.ts';

let passed = 0;
let failed = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function ok(name: string, cond: boolean) {
  eq(name, cond, true);
}

// ---------------------------------------------------------------------------
// 제어 가능한 테스트 Provider — 결과·지연·오류를 큐로 지정한다 (production factory 에 없다)
// ---------------------------------------------------------------------------
type Scripted = IdentityVerificationResult | { throw: true } | { delayMs: number; then: IdentityVerificationResult };

class TestIdentityProvider implements IdentityVerificationProvider {
  queue: Scripted[] = [];
  startCalls = 0;
  resultCalls: { verificationId: string; code: string }[] = [];
  startThrows = false;
  /** 큐가 비었을 때의 기본 결과 (identityKey 를 사람별로 고정) */
  defaultFor: ((input: IdentityRequestInput) => IdentityVerificationResult) | null = null;

  async startVerification(_input: IdentityRequestInput) {
    this.startCalls += 1;
    if (this.startThrows) throw new Error('provider down');
    return { verificationId: `prov-${this.startCalls}`, redirectUrl: null };
  }
  async getVerificationResult(verificationId: string, code: string, input: IdentityRequestInput) {
    this.resultCalls.push({ verificationId, code });
    const next = this.queue.shift();
    if (!next) {
      if (this.defaultFor) return this.defaultFor(input);
      throw new Error('no scripted result');
    }
    if ('throw' in next) throw new Error('network error');
    if ('delayMs' in next) {
      await new Promise((r) => setTimeout(r, next.delayMs));
      return next.then;
    }
    return next;
  }
}

const okResult = (identityKey: string, birthDate = '1996-05-15', gender: 'male' | 'female' | undefined = 'female'): IdentityVerificationResult => ({
  verified: true,
  identityKey,
  birthDate,
  gender,
  verifiedAt: '2026-09-16T00:00:00.000Z',
});

// ---------------------------------------------------------------------------
// 인메모리 DB — user_identities 의 UNIQUE(identity_key_hash)·UNIQUE(user_id), 세션의 조건부 갱신, cascade, ban 동기화
// ---------------------------------------------------------------------------
type User = { id: string; status: string; phone: string | null; identityVerified: boolean; ageVerified: boolean; purgedAt: string | null };
type Identity = IdentityRow & { hash: string; birthDate: string | null; gender: string | null; verifiedAt: string | null };
type Session = SessionRow & { consumedAt: string | null };

class MemDb implements IdentityDb {
  users = new Map<string, User>();
  identities: Identity[] = [];
  sessions = new Map<string, Session>();
  privateProfiles = new Map<string, { birthDate: string; phone: string | null }>();
  events: { userId: string | null; type: DeviceEventType; meta: Record<string, unknown> }[] = [];
  seq = 0;
  /** 한 번 실패할 메서드 이름 */
  failOnce = new Set<string>();
  /** 메서드 진입 직전에 실행되는 훅 (동시 요청 끼워넣기용) */
  before: Partial<Record<keyof IdentityDb, () => Promise<void>>> = {};
  calls: string[] = [];

  private async enter(name: keyof IdentityDb) {
    this.calls.push(name);
    const hook = this.before[name];
    if (hook) {
      this.before[name] = undefined;
      await hook();
    }
  }
  private fail(name: string): boolean {
    if (this.failOnce.has(name)) {
      this.failOnce.delete(name);
      return true;
    }
    return false;
  }
  uuid(): string {
    this.seq += 1;
    return `00000000-0000-4000-8000-${String(this.seq).padStart(12, '0')}`;
  }
  addUser(id: string, phone: string | null, status = 'active'): User {
    const u = { id, status, phone, identityVerified: false, ageVerified: false, purgedAt: null };
    this.users.set(id, u);
    return u;
  }
  /** users.status 변경 + 0009 sync_identity_ban 트리거 흉내 */
  setStatus(userId: string, status: string) {
    const u = this.users.get(userId)!;
    const prev = u.status;
    u.status = status;
    for (const i of this.identities) {
      if (i.userId !== userId) continue;
      if (status === 'banned' && prev !== 'banned') i.banned = true;
      else if (prev === 'banned' && status === 'active') i.banned = false;
    }
  }
  /** auth 삭제 cascade: users 행 삭제 → 세션 삭제 · identity.user_id null (해시·banned 유지)
   *  0009: user_identities.user_id references users on delete set null */
  cascadeDeleteUser(userId: string) {
    this.users.delete(userId);
    for (const [id, s] of this.sessions) if (s.userId === userId) this.sessions.delete(id);
    for (const i of this.identities) if (i.userId === userId) i.userId = null;
    this.privateProfiles.delete(userId);
  }

  async createSession(input: { userId: string; provider: string; providerSessionId: string | null; expiresAt: string }) {
    await this.enter('createSession');
    if (this.fail('createSession')) return null;
    if (!this.users.has(input.userId)) return null;
    const id = this.uuid();
    this.sessions.set(id, {
      id,
      userId: input.userId,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      status: 'pending',
      outcome: null,
      identityKeyHash: null,
      birthDate: null,
      gender: null,
      ownerUserId: null,
      attempts: 0,
      expiresAt: input.expiresAt,
      checkingSince: null,
      consumedAt: null,
    });
    return { id };
  }
  async getSession(id: string) {
    await this.enter('getSession');
    const s = this.sessions.get(id);
    return s ? { ...s } : null;
  }
  async claimSession(id: string, userId: string, nowIso: string, staleBeforeIso: string) {
    await this.enter('claimSession');
    if (this.fail('claimSession')) return null;
    const s = this.sessions.get(id);
    if (!s || s.userId !== userId) return null;
    if (!(s.expiresAt > nowIso)) return null;
    const claimable = s.status === 'pending' || (s.status === 'checking' && s.checkingSince !== null && s.checkingSince < staleBeforeIso);
    if (!claimable) return null;
    s.status = 'checking';
    s.checkingSince = nowIso;
    return { ...s };
  }
  async updateSession(id: string, patch: SessionPatch, expectStatus: SessionStatus) {
    await this.enter('updateSession');
    if (this.fail('updateSession')) return false;
    const s = this.sessions.get(id);
    if (!s || s.status !== expectStatus) return false;
    Object.assign(s, patch);
    return true;
  }
  async findIdentityByHash(hash: string) {
    await this.enter('findIdentityByHash');
    const i = this.identities.find((x) => x.hash === hash);
    return i ? { id: i.id, userId: i.userId, banned: i.banned } : null;
  }
  async findIdentityByUser(userId: string) {
    await this.enter('findIdentityByUser');
    const i = this.identities.find((x) => x.userId === userId);
    return i ? { id: i.id, userId: i.userId, banned: i.banned } : null;
  }
  async getUser(userId: string) {
    await this.enter('getUser');
    const u = this.users.get(userId);
    return u ? { status: u.status, phone: u.phone, identityVerified: u.identityVerified } : null;
  }
  async insertIdentity(row: { userId: string; identityKeyHash: string; birthDate: string; gender: 'male' | 'female' | null; verifiedAt: string }) {
    await this.enter('insertIdentity');
    if (this.fail('insertIdentity')) return 'error' as const;
    if (this.identities.some((x) => x.hash === row.identityKeyHash || x.userId === row.userId)) return 'conflict' as const;
    this.identities.push({ id: this.uuid(), userId: row.userId, hash: row.identityKeyHash, banned: false, birthDate: row.birthDate, gender: row.gender, verifiedAt: row.verifiedAt });
    return 'ok' as const;
  }
  async relinkIdentity(id: string, userId: string, birthDate: string, gender: 'male' | 'female' | null, verifiedAt: string) {
    await this.enter('relinkIdentity');
    const i = this.identities.find((x) => x.id === id);
    if (!i || i.userId !== null) return 0;
    if (this.identities.some((x) => x.userId === userId)) throw new Error('unique_violation user_id');
    i.userId = userId;
    i.birthDate = birthDate;
    i.gender = gender;
    i.verifiedAt = verifiedAt;
    return 1;
  }
  async markUserVerified(userId: string) {
    await this.enter('markUserVerified');
    if (this.fail('markUserVerified')) return false;
    const u = this.users.get(userId);
    if (!u) return false;
    u.identityVerified = true;
    u.ageVerified = true;
    return true;
  }
  async upsertPrivateProfile(userId: string, birthDate: string, phoneE164: string | null) {
    await this.enter('upsertPrivateProfile');
    if (this.fail('upsertPrivateProfile')) return false;
    this.privateProfiles.set(userId, { birthDate, phone: phoneE164 });
    return true;
  }
  async setUserPhone(userId: string, phoneE164: string, _atIso: string) {
    await this.enter('setUserPhone');
    const u = this.users.get(userId);
    if (!u) return false;
    u.phone = phoneE164;
    return true;
  }
  async reactivateIfDeleted(userId: string) {
    await this.enter('reactivateIfDeleted');
    const u = this.users.get(userId);
    if (u && u.status === 'deleted') u.status = 'active';
    return true;
  }
  async logEvent(userId: string | null, type: DeviceEventType, meta: Record<string, string | number | boolean>) {
    this.events.push({ userId, type, meta });
  }
}

class MemAuth implements IdentityAuth {
  users = new Map<string, { phoneE164: string | null; phoneConfirmed: boolean }>();
  failOnce = new Set<string>();
  calls: string[] = [];
  db: MemDb;
  constructor(db: MemDb) {
    this.db = db;
  }
  add(id: string, phoneE164: string | null, confirmed = true) {
    this.users.set(id, { phoneE164, phoneConfirmed: confirmed });
    this.db.addUser(id, confirmed ? phoneE164 : null);
  }
  private fail(name: string) {
    if (this.failOnce.has(name)) {
      this.failOnce.delete(name);
      return true;
    }
    return false;
  }
  async getUser(userId: string) {
    const u = this.users.get(userId);
    return u ? { ...u } : null;
  }
  async deleteUser(userId: string) {
    this.calls.push(`delete:${userId}`);
    if (this.fail('deleteUser')) return false;
    if (!this.users.has(userId)) return false;
    this.users.delete(userId);
    this.db.cascadeDeleteUser(userId);
    return true;
  }
  async updateUserPhone(userId: string, phoneE164: string) {
    this.calls.push(`phone:${userId}`);
    if (this.fail('updateUserPhone')) return false;
    for (const [id, u] of this.users) if (id !== userId && u.phoneE164 === phoneE164) return false; // auth 전화번호 UNIQUE
    const u = this.users.get(userId);
    if (!u) return false;
    u.phoneE164 = phoneE164;
    u.phoneConfirmed = true;
    const appUser = this.db.users.get(userId); // 0009 트리거: auth phone 변경 → users.phone 동기화
    if (appUser) appUser.phone = phoneE164;
    return true;
  }
}

// ---------------------------------------------------------------------------
// 하네스
// ---------------------------------------------------------------------------
const NOW = new Date('2026-09-16T09:00:00.000Z');
const SECRET = DEV_IDENTITY_HASH_SECRET;
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';
const PHONE_A = '+821012340001';
const PHONE_B = '+821012340002';
const PHONE_C = '+821012340003';
const CODE = '654321';
const RAW_KEY = 'DI-RAW-SECRET-VALUE-9f8e7d';
const CLIENT_NAME = '홍길동';

type Harness = {
  db: MemDb;
  auth: MemAuth;
  provider: TestIdentityProvider;
  clock: { now: Date };
  deps: VerifyDeps;
  logs: string[];
  request: (userId: string, extra?: Record<string, unknown>) => Promise<VerifyResponse>;
  confirm: (userId: string, requestId: unknown, extra?: Record<string, unknown>) => Promise<VerifyResponse>;
  recover: (userId: string, requestId: unknown) => Promise<VerifyResponse>;
  /** request → confirm 을 한 번에. 응답과 requestId */
  verify: (userId: string, scripted?: Scripted) => Promise<{ res: VerifyResponse; requestId: string }>;
};

const consoleLogs: string[] = [];
for (const m of ['log', 'error', 'warn', 'info'] as const) {
  const orig = console[m].bind(console);
  console[m] = (...args: unknown[]) => {
    const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    if (line.startsWith('FAIL ') || line.startsWith('verify-identity selftest')) orig(...args);
    else consoleLogs.push(line);
  };
}

function harness(opts: Partial<VerifyDeps> = {}): Harness {
  const db = new MemDb();
  const auth = new MemAuth(db);
  const provider = new TestIdentityProvider();
  const clock = { now: new Date(NOW) };
  const deps: VerifyDeps = { provider, providerKind: 'test', db, auth, identitySecret: SECRET, now: () => new Date(clock.now), ...opts };
  const request = (userId: string, extra: Record<string, unknown> = {}) =>
    runVerifyIdentity({ userId, action: 'request', name: CLIENT_NAME, birthDate: '1996-05-15', carrier: 'skt', ...extra }, deps);
  const confirm = (userId: string, requestId: unknown, extra: Record<string, unknown> = {}) =>
    runVerifyIdentity({ userId, action: 'confirm', requestId, code: CODE, name: CLIENT_NAME, birthDate: '1996-05-15', carrier: 'skt', ...extra }, deps);
  const recover = (userId: string, requestId: unknown) => runVerifyIdentity({ userId, action: 'recover', requestId }, deps);
  const verify = async (userId: string, scripted?: Scripted) => {
    const r = await request(userId);
    const requestId = String(r.body.requestId);
    if (scripted) provider.queue.push(scripted);
    const res = await confirm(userId, requestId);
    return { res, requestId };
  };
  return { db, auth, provider, clock, deps, logs: consoleLogs, request, confirm, recover, verify };
}

const everything: unknown[] = []; // 모든 응답·이벤트를 모아 마지막에 PII 검사
function record(res: VerifyResponse) {
  everything.push(res);
  return res;
}

const main = async () => {
  const hashA = await hashIdentityKey(RAW_KEY, SECRET);

  // ── 1. 신규 가입: request → confirm → created. 저장 값은 Provider 결과 (클라이언트 생년월일·이름 아님) ─────────────
  {
    const h = harness();
    h.auth.add(A, PHONE_A);
    const r = record(await h.request(A));
    eq('request 200 + requestId(uuid)', [r.status, /^[0-9a-f-]{36}$/.test(String(r.body.requestId)), r.body.redirectUrl], [200, true, null]);
    ok('request 는 provider 세션 id 를 클라이언트에 주지 않는다', !JSON.stringify(r.body).includes('prov-1'));
    const s = h.db.sessions.get(String(r.body.requestId))!;
    eq('세션은 호출자 소유·pending·10분', [s.userId, s.status, s.providerSessionId, s.expiresAt], [A, 'pending', 'prov-1', '2026-09-16T09:10:00.000Z']);

    h.provider.queue.push(okResult(RAW_KEY, '1994-01-02', 'male'));
    const c = record(await h.confirm(A, r.body.requestId, { birthDate: '1996-05-15', name: '다른이름' }));
    eq('confirm created', c.body, { verified: true, result: 'created', ageVerified: true });
    eq('provider 에 서버 세션 id 가 아닌 provider 세션 id 와 코드가 전달된다', h.provider.resultCalls, [{ verificationId: 'prov-1', code: CODE }]);
    const idn = h.db.identities[0];
    eq('identity 는 HMAC 해시·Provider 생년월일·성별', [idn.userId, idn.hash === hashA, idn.birthDate, idn.gender, idn.banned], [A, true, '1994-01-02', 'male', false]);
    ok('raw identityKey 는 저장되지 않는다', !JSON.stringify([...h.db.identities, ...h.db.sessions.values()]).includes(RAW_KEY));
    eq('users 플래그', [h.db.users.get(A)!.identityVerified, h.db.users.get(A)!.ageVerified], [true, true]);
    eq('private_profiles 생년월일 = Provider 값, phone = auth 값', h.db.privateProfiles.get(A), { birthDate: '1994-01-02', phone: PHONE_A });
    eq('세션 completed/created + 소비 시각', [s.status, s.outcome, s.consumedAt, s.checkingSince], ['completed', 'created', NOW.toISOString(), null]);
    eq('signup_success 이벤트', h.db.events.map((e) => e.type), ['signup_success']);

    // ── 2. 동일 사용자 재인증 → already_verified (identity 1행 유지) ─────────────────────────────
    const again = await h.verify(A, okResult(RAW_KEY, '1994-01-02', 'male'));
    eq('재인증 already_verified', record(again.res).body, { verified: true, result: 'already_verified', ageVerified: true });
    eq('identity 는 여전히 1행', h.db.identities.length, 1);

    // ── 10. 결과 재전송: 같은 세션으로 다시 confirm → Provider 재호출 없이 저장된 결과 재생 ─────────
    const calls = h.provider.resultCalls.length;
    const replay = record(await h.confirm(A, again.requestId));
    eq('완료된 세션 재전송은 같은 결과', replay.body, { verified: true, result: 'already_verified', ageVerified: true });
    eq('재전송은 Provider 를 부르지 않는다', h.provider.resultCalls.length, calls);
    eq('재전송은 identity 를 늘리지 않는다', h.db.identities.length, 1);
  }

  // ── 3. 전화번호 변경 후 기존 계정 복구 ────────────────────────────────────────────────────────
  {
    const h = harness();
    h.auth.add(A, PHONE_A);
    h.auth.add(B, PHONE_B);
    await h.verify(A, okResult(RAW_KEY));
    // A 는 프로필 등 콘텐츠가 있는 기존 계정. 새 번호(B)로 로그인해 같은 사람으로 인증
    const found = await h.verify(B, okResult(RAW_KEY, '1996-05-15', 'female'));
    eq('새 번호 + 기존 identity → existing_account + 마스킹 번호', record(found.res).body, { verified: false, result: 'existing_account', maskedPhone: '010-****-0001' });
    eq('B 는 인증 완료가 아니다 · identity 는 A 것 그대로', [h.db.users.get(B)!.identityVerified, h.db.identities.length, h.db.identities[0].userId], [false, 1, A]);
    const sess = h.db.sessions.get(found.requestId)!;
    eq('세션 existing_account + 대상 계정 + 복구 창 15분', [sess.status, sess.ownerUserId, sess.identityKeyHash === hashA, sess.expiresAt], ['existing_account', A, true, '2026-09-16T09:15:00.000Z']);
    eq('duplicate_identity_attempt 이벤트 (B)', h.db.events.filter((e) => e.type === 'duplicate_identity_attempt').map((e) => e.userId), [B]);

    // 잘못된 세션(가입이 끝난 completed 세션)으로는 복구할 수 없다
    h.auth.add(C, PHONE_C);
    const done = await h.verify(C, okResult('someone-else'));
    eq('completed 세션으로 recover → not_recoverable', record(await h.recover(C, done.requestId)).body.error, 'not_recoverable');
    const before = h.provider.resultCalls.length;
    const rec = record(await h.recover(B, found.requestId));
    eq('recover 성공', rec.body, { recovered: true });
    eq('recover 는 Provider 를 다시 부르지 않는다', h.provider.resultCalls.length, before);
    eq('Auth: 새 계정 삭제 → 기존 계정 번호 이동 순서', h.auth.calls, [`delete:${B}`, `phone:${A}`]);
    eq('auth A 번호 = B 가 로그인한 번호', h.auth.users.get(A), { phoneE164: PHONE_B, phoneConfirmed: true });
    eq('users A phone 동기화 · B 삭제 · B 세션 삭제(cascade)', [h.db.users.get(A)!.phone, h.db.users.has(B), h.db.sessions.has(found.requestId)], [PHONE_B, false, false]);
    eq('identity 는 그대로 A (C 의 별개 identity 외)', [h.db.identities.length, h.db.identities[0].userId], [2, A]);
    eq('account_recovery 이벤트는 기존 계정에', h.db.events.filter((e) => e.type === 'account_recovery').map((e) => [e.userId, e.meta.ok]), [[A, true]]);
    eq('삭제된 B 의 재호출은 401', record(await h.recover(B, found.requestId)).status, 401);
  }

  // ── 3b. 번호 소유가 확인되지 않은 요청으로는 복구할 수 없다 ────────────────────────────────
  {
    const h = harness();
    h.auth.add(A, PHONE_A);
    h.auth.add(B, PHONE_B, false); // 이메일/개발 로그인처럼 phone_confirmed_at 없음
    await h.verify(A, okResult(RAW_KEY));
    const found = await h.verify(B, okResult(RAW_KEY));
    eq('미확인 번호도 existing_account 안내는 받는다', found.res.body.result, 'existing_account');
    const rec = record(await h.recover(B, found.requestId));
    eq('미확인 번호 recover → phone_login_required', [rec.status, rec.body.error], [400, 'phone_login_required']);
    eq('Auth 호출 없음 · A 번호 그대로', [h.auth.calls, h.auth.users.get(A)!.phoneE164], [[], PHONE_A]);
  }

  // ── 3c. 복구 대상/세션 검증: 타인 세션 · 복구 창 만료 · 이미 identity 가 있는 계정 · 사이에 차단된 대상 ──────
  {
    const h = harness();
    h.auth.add(A, PHONE_A);
    h.auth.add(B, PHONE_B);
    h.auth.add(C, PHONE_C);
    await h.verify(A, okResult(RAW_KEY));
    const found = await h.verify(B, okResult(RAW_KEY));
    // 타인(C)이 B 의 세션으로 recover
    const other = record(await h.recover(C, found.requestId));
    eq('타인 세션 recover → invalid_session (Auth 호출 없음)', [other.status, other.body.error, h.auth.calls], [400, 'invalid_session', []]);
    eq('타인 세션 사용 시도 이벤트 (사유 코드만)', h.db.events.filter((e) => e.meta.reason === 'session_not_owned').map((e) => e.userId), [C]);
    // 복구 창 만료
    h.clock.now = new Date('2026-09-16T09:15:00.001Z');
    const late = record(await h.recover(B, found.requestId));
    eq('복구 창 지난 recover → session_expired', [late.status, late.body.error, h.db.sessions.get(found.requestId)!.status], [400, 'session_expired', 'expired']);
    h.clock.now = new Date(NOW);
    // 이미 다른 identity 가 연결된 계정(C 를 다른 사람으로 인증)으로는 복구 불가 — 그 계정을 지우면 안 된다
    await h.verify(C, okResult('another-person'));
    h.provider.queue.push(okResult(RAW_KEY));
    const cReq = await h.request(C);
    const cConf = record(await h.confirm(C, cReq.body.requestId));
    eq('identity 있는 계정이 다른 사람으로 confirm → identity_mismatch', [cConf.status, cConf.body.error], [409, 'identity_mismatch']);
    // 사이에 대상 계정이 차단됨
    const found2 = await h.verify(B, okResult(RAW_KEY));
    eq('B 재확인 existing_account', found2.res.body.result, 'existing_account');
    h.db.setStatus(A, 'banned');
    const rec = record(await h.recover(B, found2.requestId));
    eq('대상이 차단되면 recover → not_recoverable · Auth 호출 없음', [rec.status, rec.body.error, h.auth.calls], [400, 'not_recoverable', []]);
    eq('세션은 failed 로 닫힌다', h.db.sessions.get(found2.requestId)!.status, 'failed');
  }

  // ── 3d. identity 연결 전이라도 users.identity_verified 가 true 인 계정은 복구로 지우지 않는다 ──
  {
    const h = harness();
    h.auth.add(A, PHONE_A);
    h.auth.add(B, PHONE_B);
    await h.verify(A, okResult(RAW_KEY));
    const found = await h.verify(B, okResult(RAW_KEY));
    h.db.users.get(B)!.identityVerified = true; // 비정상 상태 가정
    const rec = record(await h.recover(B, found.requestId));
    eq('인증 완료 표시된 계정은 not_recoverable', [rec.status, rec.body.error, h.auth.calls], [400, 'not_recoverable', []]);
  }

  // ── 4. 같은 identity 의 동시 가입 (created 경쟁): 한쪽만 연결, 다른 쪽은 existing_account ──────
  {
    const h = harness();
    h.auth.add(A, PHONE_A);
    h.auth.add(B, PHONE_B);
    const ra = await h.request(A);
    const rb = await h.request(B);
    h.provider.defaultFor = () => okResult(RAW_KEY);
    // A 가 insert 하기 직전에 B 의 confirm 전체가 끼어든다 (두 요청 모두 "identity 없음" 을 보고 created 로 판단한 상황)
    let bRes: VerifyResponse | null = null;
    h.db.before.insertIdentity = async () => {
      bRes = await h.confirm(B, rb.body.requestId);
    };
    const aRes = record(await h.confirm(A, ra.body.requestId));
    eq('끼어든 B 는 created', record(bRes!).body, { verified: true, result: 'created', ageVerified: true });
    eq('A 의 insert 는 UNIQUE 충돌 → 재조회 → existing_account', aRes.body, { verified: false, result: 'existing_account', maskedPhone: '010-****-0002' });
    eq('identity 1행 (B) · A 는 인증 완료 아님', [h.db.identities.length, h.db.identities[0].userId, h.db.users.get(A)!.identityVerified, h.db.users.get(B)!.identityVerified], [1, B, false, true]);
    eq('A 세션은 existing_account (복구 가능)', [h.db.sessions.get(String(ra.body.requestId))!.status, h.db.sessions.get(String(ra.body.requestId))!.ownerUserId], ['existing_account', B]);
  }

  // ── 4b. 삭제된 계정의 identity 재연결 경쟁 (relinked 경쟁) — 결함 재현: 0행 갱신을 성공으로 보면 두 계정이 인증 완료가 된다 ──
  {
    const h = harness();
    h.auth.add(A, PHONE_A);
    h.auth.add(B, PHONE_B);
    h.db.identities.push({ id: h.db.uuid(), userId: null, hash: hashA, banned: false, birthDate: null, gender: null, verifiedAt: null }); // hard delete 뒤 남은 identity
    const ra = await h.request(A);
    const rb = await h.request(B);
    h.provider.defaultFor = () => okResult(RAW_KEY);
    let bRes: VerifyResponse | null = null;
    h.db.before.relinkIdentity = async () => {
      bRes = await h.confirm(B, rb.body.requestId);
    };
    const aRes = record(await h.confirm(A, ra.body.requestId));
    eq('끼어든 B 는 relinked', record(bRes!).body, { verified: true, result: 'relinked', ageVerified: true });
    eq('A 의 relink 는 0행 → 재조회 → existing_account', aRes.body, { verified: false, result: 'existing_account', maskedPhone: '010-****-0002' });
    eq('두 active 계정이 같은 identity 로 인증 완료되지 않는다', [h.db.identities.length, h.db.identities[0].userId, h.db.users.get(A)!.identityVerified, h.db.users.get(B)!.identityVerified], [1, B, false, true]);
  }

  // ── 5. 탈퇴 계정: 유예 중 복구 · 익명화 뒤 재연결(처음부터) · hard delete 뒤 재가입(relinked) ───────────
  {
    const h = harness();
    h.auth.add(A, PHONE_A);
    h.auth.add(B, PHONE_B);
    await h.verify(A, okResult(RAW_KEY));
    h.db.setStatus(A, 'deleted'); // 유예 중 (identity 는 A 에 연결된 채)
    const f1 = await h.verify(B, okResult(RAW_KEY));
    eq('유예 중 탈퇴 계정 → existing_account (새 계정 만들지 않음)', record(f1.res).body.result, 'existing_account');
    eq('recover → 기존 계정 재활성화', [record(await h.recover(B, f1.requestId)).body.recovered, h.db.users.get(A)!.status, h.db.users.get(A)!.phone], [true, 'active', PHONE_B]);

    // 익명화 뒤 (account_purge: identity 행은 user_id 유지·생년월일 등 null, users 스켈레톤·플래그 초기화)
    h.db.setStatus(A, 'deleted');
    const uA = h.db.users.get(A)!;
    uA.identityVerified = false;
    uA.ageVerified = false;
    uA.purgedAt = '2026-08-01T00:00:00.000Z';
    h.db.identities[0].birthDate = null;
    h.db.identities[0].gender = null;
    h.auth.add(C, PHONE_C);
    const f2 = await h.verify(C, okResult(RAW_KEY));
    eq('익명화된 계정도 identity 가 연결돼 있으면 existing_account (재연결 → 처음부터)', record(f2.res).body.result, 'existing_account');
    eq('recover → 스켈레톤 계정 active', [record(await h.recover(C, f2.requestId)).body.recovered, h.db.users.get(A)!.status, h.db.users.get(A)!.phone, h.db.users.has(C)], [true, 'active', PHONE_C, false]);

    // hard delete 뒤 (auth 삭제 → users 삭제 → identity.user_id null)
    h.auth.deleteUser(A);
    eq('hard delete 뒤 identity 는 user_id null 로 남는다', [h.db.identities.length, h.db.identities[0].userId], [1, null]);
    const D = 'dddddddd-0000-4000-8000-000000000004';
    h.auth.add(D, '+821012340004');
    const f3 = await h.verify(D, okResult(RAW_KEY, '1996-05-15', 'female'));
    eq('hard delete 뒤 재가입 → relinked (identity 1행 유지)', [record(f3.res).body, h.db.identities.length, h.db.identities[0].userId, h.db.identities[0].birthDate], [{ verified: true, result: 'relinked', ageVerified: true }, 1, D, '1996-05-15']);
  }

  // ── 6. 영구정지 identity 는 번호를 바꿔도 우회할 수 없다 ───────────────────────────────────────
  {
    const h = harness();
    h.auth.add(A, PHONE_A);
    h.auth.add(B, PHONE_B);
    await h.verify(A, okResult(RAW_KEY));
    h.db.setStatus(A, 'banned');
    const r1 = await h.verify(B, okResult(RAW_KEY));
    eq('banned identity + 새 번호 → blocked', record(r1.res).body, { verified: false, result: 'blocked', reason: 'blocked' });
    eq('banned_identity_attempt 이벤트 · B 미인증 · identity 1행', [h.db.events.filter((e) => e.type === 'banned_identity_attempt').length, h.db.users.get(B)!.identityVerified, h.db.identities.length], [1, false, 1]);
    eq('blocked 세션으로 recover 불가', record(await h.recover(B, r1.requestId)).body.error, 'not_recoverable');
    // 차단된 계정을 hard delete 해도 identity 의 banned 는 남는다
    h.auth.deleteUser(A);
    eq('hard delete 뒤에도 banned 유지', [h.db.identities[0].userId, h.db.identities[0].banned], [null, true]);
    eq('삭제된 banned identity 로 재가입 → blocked', record((await h.verify(B, okResult(RAW_KEY))).res).body.result, 'blocked');
    // 동기화 누락 대비: users.status 만 banned
    const h2 = harness();
    h2.auth.add(A, PHONE_A);
    h2.auth.add(B, PHONE_B);
    await h2.verify(A, okResult(RAW_KEY));
    h2.db.users.get(A)!.status = 'banned'; // 트리거 없이 status 만
    eq('users.status=banned 만으로도 blocked', record((await h2.verify(B, okResult(RAW_KEY))).res).body.result, 'blocked');
  }

  // ── 7. 미성년자 차단 — 기존 정책(만 19세)·고정 시계·Provider 생년월일 기준 ─────────────────────
  {
    const h = harness();
    h.auth.add(A, PHONE_A);
    // 클라이언트는 성인 생년월일을 보냈지만 Provider 결과는 미성년 → 차단 (Provider 값이 이긴다)
    const minor = await h.verify(A, okResult(RAW_KEY, '2007-09-17'));
    eq('만 19세 하루 전 → underage', record(minor.res).body, { verified: false, result: 'underage', reason: 'underage' });
    eq('미성년: identity·플래그·프로필 없음, 세션 completed/underage', [h.db.identities.length, h.db.users.get(A)!.identityVerified, h.db.privateProfiles.size, h.db.sessions.get(minor.requestId)!.outcome], [0, false, 0, 'underage']);
    const adult = await h.verify(A, okResult(RAW_KEY, '2007-09-16'));
    eq('만 19세 생일 당일 → 성인', record(adult.res).body.result, 'created');
    eq('저장된 생년월일은 Provider 값', h.db.identities[0].birthDate, '2007-09-16');
  }

  // ── 8. 인증 취소·실패·만료·네트워크 오류 — 어느 것도 성공이 되지 않는다 ───────────────────────
  {
    const h = harness();
    h.auth.add(A, PHONE_A);
    const r = await h.request(A);
    const id = String(r.body.requestId);
    for (let i = 1; i < DEFAULT_MAX_ATTEMPTS; i += 1) {
      h.provider.queue.push({ verified: false, reason: 'invalid_code' });
      const f = record(await h.confirm(A, id));
      eq(`틀린 코드 ${i}회 → failed/invalid_code, 세션 pending 유지`, [f.body, h.db.sessions.get(id)!.status, h.db.sessions.get(id)!.attempts], [{ verified: false, result: 'failed', reason: 'invalid_code' }, 'pending', i]);
    }
    h.provider.queue.push({ verified: false, reason: 'invalid_code' });
    const last = record(await h.confirm(A, id));
    eq('5회째 → too_many_attempts, 세션 failed', [last.body.reason, h.db.sessions.get(id)!.status], ['too_many_attempts', 'failed']);
    h.provider.queue.push(okResult(RAW_KEY));
    const dead = record(await h.confirm(A, id));
    eq('failed 세션은 맞는 코드로도 진행 불가 (Provider 미호출)', [dead.status, dead.body.error, h.provider.queue.length], [400, 'too_many_attempts', 1]);
    h.provider.queue.length = 0;
    eq('verification_failure 이벤트 5건, 사유 코드만', h.db.events.filter((e) => e.type === 'verification_failure').length, 5);

    // 취소
    const r2 = await h.request(A);
    h.provider.queue.push({ verified: false, reason: 'cancelled' });
    eq('취소 → failed/cancelled, 세션 failed', [record(await h.confirm(A, r2.body.requestId)).body, h.db.sessions.get(String(r2.body.requestId))!.status], [{ verified: false, result: 'failed', reason: 'cancelled' }, 'failed']);
    // Provider 만료
    const r3 = await h.request(A);
    h.provider.queue.push({ verified: false, reason: 'expired' });
    eq('Provider 만료 → failed/expired, 세션 expired', [record(await h.confirm(A, r3.body.requestId)).body.reason, h.db.sessions.get(String(r3.body.requestId))!.status], ['expired', 'expired']);
    // 서버 세션 TTL 만료 (고정 시계)
    const r4 = await h.request(A);
    h.clock.now = new Date('2026-09-16T09:10:00.000Z');
    const exp = record(await h.confirm(A, r4.body.requestId));
    eq('10분 지난 세션 → session_expired (Provider 미호출)', [exp.status, exp.body.error, h.db.sessions.get(String(r4.body.requestId))!.status, h.provider.resultCalls.length], [400, 'session_expired', 'expired', 7]);
    h.clock.now = new Date(NOW);
    // 네트워크 오류 → 503, 세션은 pending 으로 복귀 → 재시도 성공
    const r5 = await h.request(A);
    h.provider.queue.push({ throw: true });
    const net = record(await h.confirm(A, r5.body.requestId));
    eq('Provider 오류 → 503 provider_unavailable, 세션 pending 복귀', [net.status, net.body.error, h.db.sessions.get(String(r5.body.requestId))!.status, h.db.sessions.get(String(r5.body.requestId))!.checkingSince], [503, 'provider_unavailable', 'pending', null]);
    h.provider.queue.push(okResult(RAW_KEY));
    eq('오류 뒤 재시도는 성공', record(await h.confirm(A, r5.body.requestId)).body.result, 'created');
    // Provider 가 준 실패 사유에 문장/개인정보가 섞이면 코드로 정리
    const r6 = await h.request(A);
    h.provider.queue.push({ verified: false, reason: `user ${CLIENT_NAME} 010-1234-0001 mismatch` });
    eq('비정형 사유는 failed 로 정리', record(await h.confirm(A, r6.body.requestId)).body.reason, 'failed');
    // Provider 결과가 불완전(생년월일 없음)하면 성공 처리하지 않는다
    const r7 = await h.request(A);
    h.provider.queue.push({ verified: true, identityKey: 'x', birthDate: '', verifiedAt: '' });
    eq('불완전한 Provider 결과 → 502', [record(await h.confirm(A, r7.body.requestId)).status, h.db.sessions.get(String(r7.body.requestId))!.status], [502, 'failed']);
    // request 단계 Provider 오류 → 503, 세션 없음
    h.provider.startThrows = true;
    const r8 = record(await h.request(A));
    eq('request 단계 Provider 오류 → 503', [r8.status, r8.body.error], [503, 'provider_unavailable']);
    eq('입력 형식 오류 → 400', record(await runVerifyIdentity({ userId: A, action: 'request', name: '', birthDate: '19960515' }, h.deps)).body.error, 'invalid_input');
    eq('알 수 없는 action → 400', record(await runVerifyIdentity({ userId: A, action: 'hack' }, h.deps)).body.error, 'unknown_action');
    eq('uuid 아닌 requestId → invalid_session', record(await h.confirm(A, 'prov-1')).body.error, 'invalid_session');
  }

  // ── 9. 다른 사용자의 인증 세션 사용 — 존재 여부와 무관하게 invalid_session, Provider 미호출 ──────
  {
    const h = harness();
    h.auth.add(A, PHONE_A);
    h.auth.add(C, PHONE_C);
    const r = await h.request(A);
    const stolen = record(await h.confirm(C, r.body.requestId));
    eq('타인 세션 confirm → 400 invalid_session', [stolen.status, stolen.body.error], [400, 'invalid_session']);
    eq('Provider 미호출 · 세션 pending 그대로', [h.provider.resultCalls.length, h.db.sessions.get(String(r.body.requestId))!.status], [0, 'pending']);
    eq('없는 세션도 같은 응답', record(await h.confirm(C, '00000000-0000-4000-8000-999999999999')).body.error, 'invalid_session');
    eq('세션 오용 이벤트 (C, 사유 코드)', h.db.events.map((e) => [e.userId, e.type, e.meta.reason]), [[C, 'verification_failure', 'session_not_owned']]);
  }

  // ── 10b. 같은 세션의 동시 confirm — 하나만 Provider 에 닿고, 나머지는 409 · 죽은 점유는 lease 뒤 재점유 ──
  {
    const h = harness({ checkingLeaseSeconds: 120 });
    h.auth.add(A, PHONE_A);
    const r = await h.request(A);
    const id = String(r.body.requestId);
    h.provider.queue.push({ delayMs: 30, then: okResult(RAW_KEY) });
    const first = h.confirm(A, id);
    await new Promise((res) => setTimeout(res, 5));
    const second = record(await h.confirm(A, id));
    eq('동시 confirm 두 번째 → 409 session_in_progress', [second.status, second.body.error], [409, 'session_in_progress']);
    eq('첫 번째는 정상 완료', record(await first).body.result, 'created');
    eq('Provider 는 1회만', h.provider.resultCalls.length, 1);
    // 죽은 점유: checking 인 채 lease 가 지나면 다시 점유할 수 있다
    const r2 = await h.request(A);
    const s2 = h.db.sessions.get(String(r2.body.requestId))!;
    s2.status = 'checking';
    s2.checkingSince = '2026-09-16T08:57:59.000Z'; // 121초 전
    h.provider.queue.push(okResult(RAW_KEY));
    eq('lease 지난 checking 세션은 재점유돼 진행된다', record(await h.confirm(A, r2.body.requestId)).body.result, 'already_verified');
    const r3 = await h.request(A);
    const s3 = h.db.sessions.get(String(r3.body.requestId))!;
    s3.status = 'checking';
    s3.checkingSince = '2026-09-16T08:59:00.000Z'; // 60초 전
    eq('lease 안의 checking 세션은 409', record(await h.confirm(A, r3.body.requestId)).status, 409);
  }

  // ── 11. 중간 실패와 재시도 — Auth 와 DB 사이의 부분 실패 ──────────────────────────────────────
  {
    // (a) 복구: 새 계정 삭제 실패 → 아무것도 바뀌지 않고 세션은 다시 existing_account → 재시도 성공
    const h = harness();
    h.auth.add(A, PHONE_A);
    h.auth.add(B, PHONE_B);
    await h.verify(A, okResult(RAW_KEY));
    const found = await h.verify(B, okResult(RAW_KEY));
    h.auth.failOnce.add('deleteUser');
    const f = record(await h.recover(B, found.requestId));
    eq('삭제 실패 → 500 recover_failed', [f.status, f.body.error], [500, 'recover_failed']);
    eq('상태 불변 (B 존재 · A 번호 그대로 · 세션 existing_account)', [h.auth.users.has(B), h.auth.users.get(A)!.phoneE164, h.db.sessions.get(found.requestId)!.status], [true, PHONE_A, 'existing_account']);
    eq('실패 이벤트 단계 기록', h.db.events.filter((e) => e.type === 'account_recovery').map((e) => [e.meta.ok, e.meta.stage]), [[false, 'delete_new_account']]);
    eq('재시도 성공', record(await h.recover(B, found.requestId)).body, { recovered: true });

    // (b) 복구: 번호 이동 실패 → 새 계정은 없고 기존 계정은 그대로 → 재로그인(새 계정) → 재인증 → 복구
    const h2 = harness();
    h2.auth.add(A, PHONE_A);
    h2.auth.add(B, PHONE_B);
    await h2.verify(A, okResult(RAW_KEY));
    const found2 = await h2.verify(B, okResult(RAW_KEY));
    h2.auth.failOnce.add('updateUserPhone');
    const f2 = record(await h2.recover(B, found2.requestId));
    eq('번호 이동 실패 → 500', [f2.status, f2.body.error], [500, 'recover_failed']);
    eq('일관된 중간 상태: B 삭제됨 · A 번호/identity 그대로 · B 세션 없음', [h2.auth.users.has(B), h2.auth.users.get(A)!.phoneE164, h2.db.identities[0].userId, h2.db.sessions.has(found2.requestId), h2.db.users.get(A)!.status], [false, PHONE_A, A, false, 'active']);
    // 같은 번호로 다시 로그인하면 새 auth 계정이 생긴다 (번호는 해제돼 있다)
    const B2 = 'bbbbbbbb-0000-4000-8000-000000000022';
    h2.auth.add(B2, PHONE_B);
    const found3 = await h2.verify(B2, okResult(RAW_KEY));
    eq('재로그인 뒤 재인증 → existing_account', found3.res.body.result, 'existing_account');
    eq('재복구 성공 → A 에 번호 연결', [record(await h2.recover(B2, found3.requestId)).body.recovered, h2.auth.users.get(A)!.phoneE164, h2.auth.users.has(B2)], [true, PHONE_B, false]);

    // (c) confirm: identity 는 들어갔는데 users 플래그 갱신 실패 → 500, 세션 pending → 재시도하면 already_verified 로 플래그 완성
    const h3 = harness();
    h3.auth.add(A, PHONE_A);
    const r = await h3.request(A);
    h3.provider.queue.push(okResult(RAW_KEY));
    h3.db.failOnce.add('markUserVerified');
    const f3 = record(await h3.confirm(A, r.body.requestId));
    eq('플래그 갱신 실패 → 500 update_failed, identity 는 있음, 플래그 없음, 세션 pending', [f3.status, h3.db.identities.length, h3.db.users.get(A)!.identityVerified, h3.db.sessions.get(String(r.body.requestId))!.status], [500, 1, false, 'pending']);
    h3.provider.queue.push(okResult(RAW_KEY));
    const retry = record(await h3.confirm(A, r.body.requestId));
    eq('재시도 → already_verified + 플래그 완성 (identity 1행)', [retry.body.result, h3.db.users.get(A)!.identityVerified, h3.db.identities.length, h3.db.privateProfiles.get(A)?.birthDate], ['already_verified', true, 1, '1996-05-15']);

    // (d) confirm: private_profiles 실패 → 500, 재시도 성공
    const h4 = harness();
    h4.auth.add(A, PHONE_A);
    const r4 = await h4.request(A);
    h4.provider.queue.push(okResult(RAW_KEY));
    h4.db.failOnce.add('upsertPrivateProfile');
    eq('프로필 저장 실패 → 500', record(await h4.confirm(A, r4.body.requestId)).status, 500);
    h4.provider.queue.push(okResult(RAW_KEY));
    eq('재시도 → 완료', [record(await h4.confirm(A, r4.body.requestId)).body.result, h4.db.privateProfiles.has(A)], ['already_verified', true]);

    // (e) identity insert 오류(UNIQUE 아님) → 500, 세션 pending
    const h5 = harness();
    h5.auth.add(A, PHONE_A);
    const r5 = await h5.request(A);
    h5.provider.queue.push(okResult(RAW_KEY));
    h5.db.failOnce.add('insertIdentity');
    eq('identity 저장 오류 → 500, 플래그 없음', [record(await h5.confirm(A, r5.body.requestId)).status, h5.db.users.get(A)!.identityVerified, h5.db.sessions.get(String(r5.body.requestId))!.status], [500, false, 'pending']);

    // (f) 세션 생성 실패 → 500 (Provider 세션만 열리고 서버 세션이 없으면 confirm 할 수 없다)
    const h6 = harness();
    h6.auth.add(A, PHONE_A);
    h6.db.failOnce.add('createSession');
    eq('세션 생성 실패 → 500', record(await h6.request(A)).status, 500);
  }

  // ── 12. 전화번호 없는 로그인(개발/이메일)도 가입은 되지만 복구는 안 된다 ─────────────────────────
  {
    const h = harness();
    const E = 'eeeeeeee-0000-4000-8000-000000000005';
    h.auth.add(E, null, false);
    const r = await h.verify(E, okResult(RAW_KEY));
    eq('번호 없는 계정 가입 → created, 프로필 phone null', [record(r.res).body.result, h.db.privateProfiles.get(E)?.phone], ['created', null]);
    eq('없는 auth 사용자 → 401', record(await h.request('ffffffff-0000-4000-8000-000000000006')).status, 401);
  }

  // ── 14. 개인정보 비노출 — 응답·이벤트·콘솔 어디에도 raw identityKey · 인증번호 · 전화번호 전체 · 이름이 없다 ──
  {
    const blob = JSON.stringify(everything);
    ok('응답에 raw identityKey 없음', !blob.includes(RAW_KEY));
    ok('응답에 인증번호 없음', !blob.includes(CODE));
    ok('응답에 전화번호 전체 없음', !/\+8210\d{8}|010\d{8}|010-\d{4}-\d{4}/.test(blob));
    ok('응답에 이름 없음', !blob.includes(CLIENT_NAME));
    ok('응답에 provider 세션 id 없음', !/prov-\d/.test(blob));
    const logs = consoleLogs.join('\n');
    ok('코어는 콘솔에 아무것도 남기지 않는다', logs.length === 0);
  }

  // ── 15. 테스트 Provider 는 production factory 에서 선택될 수 없다 ────────────────────────────
  {
    let threw = false;
    try {
      getIdentityProvider('test');
    } catch {
      threw = true;
    }
    ok("getIdentityProvider('test') 는 실패한다", threw);
    ok("getIdentityProvider('mock') 은 Mock", getIdentityProvider('mock').constructor.name === 'MockIdentityProvider');
  }

  console.log(`verify-identity selftest: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
};

main().catch((e) => {
  console.error('FAIL selftest crashed:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
