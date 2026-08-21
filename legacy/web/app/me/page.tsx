"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import BottomNav from "@/components/BottomNav";
import { DEFAULT_WEIGHTS, type Weights } from "@/lib/types";

interface Me {
  name: string; age: number; region: string; heightCm: number; job: string;
  mbti: string; plan: string; phoneVerified: boolean; faceVerified: boolean;
  weights: Weights;
}

const WEIGHT_LABELS: [keyof Weights, string][] = [
  ["physical", "외모"],
  ["personality", "성격"],
  ["values", "가치관"],
  ["lifestyle", "생활방식"],
  ["relationship", "연애관"],
  ["conversation", "대화 궁합"],
];

export default function MePage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [weights, setWeights] = useState<Weights>({ ...DEFAULT_WEIGHTS });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/profile").then(async (res) => {
      if (res.status === 401) return router.replace("/login");
      const d = await res.json();
      setMe(d.me);
      setWeights({ ...DEFAULT_WEIGHTS, ...d.me.weights });
    });
  }, [router]);

  const sum = useMemo(() => Object.values(weights).reduce((a, b) => a + b, 0), [weights]);

  const saveWeights = async () => {
    await fetch("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ weights }),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const setPlan = async (plan: "free" | "plus") => {
    await fetch("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan }),
    });
    setMe((m) => (m ? { ...m, plan } : m));
  };

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/");
  };

  if (!me) return <main className="page"><p className="muted center mt24">불러오는 중…</p></main>;

  return (
    <>
      <header className="topbar"><h1>나</h1></header>
      <main className="page">
        <div className="card center">
          <div className="no-photo" style={{ width: 72, height: 72, borderRadius: "50%", background: "linear-gradient(135deg, var(--accent-soft), #fde7d8)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.8rem", margin: "0 auto 10px" }}>👤</div>
          <p style={{ fontWeight: 700, fontSize: "1.1rem" }}>{me.name}</p>
          <p className="muted small">{me.age}세 · {me.region} · {me.job} · {me.mbti}</p>
          <div style={{ display: "flex", gap: 6, justifyContent: "center", marginTop: 10 }}>
            {me.phoneVerified && <span className="badge">본인 인증 완료 ✓</span>}
            {me.faceVerified && <span className="badge">얼굴 인증 완료 ✓</span>}
          </div>
          <p className="muted small mt8">내 사진은 그 누구에게도 공개되지 않아요.</p>
        </div>

        <div className="card">
          <p style={{ fontWeight: 700 }}>매칭 중요도</p>
          <p className="muted small mt8">나에게 중요한 기준의 비율이에요. AI가 이 기준으로 소개해요.</p>
          <div className="mt16">
            {WEIGHT_LABELS.map(([k, label]) => (
              <div className="weight-row" key={k}>
                <span className="name">{label}</span>
                <input type="range" min={0} max={60} value={weights[k]}
                  onChange={(e) => setWeights({ ...weights, [k]: Number(e.target.value) })}
                  style={{ flex: 1 }} />
                <span className="val">{sum > 0 ? Math.round((weights[k] / sum) * 100) : 0}%</span>
              </div>
            ))}
          </div>
          <button className="btn small" onClick={saveWeights}>{saved ? "저장됨 ✓" : "저장"}</button>
        </div>

        <div className="card">
          <p style={{ fontWeight: 700 }}>요금제</p>
          <p className="muted small mt8">
            <b>Free와 Plus의 AI 매칭 품질은 동일해요.</b> Plus는 추천 기회와 편의만 늘려요.
            돈을 낸 사람이 더 좋은 사람을 소개받는 일은 없어요.
          </p>
          <div className="row mt16">
            <div className="card" style={{ marginBottom: 0, borderColor: me.plan === "free" ? "var(--accent)" : undefined }}>
              <p style={{ fontWeight: 700 }}>Free</p>
              <ul className="small muted" style={{ paddingLeft: 16, marginTop: 6 }}>
                <li>하루 2명 소개</li>
                <li>무제한 채팅</li>
                <li>AI Icebreaker</li>
                <li>실제 만남 기능</li>
                <li>모든 안전 기능</li>
              </ul>
              {me.plan !== "free" && <button className="btn secondary small mt8" onClick={() => setPlan("free")}>Free로 변경</button>}
            </div>
            <div className="card" style={{ marginBottom: 0, borderColor: me.plan === "plus" ? "var(--accent)" : undefined }}>
              <p style={{ fontWeight: 700 }}>Plus <span className="muted small">월 9,900원</span></p>
              <ul className="small muted" style={{ paddingLeft: 16, marginTop: 6 }}>
                <li>하루 4명 소개</li>
                <li>추천 지역 확장</li>
                <li>세밀한 Preference</li>
                <li>추천 일시정지</li>
                <li>매칭 품질은 Free와 동일</li>
              </ul>
              {me.plan !== "plus" && <button className="btn small mt8" onClick={() => setPlan("plus")}>Plus 시작 (데모)</button>}
            </div>
          </div>
        </div>

        <button className="btn ghost" onClick={logout}>로그아웃</button>
      </main>
      <BottomNav />
    </>
  );
}
