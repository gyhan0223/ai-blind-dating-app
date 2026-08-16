import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, bad } from "@/lib/api";
import { FACE_DIMS } from "@/lib/types";

// 외모 Preference Test 결과 반영.
// 클라이언트가 AI 생성 가상 얼굴(특징 벡터로 렌더링된 일러스트) A/B를 보여주고
// 선택 기록을 보내면, 선택된 벡터 방향으로 취향 벡터를 이동시킨다.
export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;
  const { rounds } = await req.json().catch(() => ({}));
  if (!Array.isArray(rounds) || rounds.length === 0) return bad("선택 기록이 없습니다.");

  const n = FACE_DIMS.length;
  let pref: number[];
  try {
    pref = JSON.parse(user.face_pref_vec);
  } catch {
    pref = [];
  }
  if (!Array.isArray(pref) || pref.length !== n) pref = Array(n).fill(0.5);

  const lr = 0.25;
  for (const r of rounds.slice(0, 40)) {
    const chosen = r?.chosen;
    const other = r?.other;
    if (!Array.isArray(chosen) || !Array.isArray(other)) continue;
    if (chosen.length !== n || other.length !== n) continue;
    for (let i = 0; i < n; i++) {
      const c = Math.min(1, Math.max(0, Number(chosen[i]) || 0));
      const o = Math.min(1, Math.max(0, Number(other[i]) || 0));
      pref[i] = Math.min(1, Math.max(0, pref[i] + lr * (c - pref[i]) - (lr / 2) * (o - pref[i])));
    }
  }

  db()
    .prepare("UPDATE users SET face_pref_vec = ? WHERE id = ?")
    .run(JSON.stringify(pref.map((v) => Math.round(v * 1000) / 1000)), user.id);

  return NextResponse.json({ ok: true });
}
