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
 * 스킵 사유 — 2단계 선택 (아쉬웠던 항목 → 구체 사유).
 * 지금은 수집만 하고 추후 추천 가중치/탐색 정책에 반영한다.
 * details 가 없는 항목은 선택 즉시 제출된다.
 */
export type SkipCategory =
  | 'age'
  | 'region'
  | 'height'
  | 'job'
  | 'smoking_drinking'
  | 'style'
  | 'not_now'
  | 'other';

export const SKIP_CATEGORIES: {
  value: SkipCategory;
  label: string;
  details?: { value: string; label: string }[];
}[] = [
  {
    value: 'age',
    label: '나이',
    details: [
      { value: 'too_old', label: '나이가 너무 많아요' },
      { value: 'too_young', label: '나이가 너무 어려요' },
    ],
  },
  {
    value: 'region',
    label: '지역',
    details: [
      { value: 'too_far', label: '거리가 너무 멀어요' },
      { value: 'different_area', label: '생활권이 달라요' },
    ],
  },
  {
    value: 'height',
    label: '키',
    details: [
      { value: 'too_tall', label: '키가 너무 커요' },
      { value: 'too_short', label: '키가 더 컸으면 해요' },
    ],
  },
  {
    value: 'job',
    label: '직업',
    details: [
      { value: 'not_preferred', label: '선호하는 직업군이 아니에요' },
      { value: 'lifestyle_mismatch', label: '생활 패턴이 다를 것 같아요' },
    ],
  },
  {
    value: 'smoking_drinking',
    label: '흡연·음주',
    details: [
      { value: 'smoking', label: '흡연이 마음에 걸려요' },
      { value: 'drinking', label: '음주가 마음에 걸려요' },
    ],
  },
  {
    value: 'style',
    label: '느낌·취향',
    details: [
      { value: 'hobbies', label: '취미가 안 맞아요' },
      { value: 'personality', label: '성격 키워드가 안 끌려요' },
      { value: 'no_pull', label: '전체적으로 끌리지 않아요' },
    ],
  },
  { value: 'not_now', label: '지금은 여유가 없어요' },
  { value: 'other', label: '그 외' },
];

/**
 * 추천에 대한 결정.
 * 수락 시 like 를 저장하고, 상호 좋아요라면 DB 트리거가 매치를 만든다.
 * @returns 상호 매치가 생겼는지 여부
 */
export async function decideRecommendation(
  rec: Recommendation,
  decision: 'accepted' | 'skipped',
  skipCategory?: SkipCategory | null,
  skipDetail?: string | null,
): Promise<{ matched: boolean }> {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) throw new Error('로그인이 필요합니다.');

  const { error: updateErr } = await supabase
    .from('recommendations')
    .update({
      status: decision,
      decided_at: new Date().toISOString(),
      skip_reason: decision === 'skipped' ? (skipCategory ?? null) : null,
      skip_reason_detail: decision === 'skipped' ? (skipDetail ?? null) : null,
    })
    .eq('id', rec.id);
  if (updateErr) throw new Error('처리하지 못했습니다.');

  if (decision === 'skipped') {
    track('recommendation_skipped', {
      recommendation_id: rec.id,
      strategy: rec.strategy,
      reason: skipCategory ?? null,
      reason_detail: skipDetail ?? null,
    });
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
