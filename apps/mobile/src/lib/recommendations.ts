import { track } from './analytics';
import { supabase } from './supabase';

export type RecommendationCard = {
  nickname: string;
  age: number;
  region_code: string;
  height_cm: number;
  job_group: string;
  smoking: string;
  drinking: string;
  hobbies: string[];
  personality_keywords: string[];
  identity_verified: boolean;
  face_verified: boolean;
  reasons: string[];
};

export type Recommendation = {
  id: string;
  status: 'pending' | 'accepted' | 'skipped' | 'expired';
  strategy: string;
  candidate_id: string;
  card: RecommendationCard;
};

/** 오늘의 추천을 가져온다 (없으면 서버가 생성). */
export async function fetchTodayRecommendations(): Promise<{
  recommendations: Recommendation[];
  dailyLimit: number;
  exhausted: boolean;
}> {
  const { data, error } = await supabase.functions.invoke('daily-recommendation', { body: {} });
  if (error) throw new Error('추천을 불러오지 못했습니다.');
  return {
    recommendations: (data?.recommendations ?? []) as Recommendation[],
    dailyLimit: data?.daily_limit ?? 1,
    exhausted: data?.exhausted ?? false,
  };
}

/**
 * 추천에 대한 결정.
 * 수락 시 like 를 저장하고, 상호 좋아요라면 DB 트리거가 매치를 만든다.
 * @returns 상호 매치가 생겼는지 여부
 */
export async function decideRecommendation(
  rec: Recommendation,
  decision: 'accepted' | 'skipped',
): Promise<{ matched: boolean }> {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) throw new Error('로그인이 필요합니다.');

  const { error: updateErr } = await supabase
    .from('recommendations')
    .update({ status: decision, decided_at: new Date().toISOString() })
    .eq('id', rec.id);
  if (updateErr) throw new Error('처리하지 못했습니다.');

  if (decision === 'skipped') {
    track('recommendation_skipped', { recommendation_id: rec.id, strategy: rec.strategy });
    return { matched: false };
  }

  const { error: likeErr } = await supabase.from('likes').insert({
    from_user_id: userId,
    to_user_id: rec.candidate_id,
    recommendation_id: rec.id,
  });
  // 중복 좋아요(재시도)는 무시
  if (likeErr && !`${likeErr.message}`.includes('duplicate')) {
    throw new Error('처리하지 못했습니다.');
  }
  track('recommendation_accepted', { recommendation_id: rec.id, strategy: rec.strategy });

  const [a, b] = [userId, rec.candidate_id].sort();
  const { data: match } = await supabase
    .from('matches')
    .select('id')
    .eq('user_a', a)
    .eq('user_b', b)
    .maybeSingle();
  return { matched: match != null };
}
