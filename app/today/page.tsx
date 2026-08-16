"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import BottomNav from "@/components/BottomNav";

interface RecItem {
  recId: number;
  profile: {
    id: number; age: number; region: string; heightCm: number; job: string;
    education: string; smoking: string; drinking: string; religion: string;
    mbti: string; phoneVerified: boolean; faceVerified: boolean;
  };
  bucket: string;
  reasons: string[];
  decision: string;
  confidence: string;
}

const BUCKET_LABEL: Record<string, string> = {
  confident: "서로 끌릴 가능성이 높아요",
  other_strength: "내면 궁합이 특히 좋아요",
  explore: "새로운 시선의 소개예요",
};

export default function Today() {
  const router = useRouter();
  const [items, setItems] = useState<RecItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [matchedName, setMatchedName] = useState<number | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/recommendations");
    if (res.status === 401) return router.replace("/login");
    if (res.status === 409) return router.replace("/onboarding");
    const data = await res.json();
    setItems(data.items);
  }, [router]);

  useEffect(() => { load(); }, [load]);

  const decide = async (targetId: number, decision: "like" | "pass") => {
    setBusy(true);
    const res = await fetch("/api/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetId, decision }),
    });
    const data = await res.json();
    setBusy(false);
    if (data.matched) setMatchedName(data.matchId);
    await load();
  };

  const pending = items?.filter((i) => i.decision === "pending") ?? [];
  const decided = items?.filter((i) => i.decision !== "pending") ?? [];

  return (
    <>
      <header className="topbar">
        <h1><span className="brand">본심</span> · 오늘의 소개</h1>
      </header>
      <main className="page">
        {items === null && <p className="muted center mt24">AI가 오늘의 소개를 준비하고 있어요…</p>}

        {matchedName !== null && (
          <div className="card" style={{ borderColor: "var(--accent)", background: "var(--accent-soft)" }}>
            <p style={{ fontWeight: 700 }}>🎉 서로 호감이 통했어요!</p>
            <p className="muted small mt8">두 분 모두 알아가고 싶다고 했어요. 대화를 시작해 보세요.</p>
            <button className="btn small mt8" onClick={() => router.push(`/chat/${matchedName}`)}>
              대화 시작하기
            </button>
          </div>
        )}

        {pending.map((item) => (
          <div className="card rec-card" key={item.recId}>
            <div className="no-photo">🤍</div>
            <p className="center muted small">{BUCKET_LABEL[item.bucket] ?? ""}</p>
            <div className="facts">
              <span>{item.profile.age}세</span>
              <span>{item.profile.region}</span>
              <span>{item.profile.heightCm}cm</span>
              <span>{item.profile.smoking}</span>
              <span>{item.profile.job}</span>
              <span>{item.profile.mbti}</span>
            </div>
            <div className="center" style={{ display: "flex", gap: 6, justifyContent: "center" }}>
              {item.profile.phoneVerified && <span className="badge">본인 인증 완료 ✓</span>}
              {item.profile.faceVerified && <span className="badge">얼굴 인증 완료 ✓</span>}
            </div>
            <p className="center mt16" style={{ fontWeight: 600 }}>{item.confidence}</p>
            <div className="reasons">
              {item.reasons.map((r) => <span className="badge pink" key={r}>{r}</span>)}
            </div>
            <div className="row">
              <button className="btn secondary" disabled={busy}
                onClick={() => decide(item.profile.id, "pass")}>
                다음에요
              </button>
              <button className="btn" disabled={busy}
                onClick={() => decide(item.profile.id, "like")}>
                알아가고 싶어요
              </button>
            </div>
          </div>
        ))}

        {items !== null && pending.length === 0 && (
          <div className="card center">
            <p style={{ fontSize: "2rem" }}>🌙</p>
            <p style={{ fontWeight: 700 }}>오늘의 소개를 모두 확인했어요</p>
            <p className="muted small mt8">
              내일 새로운 분을 소개해 드릴게요.
              <br />
              하루에 소수만 소개하는 건, 한 사람에게 집중하기 위해서예요.
            </p>
          </div>
        )}

        {decided.length > 0 && (
          <p className="muted small center mt16">
            오늘 {decided.length}명의 소개에 응답했어요.
          </p>
        )}
      </main>
      <BottomNav />
    </>
  );
}
