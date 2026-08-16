import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, bad, publicProfile } from "@/lib/api";
import { pickDaily, scoreCandidates, topReasons } from "@/lib/matching";
import type { UserRow } from "@/lib/types";

const FREE_DAILY = 2; // 하루 기본 추천 (계획서 13장: 1~3명)
const PLUS_DAILY = 4; // Plus: 하루 추가 추천 — 품질이 아니라 '기회'를 판다

// 오늘의 소개 조회 (없으면 생성)
export async function GET() {
  const { user, error } = await requireUser();
  if (error) return error;
  if (!user.onboarded) return bad("온보딩을 먼저 완료해 주세요.", 409);

  const d = db();
  const today = new Date().toISOString().slice(0, 10);
  const limit = user.plan === "plus" ? PLUS_DAILY : FREE_DAILY;

  let rows = d
    .prepare(
      `SELECT * FROM recommendations WHERE user_id = ? AND rec_date = ? ORDER BY id`
    )
    .all(user.id, today) as {
    id: number; target_id: number; bucket: string; score_ab: number;
    score_ba: number; components: string; decision: string;
  }[];

  if (rows.length < limit) {
    const cands = scoreCandidates(d, user).filter(
      (c) => !rows.some((r) => r.target_id === c.user.id)
    );
    const picked = pickDaily(cands, limit - rows.length);
    const ins = d.prepare(
      `INSERT OR IGNORE INTO recommendations
       (user_id, target_id, rec_date, bucket, score_ab, score_ba, components)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const { cand, bucket } of picked) {
      ins.run(user.id, cand.user.id, today, bucket, cand.ab, cand.ba,
        JSON.stringify(cand.comp));
    }
    rows = d
      .prepare(
        `SELECT * FROM recommendations WHERE user_id = ? AND rec_date = ? ORDER BY id`
      )
      .all(user.id, today) as typeof rows;
  }

  const getU = d.prepare("SELECT * FROM users WHERE id = ?");
  const items = rows.map((r) => {
    const target = getU.get(r.target_id) as UserRow;
    const comp = JSON.parse(r.components || "{}");
    return {
      recId: r.id,
      profile: publicProfile(target),
      bucket: r.bucket,
      reasons: topReasons(comp),
      decision: r.decision,
      // 원칙: 사용자에게 원시 점수·퍼센트는 노출하지 않는다. 문구 단계만 전달.
      confidence:
        (r.score_ab + r.score_ba) / 2 >= 0.62
          ? "두 분은 서로 잘 맞을 가능성이 높은 편이에요."
          : "새로운 시선으로 만나 보면 좋을 것 같은 분이에요.",
    };
  });

  return NextResponse.json({ date: today, limit, items, plan: user.plan });
}
