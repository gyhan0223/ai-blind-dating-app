/**
 * 관리자 인증 코어 (#27) — 개인 계정(Supabase Auth 이메일+비밀번호) · 관리형 MFA(TOTP, aal2) · DB 세션 · 역할.
 * Next 에 의존하지 않는다 (Node selftest: scripts/admin-auth-selftest.mjs 가 Provider/Directory 를 주입해 검증).
 *
 * 원칙
 *   * 권한의 근거는 admin_members 행(서버 관리)뿐이다 — JWT/user metadata/쿠키/요청 입력의 role 을 믿지 않는다.
 *   * 세션 쿠키에는 서버 세션 id 와 서명만 있다. 역할·활성 여부·취소 여부는 매 요청 DB(admin_session_check)에서 읽는다.
 *   * 세션은 GoTrue 가 aal2 라고 답한 access token 을 서버가 확인한 뒤에만 발급한다 ("MFA 완료" 는 클라이언트 boolean 이 아니다).
 *   * 비밀번호만 통과한 상태는 pending 쿠키(10분)로만 존재하며, 등록/검증 화면 외의 어떤 관리자 데이터·조치에도 쓰이지 않는다.
 *   * DB/Auth 가 응답하지 않으면 허용이 아니라 거부다.
 *   * 구 공유 비밀번호 로그인은 (환경변수 opt-in) AND (MFA 로 로그인을 완료한 관리자가 아직 없음) 일 때만 열린다 — 전환이 끝나면 자동으로 닫힌다.
 *   * TOTP secret · QR · 코드 · access token 은 로그/감사/URL 에 넣지 않는다 (이 모듈은 console 을 쓰지 않는다).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { type LoginGuardStore, passwordMatches, runLoginGuard, sanitizeActor } from './adminSessionCore.ts';

export const ADMIN_SESSION_TTL_SECONDS = 12 * 60 * 60;
export const ADMIN_PENDING_TTL_SECONDS = 10 * 60;
export const ADMIN_PASSWORD_MIN_LENGTH = 12;

export type AdminRole = 'owner' | 'viewer';
export const ADMIN_ROLES: AdminRole[] = ['owner', 'viewer'];

// ---------------------------------------------------------------------------
// 서명 토큰 (v2) — 쿠키 값. v1(공유 비밀번호 시절)은 형식이 달라 검증에서 걸러진다
// ---------------------------------------------------------------------------
export type SessionToken = { v: 2; k: 's'; sid: string; iat: number; exp: number; nonce: string };
export type PendingPurpose = 'login' | 'reenroll';
export type PendingToken = { v: 2; k: 'p'; sub: string; purpose: PendingPurpose; at: string; rt: string; fid?: string; iat: number; exp: number };
export type LegacyToken = { v: 2; k: 'l'; actor: string; iat: number; exp: number; nonce: string };
export type AdminToken = SessionToken | PendingToken | LegacyToken;

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  try {
    return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
  } catch {
    return null;
  }
}
function sign(secret: string, payloadB64: string): string {
  return b64url(createHmac('sha256', secret).update(payloadB64).digest());
}

export function issueToken(secret: string, payload: AdminToken): string {
  const p = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${p}.${sign(secret, p)}`;
}

/** 서명·형식·만료를 검사한 payload. 아니면 null. kind 를 주면 그 종류만 */
export function verifyToken(secret: string, token: string | null | undefined, now: number = Date.now(), kind?: AdminToken['k']): AdminToken | null {
  if (!token || typeof token !== 'string' || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [p, sig] = parts;
  const expected = sign(secret, p);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const raw = fromB64url(p);
  if (!raw) return null;
  let payload: AdminToken;
  try {
    payload = JSON.parse(raw.toString('utf8')) as AdminToken;
  } catch {
    return null;
  }
  if (!payload || payload.v !== 2 || typeof payload.exp !== 'number' || typeof payload.iat !== 'number') return null;
  if (payload.k !== 's' && payload.k !== 'p' && payload.k !== 'l') return null;
  if (kind && payload.k !== kind) return null;
  if (payload.exp * 1000 <= now) return null;
  if (payload.k === 's' && typeof payload.sid !== 'string') return null;
  if (payload.k === 'p' && (typeof payload.sub !== 'string' || typeof payload.at !== 'string' || (payload.purpose !== 'login' && payload.purpose !== 'reenroll'))) return null;
  if (payload.k === 'l' && typeof payload.actor !== 'string') return null;
  return payload;
}

export function sessionToken(secret: string, sessionId: string, now: number = Date.now()): string {
  const iat = Math.floor(now / 1000);
  return issueToken(secret, { v: 2, k: 's', sid: sessionId, iat, exp: iat + ADMIN_SESSION_TTL_SECONDS, nonce: b64url(randomBytes(12)) });
}

export function pendingToken(secret: string, p: Omit<PendingToken, 'v' | 'k' | 'iat' | 'exp'>, now: number = Date.now()): string {
  const iat = Math.floor(now / 1000);
  return issueToken(secret, { v: 2, k: 'p', ...p, iat, exp: iat + ADMIN_PENDING_TTL_SECONDS });
}

export function legacyToken(secret: string, actor: string, now: number = Date.now()): string {
  const iat = Math.floor(now / 1000);
  return issueToken(secret, { v: 2, k: 'l', actor, iat, exp: iat + ADMIN_SESSION_TTL_SECONDS, nonce: b64url(randomBytes(12)) });
}

// ---------------------------------------------------------------------------
// 주입 인터페이스 — Provider(GoTrue) · Directory(DB RPC)
// ---------------------------------------------------------------------------
export type AuthTokens = { accessToken: string; refreshToken: string };

export interface AdminAuthProvider {
  signInWithPassword(email: string, password: string): Promise<{ ok: true; userId: string; tokens: AuthTokens } | { ok: false; reason: 'bad_credentials' | 'unavailable' }>;
  /** verified / unverified TOTP factor id */
  listFactors(tokens: AuthTokens): Promise<{ ok: true; verified: string[]; unverified: string[] } | { ok: false }>;
  enrollTotp(tokens: AuthTokens, friendlyName: string): Promise<{ ok: true; factorId: string; qrCodeSvg: string; secret: string; uri: string } | { ok: false }>;
  unenroll(tokens: AuthTokens, factorId: string): Promise<boolean>;
  /** challenge + verify. 성공하면 aal2 토큰 */
  challengeAndVerify(tokens: AuthTokens, factorId: string, code: string): Promise<{ ok: true; tokens: AuthTokens } | { ok: false; reason: 'bad_code' | 'unavailable' }>;
  /** 서버가 GoTrue 에 물어 확인한 인증 수준 (네트워크 호출). 실패면 null */
  assuranceLevel(accessToken: string): Promise<'aal1' | 'aal2' | null>;
  updatePassword(tokens: AuthTokens, newPassword: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  signOut(accessToken: string): Promise<void>;
  /** ── service role (admin API) ── */
  emailOf(userId: string): Promise<string | null>;
  createAdminUser(email: string, password: string): Promise<{ ok: true; userId: string } | { ok: false; reason: string }>;
  deleteAllFactors(userId: string): Promise<boolean>;
}

export type MemberInfo = { role: AdminRole; status: 'active' | 'disabled'; displayName: string };

export interface AdminDirectory {
  /** null = 멤버 아님, 'unavailable' = DB 오류 */
  member(userId: string): Promise<MemberInfo | null | 'unavailable'>;
  sessionIssue(userId: string, ttlSeconds: number): Promise<{ sessionId: string; role: AdminRole; displayName: string } | null>;
  sessionCheck(sessionId: string): Promise<{ ok: true; userId: string; role: AdminRole; displayName: string } | { ok: false } | null>;
  sessionRevoke(sessionId: string): Promise<boolean>;
  revokeAllSessions(actorUserId: string | null, targetUserId: string, reason: string): Promise<boolean>;
  /** null = DB 오류 (허용하지 않는다) */
  legacyAllowed(): Promise<boolean | null>;
  guard: LoginGuardStore;
  audit(actor: string, action: string, targetType: string | null, targetId: string | null, detail: Record<string, unknown>): Promise<void>;
}

export type AdminAuthDeps = {
  provider: AdminAuthProvider;
  directory: AdminDirectory;
  secret: string;
  now: () => number;
  /** 구 공유 비밀번호 로그인 opt-in (ADMIN_LEGACY_PASSWORD_LOGIN=1) + 그 비밀번호 */
  legacy: { enabled: boolean; password: string | undefined };
};

/** 로그인 제한 키 — 원문(이메일·사용자 id·IP)은 저장하지 않는다 */
export function guardKey(secret: string, scope: 'ip' | 'acct' | 'mfa', value: string): string {
  return `${scope}:${createHmac('sha256', secret).update(`admin-${scope}:${value.trim().toLowerCase()}`).digest('hex').slice(0, 40)}`;
}

// ---------------------------------------------------------------------------
// 세션 판정 — 매 요청
// ---------------------------------------------------------------------------
export type AdminSession = {
  /** 감사 기록 actor — 불변 관리자 id (auth user id). 구 로그인은 'legacy:<이름>' */
  actor: string;
  userId: string | null;
  role: AdminRole;
  displayName: string;
  sessionId: string | null;
  legacy: boolean;
};

export async function resolveSession(deps: AdminAuthDeps, cookie: string | null | undefined): Promise<AdminSession | null> {
  const t = verifyToken(deps.secret, cookie, deps.now());
  if (!t) return null;
  if (t.k === 's') {
    const r = await deps.directory.sessionCheck(t.sid);
    if (!r || !r.ok) return null; // DB 오류·취소·만료·비활성화 → 거부
    return { actor: r.userId, userId: r.userId, role: r.role, displayName: r.displayName, sessionId: t.sid, legacy: false };
  }
  if (t.k === 'l') {
    if (!(await legacyLoginAllowed(deps))) return null; // 전환이 끝나면 구 쿠키도 즉시 무효
    return { actor: `legacy:${t.actor}`, userId: null, role: 'owner', displayName: t.actor, sessionId: null, legacy: true };
  }
  return null; // pending 은 세션이 아니다
}

export function hasRole(session: AdminSession, required: AdminRole): boolean {
  if (required === 'viewer') return session.role === 'owner' || session.role === 'viewer';
  return session.role === 'owner';
}

export async function legacyLoginAllowed(deps: AdminAuthDeps): Promise<boolean> {
  if (!deps.legacy.enabled || !deps.legacy.password) return false;
  const db = await deps.directory.legacyAllowed();
  return db === true;
}

// ---------------------------------------------------------------------------
// 1단계: 이메일 + 비밀번호 → pending (MFA 등록 또는 검증 필요)
// ---------------------------------------------------------------------------
export type PasswordLoginResult =
  | { ok: true; next: 'verify' | 'enroll'; pending: string }
  | { ok: false; reason: 'bad_credentials' | 'locked' | 'unavailable' | 'disabled'; lockedSeconds?: number };

export async function runPasswordLogin(deps: AdminAuthDeps, input: { email: string; password: string; clientIp: string }): Promise<PasswordLoginResult> {
  const email = input.email.trim().toLowerCase();
  if (!email || !input.password) return { ok: false, reason: 'bad_credentials' };
  const ipKey = guardKey(deps.secret, 'ip', input.clientIp);
  const acctKey = guardKey(deps.secret, 'acct', email);
  const keys = [ipKey, acctKey];

  // 잠금 확인 (둘 중 하나라도) — 잠금 중에는 비밀번호를 검사하지 않는다
  for (const k of keys) {
    const h = await deps.directory.guard.hit(k, 'check');
    if (!h) return { ok: false, reason: 'unavailable' };
    if (h.locked) {
      await deps.directory.audit('anonymous', 'admin_login_locked', 'client', k, { locked_seconds: h.lockedSeconds });
      return { ok: false, reason: 'locked', lockedSeconds: h.lockedSeconds };
    }
  }

  const signIn = await deps.provider.signInWithPassword(email, input.password);
  if (!signIn.ok) {
    if (signIn.reason === 'unavailable') return { ok: false, reason: 'unavailable' };
    return recordFailure(deps, keys, acctKey, 'admin_login_failed');
  }

  const member = await deps.directory.member(signIn.userId);
  if (member === 'unavailable') {
    await deps.provider.signOut(signIn.tokens.accessToken);
    return { ok: false, reason: 'unavailable' };
  }
  if (!member) {
    // 관리자가 아닌 Auth 계정(앱 사용자 등) — 자격 증명 실패와 같은 응답, 실패로 집계
    await deps.provider.signOut(signIn.tokens.accessToken);
    return recordFailure(deps, keys, signIn.userId, 'admin_login_not_member');
  }
  if (member.status !== 'active') {
    await deps.provider.signOut(signIn.tokens.accessToken);
    await deps.directory.audit(signIn.userId, 'admin_login_disabled', 'admin_member', signIn.userId, {});
    return { ok: false, reason: 'disabled' };
  }

  for (const k of keys) {
    const h = await deps.directory.guard.hit(k, 'success');
    if (!h) {
      await deps.provider.signOut(signIn.tokens.accessToken);
      return { ok: false, reason: 'unavailable' };
    }
  }

  const factors = await deps.provider.listFactors(signIn.tokens);
  if (!factors.ok) {
    await deps.provider.signOut(signIn.tokens.accessToken);
    return { ok: false, reason: 'unavailable' };
  }
  const verified = factors.verified[0];
  const pending = pendingToken(
    deps.secret,
    { sub: signIn.userId, purpose: 'login', at: signIn.tokens.accessToken, rt: signIn.tokens.refreshToken, ...(verified ? { fid: verified } : {}) },
    deps.now(),
  );
  await deps.directory.audit(signIn.userId, 'admin_password_ok', 'admin_member', signIn.userId, { next: verified ? 'verify' : 'enroll' });
  return { ok: true, next: verified ? 'verify' : 'enroll', pending };
}

async function recordFailure(deps: AdminAuthDeps, keys: string[], targetId: string, action: string): Promise<PasswordLoginResult> {
  let locked: number | null = null;
  for (const k of keys) {
    const h = await deps.directory.guard.hit(k, 'failure');
    if (!h) return { ok: false, reason: 'unavailable' };
    if (h.locked) locked = Math.max(locked ?? 0, h.lockedSeconds);
  }
  await deps.directory.audit('anonymous', action, 'client', targetId, {});
  if (locked !== null) return { ok: false, reason: 'locked', lockedSeconds: locked };
  return { ok: false, reason: 'bad_credentials' };
}

// ---------------------------------------------------------------------------
// 2단계: MFA 등록 시작 (등록된 factor 가 없을 때) — QR/secret 은 화면에만
// ---------------------------------------------------------------------------
export type EnrollStartResult =
  | { ok: true; pending: string; qrCodeSvg: string; secret: string; uri: string }
  | { ok: false; reason: 'no_pending' | 'unavailable' | 'already_enrolled' };

export async function runMfaEnrollStart(deps: AdminAuthDeps, pendingCookie: string | null | undefined, friendlyName: string): Promise<EnrollStartResult> {
  const p = verifyToken(deps.secret, pendingCookie, deps.now(), 'p') as PendingToken | null;
  if (!p) return { ok: false, reason: 'no_pending' };
  const tokens = { accessToken: p.at, refreshToken: p.rt };
  const factors = await deps.provider.listFactors(tokens);
  if (!factors.ok) return { ok: false, reason: 'unavailable' };
  if (factors.verified.length > 0 && p.purpose === 'login') return { ok: false, reason: 'already_enrolled' };
  // 중단된 등록(unverified)은 지우고 새로 시작 — verified factor 는 여기서 건드리지 않는다 (해제는 재인증 절차)
  for (const f of factors.unverified) await deps.provider.unenroll(tokens, f);
  const enrolled = await deps.provider.enrollTotp(tokens, friendlyName);
  if (!enrolled.ok) return { ok: false, reason: 'unavailable' };
  const pending = pendingToken(deps.secret, { sub: p.sub, purpose: p.purpose, at: p.at, rt: p.rt, fid: enrolled.factorId }, deps.now());
  return { ok: true, pending, qrCodeSvg: enrolled.qrCodeSvg, secret: enrolled.secret, uri: enrolled.uri };
}

// ---------------------------------------------------------------------------
// 3단계: TOTP 코드 검증 → aal2 확인 → 서버 세션 발급
// ---------------------------------------------------------------------------
export type MfaVerifyResult =
  | { ok: true; session: string; userId: string; role: AdminRole; displayName: string }
  | { ok: false; reason: 'no_pending' | 'bad_code' | 'locked' | 'unavailable' | 'not_aal2' | 'not_active'; lockedSeconds?: number };

export async function runMfaVerify(deps: AdminAuthDeps, pendingCookie: string | null | undefined, code: string): Promise<MfaVerifyResult> {
  const p = verifyToken(deps.secret, pendingCookie, deps.now(), 'p') as PendingToken | null;
  if (!p || !p.fid) return { ok: false, reason: 'no_pending' };
  const cleaned = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleaned)) return { ok: false, reason: 'bad_code' };
  const key = guardKey(deps.secret, 'mfa', p.sub);
  const tokens = { accessToken: p.at, refreshToken: p.rt };

  const verified = await runLoginGuardAsync(deps.directory.guard, key, async () => {
    const r = await deps.provider.challengeAndVerify(tokens, p.fid!, cleaned);
    if (r.ok) return { ok: true as const, value: r.tokens };
    if (r.reason === 'unavailable') return { ok: false as const, unavailable: true };
    return { ok: false as const, unavailable: false };
  });
  if (verified.outcome === 'unavailable') return { ok: false, reason: 'unavailable' };
  if (verified.outcome === 'locked') {
    await deps.directory.audit(p.sub, 'admin_mfa_locked', 'admin_member', p.sub, { locked_seconds: verified.lockedSeconds });
    return { ok: false, reason: 'locked', lockedSeconds: verified.lockedSeconds };
  }
  if (verified.outcome === 'bad') {
    await deps.directory.audit(p.sub, 'admin_mfa_failed', 'admin_member', p.sub, {});
    return { ok: false, reason: 'bad_code' };
  }
  const aal2 = verified.value;

  // "MFA 완료" 는 GoTrue 가 확인한 인증 수준으로 판단한다
  const level = await deps.provider.assuranceLevel(aal2.accessToken);
  if (level !== 'aal2') {
    await deps.provider.signOut(aal2.accessToken);
    return { ok: false, reason: level === null ? 'unavailable' : 'not_aal2' };
  }
  const member = await deps.directory.member(p.sub);
  if (member === 'unavailable') {
    await deps.provider.signOut(aal2.accessToken);
    return { ok: false, reason: 'unavailable' };
  }
  if (!member || member.status !== 'active') {
    await deps.provider.signOut(aal2.accessToken);
    return { ok: false, reason: 'not_active' };
  }
  const issued = await deps.directory.sessionIssue(p.sub, ADMIN_SESSION_TTL_SECONDS);
  // GoTrue 세션은 더 쓰지 않는다 — 우리 세션(DB 행)만 남긴다
  await deps.provider.signOut(aal2.accessToken);
  if (!issued) return { ok: false, reason: 'unavailable' };
  await deps.directory.audit(p.sub, p.purpose === 'reenroll' ? 'admin_mfa_reenrolled' : 'admin_login', 'admin_member', p.sub, { actor_name: issued.displayName, role: issued.role });
  return { ok: true, session: sessionToken(deps.secret, issued.sessionId, deps.now()), userId: p.sub, role: issued.role, displayName: issued.displayName };
}

