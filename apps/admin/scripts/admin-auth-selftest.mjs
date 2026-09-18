/**
 * 관리자 계정·MFA·역할·세션 흐름 selftest (#27) — Node 로 실행 (Next·Supabase 불필요).
 *   cd apps/admin && node --experimental-strip-types scripts/admin-auth-selftest.mjs
 *
 * adminAuthCore 에 가짜 Provider(GoTrue 흉내: 비밀번호·factor·challenge/verify·aal) 와 가짜 Directory(0033 RPC 규칙 흉내)를 주입해
 * 로그인 → MFA 등록/검증 → 세션 → 역할 → 강등/비활성화/취소 → 재인증 → 구 로그인 게이트를 검증한다.
 * 실제 GoTrue·DB 는 여기서 검증하지 않는다 (DB RPC 는 supabase/tests/admin_accounts_tests.sql · 로컬 Auth 통합은 미실행 — docs/security.md).
 */
import {
  ADMIN_PENDING_TTL_SECONDS,
  ADMIN_SESSION_TTL_SECONDS,
  guardKey,
  hasRole,
  issueToken,
  legacyLoginAllowed,
  maskCode,
  maskContact,
  maskEmail,
  pendingToken,
  resolveSession,
  runChangePassword,
  runLegacyLogin,
  runMfaEnrollStart,
  runMfaVerify,
  runPasswordLogin,
  runReauth,
  runSelfMfaReset,
  sessionToken,
  verifyToken,
} from '../lib/adminAuthCore.ts';
import { applyGuardEvent, LOGIN_LOCK_SECONDS, LOGIN_MAX_FAILURES } from '../lib/adminSessionCore.ts';

let passed = 0;
let failed = 0;
function check(name, ok) {
  if (ok) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
}

// 콘솔 캡처 — 코어/어댑터가 secret·코드·토큰을 출력하지 않는지
const captured = [];
for (const m of ['log', 'info', 'warn', 'error']) {
  const orig = console[m].bind(console);
  console[m] = (...a) => {
    const line = a.map(String).join(' ');
    if (line.startsWith('FAIL ') || line.startsWith('admin auth selftest')) orig(...a);
    else captured.push(line);
  };
}

const SECRET = 'admin-auth-selftest-secret-0123456789';
const OWNER = 'ad000000-0000-4000-8000-000000000001';
const VIEWER = 'ad000000-0000-4000-8000-000000000002';
const APPUSER = 'ad000000-0000-4000-8000-000000000009';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP-TEST-SECRET';
const GOOD_CODE = '123456';

