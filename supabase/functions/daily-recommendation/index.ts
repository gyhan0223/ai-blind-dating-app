/**
 * 오늘의 소개 생성 Edge Function.
 *
 * POST {} → { recommendations: [{ id, status, strategy, card }] }
 *
 * 원칙
 *  * 하루 기본 1명 (Plus 는 2명) — 무한 스와이프 없음
 *  * Plus 여부는 "추천 개수"에만 영향, 매칭 품질/순서에는 영향 없음
 *  * 원시 점수는 클라이언트에 내려주지 않는다 (card 스냅샷만)
 *  * 차단 쌍, 기존 매치, 이미 추천된 상대는 제외
 */
import { corsHeaders, json, requireUser, serviceClient } from '../_shared/http.ts';
import { computeMatch, pickStrategy } from '../_shared/matching/MatchingEngine.ts';
import { loadSnapshots } from '../_shared/matching/snapshot.ts';
import type { MatchResult, RecommendationStrategy, UserSnapshot } from '../_shared/matching/types.ts';

const POOL_LIMIT = 60;

function seoulToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

function nowYearSeoul(): number {
  return Number(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }).slice(0, 4));
}

function buildCard(candidate: UserSnapshot, badges: { identity: boolean; face: boolean }, reasons: string[], nowYear: number) {
  const p = candidate.profile;
  return {
    nickname: p.nickname,
    age: nowYear - p.birthYear,
    region_code: p.regionCode,
    height_cm: p.heightCm,
    job_group: p.jobGroup,
    smoking: p.smoking,
    drinking: p.drinking,
    hobbies: p.hobbies,
    personality_keywords: p.personalityKeywords,
    identity_verified: badges.identity,
    face_verified: badges.face,
    reasons,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const db = serviceClient();
  const today = seoulToday();
  const nowYear = nowYearSeoul();

  // 사용자 상태 확인
  const { data: me } = await db
    .from('users')
    .select('id, status, onboarding_completed')
    .eq('id', auth.userId)
    .single();
  if (!me || me.status !== 'active' || !me.onboarding_completed) {
    return json({ error: 'not_ready' }, 403);
  }

  // 오늘 추천 한도 (Plus 는 +1 — 품질이 아니라 개수만)
  const { data: sub } = await db
    .from('subscriptions')
    .select('plan, status')
    .eq('user_id', auth.userId)
    .maybeSingle();
  const dailyLimit = sub?.plan === 'plus' && sub?.status === 'active' ? 2 : 1;

  const { data: todayRecs } = await db
    .from('recommendations')
    .select('id, status, strategy, card, candidate_id')
    .eq('user_id', auth.userId)
    .eq('for_date', today)
    .order('created_at', { ascending: true });

  if ((todayRecs?.length ?? 0) >= dailyLimit) {
    return json({ recommendations: todayRecs, daily_limit: dailyLimit });
  }

  // 제외 대상 수집
  const [pastRecsRes, likesRes, matchesRes, blocksRes] = await Promise.all([
    db.from('recommendations').select('candidate_id').eq('user_id', auth.userId),
    db.from('likes').select('to_user_id').eq('from_user_id', auth.userId),
    db.from('matches').select('user_a, user_b').or(`user_a.eq.${auth.userId},user_b.eq.${auth.userId}`),
    db.from('blocks').select('blocker_id, blocked_id').or(`blocker_id.eq.${auth.userId},blocked_id.eq.${auth.userId}`),
  ]);
  const excluded = new Set<string>([auth.userId]);
  for (const r of pastRecsRes.data ?? []) excluded.add(r.candidate_id);
  for (const l of likesRes.data ?? []) excluded.add(l.to_user_id);
  for (const m of matchesRes.data ?? []) {
    excluded.add(m.user_a);
    excluded.add(m.user_b);
  }
  for (const b of blocksRes.data ?? []) {
    excluded.add(b.blocker_id);
    excluded.add(b.blocked_id);
  }

  // 내 스냅샷
  const meSnap = (await loadSnapshots(db, [auth.userId])).get(auth.userId);
  if (!meSnap) return json({ error: 'profile_missing' }, 400);

  // 후보 풀: 서로의 성별 지향이 맞는 활성 완료 사용자
  const { data: candidates } = await db
    .from('profiles')
    .select('user_id, users!inner(status, onboarding_completed)')
    .eq('gender', meSnap.profile.seekingGender)
    .eq('seeking_gender', meSnap.profile.gender)
    .eq('users.status', 'active')
    .eq('users.onboarding_completed', true)
    .limit(POOL_LIMIT + excluded.size);

  const poolIds = (candidates ?? [])
    .map((c) => c.user_id as string)
    .filter((id) => !excluded.has(id))
    .slice(0, POOL_LIMIT);

  if (poolIds.length === 0) {
    return json({ recommendations: todayRecs ?? [], daily_limit: dailyLimit, exhausted: true });
  }

  const snapshots = await loadSnapshots(db, poolIds);
  const { data: candUsers } = await db
    .from('users')
    .select('id, identity_verified, face_verified')
    .in('id', poolIds);
  const badgeMap = new Map((candUsers ?? []).map((u) => [u.id, u]));

  // 양방향 계산 → eligible 만 정렬
  const scored: { id: string; result: MatchResult }[] = [];
  for (const [id, snap] of snapshots) {
    const result = computeMatch(meSnap, snap, nowYear);
    if (result.eligible && result.score) scored.push({ id, result });
  }
  scored.sort((x, y) => (y.result.score?.total ?? 0) - (x.result.score?.total ?? 0));

  if (scored.length === 0) {
    return json({ recommendations: todayRecs ?? [], daily_limit: dailyLimit, exhausted: true });
  }

  // 부족한 개수만큼 생성
  const need = dailyLimit - (todayRecs?.length ?? 0);
  const created: unknown[] = [];
  for (let i = 0; i < Math.min(need, scored.length); i += 1) {
    const { id: candidateId, result } = scored[i];
    const snap = snapshots.get(candidateId)!;
    const badges = badgeMap.get(candidateId);
    const strategy: RecommendationStrategy = pickStrategy(result.score!.total, i);
    const card = buildCard(
      snap,
      { identity: badges?.identity_verified ?? false, face: badges?.face_verified ?? false },
      result.reasons,
      nowYear,
    );
    const { data: inserted, error } = await db
      .from('recommendations')
      .insert({
        user_id: auth.userId,
        candidate_id: candidateId,
        for_date: today,
        strategy,
        score_total: result.score!.total,
        score_a_to_b: result.score!.aToB,
        score_b_to_a: result.score!.bToA,
        dimensions: result.score!.dimensions,
        card,
      })
      .select('id, status, strategy, card, candidate_id')
      .single();
    if (!error && inserted) created.push(inserted);
  }

  return json({
    recommendations: [...(todayRecs ?? []), ...created],
    daily_limit: dailyLimit,
  });
});
