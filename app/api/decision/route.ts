import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, bad } from "@/lib/api";
import { componentsFor, directionalScore } from "@/lib/matching";
import type { UserRow, Weights } from "@/lib/types";

// [알아가고 싶어요] / [다음에요] 선택 처리.
// 상호 호감이면 매칭 생성. 한쪽만 선택한 경우 상대에게 알리지 않는다.
export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;
  const { targetId, decision } = await req.json().catch(() => ({}));
  const tid = Number(targetId);
  if (!tid || !["like", "pass"].includes(decision)) return bad("잘못된 요청입니다.");

  const d = db();
  const today = new Date().toISOString().slice(0, 10);
  const rec = d
    .prepare(
      `SELECT id FROM recommendations WHERE user_id = ? AND target_id = ? AND rec_date = ?`
    )
    .get(user.id, tid, today);
  if (!rec) return bad("오늘 추천된 상대가 아닙니다.");

  d.prepare(
    `UPDATE recommendations SET decision = ?, decided_at = datetime('now')
     WHERE user_id = ? AND target_id = ? AND rec_date = ?`
  ).run(decision === "like" ? "liked" : "passed", user.id, tid, today);

  d.prepare(
    `INSERT INTO behavior_events (user_id, target_id, event) VALUES (?, ?, ?)`
  ).run(user.id, tid, decision);

  if (decision === "pass") return NextResponse.json({ ok: true, matched: false });

  d.prepare("INSERT OR IGNORE INTO likes (from_id, to_id) VALUES (?, ?)").run(user.id, tid);

  const target = d.prepare("SELECT * FROM users WHERE id = ?").get(tid) as UserRow;

  // 데모 사용자는 '상대 → 나' 예상 호감도가 충분하면 호감을 돌려준다 (데모 전용 동작)
  if (target?.is_demo) {
    const comp = componentsFor(d, target, user);
    const w = JSON.parse(target.weights || "{}") as Weights;
    if (directionalScore(comp, w) >= 0.5) {
      d.prepare("INSERT OR IGNORE INTO likes (from_id, to_id) VALUES (?, ?)").run(tid, user.id);
    }
  }

  const mutual = d
    .prepare("SELECT 1 FROM likes WHERE from_id = ? AND to_id = ?")
    .get(tid, user.id);

  if (!mutual) return NextResponse.json({ ok: true, matched: false });

  const [a, b] = user.id < tid ? [user.id, tid] : [tid, user.id];
  d.prepare("INSERT OR IGNORE INTO matches (user_a, user_b) VALUES (?, ?)").run(a, b);
  const match = d
    .prepare("SELECT id FROM matches WHERE user_a = ? AND user_b = ?")
    .get(a, b) as { id: number };

  return NextResponse.json({ ok: true, matched: true, matchId: match.id });
}
