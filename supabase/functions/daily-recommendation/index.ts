/**
 * 오늘의 소개 생성 Edge Function — 얇은 HTTP 어댑터.
 *
 * POST {} → { recommendations: [{ id, status, strategy, card, candidate_id }], daily_limit, exhausted? }
 *
 * 실제 정책·계산은 _shared/matching/recommend.ts(runDailyRecommendation) 에 있다 (#40):
 *  * 하루 1명 — 무한 스와이프 없음. Plus 추천 개수 차등은 PLUS_EXTRA_RECOMMENDATION_ENABLED=false 로 비활성 (#29/#39)
 *  * 요청자·후보 모두 active·온보딩 완료·본인확인·얼굴 인증·성인 확인 플래그(users 행, 서버만 갱신)를 검사
 *  * 외모 취향·얼굴 벡터는 조회도 계산도 하지 않는다
 *  * 원시 점수·비공개 응답은 클라이언트에 내려주지 않는다 — card 스냅샷의 공개 필드만
 *  * 안전 조회 실패(500 lookup_failed)와 후보 부족(200 exhausted)은 다른 결과다
 */
import { corsHeaders, json, requireUser, serviceClient } from '../_shared/http.ts';
import { runDailyRecommendation } from '../_shared/matching/recommend.ts';
import { supabaseDataSource } from '../_shared/matching/supabaseDataSource.ts';

/**
 * Plus(하루 +1 추천) feature flag — MVP 베타에서는 결제가 없으므로 끈다 (#29).
 * subscriptions 테이블과 기존 행은 그대로 두며, 재도입 시 이 플래그만 켠다.
 */
const PLUS_EXTRA_RECOMMENDATION_ENABLED = false;

function seoulToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

function nowYearSeoul(): number {
  return Number(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }).slice(0, 4));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const db = serviceClient();

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

  const outcome = await runDailyRecommendation(supabaseDataSource(db), {
    userId: auth.userId,
    today: seoulToday(),
    nowYear: nowYearSeoul(),
    dailyLimit,
  });

  switch (outcome.kind) {
    case 'not_ready':
      return json({ error: 'not_ready' }, 403);
    case 'not_verified':
      return json({ error: 'not_verified' }, 403);
    case 'profile_missing':
      return json({ error: 'profile_missing' }, 400);
    case 'lookup_failed':
      // 안전·계정 조회 실패 — 추천을 만들지 않았다. 후보 부족(exhausted)과 구분된다.
      console.error(`daily-recommendation lookup failed at stage=${outcome.stage}`);
      return json({ error: 'lookup_failed' }, 500);
    case 'ok':
      return json({
        recommendations: outcome.recommendations,
        daily_limit: outcome.dailyLimit,
        ...(outcome.exhausted ? { exhausted: true } : {}),
      });
  }
});
