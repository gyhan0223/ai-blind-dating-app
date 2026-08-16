"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import BottomNav from "@/components/BottomNav";

interface MatchItem {
  matchId: number;
  partnerName: string;
  profile: { age: number; region: string; mbti: string };
  lastMessage: string | null;
  bothWantMeet: boolean;
}

export default function Matches() {
  const [items, setItems] = useState<MatchItem[] | null>(null);

  useEffect(() => {
    fetch("/api/matches")
      .then((r) => r.json())
      .then((d) => setItems(d.items ?? []));
  }, []);

  return (
    <>
      <header className="topbar"><h1>대화</h1></header>
      <main className="page">
        {items === null && <p className="muted center mt24">불러오는 중…</p>}
        {items?.length === 0 && (
          <div className="card center">
            <p style={{ fontSize: "2rem" }}>💬</p>
            <p style={{ fontWeight: 700 }}>아직 매칭이 없어요</p>
            <p className="muted small mt8">
              오늘의 소개에서 서로 호감이 통하면 여기서 대화할 수 있어요.
            </p>
          </div>
        )}
        {items?.map((m) => (
          <Link href={`/chat/${m.matchId}`} key={m.matchId}>
            <div className="list-item">
              <div className="avatar">🤍</div>
              <div className="body">
                <p className="name">
                  {m.partnerName}
                  <span className="muted small"> · {m.profile.age}세 · {m.profile.region}</span>
                  {m.bothWantMeet && <span className="badge pink" style={{ marginLeft: 6 }}>만남 예정 💐</span>}
                </p>
                <p className="preview">{m.lastMessage ?? "AI가 첫 대화 주제를 준비해 뒀어요."}</p>
              </div>
            </div>
          </Link>
        ))}
      </main>
      <BottomNav />
    </>
  );
}
