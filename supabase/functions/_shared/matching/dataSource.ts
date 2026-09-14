/**
 * 추천 생성에 필요한 데이터 접근 계약 (#40).
 *
 * 왜 인터페이스인가
 *  * Edge Function 은 supabase-js(service role) 로 구현하고(supabaseDataSource.ts),
 *    로컬 검증은 psql 로 실제 Postgres 스키마에 붙는 구현(supabase/tests/recommendation_db_test.mjs)을 쓴다.
 *    두 구현이 같은 계약을 만족하므로 "DB → 스냅샷 → 엔진 → 카드 저장·반환" 연결을 실제 DB 로 검증할 수 있다.
 *  * 모든 메서드는 조회 실패 시 **throw** 한다. "데이터 없음" 과 "조회 실패" 를 구분하기 위해
 *    실패를 빈 배열로 삼키지 않는다 (안전 조건 조회 실패 → 추천 진행 금지).
 *
 * 외모 데이터(appearance_preference_events, face_verifications.feature_vector)는 이 계약에 없다.
 * 인증 플래그(identity/face/age_verified)는 users 행에서 읽는다 — 얼굴 벡터 유무와 무관하다.
 */

export type Row = Record<string, unknown>;

export interface UserAccountRow {
  id: string;
  status: string;
  onboarding_completed: boolean;
  identity_verified: boolean;
  face_verified: boolean;
  age_verified: boolean;
}

export interface StoredRecommendation {
  id: string;
  status: string;
  strategy: string;
  card: Row;
  candidate_id: string;
}

export interface NewRecommendationRow {
  user_id: string;
  candidate_id: string;
  for_date: string;
  strategy: string;
  score_total: number | null;
  score_a_to_b: number | null;
  score_b_to_a: number | null;
  dimensions: Row;
  card: Row;
}

export interface DataSource {
  // --- 스냅샷 입력 (모두 user_id in ids) ---
  profiles(ids: string[]): Promise<Row[]>;
  privateProfiles(ids: string[]): Promise<Row[]>;
  questionnaireResponses(ids: string[]): Promise<{ user_id: string; question_id: string; value: number }[]>;
  questionnaireQuestions(): Promise<{ id: string; category: string; axis: string; reverse: boolean }[]>;
  preferenceSettings(ids: string[]): Promise<Row[]>;
  dealbreakers(ids: string[]): Promise<{ user_id: string; kind: string; value: Row }[]>;

  // --- 계정·안전 ---
  userAccounts(ids: string[]): Promise<UserAccountRow[]>;
  /** 요청자가 어느 쪽이든 포함된 차단 쌍 */
  blockPairs(userId: string): Promise<{ blocker_id: string; blocked_id: string }[]>;
  /** 요청자가 신고했거나 신고당한 쌍 (당사자 간 재추천 제한용 — 전역 제외 아님) */
  reportPairs(userId: string): Promise<{ reporter_id: string; reported_id: string }[]>;
  likedUserIds(userId: string): Promise<string[]>;
  /** 상태와 무관한 모든 매치 상대 (closed/blocked 포함) */
  matchedUserIds(userId: string): Promise<string[]>;
  pastRecommendationCandidateIds(userId: string): Promise<string[]>;

  // --- 추천 ---
  recommendationsForDate(userId: string, forDate: string): Promise<StoredRecommendation[]>;
  /**
   * 후보 id 페이지 — profiles.gender = gender, seeking_gender = seekingGender,
   * users.status='active', onboarding_completed, identity/face/age_verified 모두 true.
   * user_id 오름차순 고정 정렬 (재현 가능한 순회).
   */
  candidateIdsPage(gender: string, seekingGender: string, offset: number, limit: number): Promise<string[]>;
  insertRecommendation(row: NewRecommendationRow): Promise<StoredRecommendation>;
  /** pending 추천을 expired 로 마감 (안전 조건 재검증 실패 시) */
  expireRecommendations(ids: string[]): Promise<void>;
}
