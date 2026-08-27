import { NextResponse } from "next/server";
import crypto from "crypto";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/api";
import { FACE_DIMS } from "@/lib/types";

// 얼굴 라이브니스 인증 + 다각도 촬영 — MVP에서는 모의 구현.
// 실제 서비스에서는 온디바이스 라이브니스 SDK + 얼굴 임베딩 모델로 교체한다.
// 원칙: 분석 결과(face_vec)는 그 누구에게도 노출되지 않으며,
// 절대적인 외모 점수는 만들지 않는다. 오직 관계별 취향 예측에만 사용한다.
export async function POST() {
  const { user, error } = await requireUser();
  if (error) return error;

  // 사용자별 결정적 모의 특징 벡터 (실제로는 얼굴 임베딩)
  const hash = crypto.createHash("sha256").update(`face:${user.id}:${user.phone}`).digest();
  const vec = FACE_DIMS.map((_, i) => Math.round((hash[i] / 255) * 100) / 100);

  db()
    .prepare("UPDATE users SET face_vec = ?, face_verified = 1 WHERE id = ?")
    .run(JSON.stringify(vec), user.id);

  return NextResponse.json({ ok: true, faceVerified: true });
}
