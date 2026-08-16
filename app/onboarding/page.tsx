"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import FaceCard from "@/components/FaceCard";
import {
  DEFAULT_WEIGHTS,
  DRINKING,
  EDUCATIONS,
  FACE_DIMS,
  JOBS,
  MBTIS,
  REGIONS,
  RELIGIONS,
  SMOKING,
} from "@/lib/types";

const TOTAL_STEPS = 8;

function Slider({
  value, onChange, left, right, label,
}: {
  value: number; onChange: (v: number) => void;
  left: string; right: string; label?: string;
}) {
  return (
    <div className="slider-field">
      {label && <label style={{ fontWeight: 600, fontSize: ".9rem" }}>{label}</label>}
      <input
        type="range" min={0} max={100} value={Math.round(value * 100)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
      />
      <div className="labels"><span>{left}</span><span>{right}</span></div>
    </div>
  );
}

const randVec = () => FACE_DIMS.map(() => Math.round(Math.random() * 100) / 100);

export default function Onboarding() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // step 0: 기본 정보
  const [basic, setBasic] = useState({
    name: "", gender: "M", birthYear: 1998, region: "서울", heightCm: 170,
    job: "직장인", education: "대졸", smoking: "비흡연", drinking: "가끔",
    religion: "무교", mbti: "ENFP",
  });
  // step 1: 라이프스타일
  const [life, setLife] = useState({
    morningType: 0.5, homeDate: 0.5, travelFreq: 0.5, exerciseFreq: 0.5,
    contactFreq: 0.5, drinkingParty: 0.5, spending: 0.5, weekendOut: 0.5,
  });
  // step 2: 성격 (행동 기반)
  const [pers, setPers] = useState({
    conflictDirect: 0.5, expressive: 0.5, planned: 0.5, togetherness: 0.5, humor: 0.5,
  });
  // step 3: 가치관 + 연애 스타일
  const [vals, setVals] = useState({
    marriageIntent: 0.5, marriageTiming: 0.5, kidsIntent: 0.5,
    longDistanceOk: 0.5, pastMatters: 0.5,
  });
  const [pastSkipped, setPastSkipped] = useState(false);
  const [rel, setRel] = useState({
    contactDesire: 0.5, affection: 0.5, dateFreq: 0.5, personalTime: 0.5, friendBoundary: 0.5,
  });
  // step 4: Dealbreaker
  const [dbk, setDbk] = useState({
    noSmoking: false, minAge: 22, maxAge: 38, regions: [] as string[],
    religionRequired: null as string | null, kidsMustAlign: false,
  });
  // step 5: 가중치
  const [weights, setWeights] = useState({ ...DEFAULT_WEIGHTS });
  // step 6: 외모 취향 A/B 테스트
  const [pair, setPair] = useState<[number[], number[]]>([randVec(), randVec()]);
  const [round, setRound] = useState(0);
  const [rounds, setRounds] = useState<{ chosen: number[]; other: number[] }[]>([]);
  const AB_ROUNDS = 10;
  // step 7: 얼굴 인증
  const [faceDone, setFaceDone] = useState(false);

  const weightSum = useMemo(
    () => Object.values(weights).reduce((a, b) => a + b, 0),
    [weights]
  );

  const next = () => { setErr(""); setStep((s) => Math.min(TOTAL_STEPS - 1, s + 1)); };
  const back = () => { setErr(""); setStep((s) => Math.max(0, s - 1)); };

  const chooseFace = (idx: 0 | 1) => {
    const chosen = pair[idx];
    const other = pair[idx === 0 ? 1 : 0];
    const nextRounds = [...rounds, { chosen, other }];
    setRounds(nextRounds);
    if (round + 1 >= AB_ROUNDS) {
      next();
    } else {
      setRound(round + 1);
      setPair([randVec(), randVec()]);
    }
  };

  const doFaceVerify = async () => {
    setBusy(true);
    const res = await fetch("/api/face-verify", { method: "POST" });
    setBusy(false);
    if (res.ok) setFaceDone(true);
  };

  const finish = async () => {
    setBusy(true);
    setErr("");
    try {
      const values = { ...vals, pastMatters: pastSkipped ? 0.5 : vals.pastMatters };
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...basic, lifestyle: life, personality: pers, values, relStyle: rel,
          weights, dealbreakers: dbk, completeOnboarding: true,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        setErr(data.error ?? "저장에 실패했어요.");
        setBusy(false);
        return;
      }
      if (rounds.length > 0) {
        await fetch("/api/preference-test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rounds }),
        });
      }
      router.replace("/today");
    } catch {
      setErr("네트워크 오류가 발생했어요.");
      setBusy(false);
    }
  };

  const sel = (v: string, cur: string, set: () => void) => (
    <button key={v} className={`chip ${cur === v ? "on" : ""}`} onClick={set}>{v}</button>
  );

  return (
    <main className="page no-nav">
      <div className="progress">
        {Array.from({ length: TOTAL_STEPS }, (_, i) => (
          <i key={i} className={i <= step ? "done" : ""} />
        ))}
      </div>

      {step === 0 && (
        <>
          <h1 className="tagline">기본 정보</h1>
          <p className="muted mt8">사진 대신, 나를 이해할 수 있는 정보로 소개돼요.</p>
          <div className="card mt16">
            <div className="field">
              <label>이름 (상대에게 표시)</label>
              <input type="text" value={basic.name} placeholder="닉네임 또는 이름"
                onChange={(e) => setBasic({ ...basic, name: e.target.value })} />
            </div>
            <div className="field">
              <label>성별</label>
              <div className="chips">
                {sel("남성", basic.gender === "M" ? "남성" : "여성", () => setBasic({ ...basic, gender: "M" }))}
                {sel("여성", basic.gender === "F" ? "여성" : "남성", () => setBasic({ ...basic, gender: "F" }))}
              </div>
            </div>
            <div className="row">
              <div className="field">
                <label>출생연도</label>
                <input type="number" value={basic.birthYear}
                  onChange={(e) => setBasic({ ...basic, birthYear: Number(e.target.value) })} />
              </div>
              <div className="field">
                <label>키 (cm)</label>
                <input type="number" value={basic.heightCm}
                  onChange={(e) => setBasic({ ...basic, heightCm: Number(e.target.value) })} />
              </div>
            </div>
            <div className="field">
              <label>거주 지역</label>
              <select value={basic.region} onChange={(e) => setBasic({ ...basic, region: e.target.value })}>
                {REGIONS.map((r) => <option key={r}>{r}</option>)}
              </select>
            </div>
            <div className="row">
              <div className="field">
                <label>직업군</label>
                <select value={basic.job} onChange={(e) => setBasic({ ...basic, job: e.target.value })}>
                  {JOBS.map((r) => <option key={r}>{r}</option>)}
                </select>
              </div>
              <div className="field">
                <label>학력</label>
                <select value={basic.education} onChange={(e) => setBasic({ ...basic, education: e.target.value })}>
                  {EDUCATIONS.map((r) => <option key={r}>{r}</option>)}
                </select>
              </div>
            </div>
            <div className="row">
              <div className="field">
                <label>흡연</label>
                <select value={basic.smoking} onChange={(e) => setBasic({ ...basic, smoking: e.target.value })}>
                  {SMOKING.map((r) => <option key={r}>{r}</option>)}
                </select>
              </div>
              <div className="field">
                <label>음주</label>
                <select value={basic.drinking} onChange={(e) => setBasic({ ...basic, drinking: e.target.value })}>
                  {DRINKING.map((r) => <option key={r}>{r}</option>)}
                </select>
              </div>
            </div>
            <div className="row">
              <div className="field">
                <label>종교</label>
                <select value={basic.religion} onChange={(e) => setBasic({ ...basic, religion: e.target.value })}>
                  {RELIGIONS.map((r) => <option key={r}>{r}</option>)}
                </select>
              </div>
              <div className="field">
                <label>MBTI</label>
                <select value={basic.mbti} onChange={(e) => setBasic({ ...basic, mbti: e.target.value })}>
                  {MBTIS.map((r) => <option key={r}>{r}</option>)}
                </select>
              </div>
            </div>
          </div>
          <button className="btn" onClick={next} disabled={!basic.name.trim()}>다음</button>
        </>
      )}

      {step === 1 && (
        <>
          <h1 className="tagline">라이프스타일</h1>
          <p className="muted mt8">생활 패턴이 비슷할수록 관계가 오래 이어져요.</p>
          <div className="card mt16">
            <Slider value={life.morningType} onChange={(v) => setLife({ ...life, morningType: v })} left="저녁형" right="아침형" />
            <Slider value={life.homeDate} onChange={(v) => setLife({ ...life, homeDate: v })} left="밖에서 데이트" right="집데이트" />
            <Slider value={life.travelFreq} onChange={(v) => setLife({ ...life, travelFreq: v })} left="여행은 가끔" right="여행 자주" />
            <Slider value={life.exerciseFreq} onChange={(v) => setLife({ ...life, exerciseFreq: v })} left="운동 안 함" right="운동 자주" />
            <Slider value={life.contactFreq} onChange={(v) => setLife({ ...life, contactFreq: v })} left="연락은 필요할 때" right="수시로 연락" />
            <Slider value={life.drinkingParty} onChange={(v) => setLife({ ...life, drinkingParty: v })} left="술자리 선호 안 함" right="술자리 좋아함" />
            <Slider value={life.spending} onChange={(v) => setLife({ ...life, spending: v })} left="아끼는 편" right="쓰는 편" />
            <Slider value={life.weekendOut} onChange={(v) => setLife({ ...life, weekendOut: v })} left="주말엔 집에서" right="주말엔 밖에서" />
          </div>
          <div className="row">
            <button className="btn secondary" onClick={back}>이전</button>
            <button className="btn" onClick={next}>다음</button>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <h1 className="tagline">성격</h1>
          <p className="muted mt8">MBTI보다, 실제 행동을 기준으로 답해 주세요.</p>
          <div className="card mt16">
            <Slider value={pers.conflictDirect} onChange={(v) => setPers({ ...pers, conflictDirect: v })}
              label="갈등이 생기면" left="시간을 갖는다" right="바로 이야기한다" />
            <Slider value={pers.expressive} onChange={(v) => setPers({ ...pers, expressive: v })}
              label="마음 표현은" left="행동으로 보여준다" right="말로 많이 한다" />
            <Slider value={pers.planned} onChange={(v) => setPers({ ...pers, planned: v })}
              label="일정은" left="즉흥형" right="계획형" />
            <Slider value={pers.togetherness} onChange={(v) => setPers({ ...pers, togetherness: v })}
              label="연인과의 시간" left="개인 시간 중요" right="함께가 좋다" />
            <Slider value={pers.humor} onChange={(v) => setPers({ ...pers, humor: v })}
              label="대화 스타일" left="차분한 대화" right="장난·유머 많음" />
          </div>
          <div className="row">
            <button className="btn secondary" onClick={back}>이전</button>
            <button className="btn" onClick={next}>다음</button>
          </div>
        </>
      )}

      {step === 3 && (
        <>
          <h1 className="tagline">연애 가치관</h1>
          <p className="muted mt8">중요하게 생각하는 만큼만 답해 주세요.</p>
          <div className="card mt16">
            <Slider value={vals.marriageIntent} onChange={(v) => setVals({ ...vals, marriageIntent: v })}
              label="결혼 의향" left="생각 없음" right="꼭 하고 싶음" />
            <Slider value={vals.marriageTiming} onChange={(v) => setVals({ ...vals, marriageTiming: v })}
              label="결혼 시기" left="천천히" right="빠르게" />
            <Slider value={vals.kidsIntent} onChange={(v) => setVals({ ...vals, kidsIntent: v })}
              label="자녀 계획" left="원하지 않음" right="꼭 원함" />
            <Slider value={vals.longDistanceOk} onChange={(v) => setVals({ ...vals, longDistanceOk: v })}
              label="장거리 연애" left="어려움" right="가능" />
          </div>
          <div className="card">
            <p style={{ fontWeight: 600, fontSize: ".9rem" }}>과거 연애에 대한 가치관 <span className="muted small">(민감 항목 — 선택)</span></p>
            {!pastSkipped && (
              <Slider value={vals.pastMatters} onChange={(v) => setVals({ ...vals, pastMatters: v })}
                left="상대의 과거는 무관" right="과거가 중요함" />
            )}
            <button className="btn ghost small" onClick={() => setPastSkipped(!pastSkipped)}>
              {pastSkipped ? "다시 답변하기" : "이 항목은 답변하지 않을래요"}
            </button>
          </div>
          <div className="card">
            <p style={{ fontWeight: 600, fontSize: ".9rem", marginBottom: 12 }}>연애 스타일</p>
            <Slider value={rel.contactDesire} onChange={(v) => setRel({ ...rel, contactDesire: v })}
              label="원하는 연락 빈도" left="필요할 때만" right="자주" />
            <Slider value={rel.affection} onChange={(v) => setRel({ ...rel, affection: v })}
              label="애정 표현" left="담백하게" right="적극적으로" />
            <Slider value={rel.dateFreq} onChange={(v) => setRel({ ...rel, dateFreq: v })}
              label="데이트 빈도" left="주 1회 이하" right="주 3회 이상" />
            <Slider value={rel.personalTime} onChange={(v) => setRel({ ...rel, personalTime: v })}
              label="개인 시간" left="적어도 괜찮음" right="꼭 필요함" />
            <Slider value={rel.friendBoundary} onChange={(v) => setRel({ ...rel, friendBoundary: v })}
              label="이성 친구" left="조심하는 게 좋음" right="자유로워도 됨" />
          </div>
          <div className="row">
            <button className="btn secondary" onClick={back}>이전</button>
            <button className="btn" onClick={next}>다음</button>
          </div>
        </>
      )}

      {step === 4 && (
        <>
          <h1 className="tagline">Dealbreaker</h1>
          <p className="muted mt8">
            여기서 정한 조건이 맞지 않는 사람은 <b>아예 소개하지 않아요</b>.
            선호(Preference)와는 달라요.
          </p>
          <div className="card mt16">
            <div className="field">
              <label>흡연</label>
              <div className="chips">
                <button className={`chip ${dbk.noSmoking ? "on" : ""}`}
                  onClick={() => setDbk({ ...dbk, noSmoking: !dbk.noSmoking })}>
                  흡연자는 소개받지 않기
                </button>
              </div>
            </div>
            <div className="row">
              <div className="field">
                <label>최소 나이</label>
                <input type="number" value={dbk.minAge}
                  onChange={(e) => setDbk({ ...dbk, minAge: Number(e.target.value) })} />
              </div>
              <div className="field">
                <label>최대 나이</label>
                <input type="number" value={dbk.maxAge}
                  onChange={(e) => setDbk({ ...dbk, maxAge: Number(e.target.value) })} />
              </div>
            </div>
            <div className="field">
              <label>지역 제한 <span className="muted small">(선택 없으면 전국)</span></label>
              <div className="chips">
                {REGIONS.map((r) => (
                  <button key={r}
                    className={`chip ${dbk.regions.includes(r) ? "on" : ""}`}
                    onClick={() =>
                      setDbk({
                        ...dbk,
                        regions: dbk.regions.includes(r)
                          ? dbk.regions.filter((x) => x !== r)
                          : [...dbk.regions, r],
                      })
                    }>
                    {r}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label>종교 조건 <span className="muted small">(같은 종교만 원할 때)</span></label>
              <select value={dbk.religionRequired ?? ""}
                onChange={(e) => setDbk({ ...dbk, religionRequired: e.target.value || null })}>
                <option value="">상관없음</option>
                {RELIGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div className="field">
              <label>자녀 계획</label>
              <div className="chips">
                <button className={`chip ${dbk.kidsMustAlign ? "on" : ""}`}
                  onClick={() => setDbk({ ...dbk, kidsMustAlign: !dbk.kidsMustAlign })}>
                  자녀 계획이 크게 다르면 소개받지 않기
                </button>
              </div>
            </div>
          </div>
          <div className="row">
            <button className="btn secondary" onClick={back}>이전</button>
            <button className="btn" onClick={next}>다음</button>
          </div>
        </>
      )}

      {step === 5 && (
        <>
          <h1 className="tagline">나에게 중요한 것</h1>
          <p className="muted mt8">
            사람마다 매칭 기준이 달라요. 나만의 비율을 정하면 AI가 그 기준으로 소개해요.
            앱을 쓰는 동안 실제 행동을 학습해 조금씩 보정돼요.
          </p>
          <div className="card mt16">
            {(
              [
                ["physical", "외모"],
                ["personality", "성격"],
                ["values", "가치관"],
                ["lifestyle", "생활방식"],
                ["relationship", "연애관"],
                ["conversation", "대화 궁합"],
              ] as const
            ).map(([k, label]) => (
              <div className="weight-row" key={k}>
                <span className="name">{label}</span>
                <input type="range" min={0} max={60} value={weights[k]}
                  onChange={(e) => setWeights({ ...weights, [k]: Number(e.target.value) })}
                  style={{ flex: 1 }} />
                <span className="val">{weightSum > 0 ? Math.round((weights[k] / weightSum) * 100) : 0}%</span>
              </div>
            ))}
            <p className="muted small mt8">비율은 자동으로 100% 기준으로 환산돼요.</p>
          </div>
          <div className="row">
            <button className="btn secondary" onClick={back}>이전</button>
            <button className="btn" onClick={next} disabled={weightSum <= 0}>다음</button>
          </div>
        </>
      )}

      {step === 6 && (
        <>
          <h1 className="tagline">외모 취향 알아보기</h1>
          <p className="muted mt8">
            AI가 만든 가상 얼굴이에요. 더 끌리는 쪽을 골라 주세요. ({round + 1}/{AB_ROUNDS})
            <br />
            <span className="small">이 선택으로 나만의 외모 취향 벡터가 만들어져요. 점수나 등급은 만들지 않아요.</span>
          </p>
          <div className="ab-wrap mt16">
            <button onClick={() => chooseFace(0)}><FaceCard vec={pair[0]} /><p className="mt8">A</p></button>
            <button onClick={() => chooseFace(1)}><FaceCard vec={pair[1]} /><p className="mt8">B</p></button>
          </div>
          <button className="btn ghost mt16" onClick={() => chooseFace(Math.random() < 0.5 ? 0 : 1)}>
            둘 다 비슷해요 (건너뛰기)
          </button>
        </>
      )}

      {step === 7 && (
        <>
          <h1 className="tagline">얼굴 인증</h1>
          <p className="muted mt8">
            마지막 단계예요. 얼굴 인증은 <b>상대에게 보여주기 위한 것이 아니에요.</b>
          </p>
          <div className="card mt16">
            <ul style={{ paddingLeft: 18, fontSize: ".92rem", color: "var(--ink-soft)" }}>
              <li>실제 사람인지 확인 (라이브니스)</li>
              <li>중복·가짜 계정 방지</li>
              <li>AI 외모 취향 매칭 (얼굴 원본·분석 결과 모두 비공개)</li>
            </ul>
            <p className="muted small mt8">
              상대에게는 &ldquo;본인 인증 완료 ✓ / 얼굴 인증 완료 ✓&rdquo; 배지만 보여요.
            </p>
            <button className="btn mt16" onClick={doFaceVerify} disabled={busy || faceDone}>
              {faceDone ? "얼굴 인증 완료 ✓" : "얼굴 촬영하고 인증하기 (데모)"}
            </button>
          </div>
          {err && <p className="small" style={{ color: "var(--accent-ink)", marginBottom: 10 }}>{err}</p>}
          <div className="row">
            <button className="btn secondary" onClick={back}>이전</button>
            <button className="btn" onClick={finish} disabled={busy || !faceDone}>
              {busy ? "저장 중…" : "가입 완료"}
            </button>
          </div>
        </>
      )}
    </main>
  );
}