// ---------------------------------------------------------------------------
// 가짜 GoTrue
// ---------------------------------------------------------------------------
class FakeProvider {
  constructor() {
    this.users = new Map(); // id → { email, password, factors: [{id, verified}], aal2Tokens: Set }
    this.tokens = new Map(); // accessToken → { userId, aal }
    this.seq = 0;
    this.down = false;
    this.signedOut = [];
    this.calls = [];
  }
  addUser(id, email, password, opts = {}) {
    this.users.set(id, { email, password, factors: opts.factor ? [{ id: `f-${id.slice(-4)}`, verified: true }] : [], deleted: false });
  }
  token(userId, aal) {
    this.seq += 1;
    const t = `tok-${aal}-${this.seq}-${userId.slice(-4)}`;
    this.tokens.set(t, { userId, aal });
    return t;
  }
  owner(tokens) {
    return this.tokens.get(tokens.accessToken) ?? null;
  }
  async signInWithPassword(email, password) {
    this.calls.push('signIn');
    if (this.down) return { ok: false, reason: 'unavailable' };
    for (const [id, u] of this.users) {
      if (u.email === email && u.password === password) return { ok: true, userId: id, tokens: { accessToken: this.token(id, 'aal1'), refreshToken: `rt-${this.seq}` } };
    }
    return { ok: false, reason: 'bad_credentials' };
  }
  async listFactors(tokens) {
    const o = this.owner(tokens);
    if (!o || this.down) return { ok: false };
    const u = this.users.get(o.userId);
    return { ok: true, verified: u.factors.filter((f) => f.verified).map((f) => f.id), unverified: u.factors.filter((f) => !f.verified).map((f) => f.id) };
  }
  async enrollTotp(tokens, name) {
    this.calls.push('enroll');
    const o = this.owner(tokens);
    if (!o || this.down) return { ok: false };
    const u = this.users.get(o.userId);
    this.seq += 1;
    const id = `f-new-${this.seq}`;
    u.factors.push({ id, verified: false });
    return { ok: true, factorId: id, qrCodeSvg: `data:image/svg+xml;utf-8,<svg>${TOTP_SECRET}</svg>`, secret: TOTP_SECRET, uri: `otpauth://totp/${name}?secret=${TOTP_SECRET}` };
  }
  async unenroll(tokens, factorId) {
    const o = this.owner(tokens);
    if (!o) return false;
    const u = this.users.get(o.userId);
    const f = u.factors.find((x) => x.id === factorId);
    if (!f) return false;
    if (f.verified && o.aal !== 'aal2') return false; // GoTrue: verified factor 해제는 aal2 필요
    u.factors = u.factors.filter((x) => x.id !== factorId);
    return true;
  }
  async challengeAndVerify(tokens, factorId, code) {
    this.calls.push('verify');
    const o = this.owner(tokens);
    if (!o || this.down) return { ok: false, reason: 'unavailable' };
    const u = this.users.get(o.userId);
    const f = u.factors.find((x) => x.id === factorId);
    if (!f || code !== GOOD_CODE) return { ok: false, reason: 'bad_code' };
    f.verified = true;
    return { ok: true, tokens: { accessToken: this.token(o.userId, 'aal2'), refreshToken: `rt-${this.seq}` } };
  }
  async assuranceLevel(accessToken) {
    if (this.down) return null;
    const o = this.tokens.get(accessToken);
    return o ? o.aal : null;
  }
  async updatePassword(tokens, newPassword) {
    const o = this.owner(tokens);
    if (!o || o.aal !== 'aal2') return { ok: false, reason: 'rejected' };
    this.users.get(o.userId).password = newPassword;
    return { ok: true };
  }
  async signOut(accessToken) {
    this.signedOut.push(accessToken);
    this.tokens.delete(accessToken);
  }
  async emailOf(userId) {
    return this.users.get(userId)?.email ?? null;
  }
  async createAdminUser(email, password) {
    this.seq += 1;
    const id = `ad000000-0000-4000-8000-0000000000${String(this.seq).padStart(2, '0')}`;
    this.addUser(id, email, password);
    return { ok: true, userId: id };
  }
  async deleteAllFactors(userId) {
    const u = this.users.get(userId);
    if (!u) return false;
    u.factors = [];
    return true;
  }
}

// ---------------------------------------------------------------------------
// 가짜 Directory (0033 RPC 규칙)
// ---------------------------------------------------------------------------
class FakeDirectory {
  constructor(clock) {
    this.clock = clock;
    this.members = new Map(); // userId → { role, status, displayName, mfaVerifiedAt, sessionsRevokedAt }
    this.sessions = new Map(); // sid → { userId, issuedAt, expiresAt, revokedAt }
    this.audits = [];
    this.guardState = new Map();
    this.down = false;
    this.seq = 0;
    const self = this;
    this.guard = {
      async hit(key, event) {
        if (self.down) return null;
        const r = applyGuardEvent(self.guardState.get(key), event, self.clock.now);
        if (r.next) self.guardState.set(key, r.next);
        else self.guardState.delete(key);
        return r.hit;
      },
    };
  }
  addMember(userId, role, displayName, status = 'active') {
    this.members.set(userId, { role, status, displayName, mfaVerifiedAt: null, sessionsRevokedAt: null });
  }
  async member(userId) {
    if (this.down) return 'unavailable';
    const m = this.members.get(userId);
    return m ? { role: m.role, status: m.status, displayName: m.displayName } : null;
  }
  async sessionIssue(userId, ttl) {
    if (this.down) return null;
    const m = this.members.get(userId);
    if (!m || m.status !== 'active') return null;
    this.seq += 1;
    const sid = `sid-${this.seq}`;
    this.sessions.set(sid, { userId, issuedAt: this.clock.now, expiresAt: this.clock.now + ttl * 1000, revokedAt: null });
    m.mfaVerifiedAt = m.mfaVerifiedAt ?? this.clock.now;
    return { sessionId: sid, role: m.role, displayName: m.displayName };
  }
  async sessionCheck(sid) {
    if (this.down) return null;
    const s = this.sessions.get(sid);
    if (!s || s.revokedAt || s.expiresAt <= this.clock.now) return { ok: false };
    const m = this.members.get(s.userId);
    if (!m || m.status !== 'active') return { ok: false };
    if (m.sessionsRevokedAt && s.issuedAt <= m.sessionsRevokedAt) return { ok: false };
    return { ok: true, userId: s.userId, role: m.role, displayName: m.displayName };
  }
  async sessionRevoke(sid) {
    const s = this.sessions.get(sid);
    if (!s || s.revokedAt) return false;
    s.revokedAt = this.clock.now;
    return true;
  }
  async revokeAllSessions(actor, target) {
    const m = this.members.get(target);
    if (!m) return false;
    m.sessionsRevokedAt = this.clock.now;
    for (const s of this.sessions.values()) if (s.userId === target && !s.revokedAt) s.revokedAt = this.clock.now;
    return true;
  }
  async legacyAllowed() {
    if (this.down) return null;
    for (const m of this.members.values()) if (m.mfaVerifiedAt) return false;
    return true;
  }
  async audit(actor, action, targetType, targetId, detail) {
    this.audits.push({ actor, action, targetType, targetId, detail });
  }
}

