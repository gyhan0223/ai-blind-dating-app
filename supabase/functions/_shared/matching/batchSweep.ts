/**
 * 하루 1명 추천 배치 sweep — 순수 오케스트레이션 (#22). daily-recommendation-batch Edge Function 이 얇게 감싼다.
 *
 * 한 호출(sweep 조각)이 하는 일
 *  1. 커서 claim: recommendation_batch_cursor 의 lease 를 잡는다. 다른 호출이 진행 중이면 아무것도 하지 않는다 (cron 겹침 안전).
 *  2. 저장된 after(같은 KST 날짜일 때만) 부터 recommendation_batch_targets 를 페이지(pageSize)로 읽어 사용자별로
 *     claim → 코어 → finish(runDailyRecommendationWithClaim) 를 돈다. 앱 요청과 같은 잠금이라 둘이 겹쳐도 하루 1명이다.
 *  3. 페이지가 끝날 때마다 after 를 저장한다 → 중간에 끊겨도(실행 시간 초과·크래시) 다음 호출이 그 자리부터 이어간다.
 *  4. 멈추는 조건: 대상 소진(sweep 완료 → after=null, 다음은 처음부터) · 시간 예산(timeBudgetMs) · 최대 페이지(maxPages) ·
 *     KST 날짜 변경(자정을 넘기면 for_date 가 섞이지 않게 즉시 멈춘다 — 다음 호출이 새 날짜로 처음부터 시작).
 *
 * 왜 이 방식인가
 *  * 대상 조회는 이미 "오늘 추천 있음 / 진행 중 / 최근 exhausted·failed" 를 뺀다. 여기에 저장 커서를 더하면 대상이 한 묶음보다 많아도
 *    호출마다 다음 자리부터 이어가므로 앞쪽 사용자의 1시간 재시도가 뒤쪽 사용자를 밀어내지 못한다 (round-robin).
 *  * 사용자마다 cron 을 만들거나 함수를 병렬로 부르지 않는다. 한 호출은 순차·유한(시간·페이지 상한)이다.
 *  * 사용자 한 명의 실패는 그 사용자만 failed 로 기록하고(finish) 나머지는 계속 처리한다. failed 는 대상 조회가 15분 뒤에 다시 준다.
 *
 * 시간·날짜는 주입(clock)한다 — 테스트가 실제로 기다리지 않는다.
 */
import type { ClaimedOutcome } from './runWithClaim.ts';

export const DEFAULT_PAGE_SIZE = 100;
export const HARD_MAX_PAGE_SIZE = 300;
export const DEFAULT_TIME_BUDGET_MS = 50_000;
export const HARD_MAX_TIME_BUDGET_MS = 120_000;
export const DEFAULT_MAX_PAGES = 20;
export const HARD_MAX_PAGES = 50;

export interface SweepDeps {
  /** 현재 시각 (테스트에서 제어) */
  now(): Date;
  /** KST 날짜 YYYY-MM-DD */
  seoulToday(now: Date): string;
  /** 커서 잠금 — claimed=false 면 다른 sweep 이 진행 중 */
  cursorClaim(forDate: string): Promise<{ claimed: boolean; after: string | null }>;
  /** 진행 저장 — nextAfter=null 은 sweep 완료. release=true 면 lease 해제 */
  cursorSave(forDate: string, nextAfter: string | null, release: boolean): Promise<void>;
  /** 대상 페이지 (id 오름차순, after 다음부터) */
  targets(forDate: string, after: string | null, limit: number): Promise<string[]>;
  /** 사용자 한 명 처리 — runDailyRecommendationWithClaim. throw 하면 failed 로 센다 */
  processUser(userId: string, forDate: string, nowYear: number): Promise<ClaimedOutcome>;
  /** 사용자 처리 예외 보고 (throw 하지 않는다) */
  reportError(error: unknown, context: Record<string, unknown>): Promise<void>;
}

export interface SweepOptions {
  pageSize?: number;
  timeBudgetMs?: number;
  maxPages?: number;
  /** 명시 커서 — 주어지면(null 포함) 저장된 커서 대신 여기서 시작한다 (수동 실행용) */
  after?: string | null;
}

export type StopReason = 'completed' | 'time_budget' | 'max_pages' | 'date_changed' | 'sweep_in_progress';

export interface SweepCounts {
  processed: number;
  created: number;
  exhausted: number;
  exhausted_cap_reached: number;
  slots_full: number;
  skipped: number;
  failed: number;
}

