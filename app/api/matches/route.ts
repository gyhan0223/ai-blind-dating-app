import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, publicProfile } from "@/lib/api";
import type { UserRow } from "@/lib/types";

export async function GET() {
  const { user, error } = await requireUser();
  if (error) return error;
  const d = db();

  const rows = d
    .prepare(
      `SELECT * FROM matches WHERE (user_a = ? OR user_b = ?) ORDER BY created_at DESC`
    )
    .all(user.id, user.id) as {
    id: number; user_a: number; user_b: number; meet_a: string | null;
    meet_b: string | null; meet_confirmed_at: string | null; created_at: string;
  }[];

  const getU = d.prepare("SELECT * FROM users WHERE id = ?");
  const lastMsg = d.prepare(
    `SELECT body, sender_id, created_at FROM messages
     WHERE match_id = ? ORDER BY id DESC LIMIT 1`
  );

  const items = rows
    .map((m) => {
      const partnerId = m.user_a === user.id ? m.user_b : m.user_a;
      const partner = getU.get(partnerId) as UserRow | undefined;
      if (!partner) return null;
      const blocked = d
        .prepare(
          `SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?)
           OR (blocker_id = ? AND blocked_id = ?)`
        )
        .get(user.id, partnerId, partnerId, user.id);
      if (blocked) return null;
      const last = lastMsg.get(m.id) as
        | { body: string; sender_id: number; created_at: string }
        | undefined;
      return {
        matchId: m.id,
        partnerName: partner.name,
        profile: publicProfile(partner),
        lastMessage: last?.body ?? null,
        bothWantMeet: m.meet_a === "yes" && m.meet_b === "yes",
        createdAt: m.created_at,
      };
    })
    .filter(Boolean);

  return NextResponse.json({ items });
}