function harness(opts = {}) {
  const clock = { now: 1_800_000_000_000 };
  const provider = new FakeProvider();
  const directory = new FakeDirectory(clock);
  const deps = { provider, directory, secret: SECRET, now: () => clock.now, legacy: { enabled: false, password: undefined, ...opts.legacy } };
  provider.addUser(OWNER, 'owner@admin.test', 'owner-password-1234', { factor: true });
  provider.addUser(VIEWER, 'viewer@admin.test', 'viewer-password-1234', { factor: false });
  provider.addUser(APPUSER, 'appuser@example.com', 'app-user-password-1', { factor: false });
  directory.addMember(OWNER, 'owner', '운영자');
  directory.addMember(VIEWER, 'viewer', '열람자');
  return { clock, provider, directory, deps };
}

const everything = [];
const login = async (h, email, password) => {
  const r = await runPasswordLogin(h.deps, { email, password, clientIp: '1.2.3.4' });
  everything.push(r);
  return r;
};
const verify = async (h, pending, code = GOOD_CODE) => {
  const r = await runMfaVerify(h.deps, pending, code);
  everything.push(r);
  return r;
};

// ── 1. 정상 로그인 (등록된 factor) → verify → 세션 → 역할은 DB 에서 ─────────────────────────────
{
  const h = harness();
  const l = await login(h, 'owner@admin.test', 'owner-password-1234');
  check('owner 비밀번호 통과 → verify 단계', l.ok && l.next === 'verify');
  check('pending 토큰은 세션이 아니다 (resolveSession null)', (await resolveSession(h.deps, l.pending)) === null);
  check('pending 은 10분', verifyToken(SECRET, l.pending, h.clock.now).exp - verifyToken(SECRET, l.pending, h.clock.now).iat === ADMIN_PENDING_TTL_SECONDS);
  const bad = await verify(h, l.pending, '000000');
  check('틀린 코드 → bad_code, 세션 없음', !bad.ok && bad.reason === 'bad_code' && h.directory.sessions.size === 0);
  const v = await verify(h, l.pending);
  check('맞는 코드 → 세션 발급 + owner', v.ok && v.role === 'owner' && v.userId === OWNER);
  const s = await resolveSession(h.deps, v.session);
  check('resolveSession → actor = 불변 id, role = DB', s && s.actor === OWNER && s.role === 'owner' && s.displayName === '운영자' && !s.legacy);
  check('hasRole', hasRole(s, 'viewer') && hasRole(s, 'owner'));
  check('aal1 토큰(비밀번호만)은 서명 아웃됨', h.provider.signedOut.length >= 1);
  check('GoTrue 세션은 발급 뒤 정리 (우리 세션만 남는다)', [...h.provider.tokens.values()].every((t) => t.aal !== 'aal2'));
  check('로그인 감사: actor = uuid, 이름은 detail', h.directory.audits.some((a) => a.action === 'admin_login' && a.actor === OWNER && a.detail.actor_name === '운영자'));
  check('mfa_verified_at 기록', h.directory.members.get(OWNER).mfaVerifiedAt !== null);

  // 강등 → 같은 쿠키가 즉시 viewer
  h.directory.members.get(OWNER).role = 'viewer';
  const s2 = await resolveSession(h.deps, v.session);
  check('강등이 기존 세션에 즉시 반영', s2 && s2.role === 'viewer' && !hasRole(s2, 'owner'));
  // 비활성화 → 거부
  h.directory.members.get(OWNER).status = 'disabled';
  check('비활성화 → 기존 세션 거부', (await resolveSession(h.deps, v.session)) === null);
  h.directory.members.get(OWNER).status = 'active';
  h.directory.members.get(OWNER).role = 'owner';
  // 세션 취소 → 거부
  await h.directory.revokeAllSessions(OWNER, OWNER);
  check('세션 취소 → 기존 세션 거부', (await resolveSession(h.deps, v.session)) === null);
  // 만료
  const v2 = await verify(h, (await login(h, 'owner@admin.test', 'owner-password-1234')).pending);
  h.clock.now += (ADMIN_SESSION_TTL_SECONDS + 1) * 1000;
  check('만료된 세션 거부', (await resolveSession(h.deps, v2.session)) === null);
  h.clock.now -= (ADMIN_SESSION_TTL_SECONDS + 1) * 1000;
  // DB 장애 → 거부
  h.directory.down = true;
  check('DB 장애 시 세션 거부 (허용으로 넘어가지 않음)', (await resolveSession(h.deps, v2.session)) === null);
  h.directory.down = false;
}

