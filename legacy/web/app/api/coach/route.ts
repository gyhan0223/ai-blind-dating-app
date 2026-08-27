import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/api";
import { FACE_DIMS } from "@/lib/types";

// AI Dating Coach — 매칭 품질을 조작하는 기능이 아니라,
// 사용자 자신의 행동 데이터를 분석해 돌려주는 서비스.
export async function GET() {
  const { user, error } = await requireUser();
  if (error) return error;
  const d = db();

  const counts = Object.fromEntries(
    (
      d
        .prepare(
          `SELECT event, COUNT(*) AS c FROM behavior_events WHERE user_id = ? GROUP BY event`
        )
        .all(user.id) as { event: string; c: number }[]
    ).map((r) => [r.event, r.c])
  );

  const likes = counts["like"] ?? 0;
  const passes = counts["pass"] ?? 0;
  const firstMessages = counts["first_message"] ?? 0;
  const replies = counts["reply"] ?? 0;
  const meetYes = counts["meet_yes"] ?? 0;
  const feedbackAgain = counts["feedback_again"] ?? 0;
  const feedbackNo = counts["feedback_no"] ?? 0;

  const insights: string[] = [];

  if (likes + passes >= 3) {
    const rate = likes / (likes + passes);
    if (rate >= 0.7) {
      insights.push(
        "추천받은 상대에게 호감을 표현하는 비율이 높아요. 열린 태도는 매칭 확률을 크게 높입니다."
      );
    } else if (rate <= 0.3) {
      insights.push(
        "추천의 대부분을 지나치고 계세요. 프로필 너머의 모습은 대화에서 드러나는 경우가 많아요. 한 번 더 알아가 보는 건 어떨까요?"
      );
    } else {
      insights.push("호감 표현과 신중함의 균형이 좋은 편이에요.");
    }
  }
  if (firstMessages > 0) {
    insights.push(
      `매칭 후 먼저 대화를 시작한 적이 ${firstMessages}번 있어요. 먼저 말을 거는 쪽이 대화 지속률이 더 높습니다.`
    );
  }
  if (replies >= 10) {
    insights.push("대화를 꾸준히 이어가는 타입이에요. 상대의 답장 속도와 맞춰지는 대화가 오래 지속됩니다.");
  }
  if (meetYes > 0) {
    insights.push(
      "대화에서 실제 만남으로 이어간 경험이 있어요. 이 앱의 목표인 '실제 관계'에 가까워지고 있습니다."
    );
  }
  if (feedbackAgain + feedbackNo > 0) {
    insights.push(
      feedbackAgain >= feedbackNo
        ? "실제 만남 이후 다시 만나고 싶다고 답한 비율이 높아요. AI가 취향을 잘 배워가고 있다는 신호예요."
        : "실제 만남이 기대와 달랐던 경우가 있었네요. 피드백은 다음 추천을 더 정확하게 만듭니다."
    );
  }

  // 설문 취향 vs 학습된 취향 차이 (외모 취향 벡터의 이동 정도)
  let prefDrift: string | null = null;
  try {
    const pref: number[] = JSON.parse(user.face_pref_vec);
    if (pref.length === FACE_DIMS.length) {
      const drift = pref.reduce((s, v) => s + Math.abs(v - 0.5), 0) / pref.length;
      prefDrift =
        drift > 0.15
          ? "외모 취향이 뚜렷하게 학습되었어요. 초기 설문보다 실제 선택 데이터가 추천에 더 많이 반영되고 있어요."
          : "아직 외모 취향 데이터가 충분히 쌓이지 않았어요. 추천에 대한 선택이 쌓일수록 정확해집니다.";
    }
  } catch {
    prefDrift = null;
  }
  if (prefDrift) insights.push(prefDrift);

  if (insights.length === 0) {
    insights.push(
      "아직 분석할 데이터가 부족해요. 오늘의 소개에서 선택을 시작하면 나만의 Dating Model이 만들어집니다."
    );
  }

  return NextResponse.json({
    stats: { likes, passes, firstMessages, replies, meetYes, feedbackAgain, feedbackNo },
    insights,
  });
}
