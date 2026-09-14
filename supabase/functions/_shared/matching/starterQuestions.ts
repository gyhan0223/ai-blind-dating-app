/**
 * 공개 답변 기반 선택형 대화 시작 질문 (#41) — 순수 규칙 모듈 (Deno/Node 겸용, LLM 호출 없음).
 *
 * 입력은 두 사람의 "공개 프로필 사실" 만이다: 공개 질문 선택지 코드(profiles.public_answers)와 취미(profiles.hobbies).
 * private_profiles(가치관 축)·설문 응답·인증 데이터·메시지 원문은 입력 타입에 아예 없다.
 *
 * 규칙
 *  1. 둘 다 고른 선택지 → basis 'shared' 질문 ("둘 다 …" 라고 말할 수 있는 근거가 실제로 있을 때만)
 *  2. 상대만 고른 선택지 → basis 'partner' 질문 (상대의 공개 답변을 근거로 묻는다 — 공통점이라고 주장하지 않는다)
 *  3. 근거가 부족하면 basis 'general' 일반 질문으로 채운다 (허위 공통점 없음)
 *  항상 2~3개. 결정적(같은 입력 → 같은 출력). 허용된 prompt id·선택지 코드 외의 값은 무시한다.
 *
 * 사용자는 질문을 골라 입력창에서 고쳐 보내거나 무시하고 바로 대화할 수 있다. 시스템이 답을 대신 만들지 않는다.
 */
import { PUBLIC_PROMPTS, pickAllowedValues } from './publicPrompts.ts';

export type StarterBasis = 'shared' | 'partner' | 'general';

export interface StarterQuestion {
  /** 안정적 id — 'shared:day_off:cafe' / 'partner:together:food_tour' / 'general:1' */
  id: string;
  text: string;
  basis: StarterBasis;
  promptId?: string;
  value?: string;
}

/** conversations.icebreaker 에 캐시되는 v2 형식. version 이 2 가 아니면(과거 lead/question 캐시) 무효로 본다 */
export interface StarterCache {
  version: 2;
  generated_at: string;
  questions: StarterQuestion[];
}

export const STARTER_CACHE_VERSION = 2 as const;
export const STARTER_MIN = 2;
export const STARTER_MAX = 3;

/** 질문 생성에 쓰이는 공개 프로필 사실 — 이 타입에 비공개 필드는 없다 */
export interface PublicFacts {
  hobbies: string[];
  publicAnswers: unknown;
}

type Pair = { shared: string; partner: string };