// ── 2. 등록 흐름 (factor 없음) → enroll → verify ────────────────────────────────────────────────
{
  const h = harness();
  const l = await login(h, 'viewer@admin.test', 'viewer-password-1234');
  check('factor 없는 계정 → enroll 단계', l.ok && l.next === 'enroll');
  const dead = await verify(h, l.pending);
  check('등록 전 verify 는 no_pending (factor 없음)', !dead.ok && dead.reason === 'no_pending');
  const e = await runMfaEnrollStart(h.deps, l.pending, '본심 Admin');
  everything.push({ ...e, secret: undefined, qrCodeSvg: undefined, uri: undefined });
  check('enroll 시작 → QR·secret 반환', e.ok && e.secret === TOTP_SECRET && e.qrCodeSvg.startsWith('data:image/svg+xml'));
  const e2 = await runMfaEnrollStart(h.deps, l.pending, '본심 Admin');
  check('재시작하면 unverified factor 는 정리되고 새 factor', e2.ok && h.provider.users.get(VIEWER).factors.length === 1);
  const bad = await verify(h, e2.pending, '999999');
  check('등록 코드 틀림 → bad_code, factor 미검증', !bad.ok && bad.reason === 'bad_code' && !h.provider.users.get(VIEWER).factors[0].verified);
  // 등록 화면(서버 컴포넌트 렌더)은 쿠키를 쓸 수 없어 factor id 를 폼으로 넘긴다 — fid 없는 pending + 폼 factor id 경로 (실제 Auth 통합에서 발견된 500 의 수정)
  const unverifiedId = h.provider.users.get(VIEWER).factors[0].id;
  check('fid 없는 pending + 폼 factor id 없음 → no_pending', (await runMfaVerify(h.deps, l.pending, GOOD_CODE)).reason === 'no_pending');
  check('fid 없는 pending + 모르는 factor id → no_pending (GoTrue 호출 없음)', (await runMfaVerify(h.deps, l.pending, GOOD_CODE, 'f-not-mine')).reason === 'no_pending' && !h.provider.users.get(VIEWER).factors[0].verified);
  const vForm = await runMfaVerify(h.deps, l.pending, GOOD_CODE, unverifiedId);
  check('fid 없는 pending + 이 사용자의 미검증 factor id → verified + 세션', vForm.ok && vForm.role === 'viewer' && h.provider.users.get(VIEWER).factors[0].verified);
  check('검증된 factor id 를 폼으로 넘겨도 등록 경로로 쓸 수 없다 (no_pending)', (await runMfaVerify(h.deps, l.pending, GOOD_CODE, unverifiedId)).reason === 'no_pending');
  h.provider.users.get(VIEWER).factors[0].verified = false; // 아래 기존 흐름(쿠키 fid 경로) 계속
  h.directory.sessions.clear();
  const bad2 = await verify(h, e2.pending, '999999');
  check('pending 에 fid 가 있으면 폼 값은 무시된다 (틀린 코드 → bad_code)', !bad2.ok && bad2.reason === 'bad_code' && (await runMfaVerify(h.deps, e2.pending, '999999', 'f-other')).reason === 'bad_code');
  const v = await verify(h, e2.pending);
  check('등록 코드 맞음 → factor verified + 세션 (viewer)', v.ok && v.role === 'viewer' && h.provider.users.get(VIEWER).factors[0].verified);
  const s = await resolveSession(h.deps, v.session);
  check('viewer 는 owner 권한 없음', s && hasRole(s, 'viewer') && !hasRole(s, 'owner'));
  // 이미 등록된 계정은 login 목적 enroll 불가 (verified factor 를 우회 등록으로 바꿀 수 없다)
  const l2 = await login(h, 'viewer@admin.test', 'viewer-password-1234');
  const e3 = await runMfaEnrollStart(h.deps, l2.pending, 'x');
  check('등록된 계정의 login-pending 으로 enroll 불가', !e3.ok && e3.reason === 'already_enrolled');
  // pending 만료
  h.clock.now += (ADMIN_PENDING_TTL_SECONDS + 1) * 1000;
  check('만료된 pending → no_pending', (await verify(h, l2.pending)).reason === 'no_pending');
  h.clock.now -= (ADMIN_PENDING_TTL_SECONDS + 1) * 1000;
}