export interface SweepResult extends SweepCounts {
  for_date: string;
  pages: number;
  /** 다음 호출이 이어갈 위치 (null = 처음부터) */
  next_after: string | null;
  sweep_completed: boolean;
  stopped_reason: StopReason;
  elapsed_ms: number;
}

export function clampOptions(opts: SweepOptions): Required<Pick<SweepOptions, 'pageSize' | 'timeBudgetMs' | 'maxPages'>> {
  const num = (v: unknown, def: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.max(1, Math.min(max, Math.floor(n))) : def;
  };
  return {
    pageSize: num(opts.pageSize, DEFAULT_PAGE_SIZE, HARD_MAX_PAGE_SIZE),
    timeBudgetMs: num(opts.timeBudgetMs, DEFAULT_TIME_BUDGET_MS, HARD_MAX_TIME_BUDGET_MS),
    maxPages: num(opts.maxPages, DEFAULT_MAX_PAGES, HARD_MAX_PAGES),
  };
}

/** 실행 결과 → 집계 항목 (배치 응답과 관측용) */
export function countOutcome(counts: SweepCounts, outcome: ClaimedOutcome): void {
  if (outcome.kind !== 'ok') counts.failed += 1;
  else if ('skipped' in outcome && outcome.skipped) counts.skipped += 1;
  else if ('inProgress' in outcome && outcome.inProgress) counts.skipped += 1;
  else if (outcome.slotsFull) counts.slots_full += 1;
  else if (outcome.exhausted) {
    counts.exhausted += 1;
    if (outcome.capReached) counts.exhausted_cap_reached += 1;
  } else counts.created += 1;
}

export async function runBatchSweep(deps: SweepDeps, options: SweepOptions = {}): Promise<SweepResult> {
  const { pageSize, timeBudgetMs, maxPages } = clampOptions(options);
  const started = deps.now();
  const forDate = deps.seoulToday(started);
  const nowYear = Number(forDate.slice(0, 4));
  const counts: SweepCounts = { processed: 0, created: 0, exhausted: 0, exhausted_cap_reached: 0, slots_full: 0, skipped: 0, failed: 0 };
  const elapsed = () => deps.now().getTime() - started.getTime();

  const claim = await deps.cursorClaim(forDate);
  if (!claim.claimed) {
    return { for_date: forDate, ...counts, pages: 0, next_after: null, sweep_completed: false, stopped_reason: 'sweep_in_progress', elapsed_ms: elapsed() };
  }

  let after: string | null = options.after !== undefined ? options.after : claim.after;
  let pages = 0;
  let stopped: StopReason | null = null;

  try {
    while (stopped === null) {
      if (pages >= maxPages) {
        stopped = 'max_pages';
        break;
      }
      const ids = await deps.targets(forDate, after, pageSize);
      if (ids.length === 0) {
        after = null;
        stopped = 'completed';
        break;
      }
      pages += 1;
      for (const userId of ids) {
        // 자정을 넘기면 이 호출의 for_date 로 더 만들지 않는다 — 다음 호출이 새 날짜로 처음부터
        if (deps.seoulToday(deps.now()) !== forDate) {
          stopped = 'date_changed';
          break;
        }
        if (elapsed() >= timeBudgetMs) {
          stopped = 'time_budget';
          break;
        }
        counts.processed += 1;
        try {
          countOutcome(counts, await deps.processUser(userId, forDate, nowYear));
        } catch (e) {
          counts.failed += 1;
          await deps.reportError(e, { stage: 'user', user_id: userId, for_date: forDate });
        }
        after = userId; // 처리(시도)한 마지막 사용자 — 다음 페이지/호출은 그 다음부터
      }
      if (stopped !== null) break;
      if (ids.length < pageSize) {
        after = null;
        stopped = 'completed';
        break;
      }
      // 페이지 경계마다 저장 — 이 뒤에 끊겨도 다음 호출이 여기서 이어간다
      await deps.cursorSave(forDate, after, false);
    }
  } finally {
    // 날짜가 바뀌었으면 저장된 for_date 와 달라 after 는 무시된다 (cursor_save 가 lease 만 놓는다)
    await deps.cursorSave(forDate, stopped === 'completed' ? null : after, true).catch(() => {});
  }

  return {
    for_date: forDate,
    ...counts,
    pages,
    next_after: stopped === 'completed' ? null : after,
    sweep_completed: stopped === 'completed',
    stopped_reason: stopped ?? 'completed',
    elapsed_ms: elapsed(),
  };
}