/** prompt id → 선택지 코드 → (둘 다 고름 / 상대만 고름) 질문 */
const PROMPT_QUESTIONS: Record<string, Record<string, Pair>> = {
  day_off: {
    rest_home: {
      shared: '둘 다 쉬는 날엔 집에서 쉬는 편이네요. 집에서 보내는 시간에 주로 뭘 하세요?',
      partner: '쉬는 날엔 집에서 푹 쉬신다고 했는데, 그럴 때 주로 뭘 하세요?',
    },
    cafe: {
      shared: '둘 다 카페 가는 걸 좋아하네요. 카페에 가면 주로 뭘 하세요?',
      partner: '카페 가는 걸 좋아하신다고 했는데, 카페에 가면 주로 뭘 하세요?',
    },
    exercise: {
      shared: '둘 다 쉬는 날 운동을 하네요. 요즘 하고 있는 운동은 뭐예요?',
      partner: '쉬는 날 운동을 하신다고 했는데, 요즘 하고 있는 운동은 뭐예요?',
    },
    short_trip: {
      shared: '둘 다 가까운 곳으로 떠나는 걸 좋아하네요. 최근에 다녀온 곳 중 어디가 좋았어요?',
      partner: '가까운 곳 여행을 좋아하신다고 했는데, 최근에 다녀온 곳 중 어디가 좋았어요?',
    },
    friends: {
      shared: '둘 다 쉬는 날 친구를 만나는 편이네요. 친구들과 만나면 주로 뭘 하세요?',
      partner: '쉬는 날 친구를 자주 만나신다고 했는데, 만나면 주로 뭘 하세요?',
    },
    watch: {
      shared: '둘 다 영화·드라마를 좋아하네요. 최근에 본 것 중 추천하고 싶은 작품 있어요?',
      partner: '영화·드라마를 좋아하신다고 했는데, 최근에 본 것 중 추천할 만한 게 있어요?',
    },
    walk: {
      shared: '둘 다 산책이나 드라이브를 좋아하네요. 자주 가는 코스가 있어요?',
      partner: '산책·드라이브를 좋아하신다고 했는데, 자주 가는 코스가 있어요?',
    },
    cook: {
      shared: '둘 다 요리를 하네요. 자신 있는 요리가 있다면 뭐예요?',
      partner: '요리를 하신다고 했는데, 자신 있는 요리가 있다면 뭐예요?',
    },
    culture: {
      shared: '둘 다 전시·공연을 좋아하네요. 최근에 기억에 남는 전시나 공연이 있었나요?',
      partner: '전시·공연을 좋아하신다고 했는데, 최근에 기억에 남는 전시나 공연이 있었나요?',
    },
    hobby: {
      shared: '둘 다 쉬는 날 취미 활동을 하네요. 요즘 빠져 있는 취미가 뭐예요?',
      partner: '쉬는 날 취미 활동을 하신다고 했는데, 요즘 빠져 있는 취미가 뭐예요?',
    },
  },
  together: {
    food_tour: {
      shared: '둘 다 맛집 탐방을 같이 해보고 싶어 하네요. 요즘 가보고 싶은 곳이 있어요?',
      partner: '맛집 탐방을 같이 해보고 싶다고 하셨는데, 요즘 가보고 싶은 곳이 있어요?',
    },
    short_trip: {
      shared: '둘 다 짧은 여행을 같이 가보고 싶어 하네요. 당일치기로 가기 좋은 곳 알고 있어요?',
      partner: '짧은 여행을 같이 가보고 싶다고 하셨는데, 당일치기로 가기 좋은 곳 알고 있어요?',
    },
    walk_talk: {
      shared: '둘 다 산책하며 대화하는 걸 좋아하네요. 걷기 좋아하는 동네가 있어요?',
      partner: '산책하며 대화하는 걸 좋아하신다고 했는데, 걷기 좋아하는 동네가 있어요?',
    },
    movie: {
      shared: '둘 다 같이 영화 보는 걸 원하네요. 요즘 보고 싶은 영화 있어요?',
      partner: '같이 영화 보는 걸 해보고 싶다고 하셨는데, 요즘 보고 싶은 영화 있어요?',
    },
    exercise: {
      shared: '둘 다 같이 운동하는 걸 해보고 싶어 하네요. 어떤 운동을 같이 하면 좋을까요?',
      partner: '같이 운동하는 걸 해보고 싶다고 하셨는데, 어떤 운동을 생각하셨어요?',
    },
    cook: {
      shared: '둘 다 같이 요리하는 걸 원하네요. 같이 만들어 보고 싶은 메뉴가 있어요?',
      partner: '같이 요리하는 걸 해보고 싶다고 하셨는데, 만들어 보고 싶은 메뉴가 있어요?',
    },
    culture: {
      shared: '둘 다 전시·공연 관람을 같이 해보고 싶어 하네요. 요즘 관심 가는 전시나 공연이 있어요?',
      partner: '전시·공연 관람을 같이 해보고 싶다고 하셨는데, 요즘 관심 가는 게 있어요?',
    },
    cafe_talk: {
      shared: '둘 다 카페에서 긴 대화를 원하네요. 이야기하기 좋은 카페를 알고 있어요?',
      partner: '카페에서 긴 대화를 해보고 싶다고 하셨는데, 이야기하기 좋은 카페를 알고 있어요?',
    },
    hobby_share: {
      shared: '둘 다 서로의 취미를 배워 보고 싶어 하네요. 알려주고 싶은 취미가 있어요?',
      partner: '서로의 취미를 배워 보고 싶다고 하셨는데, 알려주고 싶은 취미가 있어요?',
    },
  },
  important: {
    honest_talk: {
      shared: '둘 다 연애에서 솔직한 대화를 중요하게 생각하네요. 어떤 대화가 솔직하다고 느끼세요?',
      partner: '연애에서 솔직한 대화를 중요하게 생각하신다고 했는데, 어떤 대화가 솔직하다고 느끼세요?',
    },
    respect: {
      shared: '둘 다 서로 존중하는 걸 중요하게 생각하네요. 존중받는다고 느끼는 순간은 언제예요?',
      partner: '서로 존중하는 걸 중요하게 생각하신다고 했는데, 존중받는다고 느끼는 순간은 언제예요?',
    },
    humor: {
      shared: '둘 다 유머와 편안함을 중요하게 생각하네요. 최근에 크게 웃었던 일이 있어요?',
      partner: '유머와 편안함을 중요하게 생각하신다고 했는데, 최근에 크게 웃었던 일이 있어요?',
    },
    stability: {
      shared: '둘 다 안정감을 중요하게 생각하네요. 어떤 때 안정감을 느끼세요?',
      partner: '안정감을 중요하게 생각하신다고 했는데, 어떤 때 안정감을 느끼세요?',
    },
    trust: {
      shared: '둘 다 신뢰를 중요하게 생각하네요. 신뢰가 쌓인다고 느끼는 건 어떤 순간이에요?',
      partner: '신뢰를 중요하게 생각하신다고 했는데, 신뢰가 쌓인다고 느끼는 건 어떤 순간이에요?',
    },
    affection: {
      shared: '둘 다 애정 표현을 중요하게 생각하네요. 어떤 표현을 받으면 기분이 좋아요?',
      partner: '애정 표현을 중요하게 생각하신다고 했는데, 어떤 표현을 받으면 기분이 좋아요?',
    },
    growth: {
      shared: '둘 다 함께 성장하는 걸 중요하게 생각하네요. 요즘 배우고 있는 게 있어요?',
      partner: '함께 성장하는 걸 중요하게 생각하신다고 했는데, 요즘 배우고 있는 게 있어요?',
    },
    own_time: {
      shared: '둘 다 각자의 시간을 존중하는 걸 중요하게 생각하네요. 혼자 있는 시간엔 주로 뭘 하세요?',
      partner: '각자의 시간을 존중하는 걸 중요하게 생각하신다고 했는데, 혼자 있는 시간엔 주로 뭘 하세요?',
    },
  },
};

