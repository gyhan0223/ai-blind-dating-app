import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, bad } from "@/lib/api";
import type { UserRow } from "@/lib/types";

// 실제 만남 의사 확인: "이 사람을 실제로 만나보고 싶나요?" YES / NOT YET
// 둘 다 YES일 때만 서로에게 알린다. 한쪽만 YES인 상태는 상대에게 비공개.
export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;
  const { matchId, answer } = await req.json().catch(() => ({}));
  if (!["yes", "not_yet"].includes(answer)) return bad("잘못된 요청입니다.");

  const d = db();
  const m = d.prepare("SELECT * FROM matches WHERE id = ?").get(Number(matchId)) as
    | { id: number; user_a: number; user_b: number; meet_a: string | null; meet_b: string | null }
    | undefined;
  if (!m || (m.user_a !== user.id && m.user_b !== user.id)) {
    return bad("매칭을 찾을 수 없습니다.", 404);
  }

  const col = m.user_a === user.id ? "meet_a" : "meet_b";
  d.prepare(`UPDATE matches SET ${col} = ? WHERE id = ?`).run(answer, m.id);

  const partnerId = m.user_a === user.id ? m.user_b : m.user_a;
  d.prepare(
    "INSERT INTO behavior_events (user_id, target_id, event) VALUES (?, ?, ?)"
  ).run(user.id, partnerId, answer === "yes" ? "meet_yes" : "meet_not_yet");

  // 데모 상대는 YES에 YES로 화답 (데모 전용 동작)
  if (answer === "yes") {
    const partner = d.prepare("SELECT * FROM users WHERE id = ?").get(partnerId) as UserRow;
    if (partner?.is_demo) {
      const pcol = m.user_a === partnerId ? "meet_a" : "meet_b";
      d.prepare(`UPDATE matches SET ${pcol} = 'yes' WHERE id = ?`).run(m.id);
    }
  }

  const updated = d.prepare("SELECT meet_a, meet_b FROM matches WHERE id = ?").get(m.id) as {
    meet_a: string | null; meet_b: string | null;
  };
  const both = updated.meet_a === "yes" && updated.meet_b === "yes";
  if (both) {
    d.prepare(
      "UPDATE matches SET meet_confirmed_at = COALESCE(meet_confirmed_at, datetime('now')) WHERE id = ?"
    ).run(m.id);
  }

  return NextResponse.json({ ok: true, bothWantMeet: both });
}
