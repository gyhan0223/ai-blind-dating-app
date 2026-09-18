/**
 * 추천 생성 실행권(claim) 래퍼 (#22) — Edge Function(daily-recommendation, daily-recommendation-batch) 공용.
 *
 * recommendation_run_claim() 으로 (user_id, KST 날짜) 당 한 실행만 코어를 돌린다.
 *  - claimed → runDailyRecommendation → recommendation_run_finish(result)
 *  - busy    → 잠시 기다렸다가 다시 claim (최대 BUSY_RETRIES). 끝내 busy 면 저장된 오늘 추천을 읽어 돌려준다 (in_progress=true)
 *  - skip    → 최근에 끝난 실행이 있다: ok 면 저장된 추천을 읽고, exhausted 면 다시 훑지 않고 exhausted 로 응답 (#23 재시도 주기),
 *              slots_full 이면 그날은 다시 훑지 않고 slotsFull 로 응답 (#24 — 자리가 생겨도 다음 날 소개부터 재개)
 * 코어가 throw 하면 finish('error') 로 lease 를 닫아 다음 요청이 바로 다시 맡을 수 있게 한다.
 *
 * 관측 (#23): finish 에 eligibleCount(적격 후보 수, 훑지 않았으면 null) · 이번 실행이 저장한 추천 id · 실패 단계를 함께 넘긴다.
 *  - 전략 라벨은 DB 가 저장된 추천 행에서 읽어 기록한다 (호출자 주장이 아니라 저장 행 기준). 분석 이벤트는 insert 트리거가 1회 기록한다.
 *  - skip/busy 는 finish 를 부르지 않는다 — 같은 대기 결과를 다시 조회해도 실행 기록·집계가 늘지 않는다.
 *  - skip(exhausted) 응답의 cap_reached 를 그대로 돌려줘 앱이 "탐색 상한" 과 "적격 후보 없음" 을 구분한다.
 */
import type { DataSource, StoredRecommendation } from './dataSource.ts';
import { runDailyRecommendation, type RunInput, type RunOutcome } from './recommend.ts';

/** finish 에 함께 기록하는 관측값 (#23) */
export interface RunFinishDetails {
  /** 적격 후보 수 — 훑지 않은 실행은 null(미측정) */
  eligible: number | null;
  /** 이번 실행이 새로 저장한 추천 id (첫 번째) — 없으면 null */
  recommendationId: string | null;
  /** lookup_failed / error 의 실패 단계 — 그 외 null */
  errorStage: string | null;
}

export interface ClaimClient {
  claim(userId: string, forDate: string): Promise<{ claim: 'claimed' | 'busy' | 'skip'; result?: string; capReached?: boolean }>;
  finish(userId: string, forDate: string, result: string, scanned: number, capReached: boolean, details?: RunFinishDetails): Promise<void>;
}

export type ClaimedOutcome =
  | RunOutcome
  | {
      kind: 'ok';
      recommendations: StoredRecommendation[];
      dailyLimit: number;
      exhausted: boolean;
      scanned: number;
      capReached: boolean;
      eligibleCount: number | null;
      createdIds: string[];
      slotsFull?: boolean;
      inProgress?: boolean;
      skipped?: boolean;
    };

export const BUSY_RETRIES = 4;
export const BUSY_WAIT_MS = 400;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function resultOf(outcome: RunOutcome): string {
  if (outcome.kind === 'ok') return outcome.slotsFull ? 'slots_full' : outcome.exhausted ? 'exhausted' : 'ok';
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
        await claims
          .finish(input.userId, input.today, 'error', 0, false, { eligible: null, recommendationId: null, errorStage: 'exception' })
          .catch(() => {});
        throw e;
      }
      const ok = outcome.kind === 'ok';
      const details: RunFinishDetails = {
        eligible: ok ? outcome.eligibleCount : null,
        recommendationId: ok ? (outcome.createdIds[0] ?? null) : null,
        errorStage: outcome.kind === 'lookup_failed' ? outcome.stage : null,
      };
      await claims
        .finish(input.userId, input.today, resultOf(outcome), ok ? outcome.scanned : 0, ok ? outcome.capReached : false, details)
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
        // 저장된 실행 기록의 상한 도달 여부 — 이번 요청은 훑지 않았다
        capReached: c.result === 'exhausted' && stored.length === 0 && c.capReached === true,
        eligibleCount: null,
        createdIds: [],
        slotsFull: c.result === 'slots_full' && stored.length === 0,
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
    eligibleCount: null,
    createdIds: [],
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
      const obj = (data ?? {}) as { claim?: string; result?: string; cap_reached?: boolean };
      if (obj.claim !== 'claimed' && obj.claim !== 'busy' && obj.claim !== 'skip') {
        throw new Error('recommendation_run_claim: unexpected response');
      }
      return { claim: obj.claim, result: obj.result, capReached: obj.cap_reached === true };
    },
    async finish(userId, forDate, result, scanned, capReached, details) {
      const { error } = await db.rpc('recommendation_run_finish', {
        p_user_id: userId,
        p_for_date: forDate,
        p_result: result,
        p_scanned: scanned,
        p_cap_reached: capReached,
        p_eligible: details?.eligible ?? null,
        p_recommendation_id: details?.recommendationId ?? null,
        p_error_stage: details?.errorStage ?? null,
      });
      if (error) throw new Error(`recommendation_run_finish: ${error.message}`);
    },
  };
}