/** 공통 취미(profiles.hobbies 코드) → 질문. 둘 다 골랐을 때만 쓴다 */
const SHARED_HOBBY_QUESTIONS: Record<string, string> = {
  travel: '둘 다 여행을 좋아하네요. 갑자기 3일 휴가가 생기면 어디로 가고 싶어요?',
  movies: '둘 다 영화·드라마를 좋아하네요. 꼭 추천하고 싶은 작품이 있어요?',
  music: '둘 다 음악을 좋아하네요. 요즘 가장 자주 듣는 노래는 뭐예요?',
  reading: '둘 다 책을 좋아하네요. 인생 책 한 권을 꼽는다면요?',
  cooking: '둘 다 요리에 관심이 있네요. 자신 있는 요리 하나 소개해 줄래요?',
  cafe: '둘 다 카페 다니는 걸 좋아하네요. 단골 카페가 있어요?',
  sports: '둘 다 운동을 즐기네요. 요즘 하고 있는 운동은 뭐예요?',
  hiking: '둘 다 걷는 걸 좋아하네요. 좋아하는 산책 코스나 산이 있어요?',
  games: '둘 다 게임을 좋아하네요. 요즘 재미있게 하는 게임은 뭐예요?',
  art: '둘 다 전시·공연을 좋아하네요. 기억에 남는 전시나 공연이 있었어요?',
  pets: '둘 다 동물을 좋아하네요. 함께 살고 있거나 키우고 싶은 동물이 있어요?',
  photography: '둘 다 사진 찍는 걸 좋아하네요. 주로 어떤 순간을 찍어요?',
};

/** 근거가 없을 때 쓰는 일반 질문 — 공통점을 주장하지 않는다 */
export const GENERAL_QUESTIONS: string[] = [
  '요즘 쉬는 날에는 어떻게 보내세요?',
  '요즘 하루 중 가장 기다려지는 시간은 언제예요?',
  '최근에 가장 즐거웠던 일은 뭐였어요?',
];

