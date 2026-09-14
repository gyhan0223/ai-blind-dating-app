/**
 * MatchingEngine 입출력 타입.
 * 이 모듈은 순수 TypeScript(의존성 없음)로, Deno(Edge Function)와 Node(테스트)
 * 어디서든 동작한다. 알고리즘 교체 시 이 타입 계약만 유지하면 된다.
 */

export type Gender = 'male' | 'female';
export type Smoking = 'none' | 'sometimes' | 'regular';
export type Drinking = 'none' | 'sometimes' | 'often';

export interface ProfileInput {
  userId: string;
  nickname: string;
  birthYear: number;
  gender: Gender;
  seekingGender: Gender;
  regionCode: string;
  heightCm: number;
  jobGroup: string;
  smoking: Smoking;
  drinking: Drinking;
  religion: string | null;
  hobbies: string[];
  personalityKeywords: string[];
  /** 공개 자기소개 (#39) — 추천 카드에 그대로 실린다. 없으면 null */
  intro?: string | null;
  /** 연애 목적 (#39, 공개) — serious | marriage_minded | take_it_slow | undecided */
  relationshipGoal?: string | null;
  /** 공개 질문 답변 {prompt_id: 답변} (#39) — 허용된 prompt 만 카드에 실린다 */
  publicAnswers?: Record<string, unknown> | null;
}

/** private_profiles 의 가치관 축 (1~5) */
export interface ValuesInput {
  marriageIntent?: number | null;
  childrenIntent?: number | null;
  longDistanceOk?: number | null;
  contactFrequency?: number | null;
  dateFrequency?: number | null;
  personalTimeNeed?: number | null;
  oppositeSexFriendsOk?: number | null;
  spendingStyle?: number | null;
  religionImportance?: number | null;
}

/** 설문 응답 (문항 메타 포함 — axis 별 집계에 사용) */
export interface QuestionnaireResponse {
  questionId: string;
  category: 'personality' | 'lifestyle' | 'relationship';
  axis: string;
  reverse: boolean;
  value: number; // 1~5
}

/** 개인화 매칭 중요도 (1~5) */
export interface ImportanceWeights {
  appearance: number;
  personality: number;
  values: number;
  lifestyle: number;
  relationship: number;
}

export interface PreferenceInput {
  ageMin?: number | null;
  ageMax?: number | null;
  /** 연상/동갑/연하 선호 — Dealbreaker 가 아닌 soft preference */
  ageDirection?: 'any' | 'older' | 'same' | 'younger';
  heightMin?: number | null;
  heightMax?: number | null;
  regions: string[];
  smokingPref: 'any' | 'prefer_non';
  personalityKeywords: string[];
}

export interface Dealbreaker {
  kind:
    | 'age_range'
    | 'height_range'
    | 'smoking'
    | 'drinking'
    | 'regions'
    | 'marriage_intent'
    | 'children_intent'
    | 'religion';
  value: Record<string, unknown>;
}

/**
 * 외모 취향/스타일 벡터 (0~1 축들).
 * MVP(#39/#40) 에서는 사용하지 않는다 — 온보딩이 외모 취향을 입력받지 않고 얼굴 임베딩도 생성하지 않으므로
 * 실제 가입 경로에서는 항상 null 이다. 타입은 기존 데이터·후속 검토(#8/#9/#10) 호환을 위해 유지한다.
 */
export type StyleVector = Record<string, number>;

/**
 * 대화 행동 신호 (§21). conversation_metrics 에서 파생.
 * v1 점수에는 아직 반영하지 않지만, 입력 계약에 포함해 교체를 준비한다.
 */
export interface ConversationSignals {
  totalMessages: number;
  /** 0.5 = 균형. viewer 기준 발화 비율 */
  messageBalance: number;
  avgResponseSeconds: number | null;
  activeDays: number;
  resumedCount: number;
  lastResumedByViewer: boolean | null;
}

/** 매칭 계산에 필요한 한 사용자의 전체 스냅샷 */
export interface UserSnapshot {
  profile: ProfileInput;
  values: ValuesInput;
  responses: QuestionnaireResponse[];
  importance: ImportanceWeights;
  preferences: PreferenceInput;
  dealbreakers: Dealbreaker[];
  appearancePreferenceVector: StyleVector | null;
  appearanceStyleVector: StyleVector | null;
  conversationSignals?: ConversationSignals | null;
}

export interface DimensionScores {
  appearance?: number;
  personality: number;
  values: number;
  lifestyle: number;
  relationship: number;
  conversation?: number;
}

export interface MatchScore {
  total: number;
  aToB: number;
  bToA: number;
  dimensions: DimensionScores;
}

export interface MatchResult {
  /** 양방향 dealbreaker 통과 여부 — false 면 추천 금지 */
  eligible: boolean;
  failedDealbreakers: { direction: 'aToB' | 'bToA'; kind: Dealbreaker['kind'] }[];
  score: MatchScore | null;
  /** 카드에 보여줄 설명 문구 (원시 점수는 노출하지 않는다) */
  reasons: string[];
}

export type RecommendationStrategy = 'high_confidence' | 'exploration' | 'fallback';
