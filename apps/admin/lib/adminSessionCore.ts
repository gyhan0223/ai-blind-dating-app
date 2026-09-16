/**
 * 관리자 세션 토큰·로그인 제한 순수 로직 (#27) — Next 에 의존하지 않는다 (Node selftest: scripts/admin-session-selftest.mjs).
 *
 * 예전 방식(쿠키 = sha256(비밀번호) 고정값)은 한 번 새면 비밀번호를 바꾸기 전까지 영원히 유효했다.
 * 새 토큰: base64url(payload) + '.' + HMAC-SHA256(secret, payload)
 *   payload = { v: 1, actor, iat, exp, nonce }
 *   * 만료(exp)가 토큰 안에 있어 12시간 뒤 자동 무효
 *   * secret 은 ADMIN_SESSION_SECRET — production 에서는 필수(32자+). development 에서만 비밀번호에서 파생하는 fallback 을 허용한다
 *   * actor 는 로그인 때 입력한 처리자 이름 — 감사 기록(admin_audit_log.actor)에 남는다
 *
 * 로그인 시도 제한 (DB 공유 — 0031 admin_login_guard):
 *   * 키 = HMAC(session secret, 클라이언트 IP) — 원문 IP 는 DB 에 저장하지 않는다. 처리자 이름(사용자 입력)은 키에 쓰지 않는다.
 *   * 5회 실패 → 15분 잠금. 여러 인스턴스·재시작에 걸쳐 같은 상태를 본다.
 *   * 제한 조회/기록이 실패하면 로그인하지 않는다 (fail-closed).
 *   * 프록시 헤더(x-forwarded-for / x-real-ip)는 ADMIN_TRUST_PROXY_HEADERS=1 일 때만 믿는다. 아니면 모든 클라이언트가 한 키를 공유한다
 *     (헤더 위조로 제한을 피할 수 없다. 대신 한 공격자가 모든 운영자를 잠글 수 있으므로 신뢰할 수 있는 프록시 뒤에서는 1 로 설정한다).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

export const SESSION_TTL_SECONDS = 12 * 60 * 60;
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_LOCK_SECONDS = 15 * 60;
/** production 에서 요구하는 ADMIN_SESSION_SECRET 최소 길이 */
export const SESSION_SECRET_MIN_LENGTH_PROD = 32;
export const SESSION_SECRET_MIN_LENGTH_DEV = 16;

export type SessionPayload = { v: 1; actor: string; iat: number; exp: number; nonce: string };

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

export function sanitizeActor(raw: string | null | undefined): string {
  const t = (raw ?? '').trim().replace(/[\r\n\t]/g, ' ').slice(0, 40);
  return t.length > 0 ? t : 'admin';
}