function answersOf(facts: PublicFacts): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const raw = facts.publicAnswers;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const obj = raw as Record<string, unknown>;
  for (const prompt of PUBLIC_PROMPTS) {
    const values = pickAllowedValues(prompt, obj[prompt.id]);
    if (values.length > 0) out.set(prompt.id, values);
  }
  return out;
}

/**
 * viewer(질문을 보낼 사람) 관점에서 partner 에게 보낼 시작 질문 2~3개.
 * 같은 대화방이라도 방향에 따라 'partner' 질문은 다를 수 있다 (상대의 공개 답변 기준).
 */
export function generateStarterQuestions(viewer: PublicFacts, partner: PublicFacts): StarterQuestion[] {
  const mine = answersOf(viewer);
  const theirs = answersOf(partner);
  const shared: StarterQuestion[] = [];
  const partnerOnly: StarterQuestion[] = [];

  for (const prompt of PUBLIC_PROMPTS) {
    const table = PROMPT_QUESTIONS[prompt.id];
    if (!table) continue;
    const my = mine.get(prompt.id) ?? [];
    for (const value of theirs.get(prompt.id) ?? []) {
      const pair = table[value];
      if (!pair) continue;
      if (my.includes(value)) {
        shared.push({ id: `shared:${prompt.id}:${value}`, text: pair.shared, basis: 'shared', promptId: prompt.id, value });
      } else {
        partnerOnly.push({ id: `partner:${prompt.id}:${value}`, text: pair.partner, basis: 'partner', promptId: prompt.id, value });
      }
    }
  }

  const myHobbies = new Set(viewer.hobbies ?? []);
  for (const hobby of partner.hobbies ?? []) {
    if (!myHobbies.has(hobby)) continue;
    const text = SHARED_HOBBY_QUESTIONS[hobby];
    if (!text) continue;
    shared.push({ id: `shared:hobby:${hobby}`, text, basis: 'shared', promptId: 'hobby', value: hobby });
  }

  const out: StarterQuestion[] = [];
  const pushUnique = (q: StarterQuestion) => {
    if (out.length >= STARTER_MAX) return;
    if (out.some((x) => x.id === q.id || x.text === q.text)) return;
    out.push(q);
  };
  // 우선순위: 공통 근거 → 상대 답변 근거 → 일반. 각 그룹 안에서는 공개 질문 순서 (결정적)
  for (const q of shared) pushUnique(q);
  for (const q of partnerOnly) pushUnique(q);
  // 근거 기반 질문이 하나뿐이면 일반 질문으로 최소 2개를 채운다. 근거가 없으면 전부 일반 질문
  GENERAL_QUESTIONS.forEach((text, i) => {
    if (out.length < STARTER_MIN) pushUnique({ id: `general:${i + 1}`, text, basis: 'general' });
  });
  return out.slice(0, STARTER_MAX);
}

/** 캐시(jsonb) 파싱 — v2 형식이 아니면 null (과거 lead/question 캐시는 다시 노출하지 않는다) */
export function parseStarterCache(raw: unknown): StarterCache | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== STARTER_CACHE_VERSION || !Array.isArray(obj.questions)) return null;
  const questions: StarterQuestion[] = [];
  for (const q of obj.questions as unknown[]) {
    if (!q || typeof q !== 'object') return null;
    const item = q as Record<string, unknown>;
    if (typeof item.id !== 'string' || typeof item.text !== 'string') return null;
    if (item.basis !== 'shared' && item.basis !== 'partner' && item.basis !== 'general') return null;
    questions.push({
      id: item.id,
      text: item.text,
      basis: item.basis,
      promptId: typeof item.promptId === 'string' ? item.promptId : undefined,
      value: typeof item.value === 'string' ? item.value : undefined,
    });
  }
  if (questions.length === 0) return null;
  return { version: 2, generated_at: typeof obj.generated_at === 'string' ? obj.generated_at : '', questions };
}

export function buildStarterCache(questions: StarterQuestion[], now: Date = new Date()): StarterCache {
  return { version: 2, generated_at: now.toISOString(), questions };
}
