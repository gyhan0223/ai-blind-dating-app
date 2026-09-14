/**
 * 공개 프로필 질문(대화 소재) — 순수 상수 모듈 (Deno/Node 겸용).
 *
 * 모바일 앱 `apps/mobile/src/constants/questions.ts` 의 PUBLIC_PROMPTS / RELATIONSHIP_GOALS 와 id·문구를 동기 유지한다.
 * profiles.public_answers 는 {prompt_id: 답변} 으로 저장되며, 추천 카드 스냅샷에는
 * 여기 정의된 id 만 (질문 문구와 함께) 실린다 — 알 수 없는 키는 서버가 버린다.
 *
 * 이 답변과 relationship_goal, intro 는 "상대에게 공개" 되는 정보다.
 * 비공개 가치관 응답(private_profiles)·설문 응답·인증 데이터는 카드에 싣지 않는다.
 */
export const PUBLIC_PROMPTS: { id: string; question: string }[] = [
  { id: 'day_off', question: '쉬는 날에는 주로 무엇을 하나요?' },
  { id: 'together', question: '상대와 함께 해보고 싶은 일이 있나요?' },
  { id: 'important', question: '연애에서 중요하게 생각하는 것은 무엇인가요?' },
];

export const RELATIONSHIP_GOALS: { value: string; label: string }[] = [
  { value: 'serious', label: '진지한 연애를 원해요' },
  { value: 'marriage_minded', label: '결혼을 생각하는 만남을 원해요' },
  { value: 'take_it_slow', label: '천천히 알아가고 싶어요' },
  { value: 'undecided', label: '아직 열어 두고 있어요' },
];

export const PUBLIC_ANSWER_MAX_LENGTH = 200;
export const INTRO_MAX_LENGTH = 300;

export type PublicAnswerCard = { id: string; question: string; answer: string };

/** DB jsonb → 카드용 배열. 허용된 prompt id 의 문자열 답변만, 길이 제한 적용. */
export function buildPublicAnswerCards(raw: unknown): PublicAnswerCard[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const obj = raw as Record<string, unknown>;
  const out: PublicAnswerCard[] = [];
  for (const prompt of PUBLIC_PROMPTS) {
    const value = obj[prompt.id];
    if (typeof value !== 'string') continue;
    const answer = value.trim().slice(0, PUBLIC_ANSWER_MAX_LENGTH);
    if (answer.length === 0) continue;
    out.push({ id: prompt.id, question: prompt.question, answer });
  }
  return out;
}

export function normalizeIntro(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().slice(0, INTRO_MAX_LENGTH);
  return t.length > 0 ? t : null;
}

export function normalizeRelationshipGoal(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return RELATIONSHIP_GOALS.some((g) => g.value === raw) ? raw : null;
}