// ── 3. 접근 차단: 비관리자·미로그인·metadata/role 위조·비활성 계정 ──────────────────────────────
{
  const h = harness();
  const app = await login(h, 'appuser@example.com', 'app-user-password-1');
  check('앱 사용자(Auth 계정 있음, membership 없음) → bad_credentials (구분 불가)', !app.ok && app.reason === 'bad_credentials');
  check('비관리자 로그인은 실패로 집계·감사', h.directory.audits.some((a) => a.action === 'admin_login_not_member') && h.directory.guardState.size === 2);
  check('비관리자의 aal1 토큰은 즉시 서명 아웃', h.provider.signedOut.length === 1);
  const none = await login(h, 'nobody@example.com', 'x-password-000000');
  check('없는 계정 → bad_credentials', !none.ok && none.reason === 'bad_credentials');
  check('미로그인(쿠키 없음) → null', (await resolveSession(h.deps, undefined)) === null && (await resolveSession(h.deps, '')) === null);
  // 위조: 세션 id 를 지어내거나 role 을 쿠키에 넣어도 DB 가 결정한다
  const forged = issueToken(SECRET, { v: 2, k: 's', sid: 'sid-9999', iat: 1, exp: 9_999_999_999, nonce: 'n' });
  check('존재하지 않는 세션 id 서명 토큰 → 거부', (await resolveSession(h.deps, forged)) === null);
  const forgedRole = issueToken('wrong-secret-abcdefghijklmnop', { v: 2, k: 's', sid: 'sid-1', iat: 1, exp: 9_999_999_999, nonce: 'n', role: 'owner' });
  check('다른 키로 서명한 토큰 → 거부', (await resolveSession(h.deps, forgedRole)) === null);
  const v = await verify(h, (await login(h, 'viewer@admin.test', 'viewer-password-1234')).pending);
  // viewer 가 등록 중이라 factor 없음 → enroll 필요
  check('viewer 는 등록 전에는 세션이 없다', !v.ok && v.reason === 'no_pending');
  const e = await runMfaEnrollStart(h.deps, (await login(h, 'viewer@admin.test', 'viewer-password-1234')).pending, 'x');
  const vv = await verify(h, e.pending);
  const t = verifyToken(SECRET, vv.session, h.clock.now);
  const tampered = issueToken(SECRET, { ...t, role: 'owner' }); // 토큰에 role 을 끼워 넣어도
  const s = await resolveSession(h.deps, tampered);
  check('쿠키에 role 을 넣어도 DB 역할(viewer)', s && s.role === 'viewer');
  // 비활성 계정
  h.directory.members.get(OWNER).status = 'disabled';
  const dis = await login(h, 'owner@admin.test', 'owner-password-1234');
  check('비활성 계정 → disabled, 토큰 서명 아웃', !dis.ok && dis.reason === 'disabled');
  h.directory.members.get(OWNER).status = 'active';
  // pending 상태에서 verify 도중 비활성화되면 세션 없음
  const l = await login(h, 'owner@admin.test', 'owner-password-1234');
  h.directory.members.get(OWNER).status = 'disabled';
  const dv = await verify(h, l.pending);
  check('MFA 통과 직전에 비활성화 → not_active', !dv.ok && dv.reason === 'not_active');
  h.directory.members.get(OWNER).status = 'active';
}

