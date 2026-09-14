/**
 * MatchingEngine 입출력 타입.
 * 이 모듈은 순수 TypeScript(의존성 없음)로, Deno(Edge Function)와 Node(테스트)
 * 어디서든 동작한다. 알고리즘 교체 시 이 타입 계약만 유지하면 된다.
 *
 * #40: 외모(appearance) 차원·벡터·중요도는 계약에서 제거되었다.
 *      얼굴 임베딩·외모 취향은 MVP 에서 수집하지도, 계산에 넣지도 않는다.
 *      DB 의 과거 컬럼(appearance_preference_events, preference_settings.appearance_importance,
 *      face_verifications.feature_vector)은 보존되지만 매칭 로더는 읽지 않는다.
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
  /** 공개 질문 답변 {prompt_id: 코드 | 코드[]} (#39) — 허용된 prompt/코드만 카드·이유에 쓰인다 */
  publicAnswers?: Record<string, unknown> | null;
}

/** private_profiles 의 가치관 축 (1~5) — 비공개. 내부 점수에만 쓰이고 카드·이유에 노출되지 않는다 */
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

/** 설문 응답 (문항 메타 포함 — axis 별 집계에 사용) — 비공개 */
export interface QuestionnaireResponse {
  questionId: string;
  category: 'personality' | 'lifestyle' | 'relationship';
  axis: string;
  reverse: boolean;
  value: number; // 1~5
}

/** 활성 비교 차원 (#40) — 외모 없음 */
export type ActiveDimension = 'personality' | 'values' | 'lifestyle' | 'relationship';
export const ACTIVE_DIMENSIONS: ActiveDimension[] = ['personality', 'values', 'lifestyle', 'relationship'];

/** 개인화 매칭 중요도 (1~5) — 활성 차원만 */
export type ImportanceWeights = Record<ActiveDimension, number>;

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

/** 매칭 계산에 필요한 한 사용자의 전체 스냅샷 (외모 데이터 없음) */
export interface UserSnapshot {
  profile: ProfileInput;
  values: ValuesInput;
  responses: QuestionnaireResponse[];
  importance: ImportanceWeights;
  preferences: PreferenceInput;
  dealbreakers: Dealbreaker[];
  conversationSignals?: ConversationSignals | null;
}

/**
 * 차원별 점수 — null 은 "이 쌍에서 비교 가능한 정보가 없음" (unavailable).
 * 중립값으로 채우지 않으며, 가중 평균의 분자·분모 어디에도 들어가지 않는다.
 */
export type DimensionScores = Record<ActiveDimension, number | null>;

/**
 * 방향 점수 결과.
 *  - base: 유효 차원만의 중요도 가중 평균 (없으면 null)
 *  - adjustment: 선호 조건(나이·키·지역·연상연하) 가감점 — base 가 있을 때만 score 에 더한다
 *  - score: clamp01(base + adjustment) 또는 null
 */
export interface DirectionalScore {
  base: number | null;
  adjustment: number;
  score: number | null;
  dimensions: DimensionScores;
  availableDimensions: ActiveDimension[];
}

/**
 * 종합 점수.
 *  - basis 'scored': 양방향 모두 유효 차원이 있어 total 을 계산했다 (내부 순위용 숫자이며 "궁합 확률" 이 아니다)
 *  - basis 'conditions_only': 한쪽이라도 비교 가능한 차원이 없다. 필수 조건(성별 지향·Dealbreaker)만 통과했고
 *    total 은 null 이다. 순위는 결정적 tie-break 로만 정한다 (자동 탈락시키지 않는다)
 */
export interface MatchScore {
  basis: 'scored' | 'conditions_only';
  total: number | null;
  aToB: number | null;
  bToA: number | null;
  dimensions: DimensionScores;
}

export interface MatchResult {
  /** 양방향 dealbreaker 통과 여부 — false 면 추천 금지 */
  eligible: boolean;
  failedDealbreakers: { direction: 'aToB' | 'bToA'; kind: Dealbreaker['kind'] }[];
  score: MatchScore | null;
  /** 카드에 보여줄 설명 문구 — 공개된 사실에서만 만든다 (비공개 응답·점수 기반 문구 없음) */
  reasons: string[];
}

/**
 * recommendations.strategy 값 — DB check 제약·analytics 계약(0003) 호환을 위해 유지한다.
 * 실제 탐색(explore) 정책이나 정확도를 뜻하지 않는다. 내부 점수 구간 라벨일 뿐이다:
 *   high_confidence: scored 이고 total ≥ 0.62 인 1순위 / exploration: scored 이고 total ≥ 0.5 /
 *   fallback: 그 외 (conditions_only 포함)
 */
export type RecommendationStrategy = 'high_confidence' | 'exploration' | 'fallback';
