import Link from "next/link";
import { currentUser } from "@/lib/session";
import { redirect } from "next/navigation";

export default async function Landing() {
  const user = await currentUser();
  if (user) redirect(user.onboarded ? "/today" : "/onboarding");

  return (
    <main className="page no-nav" style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
        <p className="brand" style={{ fontSize: "1.2rem", marginBottom: 18 }}>본심</p>
        <h1 className="tagline">
          서로의 얼굴은
          <br />
          AI만 먼저 봅니다.
        </h1>
        <p className="muted mt16">
          사진을 보고 수초 만에 판단하는 소개팅 대신,
          <br />
          AI가 외모 취향·성격·가치관·대화 궁합을 학습해
          <br />
          <b>실제로 잘 맞을 사람</b>을 소개해 드려요.
        </p>

        <div className="card mt24">
          <div className="badge pink">이 앱이 다른 점</div>
          <ul style={{ paddingLeft: 18, marginTop: 10, fontSize: ".92rem", color: "var(--ink-soft)" }}>
            <li>상대의 사진을 보지 않아요. 프로필 사진 경쟁이 없어요.</li>
            <li>외모를 무시하지 않아요 — AI가 내 취향을 학습해 대신 살펴봐요.</li>
            <li>무한 스와이프가 없어요. 하루에 소수의 사람만 소개해요.</li>
            <li>양방향 매칭: 나도, 상대도 서로 끌릴 가능성이 높을 때만.</li>
            <li>목표는 체류시간이 아니라 <b>좋은 관계로 앱을 떠나는 것</b>이에요.</li>
          </ul>
        </div>
      </div>

      <Link href="/login" className="btn">시작하기</Link>
      <p className="muted small center mt8">
        가입 시 본인 인증·얼굴 인증이 진행돼요. 얼굴은 상대에게 절대 공개되지 않아요.
      </p>
    </main>
  );
}
