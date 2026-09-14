/**
 * 설문 문항 상수 — supabase/migrations/0006_content.sql 과 id/내용이 일치해야 한다.
 * (응답 저장 시 questionnaire_questions FK 검증을 통과해야 하므로)
 */
export type Question = {
  id: string;
  category: 'personality' | 'lifestyle' | 'relationship';
  text: string;
};

export const QUESTIONS: Question[] = [
  { id: 'p01', category: 'personality', text: '처음 만난 사람과도 금방 편해지는 편이다' },
  { id: 'p02', category: 'personality', text: '혼자만의 시간이 꼭 필요하다' },
  { id: 'p03', category: 'personality', text: '일정은 미리 계획하는 것이 편하다' },
  { id: 'p04', category: 'personality', text: '계획 없는 즉흥 여행도 좋다' },
  { id: 'p05', category: 'personality', text: '감정 표현을 솔직하게 하는 편이다' },
  { id: 'p06', category: 'personality', text: '갈등이 생기면 바로 이야기해서 푸는 편이다' },
  { id: 'p07', category: 'personality', text: '장난스럽고 유머러스한 분위기가 좋다' },
  { id: 'p08', category: 'personality', text: '웬만한 일에는 스트레스를 잘 받지 않는 편이다' },
  { id: 'p09', category: 'personality', text: '상대의 기분 변화를 빨리 알아차리는 편이다' },
  { id: 'p10', category: 'personality', text: '새로운 경험이나 도전을 즐긴다' },
  { id: 'l01', category: 'lifestyle', text: '주말에는 주로 집에서 쉬는 편이다' },
  { id: 'l02', category: 'lifestyle', text: '아침형 인간이다' },
  { id: 'l03', category: 'lifestyle', text: '술자리 모임을 즐기는 편이다' },
  { id: 'l04', category: 'lifestyle', text: '운동을 규칙적으로 하는 편이다' },
  { id: 'l05', category: 'lifestyle', text: '소비보다 저축을 중요하게 생각한다' },
  { id: 'l06', category: 'lifestyle', text: '정리정돈된 공간이 중요하다' },
  { id: 'l07', category: 'lifestyle', text: '반려동물과 함께하는 삶이 좋다' },
  { id: 'l08', category: 'lifestyle', text: '기회가 되면 자주 여행을 떠나고 싶다' },
  { id: 'r01', category: 'relationship', text: '연인과는 연락을 자주 주고받는 게 좋다' },
  { id: 'r02', category: 'relationship', text: '애정 표현은 자주 하는 편이 좋다' },
  { id: 'r03', category: 'relationship', text: '연인과 최대한 많은 시간을 함께 보내고 싶다' },
  { id: 'r04', category: 'relationship', text: '연애 중에도 각자의 생활이 중요하다' },
  { id: 'r05', category: 'relationship', text: '다투면 그날 안에 풀어야 한다' },
  { id: 'r06', category: 'relationship', text: '연애 초반에도 미래에 대한 대화를 나누는 게 좋다' },
  { id: 'r07', category: 'relationship', text: '연인의 이성 친구 관계를 존중할 수 있다' },
  { id: 'r08', category: 'relationship', text: '천천히 알아가며 시작하는 연애가 좋다' },
];

/** 가치관 축 (private_profiles 의 1~5 컬럼) */
export const VALUE_AXES: {
  key:
    | 'marriage_intent'
    | 'children_intent'
    | 'long_distance_ok'
    | 'contact_frequency'
    | 'date_frequency'
    | 'personal_time_need'
    | 'opposite_sex_friends_ok'
    | 'spending_style'
    | 'religion_importance';
  title: string;
  lowLabel: string;
  highLabel: string;
}[] = [
  { key: 'marriage_intent', title: '결혼에 대한 생각', lowLabel: '아직 없어요', highLabel: '적극적이에요' },
  { key: 'children_intent', title: '자녀 계획', lowLabel: '생각 없어요', highLabel: '꼭 갖고 싶어요' },
  { key: 'long_distance_ok', title: '장거리 연애', lowLabel: '어려워요', highLabel: '괜찮아요' },
  { key: 'contact_frequency', title: '연락 빈도', lowLabel: '필요할 때만', highLabel: '자주 자주' },
  { key: 'date_frequency', title: '데이트 빈도', lowLabel: '여유롭게', highLabel: '자주 만나요' },
  { key: 'personal_time_need', title: '개인 시간', lowLabel: '적어도 돼요', highLabel: '꼭 필요해요' },
  { key: 'opposite_sex_friends_ok', title: '연인의 이성 친구', lowLabel: '불편해요', highLabel: '존중해요' },
  { key: 'spending_style', title: '소비 성향', lowLabel: '저축 우선', highLabel: '경험에 투자' },
  { key: 'religion_importance', title: '종교의 중요도', lowLabel: '중요하지 않아요', highLabel: '많이 중요해요' },
];

/**
 * 공개 소개 — 상대에게 그대로 보이는 정보 (#39).
 * 자기소개는 글쓰기가 아니라 "고르기" 다. 질문마다 선택지를 고르면 고른 항목으로 짧은 소개 문장이 만들어진다.
 * 서버 supabase/functions/_shared/matching/publicPrompts.ts 와 id·value·문구·composeIntro 를 동기 유지한다.
 * (카드 스냅샷의 문장은 서버가 같은 규칙으로 만든다 — 자유 텍스트·분석 없음)
 */