// ── 4. MFA 완료 판단은 서버가 확인한 aal ──────────────────────────────────────────────────────
{
  const h = harness();
  const l = await login(h, 'owner@admin.test', 'owner-password-1234');
  const origAal = h.provider.assuranceLevel.bind(h.provider);
  h.provider.assuranceLevel = async () => 'aal1'; // Provider 가 verify 는 성공시켰지만 aal 이 올라가지 않은 상황
  const v = await verify(h, l.pending);
  check('aal2 가 확인되지 않으면 세션 없음', !v.ok && v.reason === 'not_aal2' && h.directory.sessions.size === 0);
  h.provider.assuranceLevel = async () => null;
  const l2 = await login(h, 'owner@admin.test', 'owner-password-1234');
  const v2 = await verify(h, l2.pending);
  check('aal 조회 실패 → unavailable (허용 아님)', !v2.ok && v2.reason === 'unavailable');
  h.provider.assuranceLevel = origAal;
}

// ── 5. 실패 횟수 제한 — 비밀번호(IP·계정 키) · MFA 코드 ─────────────────────────────────────
{
  const h = harness();
  const results = [];
  for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) results.push((await login(h, 'owner@admin.test', 'wrong-password-000')).reason);
  check('비밀번호 5회 실패 → 마지막은 locked', results.slice(0, 4).every((r) => r === 'bad_credentials') && results[4] === 'locked');
  const lockedOk = await login(h, 'owner@admin.test', 'owner-password-1234');
  check('잠금 중 올바른 비밀번호도 거부 · Provider 미호출', !lockedOk.ok && lockedOk.reason === 'locked' && h.provider.calls.filter((c) => c === 'signIn').length === 5);
  const other = await runPasswordLogin(h.deps, { email: 'owner@admin.test', password: 'owner-password-1234', clientIp: '9.9.9.9' });
  check('다른 IP 라도 계정 키가 잠겨 있으면 거부', !other.ok && other.reason === 'locked');
  h.clock.now += (LOGIN_LOCK_SECONDS + 1) * 1000;
  const after = await login(h, 'owner@admin.test', 'owner-password-1234');
  check('잠금 만료 뒤 성공', after.ok);
  // MFA 코드 5회 실패 → 잠금
  const mfa = [];
  for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) mfa.push((await verify(h, after.pending, '000000')).reason);
  check('MFA 5회 실패 → locked', mfa.slice(0, 4).every((r) => r === 'bad_code') && mfa[4] === 'locked');
  const lockedGood = await verify(h, after.pending);
  check('MFA 잠금 중 맞는 코드도 거부', !lockedGood.ok && lockedGood.reason === 'locked');
  check('MFA 실패·잠금 감사', h.directory.audits.some((a) => a.action === 'admin_mfa_locked') && h.directory.audits.filter((a) => a.action === 'admin_mfa_failed').length === 4);
  // targetId 의 HMAC 키(hex)에 '000000' 이 우연히 들어갈 수 있으므로 코드·비밀번호가 실릴 수 있는 detail 과 action 만 본다
  const auditText = JSON.stringify(h.directory.audits.map((a) => [a.action, a.detail]));
  check('감사 기록에 코드·비밀번호 값 없음', !auditText.includes('000000') && !auditText.includes('owner-password-1234') && !auditText.includes('wrong-password'));
  // 제한 저장소 장애 → 로그인/MFA 모두 unavailable
  const h2 = harness();
  h2.directory.down = true;
  check('제한 저장소 장애 → 비밀번호 로그인 unavailable', (await login(h2, 'owner@admin.test', 'owner-password-1234')).reason === 'unavailable');
  h2.directory.down = false;
  const l = await login(h2, 'owner@admin.test', 'owner-password-1234');
  h2.directory.down = true;
  check('제한 저장소 장애 → MFA unavailable (세션 없음)', (await verify(h2, l.pending)).reason === 'unavailable' && h2.directory.sessions.size === 0);
  h2.directory.down = false;
  // Auth 장애 → unavailable, 실패로 세지 않음
  const h3 = harness();
  h3.provider.down = true;
  const d = await login(h3, 'owner@admin.test', 'owner-password-1234');
  check('Auth 장애 → unavailable · 실패 카운트 없음', d.reason === 'unavailable' && h3.directory.guardState.size === 0);
  // 동시 MFA 시도: 맞는 코드 두 번 동시에 → 세션은 하나씩 발급되지만 둘 다 같은 사용자 (중복 세션은 허용, 잠금은 정확)
  const h4 = harness();
  const l4 = await login(h4, 'owner@admin.test', 'owner-password-1234');
  const both = await Promise.all([verify(h4, l4.pending), verify(h4, l4.pending, '000000'), verify(h4, l4.pending, '000000')]);
  check('동시 요청: 성공 1 · 실패 2 · 실패 카운트 정확', both.filter((r) => r.ok).length === 1 && (h4.directory.guardState.get(guardKey(SECRET, 'mfa', OWNER))?.failures ?? 0) <= 2);
}

