/**
 * Edge 남용 방지·베타 강제 순수 판정 (#27/#26) — 외부 의존 없음 (Node selftest 대상).
 * HTTP 응답·Supabase 호출은 ../rateLimit.ts / ../beta.ts 가 감싼다.
 */
export type RpcResult = { data: unknown; error: { message: string } | null };

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; reason: 'rate_limited'; retryAfterSeconds: number }
  | { allowed: false; reason: 'unavailable' };

export type RateLimitRpc = (scope: string, key: string, limit: number, windowSeconds: number) => Promise<RpcResult>;

/** RPC 결과 해석 — 오류·형식 이상은 전부 "거부(unavailable)" (fail-closed) */
export function decideRateLimit(res: RpcResult): RateLimitDecision {
  if (res.error) return { allowed: false, reason: 'unavailable' };
  const d = (res.data && typeof res.data === 'object' ? res.data : null) as Record<string, unknown> | null;
  if (!d || typeof d.allowed !== 'boolean') return { allowed: false, reason: 'unavailable' };
  if (d.allowed) return { allowed: true };
  const retry = typeof d.retry_after_seconds === 'number' ? d.retry_after_seconds : Number(d.retry_after_seconds) || 60;
  return { allowed: false, reason: 'rate_limited', retryAfterSeconds: Math.max(1, Math.floor(retry)) };
}

export async function checkRateLimit(rpc: RateLimitRpc, scope: string, key: string, limit: number, windowSeconds: number): Promise<RateLimitDecision> {
  try {
    return decideRateLimit(await rpc(scope, key, limit, windowSeconds));
  } catch {
    return { allowed: false, reason: 'unavailable' };
  }
}

export type BetaDecision = 'allowed' | 'denied' | 'unavailable';

/** true 만 허용, 그 외(false·null·오류)는 거부 */
export function decideBetaAccess(res: RpcResult): BetaDecision {
  if (res.error) return 'unavailable';
  if (res.data === true) return 'allowed';
  if (res.data === false) return 'denied';
  return 'unavailable';
}
