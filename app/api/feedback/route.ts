import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, bad } from "@/lib/api";

// 만남 후 피드백 — 개인 Dating Model의 가장 강력한 학습 데이터.
// 특히 looks_fit(실제 외모가 취향이었는가)은 외모 취향 벡터를 실측으로 보정한다.
export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;
  const b = await req.json().catch(() => ({}));
  const matchId = Number(b.matchId);
  if (!matchId || typeof b.meetAgain !== "boolean") return bad("잘못된 요청입니다.");

  const d = db();
  const m = d.prepare("SELECT * FROM matches WHERE id = ?").get(matchId) as
    | { id: number; user_a: number; user_b: number; meet_confirmed_at: string | null }
    | undefined;
  if (!m || (m.user_a !== user.id && m.user_b !== user.id)) {
    return bad("매칭을 찾을 수 없습니다.", 404);
  }
  if (!m.meet_confirmed_at) return bad("아직 만남이 확정되지 않았습니다.", 409);

  const opt = (v: unknown) => (typeof v === "boolean" ? (v ? 1 : 0) : null);
  d.prepare(
    `INSERT OR REPLACE INTO feedbacks
     (match_id, user_id, meet_again, looks_fit, talk_comfortable, values_fit)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(matchId, user.id, b.meetAgain ? 1 : 0, opt(b.looksFit), opt(b.talkComfortable), opt(b.valuesFit));

  const partnerId = m.user_a === user.id ? m.user_b : m.user_a;
  d.prepare(
    "INSERT INTO behavior_events (user_id, target_id, event) VALUES (?, ?, ?)"
  ).run(user.id, partnerId, b.meetAgain ? "feedback_again" : "feedback_no");

  // 실측 학습: 실제 외모가 취향이었다면 상대 특징 벡터 방향으로 취향 벡터를 이동
  if (typeof b.looksFit === "boolean") {
    try {
      const partner = d.prepare("SELECT face_vec FROM users WHERE id = ?").get(partnerId) as {
        face_vec: string;
      };
      const face: number[] = JSON.parse(partner.face_vec);
      const pref: number[] = JSON.parse(user.face_pref_vec);
      if (face.length === pref.length && face.length > 0) {
        const lr = b.looksFit ? 0.3 : -0.15;
        const next = pref.map((p, i) =>
          Math.min(1, Math.max(0, p + lr * (face[i] - p)))
        );
        d.prepare("UPDATE users SET face_pref_vec = ? WHERE id = ?").run(
          JSON.stringify(next.map((v) => Math.round(v * 1000) / 1000)), user.id
        );
      }
    } catch {
      // 벡터 파싱 실패 시 학습 생략
    }
  }

  return NextResponse.json({ ok: true });
}
