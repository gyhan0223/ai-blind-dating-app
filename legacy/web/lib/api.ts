import { NextResponse } from "next/server";
import { currentUser } from "./session";
import { age } from "./matching";
import type { PublicProfile, UserRow } from "./types";

export async function requireUser(): Promise<
  { user: UserRow; error: null } | { user: null; error: NextResponse }
> {
  const user = await currentUser();
  if (!user) {
    return {
      user: null,
      error: NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 }),
    };
  }
  return { user, error: null };
}

/** 상대에게 보여줄 수 있는 정보만 추린다 — 사진/얼굴 벡터는 절대 포함하지 않는다 */
export function publicProfile(u: UserRow): PublicProfile {
  return {
    id: u.id,
    age: age(u.birth_year),
    region: u.region,
    heightCm: u.height_cm,
    job: u.job,
    education: u.education,
    smoking: u.smoking,
    drinking: u.drinking,
    religion: u.religion,
    mbti: u.mbti,
    phoneVerified: !!u.phone_verified,
    faceVerified: !!u.face_verified,
  };
}

export const bad = (msg: string, status = 400) =>
  NextResponse.json({ error: msg }, { status });
