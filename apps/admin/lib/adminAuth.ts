import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  type AdminAuthDeps,
  type AdminRole,
  type AdminSession,
  hasRole,
  legacyLoginAllowed,
  resolveSession,
  runChangePassword,
  runLegacyLogin,
  runMfaEnrollStart,
  runMfaVerify,
  runPasswordLogin,
  runSelfMfaReset,
  ADMIN_SESSION_TTL_SECONDS,
  ADMIN_PENDING_TTL_SECONDS,
} from './adminAuthCore';
import { resolveAdminSessionSecret, resolveClientIp } from './adminSessionCore';
import { supabaseAdminAuthProvider, supabaseAdminDirectory } from './supabaseAdminAuth';

/**
 * 관리자 인증 — Next 연결부 (#27). 판단은 adminAuthCore, GoTrue/DB 는 supabaseAdminAuth.
 *  * 쿠키 `bonsim_admin`  = 서명된 서버 세션 id (역할·활성·취소는 매 요청 DB 에서 — admin_session_check)
 *  * 쿠키 `bonsim_admin_pending` = 비밀번호만 통과한 상태 (10분). 등록/검증 화면에서만 읽는다
 *  * 서명 키 ADMIN_SESSION_SECRET — production 필수(32자+). development 는 미설정 시 service role key 파생
 *  * 구 공유 비밀번호 로그인: ADMIN_LEGACY_PASSWORD_LOGIN=1 + ADMIN_PASSWORD 가 있고, MFA 로 로그인을 완료한 관리자가 없을 때만
 */
const SESSION_COOKIE = 'bonsim_admin';
const PENDING_COOKIE = 'bonsim_admin_pending';

export type { AdminRole, AdminSession };

