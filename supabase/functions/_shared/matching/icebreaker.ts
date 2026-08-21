/**
 * AI Icebreaker — 매칭 후 첫 대화 주제 추천.
 * 현재는 규칙 기반. 이 함수 시그니처를 유지한 채 LLM 호출로 교체할 수 있다.
 */
import type { UserSnapshot } from './types.ts';

export interface Icebreaker {
  lead: string; // 공통점 설명
  question: string; // 추천 질문
}

const HOBBY_QUESTIONS: Record<string, { lead: string; question: string }> = {
  travel: {
    lead: '두 분 모두 여행을 좋아해요.',
    question: '갑자기 3일 휴가가 생기면 어디로 떠나고 싶나요?',
  },
  movies: {
    lead: '두 분 모두 영화와 드라마를 좋아해요.',
    question: '최근에 본 것 중에 남에게 꼭 추천하고 싶은 작품이 있나요?',
  },
  music: {
    lead: '두 분 모두 음악을 좋아해요.',
    question: '요즘 가장 자주 듣는 노래는 무엇인가요?',
  },
  reading: {
    lead: '두 분 모두 책을 좋아해요.',
    question: '인생 책 한 권을 꼽는다면 어떤 책인가요?',
  },
  cooking: {
    lead: '두 분 모두 요리에 관심이 있어요.',
    question: '자신 있는 요리 하나를 소개해 준다면요?',
  },
  cafe: {
    lead: '두 분 모두 카페 다니는 걸 좋아해요.',
    question: '단골 카페가 있나요? 어떤 점이 좋아요?',
  },
  sports: {
    lead: '두 분 모두 운동을 즐겨요.',
    question: '요즘 하고 있는 운동은 무엇인가요?',
  },
  hiking: {
    lead: '두 분 모두 걷는 걸 좋아해요.',
    question: '가장 좋아하는 산책 코스나 산이 있나요?',
  },
  games: {
    lead: '두 분 모두 게임을 좋아해요.',
    question: '요즘 가장 재미있게 하는 게임은 무엇인가요?',
  },
  art: {
    lead: '두 분 모두 전시와 공연을 좋아해요.',
    question: '기억에 남는 전시나 공연이 있었나요?',
  },
  pets: {
    lead: '두 분 모두 동물을 좋아해요.',
    question: '반려동물과 함께 살고 있나요, 아니면 키우고 싶은 동물이 있나요?',
  },
  photography: {
    lead: '두 분 모두 사진 찍는 걸 좋아해요.',
    question: '주로 어떤 순간을 찍는 걸 좋아하나요?',
  },
};

export function generateIcebreaker(a: UserSnapshot, b: UserSnapshot): Icebreaker {
  const shared = a.profile.hobbies.filter((h) => b.profile.hobbies.includes(h));
  for (const hobby of shared) {
    const entry = HOBBY_QUESTIONS[hobby];
    if (entry) return entry;
  }

  // 취미가 겹치지 않으면 가치관/생활 축에서 화제를 찾는다
  const aTravel = a.values.spendingStyle ?? 3;
  const bTravel = b.values.spendingStyle ?? 3;
  if (aTravel >= 4 && bTravel >= 4) {
    return {
      lead: '두 분 모두 경험에 아끼지 않는 편이에요.',
      question: '최근에 해 본 것 중 가장 만족스러웠던 경험은 무엇인가요?',
    };
  }
  if ((a.values.personalTimeNeed ?? 3) >= 4 && (b.values.personalTimeNeed ?? 3) >= 4) {
    return {
      lead: '두 분 모두 자기만의 시간을 소중히 여겨요.',
      question: '혼자만의 시간에는 주로 무엇을 하며 보내나요?',
    };
  }

  return {
    lead: '첫 인사를 어떻게 시작할지 고민된다면,',
    question: '요즘 하루 중 가장 기다려지는 시간은 언제인가요?',
  };
}