/** runLoginGuard 의 비동기 판정판 — 판정 함수가 Provider 를 부른다. unavailable 이면 실패로 세지 않는다 */
async function runLoginGuardAsync<T>(
  store: LoginGuardStore,
  key: string,
  check: () => Promise<{ ok: true; value: T } | { ok: false; unavailable: boolean }>,
): Promise<{ outcome: 'ok'; value: T } | { outcome: 'bad' } | { outcome: 'locked'; lockedSeconds: number } | { outcome: 'unavailable' }> {
  const before = await store.hit(key, 'check');
  if (!before) return { outcome: 'unavailable' };
  if (before.locked) return { outcome: 'locked', lockedSeconds: before.lockedSeconds };
  const r = await check();
  if (!r.ok) {
    if (r.unavailable) return { outcome: 'unavailable' };
    const after = await store.hit(key, 'failure');
    if (!after) return { outcome: 'unavailable' };
    return after.locked ? { outcome: 'locked', lockedSeconds: after.lockedSeconds } : { outcome: 'bad' };
  }
  const reset = await store.hit(key, 'success');
  if (!reset) return { outcome: 'unavailable' };
  return { outcome: 'ok', value: r.value };
}

// ---------------------------------------------------------------------------
// 재인증 (민감 조치: 비밀번호 변경 · 본인 MFA 재등록) — 비밀번호 + 현재 TOTP 코드를 한 번에
// ---------------------------------------------------------------------------
export type ReauthResult = { ok: true; tokens: AuthTokens } | { ok: false; reason: 'bad_credentials' | 'locked' | 'unavailable' | 'no_factor'; lockedSeconds?: number };

