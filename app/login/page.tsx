"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function Login() {
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [hint, setHint] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const requestCode = async () => {
    setBusy(true);
    setErr("");
    const res = await fetch("/api/auth/request-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) return setErr(data.error);
    setHint(data.demoHint);
    setStep("code");
  };

  const verify = async () => {
    setBusy(true);
    setErr("");
    const res = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, code }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) return setErr(data.error);
    router.replace(data.onboarded ? "/today" : "/onboarding");
  };

  return (
    <main className="page no-nav">
      <h1 className="tagline" style={{ marginTop: 30 }}>휴대전화 본인 인증</h1>
      <p className="muted mt8">
        실제 사람만 가입할 수 있어요. 번호는 인증과 계정 보호에만 사용돼요.
      </p>

      <div className="card mt24">
        <div className="field">
          <label>휴대전화 번호</label>
          <input
            type="tel"
            placeholder="010-0000-0000"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            disabled={step === "code"}
          />
        </div>
        {step === "code" && (
          <div className="field">
            <label>인증번호</label>
            <input
              type="tel"
              placeholder="6자리 인증번호"
              value={code}
              maxLength={6}
              onChange={(e) => setCode(e.target.value)}
            />
            {hint && <p className="muted small mt8">{hint}</p>}
          </div>
        )}
        {err && <p className="small" style={{ color: "var(--accent-ink)", marginBottom: 10 }}>{err}</p>}
        {step === "phone" ? (
          <button className="btn" onClick={requestCode} disabled={busy || !phone}>
            인증번호 받기
          </button>
        ) : (
          <button className="btn" onClick={verify} disabled={busy || code.length !== 6}>
            인증하기
          </button>
        )}
      </div>
      <p className="muted small center">
        MVP 데모에서는 실제 SMS 대신 데모 인증번호(000000)를 사용해요.
      </p>
    </main>
  );
}
