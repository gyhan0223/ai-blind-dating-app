import { NextResponse } from "next/server";
import { bad } from "@/lib/api";

// 휴대전화 본인 인증 — MVP에서는 모의(mock) 구현.
// 실제 서비스에서는 PASS/NICE 등 본인확인 기관 연동으로 교체한다.
export async function POST(req: Request) {
  const { phone } = await req.json().catch(() => ({}));
  if (!phone || !/^01[0-9]-?\d{3,4}-?\d{4}$/.test(String(phone))) {
    return bad("올바른 휴대전화 번호를 입력해 주세요.");
  }
  // 데모: 인증번호는 항상 000000 (응답에 안내)
  return NextResponse.json({ ok: true, demoHint: "데모 인증번호: 000000" });
}
