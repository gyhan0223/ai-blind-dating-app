import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  type GuardEvent,
  type GuardHit,
  issueSessionToken,
  LOGIN_LOCK_SECONDS,
  LOGIN_MAX_FAILURES,
  type LoginGuardStore,
  loginGuardKey,
  passwordMatches,
  resolveAdminSessionSecret,
  resolveClientIp,
  runLoginGuard,
  sanitizeActor,
  SESSION_TTL_SECONDS,
  verifySessionToken,
} from './adminSessionCore';
import { adminClient } from './supabaseAdmin';

/**
 * 관리자 로그인/세션 (#27).
 *  * 쿠키 = 서명된 세션 토큰(만료 포함, adminSessionCore). httpOnly · sameSite=lax · production 에서 secure.
 *  * 서명 키: ADMIN_SESSION_SECRET — production(NODE_ENV=production) 에서는 필수(32자+). development 에서만 ADMIN_PASSWORD 파생 fallback.
 *  * 로그인 실패 5회 → 15분 잠금 — DB(admin_login_guard RPC, 0031) 에 기록되어 여러 인스턴스·재시작에 걸쳐 동일하게 적용된다.
 *    키 = HMAC(session secret, IP). 제한 조회/기록이 실패하면 로그인하지 않는다 (fail-closed).
 *  * 프록시 헤더는 ADMIN_TRUST_PROXY_HEADERS=1 일 때만 신뢰한다 (docs/security.md 4절).
 *  * 로그인 성공/실패/잠금/제한 불가는 admin_audit_log 에 남긴다 (IP 는 HMAC 키만).
 *  * 로그인 때 입력한 처리자 이름이 세션에 실려 모든 감사 기록의 actor 가 된다 (제한 키에는 쓰지 않는다).
 */
const COOKIE_NAME = 'bonsim_admin';

function sessionSecret(): string {
  const res = resolveAdminSessionSecret({
    nodeEnv: process.env.NODE_ENV,
    sessionSecret: process.env.ADMIN_SESSION_SECRET,
    password: process.env.ADMIN_PASSWORD,
  });
  if (!res.ok) {
    // 값은 절대 메시지에 넣지 않는다
    throw new Error(`ADMIN_SESSION_SECRET 설정 오류 (${res.reason}) — production 에서는 32자 이상의 고유 값이 필수입니다 (docs/environments.md)`);
  }
  return res.secret;
}

/** DB 공유 로그인 제한 저장소 — RPC 오류는 null (호출자가 fail-closed) */
const dbGuardStore: LoginGuardStore = {
  async hit(key: string, event: GuardEvent): Promise<GuardHit | null> {
    try {
      const db = adminClient();
      const { data, error } = await db.rpc('admin_login_guard', {
        p_key: key,
        p_event: event,
        p_max_failures: LOGIN_MAX_FAILURES,
        p_lock_seconds: LOGIN_LOCK_SECONDS,
      });
      if (error || typeof data !== 'object' || data === null) return null;
      const r = data as { locked?: unknown; locked_seconds?: unknown; failures?: unknown };
      if (typeof r.locked !== 'boolean') return null;
      return { locked: r.locked, lockedSeconds: Number(r.locked_seconds ?? 0), failures: Number(r.failures ?? 0) };
    } catch {
      return null;
    }
  },
};

async function clientKey(): Promise<string> {
  const h = await headers();
  const ip = resolveClientIp({
    trustProxyHeaders: process.env.ADMIN_TRUST_PROXY_HEADERS === '1',
    xForwardedFor: h.get('x-forwarded-for'),
    xRealIp: h.get('x-real-ip'),
  });
  return loginGuardKey(sessionSecret(), ip);
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

export type LoginResult = { ok: true } | { ok: false; reason: 'bad_password' | 'locked' | 'unavailable'; lockedSeconds?: number };

export async function loginWithPassword(password: string, actorName: string): Promise<LoginResult> {
  const key = await clientKey();
  const actor = sanitizeActor(actorName);
  const { recordAdminAudit } = await import('./audit');
  const result = await runLoginGuard(dbGuardStore, key, () => passwordMatches(password, process.env.ADMIN_PASSWORD ?? ''));
  switch (result.outcome) {
    case 'unavailable':
      await recordAdminAudit(actor, 'admin_login_unavailable', 'client', key, {});
      return { ok: false, reason: 'unavailable' };
    case 'locked':
      await recordAdminAudit(actor, 'admin_login_locked', 'client', key, { locked_seconds: result.lockedSeconds });
      return { ok: false, reason: 'locked', lockedSeconds: result.lockedSeconds };
    case 'bad_password':
      await recordAdminAudit(actor, 'admin_login_failed', 'client', key, {});
      return { ok: false, reason: 'bad_password' };
    case 'ok':
      break;
  }
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