// ── 6. 재인증이 필요한 조치: 비밀번호 변경 · 본인 MFA 재등록 ────────────────────────────────
{
  const h = harness();
  const v = await verify(h, (await login(h, 'owner@admin.test', 'owner-password-1234')).pending);
  const s = await resolveSession(h.deps, v.session);
  const badPw = await runChangePassword(h.deps, s, { password: 'wrong-password-000', code: GOOD_CODE, newPassword: 'new-password-abcdef', clientIp: '1.2.3.4' });
  check('비밀번호 변경: 현재 비밀번호 틀림 → 거부', !badPw.ok && badPw.reason === 'bad_credentials' && h.provider.users.get(OWNER).password === 'owner-password-1234');
  const badCode = await runChangePassword(h.deps, s, { password: 'owner-password-1234', code: '000000', newPassword: 'new-password-abcdef', clientIp: '1.2.3.4' });
  check('비밀번호 변경: 코드 틀림 → 거부', !badCode.ok && badCode.reason === 'bad_credentials');
  const weak = await runChangePassword(h.deps, s, { password: 'owner-password-1234', code: GOOD_CODE, newPassword: 'short', clientIp: '1.2.3.4' });
  check('짧은 새 비밀번호 거부', !weak.ok && weak.reason === 'weak_password');
  const ok = await runChangePassword(h.deps, s, { password: 'owner-password-1234', code: GOOD_CODE, newPassword: 'new-password-abcdef', clientIp: '1.2.3.4' });
  check('비밀번호 변경 성공 → 다른 세션 취소', ok.ok && h.provider.users.get(OWNER).password === 'new-password-abcdef' && (await resolveSession(h.deps, v.session)) === null);
  check('재인증 토큰은 정리됨', [...h.provider.tokens.values()].every((t) => t.aal !== 'aal2'));
  // MFA 재등록 (본인) — 취소 시각과 구분되게 시계를 진행
  h.clock.now += 1000;
  const v2 = await verify(h, (await login(h, 'owner@admin.test', 'new-password-abcdef')).pending);
  const s2 = await resolveSession(h.deps, v2.session);
  const r = await runSelfMfaReset(h.deps, s2, { password: 'new-password-abcdef', code: GOOD_CODE, clientIp: '1.2.3.4' });
  check('MFA 재등록: 재인증 뒤 factor 삭제 + reenroll pending', r.ok && h.provider.users.get(OWNER).factors.length === 0 && verifyToken(SECRET, r.pending, h.clock.now).purpose === 'reenroll');
  check('재등록 중 기존 세션은 취소', (await resolveSession(h.deps, v2.session)) === null);
  h.clock.now += 1000;
  const e = await runMfaEnrollStart(h.deps, r.pending, 'x');
  const v3 = await verify(h, e.pending);
  check('재등록 완료 → 새 세션', v3.ok && (await resolveSession(h.deps, v3.session)) !== null);
  // viewer 가 factor 없이 재인증 시도
  const hv = harness();
  hv.directory.members.get(VIEWER).mfaVerifiedAt = 1;
  const fakeSession = { actor: VIEWER, userId: VIEWER, role: 'viewer', displayName: '열람자', sessionId: 'x', legacy: false };
  const nf = await runReauth(hv.deps, fakeSession, 'viewer-password-1234', GOOD_CODE, '1.2.3.4');
  check('factor 없는 계정 재인증 → no_factor', !nf.ok && nf.reason === 'no_factor');
  // 구 로그인 세션은 재인증 불가
  const legacy = { actor: 'legacy:a', userId: null, role: 'owner', displayName: 'a', sessionId: null, legacy: true };
  check('legacy 세션은 비밀번호 변경 불가', !(await runChangePassword(hv.deps, legacy, { password: 'x', code: GOOD_CODE, newPassword: 'new-password-abcdef', clientIp: '1' })).ok);
}

