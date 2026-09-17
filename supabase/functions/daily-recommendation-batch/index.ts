/**
 * 하루 1명 추천 배치 (#22) — 스케줄러(pg_cron / 외부 cron)가 service role 로 호출한다. 사용자 JWT 로는 401.
 *
 * POST { after?: uuid, max_users?: number, retry_after_seconds?: number }
 *   → { for_date, retry_after_seconds, processed, created, exhausted, exhausted_cap_reached, slots_full, skipped, failed, next_after }
 *    (exhausted_cap_reached 는 exhausted 중 탐색 상한에 걸린 수 — 관측용. 사용자별 적격 후보 수는 recommendation_runs 에 기록된다, #23)
 *
 *  * 대상: recommendation_batch_targets() — 자격(active·온보딩·인증) 있고, 오늘(KST) 추천이 없고,
 *    다른 실행이 진행 중이거나 오늘 ok/slots_full 로 끝났거나 retry_after_seconds 안에 exhausted 로 끝난 사용자는 제외.
 *    → 한 번 돌고 나면 "기다리는 사용자(후보 없음)" 만 남는다. 매시간 폴링의 비용은 그 사용자 수에 비례한다.
 *  * 사용자별로 recommendation_run_claim → 코어 → finish. 앱 요청과 같은 잠금을 쓰므로 둘이 겹쳐도 하루 1명이다.
 *  * 한 번 호출에 max_users(기본 100, 최대 300)명까지 처리하고 next_after 를 돌려준다. 다음 호출이 이어서 처리한다.
 *    같은 날 여러 번 호출해도 새 행이 생기지 않는다 (멱등).
 *  * 후보 부족 자동 재확인 (#22/#23): 후보 없음(exhausted)은 그날 소개 완료가 아니다. 배치가 KST 09:00~21:45 매시간(15분 페이지 간격)
 *    돌면서 창(retry_after_seconds, 기본 50분 — _shared/matching/batchRetryWindow.ts)이 지난 후보 부족 사용자를 앱 미접속 중에도 다시 훑는다.
 *    창을 1시간이 아니라 50분으로 두는 이유: 매시간 :00 cron 과 정확히 1시간 창을 함께 쓰면 09:00:05 에 끝난 사용자가 10:00:00 에 빠져 두 시간에 한 번이 된다.
 *    앱의 daily-recommendation 은 기본 1시간 창을 그대로 쓴다 (앱 "다시 확인" 이 서버 주기를 우회하지 않는다).
 *  * 알림 (#17): 소개가 실제로 저장될 때만 recommendations insert 트리거가 notification_events 에 1건(dedupe) 넣는다.
 *    재확인만 반복하는 동안에는 이벤트가 생기지 않는다. 배치는 알림을 직접 만들지 않는다.
 *  * 스케줄 예시(docs/matching-policy.md 10절): '0,15,30,45 0-12 * * *'(UTC) = KST 09:00~21:45.
 *    앱은 여전히 daily-recommendation 을 호출하므로 배치가 아직 안 돌았어도 열면 바로 생성된다.
 */
import { corsHeaders, json, requireServiceRole, serviceClient } from '../_shared/http.ts';
import { resolveRetryAfterSeconds } from '../_shared/matching/batchRetryWindow.ts';
import { runDailyRecommendationWithClaim, supabaseClaimClient } from '../_shared/matching/runWithClaim.ts';
import { supabaseDataSource } from '../_shared/matching/supabaseDataSource.ts';
import { reportServerError } from '../_shared/observability/report.ts';

const DEFAULT_MAX_USERS = 100;
const HARD_MAX_USERS = 300;

function seoulToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const gate = requireServiceRole(req);
  if (gate instanceof Response) return gate;

  const body = (await req.json().catch(() => ({}))) as { after?: string; max_users?: number; retry_after_seconds?: number };
  const maxUsers = Math.max(1, Math.min(HARD_MAX_USERS, Number(body.max_users) || DEFAULT_MAX_USERS));
  const after = typeof body.after === 'string' && body.after ? body.after : null;
  const retryAfterSeconds = resolveRetryAfterSeconds(body.retry_after_seconds);
  const forDate = seoulToday();
  const nowYear = Number(forDate.slice(0, 4));

  const db = serviceClient();
  const { data: targets, error } = await db.rpc('recommendation_batch_targets', {
    p_for_date: forDate,
    p_after: after,
    p_limit: maxUsers,
    p_retry_after_seconds: retryAfterSeconds,
  });
  if (error) {
    await reportServerError(db, 'daily-recommendation-batch', new Error(error.message), { stage: 'targets' });
    return json({ error: 'lookup_failed' }, 500);
  }
  const ids = ((targets ?? []) as { user_id: string }[]).map((t) => t.user_id);

  const ds = supabaseDataSource(db);
  const claims = supabaseClaimClient(db, { retryAfterSeconds });
  const counts = { processed: 0, created: 0, exhausted: 0, exhausted_cap_reached: 0, slots_full: 0, skipped: 0, failed: 0 };
  for (const userId of ids) {
    counts.processed += 1;
    try {
      // 배치는 busy 를 기다리지 않는다 (앱 요청이 맡고 있으면 그쪽이 끝낸다)
      const outcome = await runDailyRecommendationWithClaim(ds, claims, { userId, today: forDate, nowYear, dailyLimit: 1 }, { retries: 0 });
      if (outcome.kind !== 'ok') counts.failed += 1;
      else if ('skipped' in outcome && outcome.skipped) counts.skipped += 1;
      else if ('inProgress' in outcome && outcome.inProgress) counts.skipped += 1;
      else if (outcome.slotsFull) counts.slots_full += 1;
      else if (outcome.exhausted) {
        counts.exhausted += 1;
        if (outcome.capReached) counts.exhausted_cap_reached += 1;
      } else counts.created += 1;
    } catch (e) {
      counts.failed += 1;
      await reportServerError(db, 'daily-recommendation-batch', e, { stage: 'user', user_id: userId });
    }
  }

  return json({
    for_date: forDate,
    retry_after_seconds: retryAfterSeconds,
    ...counts,
    next_after: ids.length === maxUsers ? ids[ids.length - 1] : null,
  });
});
