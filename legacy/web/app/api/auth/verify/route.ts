import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createSession } from "@/lib/session";
import { bad } from "@/lib/api";
import type { UserRow } from "@/lib/types";

export async function POST(req: Request) {
  const { phone, code } = await req.json().catch(() => ({}));
  const p = String(phone ?? "").replace(/-/g, "");
  if (!/^01[0-9]\d{7,8}$/.test(p)) return bad("올바른 휴대전화 번호를 입력해 주세요.");
  if (String(code) !== "000000") return bad("인증번호가 일치하지 않습니다. (데모: 000000)");

  const d = db();
  let user = d.prepare("SELECT * FROM users WHERE phone = ?").get(p) as UserRow | undefined;
  if (!user) {
    const info = d
      .prepare("INSERT INTO users (phone, phone_verified) VALUES (?, 1)")
      .run(p);
    user = d.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid) as UserRow;
  } else {
    d.prepare("UPDATE users SET phone_verified = 1 WHERE id = ?").run(user.id);
  }
  await createSession(user.id);
  return NextResponse.json({ ok: true, onboarded: !!user.onboarded });
}