function sessionSecret(): string {
  const res = resolveAdminSessionSecret({
    nodeEnv: process.env.NODE_ENV,
    sessionSecret: process.env.ADMIN_SESSION_SECRET,
    devSeed: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
  if (!res.ok) {
    // 값은 절대 메시지에 넣지 않는다
    throw new Error(`ADMIN_SESSION_SECRET 설정 오류 (${res.reason}) — production 에서는 32자 이상의 고유 값이 필수입니다 (docs/environments.md)`);
  }
  return res.secret;
}

function deps(): AdminAuthDeps {
  return {
    provider: supabaseAdminAuthProvider(),
    directory: supabaseAdminDirectory(),
    secret: sessionSecret(),
    now: () => Date.now(),
    legacy: { enabled: process.env.ADMIN_LEGACY_PASSWORD_LOGIN === '1', password: process.env.ADMIN_PASSWORD },
  };
}

async function clientIp(): Promise<string> {
  const h = await headers();
  return resolveClientIp({
    trustProxyHeaders: process.env.ADMIN_TRUST_PROXY_HEADERS === '1',
    xForwardedFor: h.get('x-forwarded-for'),
    xRealIp: h.get('x-real-ip'),
  });
}

const cookieBase = () => ({ httpOnly: true, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production', path: '/' });

async function setSessionCookie(token: string) {
  (await cookies()).set(SESSION_COOKIE, token, { ...cookieBase(), maxAge: ADMIN_SESSION_TTL_SECONDS });
}
async function setPendingCookie(token: string) {
  (await cookies()).set(PENDING_COOKIE, token, { ...cookieBase(), maxAge: ADMIN_PENDING_TTL_SECONDS });
}
async function clearPendingCookie() {
  (await cookies()).delete(PENDING_COOKIE);
}

export async function currentSession(): Promise<AdminSession | null> {
  const store = await cookies();
  return resolveSession(deps(), store.get(SESSION_COOKIE)?.value);
}

export async function isAuthed(): Promise<boolean> {
  return (await currentSession()) !== null;
}

/** 미인증이면 /login. 역할이 모자라면 대시보드로 (서버 검사 — 메뉴 숨김은 UX 일 뿐이다). 각 페이지·서버 액션·Route Handler 상단에서 호출 */
export async function requireAdmin(minRole: AdminRole = 'viewer'): Promise<AdminSession> {
  const s = await currentSession();
  if (!s) redirect('/login');
  if (!hasRole(s, minRole)) redirect('/?denied=1');
  return s;
}

/** 변경 조치 전용 — owner 만 */
export async function requireOwner(): Promise<AdminSession> {
  return requireAdmin('owner');
}

/** 감사 기록용 표시 이름 (actor 는 항상 session.actor — 불변 id) */
export function actorName(s: AdminSession): string {
  return s.displayName;
}

// ── 로그인 흐름 ──────────────────────────────────────────────────────────────

export type LoginResult = { ok: true; next: 'verify' | 'enroll' } | { ok: false; reason: 'bad_credentials' | 'locked' | 'unavailable' | 'disabled'; lockedSeconds?: number };

export async function loginWithEmailPassword(email: string, password: string): Promise<LoginResult> {
  const r = await runPasswordLogin(deps(), { email, password, clientIp: await clientIp() });
  if (!r.ok) return r;
  await setPendingCookie(r.pending);
  return { ok: true, next: r.next };
}

export type EnrollView = { ok: true; qrCodeSvg: string; secret: string; uri: string; factorId: string } | { ok: false; reason: 'no_pending' | 'unavailable' | 'already_enrolled' };

/**
 * 등록 화면 — QR·secret 은 이 응답(HTML)에만 실린다. URL·로그·감사에 넣지 않는다.
 * 서버 컴포넌트 렌더 중에 호출되므로 쿠키를 쓰지 않는다 (Next: 쿠키 변경은 서버 액션/Route Handler 에서만 — 실제 로컬 Auth 통합 테스트에서 500 으로 드러남).
 * 발급한 factor id 는 폼의 숨은 필드로 verify 액션에 전달되고, 코어가 그 id 가 이 사용자의 미검증 factor 인지 GoTrue 에 확인한다.
 */
export async function startMfaEnrollment(): Promise<EnrollView> {
  const store = await cookies();
  const r = await runMfaEnrollStart(deps(), store.get(PENDING_COOKIE)?.value, '본심 Admin');
  if (!r.ok) return r;
  const { verifyToken } = await import('./adminAuthCore');
  const t = verifyToken(sessionSecret(), r.pending, Date.now(), 'p');
  const factorId = t && t.k === 'p' && t.fid ? t.fid : '';
  if (!factorId) return { ok: false, reason: 'unavailable' };
  return { ok: true, qrCodeSvg: r.qrCodeSvg, secret: r.secret, uri: r.uri, factorId };
}

export type MfaResult = { ok: true } | { ok: false; reason: 'no_pending' | 'bad_code' | 'locked' | 'unavailable' | 'not_aal2' | 'not_active'; lockedSeconds?: number };

/** @param enrollFactorId 등록 화면이 폼에 실어 보낸 factor id (등록 경로에서만 쓰인다 — 코어가 미검증 factor 인지 확인) */
export async function verifyMfaCode(code: string, enrollFactorId?: string): Promise<MfaResult> {
  const store = await cookies();
  const r = await runMfaVerify(deps(), store.get(PENDING_COOKIE)?.value, code, enrollFactorId);
  if (!r.ok) {
    if (r.reason === 'no_pending' || r.reason === 'not_active') await clearPendingCookie();
    return r;
  }
  await clearPendingCookie();
  await setSessionCookie(r.session);
  return { ok: true };
}

/** MFA 화면용 pending 상태 — 토큰 내용은 돌려주지 않는다 */
export async function pendingState(): Promise<{ hasFactor: boolean; purpose: 'login' | 'reenroll' } | null> {
  const store = await cookies();
  const { verifyToken } = await import('./adminAuthCore');
  const t = verifyToken(sessionSecret(), store.get(PENDING_COOKIE)?.value, Date.now(), 'p');
  if (!t || t.k !== 'p') return null;
  return { hasFactor: !!t.fid, purpose: t.purpose };
}

export async function logout(): Promise<void> {
  const s = await currentSession();
  const store = await cookies();
  const d = deps();
  const sid = s?.sessionId;
  store.delete(SESSION_COOKIE);
  store.delete(PENDING_COOKIE);
  if (sid) await d.directory.sessionRevoke(sid);
  if (s) await d.directory.audit(s.actor, 'admin_logout', null, null, { actor_name: s.displayName });
}

export async function changeOwnPassword(input: { password: string; code: string; newPassword: string }) {
  const s = await requireAdmin();
  return runChangePassword(deps(), s, { ...input, clientIp: await clientIp() });
}

/** 본인 MFA 재등록 — 재인증 뒤 pending 을 만들고 등록 화면으로 보낸다 */
export async function resetOwnMfa(input: { password: string; code: string }): Promise<{ ok: true } | { ok: false; reason: string; lockedSeconds?: number }> {
  const s = await requireAdmin();
  const r = await runSelfMfaReset(deps(), s, { ...input, clientIp: await clientIp() });
  if (!r.ok) return r;
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  await setPendingCookie(r.pending);
  return { ok: true };
}

// ── 구 로그인 (전환 기간) ────────────────────────────────────────────────────

export async function legacyLoginOpen(): Promise<boolean> {
  return legacyLoginAllowed(deps());
}

export type LegacyLoginResult = { ok: true } | { ok: false; reason: 'closed' | 'bad_password' | 'locked' | 'unavailable'; lockedSeconds?: number };

export async function loginWithLegacyPassword(password: string, actorName: string): Promise<LegacyLoginResult> {
  const r = await runLegacyLogin(deps(), { password, actorName, clientIp: await clientIp() });
  if (!r.ok) return r;
  await setSessionCookie(r.token);
  return { ok: true };
}