// ── 7. 구 공유 비밀번호 로그인 게이트 — opt-in AND MFA 완료 멤버 없음 ──────────────────────────
{
  const h = harness({ legacy: { enabled: true, password: 'shared-password' } });
  check('MFA 완료 멤버 없음 + opt-in → 열림', await legacyLoginAllowed(h.deps));
  const bad = await runLegacyLogin(h.deps, { password: 'nope', actorName: '홍길동', clientIp: '1.2.3.4' });
  check('구 로그인 틀린 비밀번호', !bad.ok && bad.reason === 'bad_password');
  const ok = await runLegacyLogin(h.deps, { password: 'shared-password', actorName: '홍길동', clientIp: '1.2.3.4' });
  const ls = await resolveSession(h.deps, ok.token);
  check('구 로그인 세션: legacy owner, actor = legacy:이름', ok.ok && ls && ls.legacy && ls.role === 'owner' && ls.actor === 'legacy:홍길동' && ls.userId === null);
  // 첫 owner 가 MFA 로 로그인하면 → 게이트 닫힘 → 기존 legacy 쿠키도 즉시 무효
  await verify(h, (await login(h, 'owner@admin.test', 'owner-password-1234')).pending);
  check('MFA 완료 멤버 생기면 닫힘', !(await legacyLoginAllowed(h.deps)));
  check('닫힌 뒤 구 로그인 시도 → closed', (await runLegacyLogin(h.deps, { password: 'shared-password', actorName: 'x', clientIp: '1.2.3.4' })).reason === 'closed');
  check('닫힌 뒤 기존 legacy 쿠키 무효', (await resolveSession(h.deps, ok.token)) === null);
  // opt-in 없으면 닫힘, DB 장애면 닫힘
  const h2 = harness({ legacy: { enabled: false, password: 'shared-password' } });
  check('opt-in 없으면 닫힘', !(await legacyLoginAllowed(h2.deps)));
  const h3 = harness({ legacy: { enabled: true, password: 'shared-password' } });
  h3.directory.down = true;
  check('DB 장애 시 구 로그인 닫힘 (허용 아님)', !(await legacyLoginAllowed(h3.deps)));
  const h4 = harness({ legacy: { enabled: true, password: undefined } });
  check('비밀번호 미설정이면 닫힘', !(await legacyLoginAllowed(h4.deps)));
}

// ── 8. 표시 최소화 헬퍼 ──────────────────────────────────────────────────────────────────────
check('maskEmail', maskEmail('someone@example.com') === 's***@example.com' && maskEmail(null) === '—');
check('maskContact phone', maskContact('010-1234-5678') === '010-****-5678' && maskContact('a@b.co') === 'a***@b.co');
check('maskCode', maskCode('ABCD1234') === 'AB******');

// ── 9. secret · 코드 · 토큰 비노출 ───────────────────────────────────────────────────────────
{
  const blob = JSON.stringify(everything);
  check('응답에 TOTP secret 없음', !blob.includes(TOTP_SECRET));
  check('응답에 코드 없음', !blob.includes(GOOD_CODE));
  check('콘솔 출력 없음', captured.length === 0);
  const pendingTok = pendingToken(SECRET, { sub: OWNER, purpose: 'login', at: 'tok-aal1-x', rt: 'rt-x', fid: 'f' }, 1_800_000_000_000);
  check('pending 토큰은 kind 검사로 세션이 될 수 없다', verifyToken(SECRET, pendingTok, 1_800_000_000_000, 's') === null && verifyToken(SECRET, pendingTok, 1_800_000_000_000, 'p') !== null);
  check('guardKey 에 원문 없음', !guardKey(SECRET, 'acct', 'owner@admin.test').includes('owner') && guardKey(SECRET, 'acct', 'Owner@Admin.test') === guardKey(SECRET, 'acct', 'owner@admin.test'));
}

console.log(`admin auth selftest: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
