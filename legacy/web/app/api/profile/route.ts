import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, bad, publicProfile } from "@/lib/api";
import { DEFAULT_WEIGHTS } from "@/lib/types";

export async function GET() {
  const { user, error } = await requireUser();
  if (error) return error;
  return NextResponse.json({
    me: {
      ...publicProfile(user),
      name: user.name,
      gender: user.gender,
      birthYear: user.birth_year,
      plan: user.plan,
      onboarded: !!user.onboarded,
      weights: JSON.parse(user.weights || "{}"),
      dealbreakers: JSON.parse(user.dealbreakers || "{}"),
      lifestyle: JSON.parse(user.lifestyle || "{}"),
      personality: JSON.parse(user.personality || "{}"),
      values: JSON.parse(user.values_json || "{}"),
      relStyle: JSON.parse(user.rel_style || "{}"),
    },
  });
}

// 온보딩/프로필 저장
export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (error) return error;
  const b = await req.json().catch(() => ({}));

  const name = String(b.name ?? user.name).slice(0, 20);
  const gender = b.gender === "F" ? "F" : b.gender === "M" ? "M" : user.gender;
  const birthYear = Number(b.birthYear ?? user.birth_year);
  const year = new Date().getFullYear();
  if (birthYear && (year - birthYear < 19 || year - birthYear > 80)) {
    return bad("성인만 가입할 수 있습니다.");
  }

  const weights = { ...DEFAULT_WEIGHTS, ...(b.weights ?? {}) };
  const wsum = Object.values(weights).reduce((a: number, v) => a + Number(v || 0), 0);
  if (wsum <= 0) return bad("중요도 가중치가 올바르지 않습니다.");

  db()
    .prepare(
      `UPDATE users SET
        name=@name, gender=@gender, birth_year=@birth_year, region=@region,
        height_cm=@height_cm, job=@job, education=@education, smoking=@smoking,
        drinking=@drinking, religion=@religion, mbti=@mbti,
        lifestyle=@lifestyle, personality=@personality, values_json=@values_json,
        rel_style=@rel_style, weights=@weights, dealbreakers=@dealbreakers,
        onboarded=@onboarded
       WHERE id=@id`
    )
    .run({
      id: user.id,
      name,
      gender,
      birth_year: birthYear || user.birth_year,
      region: String(b.region ?? user.region),
      height_cm: Number(b.heightCm ?? user.height_cm),
      job: String(b.job ?? user.job),
      education: String(b.education ?? user.education),
      smoking: String(b.smoking ?? user.smoking),
      drinking: String(b.drinking ?? user.drinking),
      religion: String(b.religion ?? user.religion),
      mbti: String(b.mbti ?? user.mbti),
      lifestyle: JSON.stringify(b.lifestyle ?? JSON.parse(user.lifestyle || "{}")),
      personality: JSON.stringify(b.personality ?? JSON.parse(user.personality || "{}")),
      values_json: JSON.stringify(b.values ?? JSON.parse(user.values_json || "{}")),
      rel_style: JSON.stringify(b.relStyle ?? JSON.parse(user.rel_style || "{}")),
      weights: JSON.stringify(weights),
      dealbreakers: JSON.stringify(b.dealbreakers ?? JSON.parse(user.dealbreakers || "{}")),
      onboarded: b.completeOnboarding ? 1 : user.onboarded,
    });

  return NextResponse.json({ ok: true });
}
