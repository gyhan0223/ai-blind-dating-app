/**
 * 추천 생성 실행권(claim) 래퍼 (#22) — Edge Function(daily-recommendation, daily-recommendation-batch) 공용.
 *
 * recommendation_run_claim() 으로 (user_id, KST 날짜) 당 한 실행만 코어를 돌린다.
 *  - claimed → runDailyRecommendation → recommendation_run_finish(result)
 *  - busy    → 잠시 기다렸다가 다시 claim (최대 BUSY_RETRIES). 끝내 busy 면 저장된 오늘 추천을 읽어 돌려준다 (in_progress=true)
 *  - skip    → 최근에 끝난 실행이 있다: ok 면 저장된 추천을 읽고, exhausted 면 다시 훑지 않고 exhausted 로 응답 (#23 재시도 주기)
 * 코어가 throw 하면 finish('error') 로 lease 를 닫아 다음 요청이 바로 다시 맡을 수 있게 한다.
 */
import type { DataSource, StoredRecommendation } from './dataSource.ts';
import { runDailyRecommendation, type RunInput, type RunOutcome } from './recommend.ts';

export interface ClaimClient {
  claim(userId: string, forDate: string): Promise<{ claim: 'claimed' | 'busy' | 'skip'; result?: string }>;
  finish(userId: string, forDate: string, result: string, scanned: number, capReached: boolean): Promise<void>;
}

export type ClaimedOutcome =
  | RunOutcome
  | { kind: 'ok'; recommendations: StoredRecommendation[]; dailyLimit: number; exhausted: boolean; scanned: number; capReached: boolean; inProgress?: boolean; skipped?: boolean };

export const BUSY_RETRIES = 4;
export const BUSY_WAIT_MS = 400;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function resultOf(outcome: RunOutcome): string {
  if (outcome.kind === 'ok') return outcome.exhausted ? 'exhausted' : 'ok';
  return outcome.kind;
}

export async function runDailyRecommendationWithClaim(
  ds: DataSource,
  claims: ClaimClient,
  input: RunInput,
  opts: { retries?: number; waitMs?: number } = {},
): Promise<ClaimedOutcome> {
  const retries = opts.retries ?? BUSY_RETRIES;
  const waitMs = opts.waitMs ?? BUSY_WAIT_MS;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const c = await claims.claim(input.userId, input.today);

    if (c.claim === 'claimed') {
      let outcome: RunOutcome;
      try {
        outcome = await runDailyRecommendation(ds, input);
      } catch (e) {
        await claims.finish(input.userId, input.today, 'error', 0, false).catch(() => {});
        throw e;
      }
      const ok = outcome.kind === 'ok';
      await claims
        .finish(input.userId, input.today, resultOf(outcome), ok ? outcome.scanned : 0, ok ? outcome.capReached : false)
        .catch(() => {});
      return outcome;
    }

    if (c.claim === 'skip') {
      const stored = (await ds.recommendationsForDate(input.userId, input.today)).filter((r) => r.status !== 'expired');
      return {
        kind: 'ok',
        recommendations: stored,
        dailyLimit: input.dailyLimit,
        exhausted: c.result === 'exhausted' && stored.length === 0,
        scanned: 0,
        capReached: false,
        skipped: true,
      };
    }

    // busy
    if (attempt < retries) await sleep(waitMs);
  }

  const stored = (await ds.recommendationsForDate(input.userId, input.today)).filter((r) => r.status !== 'expired');
  return {
    kind: 'ok',
    recommendations: stored,
    dailyLimit: input.dailyLimit,
    exhausted: false,
    scanned: 0,
    capReached: false,
    inProgress: stored.length === 0,
  };
}

/** supabase-js(service role) 로 claim/finish RPC 를 호출하는 구현 */
export function supabaseClaimClient(db: {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
}): ClaimClient {
  return {
    async claim(userId, forDate) {
      const { data, error } = await db.rpc('recommendation_run_claim', { p_user_id: userId, p_for_date: forDate });
      if (error) throw new Error(`recommendation_run_claim: ${error.message}`);
      const obj = (data ?? {}) as { claim?: string; result?: string };
      if (obj.claim !== 'claimed' && obj.claim !== 'busy' && obj.claim !== 'skip') {
        throw new Error('recommendation_run_claim: unexpected response');
      }
      return { claim: obj.claim, result: obj.result };
    },
    async finish(userId, forDate, result, scanned, capReached) {
      const { error } = await db.rpc('recommendation_run_finish', {
        p_user_id: userId,
        p_for_date: forDate,
        p_result: result,
        p_scanned: scanned,
        p_cap_reached: capReached,
      });
      if (error) throw new Error(`recommendation_run_finish: ${error.message}`);
    },
  };
}
