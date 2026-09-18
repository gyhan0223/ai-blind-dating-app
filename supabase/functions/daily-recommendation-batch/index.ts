/**
 * 하루 1명 추천 배치 (#22) — 스케줄러(pg_cron / 외부 cron)가 service role 로 호출한다. 사용자 JWT 로는 401.
 *
 * POST { after?: uuid|null, max_users?: number, time_budget_ms?: number, max_pages?: number }
 *   → { for_date, processed, created, exhausted, exhausted_cap_reached, slots_full, skipped, failed,
 *       pages, next_after, sweep_completed, stopped_reason, elapsed_ms }
 *    (exhausted_cap_reached 는 exhausted 중 탐색 상한에 걸린 수 — 관측용. 사용자별 적격 후보 수는 recommendation_runs 에 기록된다, #23)
 *
 *  * 대상: recommendation_batch_targets() — 자격(active·온보딩·인증) 있고, 오늘(KST) 추천이 없고, 진행 중 실행이 없고,
 *    최근 1시간 안에 exhausted 로 끝나지 않았고(#23 재탐색 간격), 최근 15분 안에 failed 로 끝나지 않은 사용자. id 순.
 *  * 사용자별로 recommendation_run_claim → 코어 → finish. 앱 요청과 같은 잠금을 쓰므로 둘이 겹쳐도 하루 1명이다.
 *  * 진행 위치(after)는 recommendation_batch_cursor 에 저장된다 (_shared/matching/batchSweep.ts):
 *    한 호출은 max_users 명씩 페이지를 돌며 time_budget_ms(기본 50초, 최대 120초)·max_pages(기본 20) 안에서 멈추고,
 *    다음 호출이 저장된 위치부터 이어간다. 끝까지 훑으면 다음 호출은 처음부터. 다른 호출이 진행 중이면(lease) 건너뛴다.
 *    KST 날짜가 바뀌면 즉시 멈춘다 (다음 호출이 새 날짜로 시작).
 *  * body.after 를 명시하면(null 포함) 저장된 커서 대신 거기서 시작한다 — 수동 실행용. 평소 cron 은 보내지 않는다.
 *  * 후보 부족으로 끝난 사용자는 그날 소개를 받은 것으로 치지 않는다 — 1시간 뒤 다시 대상이 되어, 앱을 열지 않아도
 *    적격 후보가 생기면 소개가 저장되고 outbox 트리거(recommendations_notify)가 알림 이벤트를 만든다 (#17 send-push).
 *  * 스케줄: 하루 전체 15분 간격 (docs/matching-policy.md 10절, supabase/scripts/schedule-recommendation-cron.sql).
 *    앱은 여전히 daily-recommendation 을 호출하므로 배치가 아직 안 돌았어도 열면 바로 생성된다.
 */
import { corsHeaders, json, requireServiceRole, serviceClient } from '../_shared/http.ts';
import { runBatchSweep, type SweepDeps } from '../_shared/matching/batchSweep.ts';
import { runDailyRecommendationWithClaim, supabaseClaimClient } from '../_shared/matching/runWithClaim.ts';
import { supabaseDataSource } from '../_shared/matching/supabaseDataSource.ts';
import { reportServerError } from '../_shared/observability/report.ts';

/** 커서 lease — 한 호출의 최대 실행 시간(time_budget 상한 120초)보다 길어야 한다 */
const CURSOR_LEASE_SECONDS = 180;

export function seoulToday(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const gate = requireServiceRole(req);
  if (gate instanceof Response) return gate;

  const body = (await req.json().catch(() => ({}))) as {
    after?: string | null;
    max_users?: number;
    time_budget_ms?: number;
    max_pages?: number;
  };
  const explicitAfter = 'after' in body ? (typeof body.after === 'string' && body.after ? body.after : null) : undefined;

  const db = serviceClient();
  const ds = supabaseDataSource(db);
  const claims = supabaseClaimClient(db);

  const deps: SweepDeps = {
    now: () => new Date(),
    seoulToday,
    async cursorClaim(forDate) {
      const { data, error } = await db.rpc('recommendation_batch_cursor_claim', { p_for_date: forDate, p_lease_seconds: CURSOR_LEASE_SECONDS });
      if (error) throw new Error(`recommendation_batch_cursor_claim: ${error.message}`);
      const obj = (data ?? {}) as { claimed?: boolean; after?: string | null };
      return { claimed: obj.claimed === true, after: typeof obj.after === 'string' ? obj.after : null };
    },
    async cursorSave(forDate, nextAfter, release) {
      const { error } = await db.rpc('recommendation_batch_cursor_save', {
        p_for_date: forDate,
        p_next_after: nextAfter,
        p_release: release,
        p_lease_seconds: CURSOR_LEASE_SECONDS,
      });
      if (error) throw new Error(`recommendation_batch_cursor_save: ${error.message}`);
    },
    async targets(forDate, after, limit) {
      const { data, error } = await db.rpc('recommendation_batch_targets', { p_for_date: forDate, p_after: after, p_limit: limit });
      if (error) throw new Error(`recommendation_batch_targets: ${error.message}`);
      return ((data ?? []) as { user_id: string }[]).map((t) => t.user_id);
    },
    // 배치는 busy 를 기다리지 않는다 (앱 요청이 맡고 있으면 그쪽이 끝낸다)
    processUser: (userId, forDate, nowYear) =>
      runDailyRecommendationWithClaim(ds, claims, { userId, today: forDate, nowYear, dailyLimit: 1 }, { retries: 0 }),
    reportError: (e, context) => reportServerError(db, 'daily-recommendation-batch', e, context),
  };

  try {
    const result = await runBatchSweep(deps, {
      pageSize: body.max_users,
      timeBudgetMs: body.time_budget_ms,
      maxPages: body.max_pages,
      after: explicitAfter,
    });
    return json(result);
  } catch (e) {
    // 대상 조회·커서 RPC 실패 — 사용자별 실패는 runBatchSweep 안에서 세고 여기로 오지 않는다
    await reportServerError(db, 'daily-recommendation-batch', e, { stage: 'sweep' });
    return json({ error: 'lookup_failed' }, 500);
  }
});