export const RELATIONSHIP_GOALS = [
  { value: 'serious', label: '진지한 연애를 원해요' },
  { value: 'marriage_minded', label: '결혼을 생각하는 만남을 원해요' },
  { value: 'take_it_slow', label: '천천히 알아가고 싶어요' },
  { value: 'undecided', label: '아직 열어 두고 있어요' },
] as const;

export type RelationshipGoal = (typeof RELATIONSHIP_GOALS)[number]['value'];

export function relationshipGoalLabel(value: string | null | undefined): string | null {
  return RELATIONSHIP_GOALS.find((g) => g.value === value)?.label ?? null;
}

export type PublicPrompt = {
  id: string;
  question: string;
  /** 최대 선택 개수 */
  max: number;
  /** 소개 문장 템플릿 — {answers} 자리에 고른 라벨이 " · " 로 이어져 들어간다 */
  sentence: string;
  options: { value: string; label: string }[];
};

/** 짧은 공개 질문 — 첫 번째(쉬는 날)만 필수, 나머지는 선택. 긴 성격검사가 아니라 대화 소재용이다. */
export const PUBLIC_PROMPTS: PublicPrompt[] = [
  {
    id: 'day_off',
    question: '쉬는 날에는 주로 무엇을 하나요?',
    max: 2,
    sentence: '쉬는 날엔 주로 {answers}.',
    options: [
      { value: 'rest_home', label: '집에서 푹 쉬기' },
      { value: 'cafe', label: '카페 가기' },
      { value: 'exercise', label: '운동하기' },
      { value: 'short_trip', label: '가까운 곳 여행' },
      { value: 'friends', label: '친구 만나기' },
      { value: 'watch', label: '영화·드라마 보기' },
      { value: 'walk', label: '산책·드라이브' },
      { value: 'cook', label: '요리하기' },
      { value: 'culture', label: '전시·공연 보기' },
      { value: 'hobby', label: '취미 활동' },
    ],
  },
  {
    id: 'together',
    question: '상대와 함께 해보고 싶은 일은?',
    max: 2,
    sentence: '함께 해보고 싶은 건 {answers}.',
    options: [
      { value: 'food_tour', label: '맛집 탐방' },
      { value: 'short_trip', label: '짧은 여행' },
      { value: 'walk_talk', label: '산책하며 대화' },
      { value: 'movie', label: '영화 보기' },
      { value: 'exercise', label: '같이 운동' },
      { value: 'cook', label: '같이 요리' },
      { value: 'culture', label: '전시·공연 관람' },
      { value: 'cafe_talk', label: '카페에서 긴 대화' },
      { value: 'hobby_share', label: '서로의 취미 배우기' },
    ],
  },
  {
    id: 'important',
    question: '연애에서 가장 중요하게 생각하는 것은?',
    max: 1,
    sentence: '연애에서 중요하게 생각하는 건 {answers}.',
    options: [
      { value: 'honest_talk', label: '솔직한 대화' },
      { value: 'respect', label: '서로 존중' },
      { value: 'humor', label: '유머와 편안함' },
      { value: 'stability', label: '안정감' },
      { value: 'trust', label: '신뢰' },
      { value: 'affection', label: '애정 표현' },
      { value: 'growth', label: '함께 성장하기' },
      { value: 'own_time', label: '각자의 시간 존중' },
    ],
  },
];

/** 필수로 답해야 하는 질문 id (온보딩 완료 조건) */
export const REQUIRED_PUBLIC_PROMPT_IDS = ['day_off'] as const;

/** DB 값(문자열 또는 배열) → 허용된 선택지 코드 배열 (순서 유지·중복 제거·max 적용) */
export function pickAllowedValues(prompt: PublicPrompt, raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const allowed = new Set(prompt.options.map((o) => o.value));
  const out: string[] = [];
  for (const v of list) {
    if (typeof v !== 'string' || !allowed.has(v) || out.includes(v)) continue;
    out.push(v);
    if (out.length >= prompt.max) break;
  }
  return out;
}

/** 저장된 public_answers → {prompt_id: 코드[]} (허용 값만) */
export function normalizePublicAnswers(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const obj = raw as Record<string, unknown>;
  for (const p of PUBLIC_PROMPTS) {
    const values = pickAllowedValues(p, obj[p.id]);
    if (values.length > 0) out[p.id] = values;
  }
  return out;
}

/** 필수 질문에 모두 답했는지 */
export function hasRequiredPublicAnswers(raw: unknown): boolean {
  const answers = normalizePublicAnswers(raw);
  return REQUIRED_PUBLIC_PROMPT_IDS.every((id) => (answers[id]?.length ?? 0) > 0);
}

/**
 * 고른 항목 → 짧은 소개 문장 (서버 composeIntro 와 동일 규칙).
 * 예: "진지한 연애를 원해요. 쉬는 날엔 주로 집에서 푹 쉬기 · 카페 가기. 연애에서 중요하게 생각하는 건 솔직한 대화."
 */
export function composeIntro(relationshipGoal: string | null | undefined, publicAnswers: unknown): string | null {
  const parts: string[] = [];
  const goal = relationshipGoalLabel(relationshipGoal);
  if (goal) parts.push(goal + '.');
  const answers = normalizePublicAnswers(publicAnswers);
  for (const p of PUBLIC_PROMPTS) {
    const values = answers[p.id];
    if (!values?.length) continue;
    const labels = values.map((v) => p.options.find((o) => o.value === v)!.label);
    parts.push(p.sentence.replace('{answers}', labels.join(' · ')));
  }
  return parts.length > 0 ? parts.join(' ') : null;
}