export function issueSessionToken(secret: string, actor: string, now: number = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const payload: SessionPayload = { v: 1, actor: sanitizeActor(actor), iat, exp: iat + SESSION_TTL_SECONDS, nonce: b64url(randomBytes(12)) };
  const p = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${p}.${sign(secret, p)}`;
}

/** 유효하면 payload, 아니면 null (서명 불일치·만료·형식 오류·secret 다름) */
export function verifySessionToken(secret: string, token: string | null | undefined, now: number = Date.now()): SessionPayload | null {
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
  let payload: SessionPayload;
  try {
    payload = JSON.parse(raw.toString('utf8')) as SessionPayload;
  } catch {
    return null;
  }
  if (payload.v !== 1 || typeof payload.exp !== 'number' || typeof payload.actor !== 'string') return null;
  if (payload.exp * 1000 <= now) return null;
  return payload;
}

/** 비밀번호 비교 — 길이가 달라도 상수 시간에 가깝게 */
export function passwordMatches(input: string, expected: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(input, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // 길이 차이로 빨리 끝나지 않도록 같은 길이 비교를 한 번 수행한다
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// 세션 secret — production 은 명시적 ADMIN_SESSION_SECRET 만, development 는 비밀번호 파생 fallback 허용
// ---------------------------------------------------------------------------

export type SessionSecretResult =
  | { ok: true; secret: string; source: 'explicit' | 'derived_dev' }
  | { ok: false; reason: 'missing_in_production' | 'too_short' | 'password_missing' };

export function resolveAdminSessionSecret(env: {
  nodeEnv: string | undefined;
  sessionSecret: string | undefined;
  password: string | undefined;
}): SessionSecretResult {
  const isProd = env.nodeEnv === 'production';
  const explicit = (env.sessionSecret ?? '').trim();
  if (explicit) {
    const min = isProd ? SESSION_SECRET_MIN_LENGTH_PROD : SESSION_SECRET_MIN_LENGTH_DEV;
    if (explicit.length < min) return { ok: false, reason: 'too_short' };
    return { ok: true, secret: explicit, source: 'explicit' };
  }
  if (isProd) return { ok: false, reason: 'missing_in_production' };
  if (!env.password) return { ok: false, reason: 'password_missing' };
  return { ok: true, secret: createHash('sha256').update(`bonsim-admin-session:${env.password}`).digest('hex'), source: 'derived_dev' };
}

// ---------------------------------------------------------------------------
// 클라이언트 키 — 프록시 헤더 신뢰 경계 + HMAC
// ---------------------------------------------------------------------------

export function resolveClientIp(input: { trustProxyHeaders: boolean; xForwardedFor: string | null; xRealIp: string | null }): string {
  if (!input.trustProxyHeaders) return 'untrusted-client';
  // x-forwarded-for 는 "client, proxy1, proxy2" — 신뢰할 수 있는 프록시가 덮어쓴다는 전제에서 첫 항목
  const xff = (input.xForwardedFor ?? '').split(',')[0].trim();
  const ip = xff || (input.xRealIp ?? '').trim();
  return ip || 'untrusted-client';
}

/** DB 에 저장되는 키 — 원문 IP 대신 서버 secret 기반 HMAC (길이 8 이상 보장) */
export function loginGuardKey(secret: string, ip: string): string {
  return `ip:${createHmac('sha256', secret).update(`admin-login:${ip}`).digest('hex').slice(0, 40)}`;
}

// ---------------------------------------------------------------------------
// 로그인 제한 — 저장소 인터페이스 (DB RPC admin_login_guard) + 판정 흐름
// ---------------------------------------------------------------------------

export type GuardEvent = 'check' | 'failure' | 'success';
export type GuardHit = { locked: boolean; lockedSeconds: number; failures: number };

export interface LoginGuardStore {
  /** 실패(null)는 "제한을 판정할 수 없음" — 호출자는 로그인을 허용하지 않는다 */
  hit(key: string, event: GuardEvent): Promise<GuardHit | null>;
}

export type LoginOutcome =
  | { outcome: 'ok' }
  | { outcome: 'bad_password' }
  | { outcome: 'locked'; lockedSeconds: number }
  | { outcome: 'unavailable' };

/**
 * 로그인 판정 흐름 — 잠금 확인 → 비밀번호 검증 → 실패/성공 기록. 어느 단계든 저장소가 응답하지 않으면 unavailable (세션 미발급).
 * 잠금 중에는 비밀번호가 맞아도 로그인하지 않는다 (비밀번호 검증 결과가 잠금 판단에 새지 않도록 잠금을 먼저 본다).
 */
export async function runLoginGuard(store: LoginGuardStore, key: string, passwordOk: () => boolean): Promise<LoginOutcome> {
  const before = await store.hit(key, 'check');
  if (!before) return { outcome: 'unavailable' };
  if (before.locked) return { outcome: 'locked', lockedSeconds: before.lockedSeconds };
  if (!passwordOk()) {
    const after = await store.hit(key, 'failure');
    if (!after) return { outcome: 'unavailable' };
    return after.locked ? { outcome: 'locked', lockedSeconds: after.lockedSeconds } : { outcome: 'bad_password' };
  }
  const reset = await store.hit(key, 'success');
  if (!reset) return { outcome: 'unavailable' };
  return { outcome: 'ok' };
}

/**
 * admin_login_guard RPC 와 같은 규칙의 순수 구현 (selftest 용 인메모리 저장소 + 문서화된 규칙).
 * 실제 저장소는 DB 이며 동시성은 행 잠금이 보장한다.
 */
export type GuardState = { failures: number; lockedUntil: number };

export function applyGuardEvent(
  state: GuardState | undefined,
  event: GuardEvent,
  now: number,
  maxFailures: number = LOGIN_MAX_FAILURES,
  lockSeconds: number = LOGIN_LOCK_SECONDS,
): { next: GuardState | undefined; hit: GuardHit } {
  const cur = state ?? { failures: 0, lockedUntil: 0 };
  const lockedRemaining = cur.lockedUntil > now ? Math.max(1, Math.ceil((cur.lockedUntil - now) / 1000)) : 0;
  if (event === 'success') return { next: undefined, hit: { locked: false, lockedSeconds: 0, failures: 0 } };
  if (event === 'check') {
    return { next: state, hit: { locked: lockedRemaining > 0, lockedSeconds: lockedRemaining, failures: cur.failures } };
  }
  if (lockedRemaining > 0) return { next: cur, hit: { locked: true, lockedSeconds: lockedRemaining, failures: cur.failures } };
  const failures = (cur.lockedUntil > 0 && cur.lockedUntil <= now ? 0 : cur.failures) + 1;
  if (failures >= maxFailures) {
    return { next: { failures: 0, lockedUntil: now + lockSeconds * 1000 }, hit: { locked: true, lockedSeconds: lockSeconds, failures: 0 } };
  }
  return { next: { failures, lockedUntil: 0 }, hit: { locked: false, lockedSeconds: 0, failures } };
}
