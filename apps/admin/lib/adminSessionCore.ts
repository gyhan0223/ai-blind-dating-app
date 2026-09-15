/**
 * 관리자 세션 토큰 순수 로직 (#27) — Next 에 의존하지 않는다 (Node selftest: scripts/admin-session-selftest.mjs).
 *
 * 예전 방식(쿠키 = sha256(비밀번호) 고정값)은 한 번 새면 비밀번호를 바꾸기 전까지 영원히 유효했다.
 * 새 토큰: base64url(payload) + '.' + HMAC-SHA256(secret, payload)
 *   payload = { v: 1, actor, iat, exp, nonce }
 *   * 만료(exp)가 토큰 안에 있어 12시간 뒤 자동 무효
 *   * secret 은 ADMIN_SESSION_SECRET(없으면 비밀번호에서 파생) — 비밀번호를 바꾸면 모든 세션이 끊긴다
 *   * actor 는 로그인 때 입력한 처리자 이름 — 감사 기록(admin_audit_log.actor)에 남는다
 *
 * 로그인 시도 제한: 메모리 카운터 (프로세스 단위). 5회 실패 → 15분 잠금. 다중 인스턴스에서는 인스턴스별로 적용된다.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

export const SESSION_TTL_SECONDS = 12 * 60 * 60;
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_LOCK_SECONDS = 15 * 60;

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

/** 로그인 시도 제한 — key(예: IP 해시)별 실패 횟수. 잠금 중이면 남은 초를 돌려준다 */
export class LoginAttemptLimiter {
  private failures = new Map<string, { count: number; lockedUntil: number }>();
  private maxFailures: number;
  private lockSeconds: number;
  constructor(maxFailures: number = LOGIN_MAX_FAILURES, lockSeconds: number = LOGIN_LOCK_SECONDS) {
    this.maxFailures = maxFailures;
    this.lockSeconds = lockSeconds;
  }

  lockedFor(key: string, now: number = Date.now()): number {
    const f = this.failures.get(key);
    if (!f) return 0;
    if (f.lockedUntil > now) return Math.ceil((f.lockedUntil - now) / 1000);
    return 0;
  }

  recordFailure(key: string, now: number = Date.now()): number {
    const f = this.failures.get(key) ?? { count: 0, lockedUntil: 0 };
    if (f.lockedUntil > now) return Math.ceil((f.lockedUntil - now) / 1000);
    f.count += 1;
    if (f.count >= this.maxFailures) {
      f.lockedUntil = now + this.lockSeconds * 1000;
      f.count = 0;
    }
    this.failures.set(key, f);
    return f.lockedUntil > now ? this.lockSeconds : 0;
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
  }
}
