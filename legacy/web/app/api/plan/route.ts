import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, bad } from "@/lib/api";

// 요금제 전환 — MVP에서는 결제 없이 전환만 시뮬레이션.
// 원칙: Plus는 추천 '기회와 편의성'만 늘린다. 매칭 알고리즘 품질은 Free와 동일하다.
export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;
  const { plan } = await req.json().catch(() => ({}));
  if (!["free", "plus"].includes(plan)) return bad("잘못된 요금제입니다.");
  db().prepare("UPDATE users SET plan = ? WHERE id = ?").run(plan, user.id);
  return NextResponse.json({ ok: true, plan });
}
