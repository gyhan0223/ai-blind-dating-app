import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, bad, publicProfile } from "@/lib/api";
import { makeIcebreaker } from "@/lib/icebreaker";
import type { UserRow } from "@/lib/types";

interface MatchRow {
  id: number;
  user_a: number;
  user_b: number;
  meet_a: string | null;
  meet_b: string | null;
  meet_confirmed_at: string | null;
}

function loadMatch(matchId: number, userId: number) {
  const d = db();
  const m = d.prepare("SELECT * FROM matches WHERE id = ?").get(matchId) as
    | MatchRow
    | undefined;
  if (!m || (m.user_a !== userId && m.user_b !== userId)) return null;
  return m;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ matchId: string }> }
) {
  const { user, error } = await requireUser();
  if (error) return error;
  const { matchId } = await ctx.params;
  const m = loadMatch(Number(matchId), user.id);
  if (!m) return bad("매칭을 찾을 수 없습니다.", 404);

  const d = db();
  const partnerId = m.user_a === user.id ? m.user_b : m.user_a;
  const partner = d.prepare("SELECT * FROM users WHERE id = ?").get(partnerId) as UserRow;

  const messages = d
    .prepare(
      `SELECT id, sender_id, body, created_at FROM messages
       WHERE match_id = ? ORDER BY id ASC LIMIT 500`
    )
    .all(m.id);

  const myMeet = m.user_a === user.id ? m.meet_a : m.meet_b;
  const theirMeet = m.user_a === user.id ? m.meet_b : m.meet_a;
  const myFeedback = d
    .prepare("SELECT 1 FROM feedbacks WHERE match_id = ? AND user_id = ?")
    .get(m.id, user.id);

  return NextResponse.json({
    matchId: m.id,
    partnerName: partner.name,
    profile: publicProfile(partner),
    icebreaker: makeIcebreaker(user, partner),
    messages,
    myId: user.id,
    myMeet, // 'yes' | 'not_yet' | null
    bothWantMeet: m.meet_a === "yes" && m.meet_b === "yes",
    theirMeetVisible: m.meet_a === "yes" && m.meet_b === "yes" ? "yes" : null, // 한쪽만 YES면 비공개
    feedbackDone: !!myFeedback,
    // 실제 만남 질문은 대화가 일정 수준 진행된 후에만 노출
    meetUnlocked: messages.filter((x: any) => x.sender_id > 0).length >= 6,
  });
}

const DEMO_REPLIES = [
  "오 반가워요! 프로필 보고 대화가 잘 통할 것 같았어요 :)",
  "맞아요 ㅎㅎ 저도 그렇게 생각했어요. 주말엔 주로 뭐 하세요?",
  "재밌네요! 저는 요즘 새로운 카페 찾아다니는 게 낙이에요.",
  "그거 완전 공감이에요. 그런 얘기 나눌 수 있는 사람 오랜만이에요.",
  "하하 대화가 편하네요. 이런 페이스 좋아요.",
  "저도 궁금했던 부분이에요! 다음에 더 얘기해 봐요.",
];

export async function POST(
  req: Request,
  ctx: { params: Promise<{ matchId: string }> }
) {
  const { user, error } = await requireUser();
  if (error) return error;
  const { matchId } = await ctx.params;
  const m = loadMatch(Number(matchId), user.id);
  if (!m) return bad("매칭을 찾을 수 없습니다.", 404);

  const { body } = await req.json().catch(() => ({}));
  const text = String(body ?? "").trim().slice(0, 1000);
  if (!text) return bad("메시지를 입력해 주세요.");

  const d = db();
  const partnerId = m.user_a === user.id ? m.user_b : m.user_a;
  const blocked = d
    .prepare(
      `SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?)
       OR (blocker_id = ? AND blocked_id = ?)`
    )
    .get(user.id, partnerId, partnerId, user.id);
  if (blocked) return bad("대화할 수 없는 상대입니다.", 403);

  const prior = (
    d
      .prepare("SELECT COUNT(*) AS c FROM messages WHERE match_id = ? AND sender_id = ?")
      .get(m.id, user.id) as { c: number }
  ).c;

  d.prepare("INSERT INTO messages (match_id, sender_id, body) VALUES (?, ?, ?)").run(
    m.id, user.id, text
  );
  d.prepare(
    "INSERT INTO behavior_events (user_id, target_id, event) VALUES (?, ?, ?)"
  ).run(user.id, partnerId, prior === 0 ? "first_message" : "reply");

  // 데모 상대는 간단한 자동 응답 (데모 전용 — 실제 사용자 간에는 동작하지 않음)
  const partner = d.prepare("SELECT * FROM users WHERE id = ?").get(partnerId) as UserRow;
  if (partner?.is_demo) {
    const idx = (
      d
        .prepare("SELECT COUNT(*) AS c FROM messages WHERE match_id = ? AND sender_id = ?")
        .get(m.id, partnerId) as { c: number }
    ).c;
    const reply = DEMO_REPLIES[idx % DEMO_REPLIES.length];
    d.prepare("INSERT INTO messages (match_id, sender_id, body) VALUES (?, ?, ?)").run(
      m.id, partnerId, reply
    );
  }

  return NextResponse.json({ ok: true });
}
