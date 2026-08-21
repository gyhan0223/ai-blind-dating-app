import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, bad } from "@/lib/api";

// 신고 / 차단 — 안전 기능은 무료이며 어떤 요금제에서도 제한하지 않는다.
export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;
  const { action, userId, reason } = await req.json().catch(() => ({}));
  const tid = Number(userId);
  if (!tid || tid === user.id) return bad("잘못된 요청입니다.");

  const d = db();
  if (action === "block") {
    d.prepare(
      "INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)"
    ).run(user.id, tid);
    return NextResponse.json({ ok: true, blocked: true });
  }
  if (action === "report") {
    const r = String(reason ?? "").trim().slice(0, 500);
    if (!r) return bad("신고 사유를 입력해 주세요.");
    d.prepare(
      "INSERT INTO reports (reporter_id, reported_id, reason) VALUES (?, ?, ?)"
    ).run(user.id, tid, r);
    // 신고와 동시에 차단 처리
    d.prepare(
      "INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)"
    ).run(user.id, tid);
    return NextResponse.json({ ok: true, reported: true });
  }
  return bad("알 수 없는 동작입니다.");
}
