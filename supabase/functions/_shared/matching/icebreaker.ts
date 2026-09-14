/**
 * Icebreaker — 매칭 후 첫 대화 주제 제안 (규칙 기반).
 * 공개 프로필 정보(취미·연애 목적)만 근거로 쓴다. 비공개 응답·인증 데이터는 사용하지 않는다.
 * 공개 답변 기반 선택형 시작 질문 확장은 #41.
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

  // 공개 프로필의 연애 목적이 같으면 그 사실만 언급한다 (공개 정보)
  if (a.profile.relationshipGoal && a.profile.relationshipGoal === b.profile.relationshipGoal) {
    return {
      lead: '두 분 모두 연애 목적이 같아요.',
      question: '요즘 하루 중 가장 기다려지는 시간은 언제인가요?',
    };
  }

  // 비공개 가치관 응답(private_profiles)은 대화 문구에 쓰지 않는다 — 상대에게 응답 값이 간접 노출되기 때문 (#39)
  return {
    lead: '첫 인사를 어떻게 시작할지 고민된다면,',
    question: '요즘 하루 중 가장 기다려지는 시간은 언제인가요?',
  };
}