export async function runReauth(deps: AdminAuthDeps, session: AdminSession, password: string, code: string, clientIp: string): Promise<ReauthResult> {
  if (!session.userId) return { ok: false, reason: 'bad_credentials' };
  const email = await deps.provider.emailOf(session.userId);
  if (!email) return { ok: false, reason: 'unavailable' };
  const login = await runPasswordLogin(deps, { email, password, clientIp });
  if (!login.ok) return { ok: false, reason: login.reason === 'disabled' ? 'bad_credentials' : login.reason, lockedSeconds: login.lockedSeconds };
  const p = verifyToken(deps.secret, login.pending, deps.now(), 'p') as PendingToken;
  if (!p.fid) {
    await deps.provider.signOut(p.at);
    return { ok: false, reason: 'no_factor' };
  }
  if (p.sub !== session.userId) {
    await deps.provider.signOut(p.at);
    return { ok: false, reason: 'bad_credentials' };
  }
  const cleaned = code.replace(/\s+/g, '');
  const key = guardKey(deps.secret, 'mfa', p.sub);
  const verified = await runLoginGuardAsync(deps.directory.guard, key, async () => {
    const r = await deps.provider.challengeAndVerify({ accessToken: p.at, refreshToken: p.rt }, p.fid!, cleaned);
    if (r.ok) return { ok: true as const, value: r.tokens };
    return { ok: false as const, unavailable: r.reason === 'unavailable' };
  });
  if (verified.outcome !== 'ok') {
    await deps.provider.signOut(p.at);
    if (verified.outcome === 'locked') return { ok: false, reason: 'locked', lockedSeconds: verified.lockedSeconds };
    return { ok: false, reason: verified.outcome === 'bad' ? 'bad_credentials' : 'unavailable' };
  }
  if ((await deps.provider.assuranceLevel(verified.value.accessToken)) !== 'aal2') {
    await deps.provider.signOut(verified.value.accessToken);
    return { ok: false, reason: 'unavailable' };
  }
  return { ok: true, tokens: verified.value };
}

