"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import BottomNav from "@/components/BottomNav";

interface CoachData {
  stats: {
    likes: number; passes: number; firstMessages: number; replies: number;
    meetYes: number; feedbackAgain: number; feedbackNo: number;
  };
  insights: string[];
}

export default function Coach() {
  const router = useRouter();
  const [data, setData] = useState<CoachData | null>(null);

  useEffect(() => {
    fetch("/api/coach").then(async (res) => {
      if (res.status === 401) return router.replace("/login");
      setData(await res.json());
    });
  }, [router]);

  return (
    <>
      <header className="topbar"><h1>AI Dating Coach</h1></header>
      <main className="page">
        <div className="card" style={{ background: "var(--accent-soft)", borderColor: "var(--accent)" }}>
          <p style={{ fontWeight: 700 }}>🪞 나의 연애 패턴 분석</p>
          <p className="muted small mt8">
            매칭 결과를 조작하는 기능이 아니에요. 내 행동 데이터를 나에게 돌려주는 분석이에요.
          </p>
        </div>

        {data && (
          <>
            <div className="card">
              <p style={{ fontWeight: 700, marginBottom: 10 }}>활동 요약</p>
              <div className="facts" style={{ justifyContent: "flex-start" }}>
                <span>호감 표현 {data.stats.likes}</span>
                <span>지나침 {data.stats.passes}</span>
                <span>먼저 말 걸기 {data.stats.firstMessages}</span>
                <span>대화 {data.stats.replies}</span>
                <span>만남 의사 {data.stats.meetYes}</span>
              </div>
            </div>
            <div className="card">
              <p style={{ fontWeight: 700, marginBottom: 10 }}>AI 인사이트</p>
              {data.insights.map((ins, i) => (
                <p key={i} className="mt8" style={{ fontSize: ".92rem" }}>
                  <span style={{ color: "var(--accent)" }}>•</span> {ins}
                </p>
              ))}
            </div>
          </>
        )}
        {!data && <p className="muted center mt24">분석 중…</p>}
      </main>
      <BottomNav />
    </>
  );
}
