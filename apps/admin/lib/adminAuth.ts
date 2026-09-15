import { createHash } from 'crypto';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  issueSessionToken,
  LOGIN_LOCK_SECONDS,
  LoginAttemptLimiter,
  passwordMatches,
  sanitizeActor,
  SESSION_TTL_SECONDS,
  verifySessionToken,
} from './adminSessionCore';

/**
 * 관리자 로그인/세션 (#27).
 *  * 쿠키 = 서명된 세션 토큰(만료 포함, adminSessionCore). httpOnly · sameSite=lax · production 에서 secure.
 *  * ADMIN_SESSION_SECRET 이 있으면 그것으로 서명, 없으면 ADMIN_PASSWORD 에서 파생 (비밀번호 변경 = 전 세션 무효).
 *  * 로그인 실패 5회 → 15분 잠금 (인스턴스 메모리). 로그인 성공/실패/잠금은 admin_audit_log 에 남긴다 (IP 는 해시만).
 *  * 로그인 때 입력한 처리자 이름이 세션에 실려 모든 감사 기록의 actor 가 된다.
 */
const COOKIE_NAME = 'bonsim_admin';

function sessionSecret(): string {
  const explicit = process.env.ADMIN_SESSION_SECRET;
  if (explicit && explicit.length >= 16) return explicit;
  const password = process.env.ADMIN_PASSWORD;
  if (!password) throw new Error('ADMIN_PASSWORD 환경변수가 필요합니다.');
  return createHash('sha256').update(`bonsim-admin-session:${password}`).digest('hex');
}

const limiter = new LoginAttemptLimiter();

async function clientKey(): Promise<string> {
  const h = await headers();
  const ip = (h.get('x-forwarded-for') ?? h.get('x-real-ip') ?? 'local').split(',')[0].trim();
  return createHash('sha256').update(`ip:${ip}`).digest('hex').slice(0, 16);
}

export type AdminSession = { actor: string; expiresAt: number };

export async function currentSession(): Promise<AdminSession | null> {
  const store = await cookies();
  const payload = verifySessionToken(sessionSecret(), store.get(COOKIE_NAME)?.value);
  return payload ? { actor: payload.actor, expiresAt: payload.exp * 1000 } : null;
}

export async function isAuthed(): Promise<boolean> {
  return (await currentSession()) !== null;
}

/** 미인증이면 /login 으로 보낸다. 각 관리자 페이지·서버 액션 상단에서 호출. 세션(처리자 이름)을 돌려준다 */
export async function requireAdmin(): Promise<AdminSession> {
  const s = await currentSession();
  if (!s) redirect('/login');
  return s;
}

/** 감사 기록용 처리자 이름 — 세션의 이름, 없으면 ADMIN_ACTOR_LABEL, 그것도 없으면 admin-web */
export async function currentActor(): Promise<string> {
  const s = await currentSession();
  return s?.actor ?? sanitizeActor(process.env.ADMIN_ACTOR_LABEL ?? 'admin-web');
}

export type LoginResult = { ok: true } | { ok: false; reason: 'bad_password' | 'locked'; lockedSeconds?: number };

export async function loginWithPassword(password: string, actorName: string): Promise<LoginResult> {
  const key = await clientKey();
  const locked = limiter.lockedFor(key);
  const { recordAdminAudit } = await import('./audit');
  if (locked > 0) {
    await recordAdminAudit(sanitizeActor(actorName), 'admin_login_locked', 'client', key, { locked_seconds: locked });
    return { ok: false, reason: 'locked', lockedSeconds: locked };
  }
  if (!passwordMatches(password, process.env.ADMIN_PASSWORD ?? '')) {
    const lockNow = limiter.recordFailure(key);
    await recordAdminAudit(sanitizeActor(actorName), 'admin_login_failed', 'client', key, { locked_seconds: lockNow || undefined });
    return lockNow > 0 ? { ok: false, reason: 'locked', lockedSeconds: LOGIN_LOCK_SECONDS } : { ok: false, reason: 'bad_password' };
  }
  limiter.recordSuccess(key);
  const actor = sanitizeActor(actorName);
  const store = await cookies();
  store.set(COOKIE_NAME, issueSessionToken(sessionSecret(), actor), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_TTL_SECONDS,
    path: '/',
  });
  await recordAdminAudit(actor, 'admin_login', 'client', key, {});
  return { ok: true };
}

export async function logout(): Promise<void> {
  const s = await currentSession();
  const store = await cookies();
  store.delete(COOKIE_NAME);
  if (s) {
    const { recordAdminAudit } = await import('./audit');
    await recordAdminAudit(s.actor, 'admin_logout', null, null, {});
  }
}
