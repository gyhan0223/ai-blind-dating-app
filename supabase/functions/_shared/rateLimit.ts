/**
 * Edge Function 남용 방지 (#27) — DB RPC rate_limit_hit(scope, key, limit, window) 고정 창 카운터를 쓴다 (0023).
 *
 *  * fail-closed: RPC 오류(마이그레이션 미적용·DB 장애)면 "허용" 이 아니라 "거부(503)" 다 — send-sms 의 sms_otp_rate_limit_check 와 같은 원칙.
 *  * key 는 사용자 id 처럼 이미 서버가 아는 값만 쓴다. 전화번호·이메일 원문을 key 로 쓰지 않는다.
 *  * 응답에는 retry_after_seconds 만 담는다. 순수 판정은 security/core.ts (selftest).
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { json } from './http.ts';
import { checkRateLimit, type RateLimitDecision, type RateLimitRpc } from './security/core.ts';

export function supabaseRateLimitRpc(db: SupabaseClient): RateLimitRpc {
  return (scope, key, limit, windowSeconds) =>
    db.rpc('rate_limit_hit', { p_scope: scope, p_key: key, p_limit: limit, p_window_seconds: windowSeconds }) as Promise<{ data: unknown; error: { message: string } | null }>;
}

/** 거부 결정을 HTTP 응답으로 (429 + Retry-After, 또는 503) */
export function rateLimitResponse(decision: Exclude<RateLimitDecision, { allowed: true }>, fn: string): Response {
  if (decision.reason === 'rate_limited') {
    const res = json({ error: 'rate_limited', retry_after_seconds: decision.retryAfterSeconds }, 429);
    res.headers.set('Retry-After', String(decision.retryAfterSeconds));
    return res;
  }
  console.error(`[${fn}] rate limit unavailable — refusing request (fail-closed)`);
  return json({ error: 'rate_limit_unavailable' }, 503);
}

/**
 * 한 줄 사용: `const rl = await enforceRateLimit(db, 'icebreaker', userId, 30, 3600, 'icebreaker'); if (rl) return rl;`
 * 허용이면 null, 거부면 응답.
 */
export async function enforceRateLimit(
  db: SupabaseClient,
  scope: string,
  key: string,
  limit: number,
  windowSeconds: number,
  fn: string,
): Promise<Response | null> {
  const decision = await checkRateLimit(supabaseRateLimitRpc(db), scope, key, limit, windowSeconds);
  if (decision.allowed) return null;
  return rateLimitResponse(decision, fn);
}
