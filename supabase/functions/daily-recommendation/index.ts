/**
 * 오늘의 소개 생성 Edge Function — 얇은 HTTP 어댑터.
 *
 * POST {} → { recommendations: [{ id, status, strategy, card, candidate_id }], daily_limit, exhausted?, cap_reached?, slots_full?, in_progress? }
 *
 * 실제 정책·계산은 _shared/matching/recommend.ts(runDailyRecommendation) 에 있다 (#40):
 *  * 하루 1명 — 무한 스와이프 없음. Plus 추천 개수 차등은 PLUS_EXTRA_RECOMMENDATION_ENABLED=false 로 비활성 (#29/#39)
 *  * 요청자·후보 모두 active·온보딩 완료·본인확인·얼굴 인증·성인 확인 플래그(users 행, 서버만 갱신)를 검사
 *  * 외모 취향·얼굴 벡터는 조회도 계산도 하지 않는다
 *  * 원시 점수·비공개 응답은 클라이언트에 내려주지 않는다 — card 스냅샷의 공개 필드만
 *  * 안전 조회 실패(500 lookup_failed)와 후보 부족(200 exhausted)과 대화 자리 없음(200 slots_full, #24)은 다른 결과다
 *
 * 멱등성 (#22): recommendation_run_claim 으로 (사용자, KST 날짜) 당 한 실행만 생성한다. 동시 요청은 기다렸다가
 * 저장된 추천을 읽는다. 끝내 다른 실행이 진행 중이면 in_progress=true (앱이 잠시 후 다시 요청).
 * 후보 부족 (#23): exhausted 로 끝난 뒤 1시간 안의 재요청은 후보를 다시 훑지 않는다. exhausted 와 함께 cap_reached=true 면
 * 탐색 상한(500명)에 걸려 전체 후보를 다 보지 못한 것이다 — 앱은 "조건에 맞는 분이 전혀 없다" 고 단정하지 않는다.
 * 관측(적격 후보 수·전략·실패 단계)은 recommendation_runs 에 서버만 기록하며 응답에는 내려주지 않는다.
 */
import { corsHeaders, json, requireUser, serviceClient } from '../_shared/http.ts';
import { runDailyRecommendationWithClaim, supabaseClaimClient } from '../_shared/matching/runWithClaim.ts';
import { supabaseDataSource } from '../_shared/matching/supabaseDataSource.ts';
import { reportServerError } from '../_shared/observability/report.ts';
import { enforceRateLimit } from '../_shared/rateLimit.ts';

/**
 * Plus(하루 +1 추천) feature flag — MVP 베타에서는 결제가 없으므로 끈다 (#29).
 * subscriptions 테이블과 기존 행은 그대로 두며, 재도입 시 이 플래그만 켠다.
 */
const PLUS_EXTRA_RECOMMENDATION_ENABLED = false;

export function seoulToday(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

export function nowYearSeoul(now: Date = new Date()): number {
  return Number(seoulToday(now).slice(0, 4));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const db = serviceClient();

  // 남용 방지 (#27): 사용자당 30회/시간 — 홈 진입·in_progress 재시도로 충분하고, 후보 스캔 반복 호출을 막는다
  const rl = await enforceRateLimit(db, 'daily-recommendation', auth.userId, 30, 3600, 'daily-recommendation');
  if (rl) return rl;

  // 오늘 추천 한도 — MVP 는 모두 1명. (Plus +1 은 플래그가 켜진 경우에만, 품질이 아니라 개수만)
  let dailyLimit = 1;
  if (PLUS_EXTRA_RECOMMENDATION_ENABLED) {
    const { data: sub } = await db
      .from('subscriptions')
      .select('plan, status')
      .eq('user_id', auth.userId)
      .maybeSingle();
    if (sub?.plan === 'plus' && sub?.status === 'active') dailyLimit = 2;
  }

  let outcome;
  try {
    outcome = await runDailyRecommendationWithClaim(supabaseDataSource(db), supabaseClaimClient(db), {
      userId: auth.userId,
      today: seoulToday(),
      nowYear: nowYearSeoul(),
      dailyLimit,
    });
  } catch (e) {
    await reportServerError(db, 'daily-recommendation', e, { user_id: auth.userId });
    return json({ error: 'lookup_failed' }, 500);
  }

  switch (outcome.kind) {
    case 'not_ready':
      return json({ error: 'not_ready' }, 403);
    case 'not_verified':
      return json({ error: 'not_verified' }, 403);
    case 'profile_missing':
      return json({ error: 'profile_missing' }, 400);
    case 'lookup_failed':
      // 안전·계정 조회 실패 — 추천을 만들지 않았다. 후보 부족(exhausted)과 구분된다.
      await reportServerError(db, 'daily-recommendation', new Error('lookup_failed'), { stage: outcome.stage, user_id: auth.userId });
      return json({ error: 'lookup_failed' }, 500);
    case 'ok':
      return json({
        recommendations: outcome.recommendations,
        daily_limit: outcome.dailyLimit,
        ...(outcome.exhausted ? { exhausted: true } : {}),
        ...(outcome.exhausted && outcome.capReached ? { cap_reached: true } : {}),
        ...(outcome.slotsFull ? { slots_full: true } : {}),
        ...('inProgress' in outcome && outcome.inProgress ? { in_progress: true } : {}),
      });
  }
});