/** 비밀번호 변경 — 재인증 뒤. 다른 세션은 모두 취소한다 */
export async function runChangePassword(deps: AdminAuthDeps, session: AdminSession, input: { password: string; code: string; newPassword: string; clientIp: string }): Promise<{ ok: true } | { ok: false; reason: string; lockedSeconds?: number }> {
  if (!session.userId) return { ok: false, reason: 'bad_credentials' };
  if (input.newPassword.length < ADMIN_PASSWORD_MIN_LENGTH) return { ok: false, reason: 'weak_password' };
  const re = await runReauth(deps, session, input.password, input.code, input.clientIp);
  if (!re.ok) return { ok: false, reason: re.reason, lockedSeconds: re.lockedSeconds };
  const r = await deps.provider.updatePassword(re.tokens, input.newPassword);
  await deps.provider.signOut(re.tokens.accessToken);
  if (!r.ok) return { ok: false, reason: r.reason };
  await deps.directory.revokeAllSessions(session.userId, session.userId, 'password_changed');
  await deps.directory.audit(session.userId, 'admin_password_changed', 'admin_member', session.userId, {});
  return { ok: true };
}

/** 본인 MFA 재등록 — 재인증 뒤 기존 factor 를 지우고 등록 pending 을 돌려준다 (다른 세션 취소) */
export async function runSelfMfaReset(deps: AdminAuthDeps, session: AdminSession, input: { password: string; code: string; clientIp: string }): Promise<{ ok: true; pending: string } | { ok: false; reason: string; lockedSeconds?: number }> {
  if (!session.userId) return { ok: false, reason: 'bad_credentials' };
  const re = await runReauth(deps, session, input.password, input.code, input.clientIp);
  if (!re.ok) return { ok: false, reason: re.reason, lockedSeconds: re.lockedSeconds };
  if (!(await deps.provider.deleteAllFactors(session.userId))) {
    await deps.provider.signOut(re.tokens.accessToken);
    return { ok: false, reason: 'unavailable' };
  }
  await deps.directory.revokeAllSessions(session.userId, session.userId, 'mfa_reset_self');
  await deps.directory.audit(session.userId, 'admin_mfa_reset', 'admin_member', session.userId, { by: 'self' });
  // 재인증으로 얻은 (aal2) 토큰으로 바로 등록을 이어간다 — 등록 완료(verify) 뒤 새 세션이 발급된다
  return { ok: true, pending: pendingToken(deps.secret, { sub: session.userId, purpose: 'reenroll', at: re.tokens.accessToken, rt: re.tokens.refreshToken }, deps.now()) };
}

