import type { UserRow } from "./types";

// AI Icebreaker — 두 사람의 프로필 공통점을 찾아 첫 대화 질문을 생성한다.
// AI가 대화를 대신하지 않고, 첫 대화의 마찰만 줄인다.

const j = (s: string): Record<string, number> => {
  try {
    return JSON.parse(s) ?? {};
  } catch {
    return {};
  }
};

export function makeIcebreaker(a: UserRow, b: UserRow): string {
  const la = j(a.lifestyle);
  const lb = j(b.lifestyle);
  const pa = j(a.personality);
  const pb = j(b.personality);

  const candidates: string[] = [];

  if (la.travelFreq > 0.6 && lb.travelFreq > 0.6) {
    candidates.push(
      "두 분 모두 여행을 자주 다니는 편이라고 답했어요. 내일 갑자기 3일 휴가가 생긴다면 어디로 떠날 건가요?"
    );
  }
  if (la.morningType > 0.6 && lb.morningType > 0.6) {
    candidates.push(
      "두 분 모두 아침형 인간이시네요. 하루 중 가장 좋아하는 아침 루틴이 있나요?"
    );
  }
  if (la.morningType < 0.4 && lb.morningType < 0.4) {
    candidates.push(
      "두 분 모두 저녁형 인간이시네요. 밤에 주로 뭘 하면서 시간을 보내세요?"
    );
  }
  if (la.exerciseFreq > 0.6 && lb.exerciseFreq > 0.6) {
    candidates.push(
      "두 분 모두 운동을 즐겨 하신대요. 요즘 빠져 있는 운동이 있다면 서로 소개해 볼까요?"
    );
  }
  if (la.homeDate > 0.6 && lb.homeDate > 0.6) {
    candidates.push(
      "두 분 모두 아늑한 집데이트를 선호하시네요. 완벽한 집데이트에 꼭 필요한 한 가지는 뭐라고 생각하세요?"
    );
  }
  if (la.homeDate < 0.4 && lb.homeDate < 0.4) {
    candidates.push(
      "두 분 모두 밖에서 보내는 데이트를 좋아하신대요. 최근에 가 본 곳 중 최고의 장소는 어디였나요?"
    );
  }
  if (pa.humor > 0.6 && pb.humor > 0.6) {
    candidates.push(
      "두 분 모두 유머 코드가 중요한 타입이에요. 최근에 빵 터졌던 순간 하나씩 공유해 볼까요?"
    );
  }
  if (pa.planned > 0.6 && pb.planned > 0.6) {
    candidates.push(
      "두 분 모두 계획 세우는 걸 좋아하시네요. 올해 꼭 이루고 싶은 계획 하나를 서로 말해 볼까요?"
    );
  }
  if (pa.planned < 0.4 && pb.planned < 0.4) {
    candidates.push(
      "두 분 모두 즉흥적인 걸 즐기는 타입이에요. 즉흥적으로 저질렀던 일 중 가장 기억에 남는 건 뭔가요?"
    );
  }
  if (a.mbti === b.mbti) {
    candidates.push(
      `두 분 모두 ${a.mbti}시네요! 같은 MBTI끼리만 아는 특징이 있다면 뭘까요?`
    );
  }
  if (a.region === b.region) {
    candidates.push(
      `두 분 모두 ${a.region}에 계시네요. 동네에서 제일 좋아하는 공간을 서로 추천해 볼까요?`
    );
  }

  if (candidates.length === 0) {
    candidates.push(
      "서로 다른 매력을 가진 두 분이 만났어요. 요즘 하루 중 가장 기다려지는 시간은 언제인가요?"
    );
  }
  // 매칭 id 기반이 아닌 결정적 선택: 두 사용자 id 합으로 고른다
  return candidates[(a.id + b.id) % candidates.length];
}
