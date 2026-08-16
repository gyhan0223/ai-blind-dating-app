"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";

interface Msg { id: number; sender_id: number; body: string; created_at: string }

interface ChatData {
  matchId: number;
  partnerName: string;
  profile: { id: number; age: number; region: string; job: string; mbti: string };
  icebreaker: string;
  messages: Msg[];
  myId: number;
  myMeet: string | null;
  bothWantMeet: boolean;
  feedbackDone: boolean;
  meetUnlocked: boolean;
}

export default function Chat() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<ChatData | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [showSafety, setShowSafety] = useState(false);
  const [fb, setFb] = useState({ meetAgain: null as boolean | null, looksFit: null as boolean | null, talkComfortable: null as boolean | null });
  const endRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/chat/${id}`);
    if (res.status === 401) return router.replace("/login");
    if (!res.ok) return router.replace("/matches");
    setData(await res.json());
  }, [id, router]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [data?.messages.length]);

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setText("");
    await fetch(`/api/chat/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    setBusy(false);
    await load();
  };

  const answerMeet = async (answer: "yes" | "not_yet") => {
    await fetch("/api/meet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matchId: Number(id), answer }),
    });
    await load();
  };

  const submitFeedback = async () => {
    if (fb.meetAgain === null) return;
    await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        matchId: Number(id), meetAgain: fb.meetAgain,
        looksFit: fb.looksFit ?? undefined, talkComfortable: fb.talkComfortable ?? undefined,
      }),
    });
    setShowFeedback(false);
    await load();
  };

  const safetyAction = async (action: "block" | "report") => {
    const reason = action === "report" ? prompt("신고 사유를 입력해 주세요.") : null;
    if (action === "report" && !reason) return;
    await fetch("/api/safety", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, userId: data?.profile.id, reason }),
    });
    setShowSafety(false);
    router.replace("/matches");
  };

  if (!data) return <main className="page"><p className="muted center mt24">불러오는 중…</p></main>;

  return (
    <>
      <header className="topbar">
        <h1>
          {data.partnerName}
          <span className="muted small"> · {data.profile.age}세 · {data.profile.region}</span>
        </h1>
        <button className="btn ghost small" onClick={() => setShowSafety(true)}>⋯</button>
      </header>
      <main className="page" style={{ paddingBottom: 140 }}>
        <div className="chat-list">
          <div className="bubble system">
            💡 AI Icebreaker
            <br />
            {data.icebreaker}
          </div>

          {data.messages.map((m) => (
            <div key={m.id} className={`bubble ${m.sender_id === data.myId ? "mine" : "theirs"}`}>
              {m.body}
            </div>
          ))}

          {data.bothWantMeet && (
            <div className="bubble system">
              💐 두 분 모두 만나보고 싶어 해요!
              <br />
              장소와 시간을 정해 보세요. 얼굴은 실제 만남에서 처음 확인하게 돼요.
              <br />
              <span className="small">
                첫 만남은 카페 등 공개된 장소에서, 지인에게 일정을 공유하면 더 안전해요.
              </span>
              {!data.feedbackDone && (
                <button className="btn small mt8" onClick={() => setShowFeedback(true)}>
                  만남 후 피드백 남기기
                </button>
              )}
              {data.feedbackDone && <p className="small mt8">피드백 완료 — AI가 다음 추천에 반영해요 ✓</p>}
            </div>
          )}

          {data.meetUnlocked && !data.myMeet && !data.bothWantMeet && (
            <div className="bubble system">
              대화가 잘 이어지고 있네요. 이 분을 실제로 만나보고 싶나요?
              <div className="row mt8">
                <button className="btn small" onClick={() => answerMeet("yes")}>만나보고 싶어요</button>
                <button className="btn secondary small" onClick={() => answerMeet("not_yet")}>아직이요</button>
              </div>
              <p className="small mt8">내 선택은 상대에게 바로 알려지지 않아요. 둘 다 원할 때만 알려드려요.</p>
            </div>
          )}

          {data.myMeet === "yes" && !data.bothWantMeet && (
            <div className="bubble system">
              만나보고 싶다고 답했어요. 상대도 원하면 알려드릴게요. (그전까지는 비공개)
            </div>
          )}
          <div ref={endRef} />
        </div>
      </main>

      <div className="chat-input">
        <input
          value={text}
          placeholder="메시지 보내기"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <button onClick={send} disabled={busy || !text.trim()}>전송</button>
      </div>

      {showFeedback && (
        <div className="modal-back" onClick={() => setShowFeedback(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <p style={{ fontWeight: 700, fontSize: "1.05rem" }}>만남은 어땠나요?</p>
            <p className="muted small mt8">답변은 상대에게 공개되지 않고, 나의 다음 추천을 더 정확하게 만드는 데만 사용돼요.</p>
            <div className="field mt16">
              <label>다시 만나고 싶나요?</label>
              <div className="chips">
                <button className={`chip ${fb.meetAgain === true ? "on" : ""}`} onClick={() => setFb({ ...fb, meetAgain: true })}>네!</button>
                <button className={`chip ${fb.meetAgain === false ? "on" : ""}`} onClick={() => setFb({ ...fb, meetAgain: false })}>아니요</button>
              </div>
            </div>
            <div className="field">
              <label>실제 모습이 취향이었나요? <span className="muted small">(선택)</span></label>
              <div className="chips">
                <button className={`chip ${fb.looksFit === true ? "on" : ""}`} onClick={() => setFb({ ...fb, looksFit: true })}>네</button>
                <button className={`chip ${fb.looksFit === false ? "on" : ""}`} onClick={() => setFb({ ...fb, looksFit: false })}>아니요</button>
              </div>
            </div>
            <div className="field">
              <label>대화가 편했나요? <span className="muted small">(선택)</span></label>
              <div className="chips">
                <button className={`chip ${fb.talkComfortable === true ? "on" : ""}`} onClick={() => setFb({ ...fb, talkComfortable: true })}>네</button>
                <button className={`chip ${fb.talkComfortable === false ? "on" : ""}`} onClick={() => setFb({ ...fb, talkComfortable: false })}>아니요</button>
              </div>
            </div>
            <button className="btn" onClick={submitFeedback} disabled={fb.meetAgain === null}>제출하기</button>
          </div>
        </div>
      )}

      {showSafety && (
        <div className="modal-back" onClick={() => setShowSafety(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <p style={{ fontWeight: 700 }}>안전 도구</p>
            <p className="muted small mt8">안전 기능은 항상 무료예요.</p>
            <button className="btn secondary mt16" onClick={() => safetyAction("block")}>이 사용자 차단하기</button>
            <button className="btn secondary mt8" style={{ color: "var(--accent-ink)" }} onClick={() => safetyAction("report")}>신고하기</button>
            <button className="btn ghost mt8" onClick={() => setShowSafety(false)}>닫기</button>
          </div>
        </div>
      )}
    </>
  );
}