// ---------------------------------------------------------------------------
// 구 공유 비밀번호 로그인 — 전환 기간 한정 (opt-in AND MFA 완료 멤버 없음)
// ---------------------------------------------------------------------------
export type LegacyLoginResult = { ok: true; token: string } | { ok: false; reason: 'closed' | 'bad_password' | 'locked' | 'unavailable'; lockedSeconds?: number };

export async function runLegacyLogin(deps: AdminAuthDeps, input: { password: string; actorName: string; clientIp: string }): Promise<LegacyLoginResult> {
  if (!(await legacyLoginAllowed(deps))) return { ok: false, reason: 'closed' };
  const key = guardKey(deps.secret, 'ip', input.clientIp);
  const actor = sanitizeActor(input.actorName);
  const r = await runLoginGuard(deps.directory.guard, key, () => passwordMatches(input.password, deps.legacy.password ?? ''));
  if (r.outcome === 'unavailable') return { ok: false, reason: 'unavailable' };
  if (r.outcome === 'locked') {
    await deps.directory.audit(`legacy:${actor}`, 'admin_login_locked', 'client', key, { locked_seconds: r.lockedSeconds });
    return { ok: false, reason: 'locked', lockedSeconds: r.lockedSeconds };
  }
  if (r.outcome === 'bad_password') {
    await deps.directory.audit(`legacy:${actor}`, 'admin_login_failed', 'client', key, { legacy: true });
    return { ok: false, reason: 'bad_password' };
  }
  await deps.directory.audit(`legacy:${actor}`, 'admin_login', 'client', key, { legacy: true, actor_name: actor });
  return { ok: true, token: legacyToken(deps.secret, actor, deps.now()) };
}

// ---------------------------------------------------------------------------
// viewer 표시 최소화 — 개인정보·위험 입력값은 필요한 범위만
// ---------------------------------------------------------------------------
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '—';
  const [local, domain] = email.split('@');
  if (!domain) return `${email.slice(0, 1)}***`;
  return `${local.slice(0, 1)}***@${domain}`;
}

/** 전화번호 또는 이메일 연락처 */
export function maskContact(contact: string | null | undefined): string {
  if (!contact) return '—';
  if (contact.includes('@')) return maskEmail(contact);
  const digits = contact.replace(/[^\d]/g, '');
  if (digits.length < 8) return '***';
  return `${digits.slice(0, 3)}-****-${digits.slice(-4)}`;
}

export function maskCode(code: string | null | undefined): string {
  if (!code) return '—';
  return `${code.slice(0, 2)}${'*'.repeat(Math.max(2, code.length - 2))}`;
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 120;
}
