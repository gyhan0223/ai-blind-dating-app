/**
 * 하루 1명 추천 배치 (#22) — 스케줄러(pg_cron / 외부 cron)가 service role 로 호출한다. 사용자 JWT 로는 401.
 *
 * POST { after?: uuid, max_users?: number } → { for_date, processed, created, exhausted, skipped, failed, next_after }
 *
 *  * 대상: recommendation_batch_targets() — 자격(active·온보딩·인증) 있고, 오늘(KST) 추천이 없고,
 *    다른 실행이 진행 중이거나 최근 1시간 안에 exhausted 로 끝난 사용자는 제외.
 *  * 사용자별로 recommendation_run_claim → 코어 → finish. 앱 요청과 같은 잠금을 쓰므로 둘이 겹쳐도 하루 1명이다.
 *  * 한 번 호출에 max_users(기본 100, 최대 300)명까지 처리하고 next_after 를 돌려준다. 다음 호출이 이어서 처리한다.
 *    같은 날 여러 번 호출해도 새 행이 생기지 않는다 (멱등).
 *  * 스케줄 예시(docs/matching-policy.md 10절): KST 09:00 부터 15분 간격으로 호출 → 아침에 모든 사용자에게 오늘 소개가 준비된다.
 *    앱은 여전히 daily-recommendation 을 호출하므로 배치가 아직 안 돌았어도 열면 바로 생성된다.
 */
import { corsHeaders, json, requireServiceRole, serviceClient } from '../_shared/http.ts';
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

  const body = (await req.json().catch(() => ({}))) as { after?: string; max_users?: number };
  const maxUsers = Math.max(1, Math.min(HARD_MAX_USERS, Number(body.max_users) || DEFAULT_MAX_USERS));
  const after = typeof body.after === 'string' && body.after ? body.after : null;
  const forDate = seoulToday();
  const nowYear = Number(forDate.slice(0, 4));

  const db = serviceClient();
  const { data: targets, error } = await db.rpc('recommendation_batch_targets', {
    p_for_date: forDate,
    p_after: after,
    p_limit: maxUsers,
  });
  if (error) {
    await reportServerError(db, 'daily-recommendation-batch', new Error(error.message), { stage: 'targets' });
    return json({ error: 'lookup_failed' }, 500);
  }
  const ids = ((targets ?? []) as { user_id: string }[]).map((t) => t.user_id);

  const ds = supabaseDataSource(db);
  const claims = supabaseClaimClient(db);
  const counts = { processed: 0, created: 0, exhausted: 0, skipped: 0, failed: 0 };
  for (const userId of ids) {
    counts.processed += 1;
    try {
      // 배치는 busy 를 기다리지 않는다 (앱 요청이 맡고 있으면 그쪽이 끝낸다)
      const outcome = await runDailyRecommendationWithClaim(ds, claims, { userId, today: forDate, nowYear, dailyLimit: 1 }, { retries: 0 });
      if (outcome.kind !== 'ok') counts.failed += 1;
      else if ('skipped' in outcome && outcome.skipped) counts.skipped += 1;
      else if ('inProgress' in outcome && outcome.inProgress) counts.skipped += 1;
      else if (outcome.exhausted) counts.exhausted += 1;
      else counts.created += 1;
    } catch (e) {
      counts.failed += 1;
      await reportServerError(db, 'daily-recommendation-batch', e, { stage: 'user', user_id: userId });
    }
  }

  return json({
    for_date: forDate,
    ...counts,
    next_after: ids.length === maxUsers ? ids[ids.length - 1] : null,
  });
});
