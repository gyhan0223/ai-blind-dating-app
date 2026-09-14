/**
 * 공개 프로필 질문(대화 소재) — 순수 상수 모듈 (Deno/Node 겸용).
 *
 * #39: 자기소개는 "글쓰기" 가 아니라 "고르기" 다. 사용자는 질문마다 선택지를 고르고,
 * 서버가 고른 항목으로 짧은 소개 문장을 만들어 카드에 싣는다 (composeIntro).
 *
 * 모바일 앱 `apps/mobile/src/constants/questions.ts` 의 PUBLIC_PROMPTS / RELATIONSHIP_GOALS / composeIntro 와
 * id·value·문구를 동기 유지한다.
 * profiles.public_answers 는 {prompt_id: value | value[]} 로 저장되며(값은 선택지 코드),
 * 카드에는 여기 정의된 id·value 만 라벨로 바꿔 싣는다 — 알 수 없는 키/값은 서버가 버린다.
 *
 * 이 답변과 relationship_goal 은 "상대에게 공개" 되는 정보다.
 * 비공개 가치관 응답(private_profiles)·설문 응답·인증 데이터는 카드에 싣지 않는다.
 */
export type PublicPromptOption = { value: string; label: string };

export type PublicPrompt = {
  id: string;
  question: string;
  /** 최대 선택 개수 */
  max: number;
  /** 소개 문장 템플릿 — {answers} 자리에 고른 라벨이 " · " 로 이어져 들어간다 */
  sentence: string;
  options: PublicPromptOption[];
};

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

export const RELATIONSHIP_GOALS: { value: string; label: string }[] = [
  { value: 'serious', label: '진지한 연애를 원해요' },
  { value: 'marriage_minded', label: '결혼을 생각하는 만남을 원해요' },
  { value: 'take_it_slow', label: '천천히 알아가고 싶어요' },
  { value: 'undecided', label: '아직 열어 두고 있어요' },
];

export type PublicAnswerCard = { id: string; question: string; values: string[]; answer: string };

/** DB jsonb 값(문자열 또는 문자열 배열) → 허용된 선택지 코드 배열 (순서 유지, 중복 제거, max 적용) */
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

/** DB jsonb → 카드용 배열. 허용된 prompt/선택지만, 라벨로 변환. */
export function buildPublicAnswerCards(raw: unknown): PublicAnswerCard[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const obj = raw as Record<string, unknown>;
  const out: PublicAnswerCard[] = [];
  for (const prompt of PUBLIC_PROMPTS) {
    const values = pickAllowedValues(prompt, obj[prompt.id]);
    if (values.length === 0) continue;
    const labels = values.map((v) => prompt.options.find((o) => o.value === v)!.label);
    out.push({ id: prompt.id, question: prompt.question, values, answer: labels.join(' · ') });
  }
  return out;
}

export function normalizeRelationshipGoal(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return RELATIONSHIP_GOALS.some((g) => g.value === raw) ? raw : null;
}

/**
 * 고른 항목 → 짧은 소개 문장. 규칙 기반 조합일 뿐 분석·추론이 아니다.
 * 예: "진지한 연애를 원해요. 쉬는 날엔 주로 집에서 푹 쉬기 · 카페 가기. 연애에서 중요하게 생각하는 건 솔직한 대화."
 * 고른 것이 없으면 null.
 */
export function composeIntro(relationshipGoal: unknown, publicAnswers: unknown): string | null {
  const parts: string[] = [];
  const goal = normalizeRelationshipGoal(relationshipGoal);
  if (goal) parts.push(RELATIONSHIP_GOALS.find((g) => g.value === goal)!.label + '.');
  for (const card of buildPublicAnswerCards(publicAnswers)) {
    const prompt = PUBLIC_PROMPTS.find((p) => p.id === card.id)!;
    parts.push(prompt.sentence.replace('{answers}', card.answer));
  }
  return parts.length > 0 ? parts.join(' ') : null;
}
