import { track } from './analytics';
import type { AcceptResult } from './chatCore';
import { supabase } from './supabase';

/**
 * 추천 카드 스냅샷 — 서버(daily-recommendation)가 공개 가능한 profiles 필드만 담아 만든다.
 * 비공개 가치관 응답·설문·인증 원본·외모 데이터는 여기에 없다 (#39).
 * intro/relationship_goal/public_answers 는 0015 이후 생성된 카드에만 있다 (예전 카드는 undefined).
 */
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
  intro?: string | null;
  relationship_goal?: string | null;
  public_answers?: { id: string; question: string; answer: string }[];
  identity_verified: boolean;
  face_verified: boolean;
  reasons: string[];
};

/**
 * 예전 서버(#40 이전)가 저장한 카드에 남아 있을 수 있는 이유 문구 — 표시 단계에서 걸러낸다.
 *  * 근거 없는 문구, 비공개 설문/점수 기반 문구, 실제 거리를 단정하는 문구.
 *  서버는 더 이상 만들지 않지만 저장된 스냅샷(과거 추천·대화 이력)은 바꾸지 않는다 (docs/matching-policy.md 8·9절).
 */
const UNSUPPORTED_LEGACY_REASONS = new Set([
  '서로 다른 매력이 잘 어울릴 수 있는 조합이에요',
  '성격의 결이 잘 맞아요',
  '연애 스타일이 잘 맞아요',
  '생활 패턴이 비슷해요',
  '성격 질문에 비슷하게 답했어요',
  '생활 패턴 질문에 비슷하게 답했어요',
  '연애 스타일 질문에 비슷하게 답했어요',
  '연애에서 중요하게 생각하는 부분이 비슷해요',
  '가까운 지역에 살고 있어요',
]);

function sanitizeCard(card: RecommendationCard): RecommendationCard {
  return {
    ...card,
    reasons: (card.reasons ?? []).filter((r) => !UNSUPPORTED_LEGACY_REASONS.has(r)),
    public_answers: Array.isArray(card.public_answers) ? card.public_answers : [],
  };
}

export type Recommendation = {
  id: string;
  status: 'pending' | 'accepted' | 'skipped' | 'expired';
  strategy: string;
  candidate_id: string;
  card: RecommendationCard;
};

export type TodayRecommendations = {
  recommendations: Recommendation[];
  dailyLimit: number;
  /** 오늘 후보가 없다 (서버가 1시간 동안 다시 훑지 않는다 — #23) */
  exhausted: boolean;
  /**
   * exhausted 이면서 서버가 탐색 상한(500명)에 걸려 전체 후보를 다 보지 못했다 (#23).
   * "조건에 맞는 분이 전혀 없다" 고 단정할 수 없는 상태 — 화면 문구를 구분한다
   */
  capReached: boolean;
  /** 다른 요청(앱·배치)이 지금 생성 중이라 아직 결과가 없다 — 잠시 후 다시 조회 (#22) */
  inProgress: boolean;
  /** 진행 중인 대화가 3개라 오늘의 새 소개를 만들지 않았다 (#24). 자리가 생기면 다음 소개부터 재개된다 */
  slotsFull: boolean;
};

/**
 * 오늘의 추천을 가져온다 (없으면 서버가 생성). 서버가 생성 중이면 짧게 기다렸다가 다시 요청한다.
 * 서버 오류(HTTP 500 lookup_failed 등)는 throw — 화면은 이를 "후보 부족" 으로 바꾸지 않는다.
 * "다시 확인" 은 같은 요청을 다시 보낼 뿐이다: 후보 부족 뒤 1시간 안의 재요청은 서버가 다시 훑지 않고 같은 답을 준다 (#23 재시도 주기 우회 없음).
 */
export async function fetchTodayRecommendations(): Promise<TodayRecommendations> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data, error } = await supabase.functions.invoke('daily-recommendation', { body: {} });
    if (error) throw new Error('추천을 불러오지 못했습니다.');
    const recommendations = ((data?.recommendations ?? []) as Recommendation[]).map((r) => ({
      ...r,
      card: sanitizeCard(r.card),
    }));
    const inProgress = data?.in_progress === true && recommendations.length === 0;
    if (!inProgress || attempt === 2) {
      const exhausted = data?.exhausted === true;
      return {
        recommendations,
        dailyLimit: data?.daily_limit ?? 1,
        exhausted,
        capReached: exhausted && data?.cap_reached === true,
        inProgress,
        slotsFull: data?.slots_full === true,
      };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('추천을 불러오지 못했습니다.');
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
 * 추천 카드를 실제로 표시했음을 서버에 기록한다 (#24 — 생성/확인/수락 구분). 멱등이며 실패해도 화면을 막지 않는다.
 */
export async function markRecommendationViewed(recommendationId: string): Promise<void> {
  try {
    await supabase.rpc('recommendation_mark_viewed', { p_recommendation_id: recommendationId });
  } catch {
    // 열람 기록 실패는 조용히 무시 (다음 표시 때 다시 시도된다)
  }
}

export type DecisionResult = {
  /** 상호 매치가 생겼는지 */
  matched: boolean;
  /** 수락 결과 (#24). skipped 면 null. no_slot_* 는 상대의 거절이 아니며 추천은 pending 으로 남는다 */
  result: AcceptResult | null;
};

/**
 * 추천에 대한 결정.
 *  * 수락: 서버 RPC recommendation_accept 가 추천 상태·좋아요·매치 생성을 한 트랜잭션으로 처리한다 (#24).
 *    자리 부족(no_slot_self / no_slot_partner)이면 아무것도 저장되지 않고 결과만 돌아온다 — 다시 시도하거나 넘길 수 있다.
 *  * 넘김: 추천 상태와 사유만 저장한다.
 */
export async function decideRecommendation(
  rec: Recommendation,
  decision: 'accepted' | 'skipped',
  skipCategory?: SkipCategory | null,
  skipDetail?: string | null,
): Promise<DecisionResult> {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) throw new Error('로그인이 필요합니다.');

  if (decision === 'skipped') {
    const { error: updateErr } = await supabase
      .from('recommendations')
      .update({
        status: 'skipped',
        decided_at: new Date().toISOString(),
        skip_reason: skipCategory ?? null,
        skip_reason_detail: skipDetail ?? null,
      })
      .eq('id', rec.id);
    if (updateErr) throw new Error('처리하지 못했습니다.');
    track('recommendation_skipped', {
      recommendation_id: rec.id,
      strategy: rec.strategy,
      reason: skipCategory ?? null,
      reason_detail: skipDetail ?? null,
    });
    return { matched: false, result: null };
  }

  const { data, error } = await supabase.rpc('recommendation_accept', { p_recommendation_id: rec.id });
  if (error) throw new Error('처리하지 못했습니다.');
  const obj = (data ?? {}) as { result?: string; match_id?: string | null };
  const result = (['matched', 'liked', 'no_slot_self', 'no_slot_partner', 'already_matched'] as const).find((r) => r === obj.result) ?? null;
  if (!result) throw new Error('처리하지 못했습니다.');
  // 수락 이벤트는 서버(RPC)가 기록한다 — 클라이언트 track 없음
  return { matched: result === 'matched', result };
}
