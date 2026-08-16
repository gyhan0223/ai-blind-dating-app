"use client";

// AI 생성 가상 얼굴 일러스트 — 외모 Preference Test 전용.
// 특징 벡터(FACE_DIMS 순서)를 받아 스타일화된 얼굴을 그린다.
// 실제 인물 사진이 아니며, 벡터의 각 차원이 시각 요소에 대응한다.
// [faceRound, eyeSize, eyeSmile, hairLength, hairTone, softness, boldStyle, warmth]

export default function FaceCard({ vec }: { vec: number[] }) {
  const [faceRound, eyeSize, eyeSmile, hairLength, hairTone, softness, boldStyle, warmth] =
    vec.map((v) => Math.min(1, Math.max(0, v)));

  const w = 160;
  const h = 190;
  const cx = w / 2;

  // 얼굴형: 갸름 ~ 둥근
  const faceRx = 42 + faceRound * 14;
  const faceRy = 58 - faceRound * 8;
  const faceCy = 100;

  // 피부 톤 (웜/쿨 분위기)
  const skin = warmth > 0.5 ? "#f7dcc4" : "#f3ddd2";
  const blush = warmth > 0.5 ? "#f5b79b" : "#eab5b5";

  // 헤어
  const hairColors = ["#2b2320", "#4a352a", "#6b4a33", "#8a6a45", "#b08d5e"];
  const hairColor = hairColors[Math.min(4, Math.floor(hairTone * 5))];
  const hairBottom = faceCy + 10 + hairLength * 70; // 짧은 머리 ~ 긴 머리

  // 눈
  const eyeR = 3.5 + eyeSize * 4;
  const eyeY = faceCy - 6;
  const eyeDx = 18 + faceRound * 3;

  // 입: 부드러움에 따라 미소 곡률
  const smile = 2 + softness * 8;

  // 개성 스타일: 안경/귀걸이 등 포인트
  const showGlasses = boldStyle > 0.66;
  const showEarring = boldStyle > 0.4 && boldStyle <= 0.66;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width="100%"
      role="img"
      aria-label="AI 생성 가상 얼굴 일러스트"
      style={{ display: "block", borderRadius: 12, background: "#fbf3ec" }}
    >
      {/* 뒷머리 (긴 머리일수록 아래로) */}
      <path
        d={`M ${cx - faceRx - 8} ${faceCy - 20}
            Q ${cx - faceRx - 14} ${hairBottom} ${cx - faceRx + 6} ${hairBottom}
            L ${cx + faceRx - 6} ${hairBottom}
            Q ${cx + faceRx + 14} ${hairBottom} ${cx + faceRx + 8} ${faceCy - 20}
            Q ${cx + faceRx} ${faceCy - 70} ${cx} ${faceCy - 70}
            Q ${cx - faceRx} ${faceCy - 70} ${cx - faceRx - 8} ${faceCy - 20} Z`}
        fill={hairColor}
      />
      {/* 얼굴 */}
      <ellipse cx={cx} cy={faceCy} rx={faceRx} ry={faceRy} fill={skin} />
      {/* 앞머리 */}
      <path
        d={`M ${cx - faceRx} ${faceCy - 18}
            Q ${cx - faceRx * 0.6} ${faceCy - faceRy - 6} ${cx + faceRx * 0.15} ${faceCy - faceRy + 2}
            Q ${cx + faceRx * 0.8} ${faceCy - faceRy - 2} ${cx + faceRx} ${faceCy - 14}
            Q ${cx + faceRx} ${faceCy - faceRy - 14} ${cx} ${faceCy - faceRy - 12}
            Q ${cx - faceRx} ${faceCy - faceRy - 14} ${cx - faceRx} ${faceCy - 18} Z`}
        fill={hairColor}
      />
      {/* 볼터치 (부드러움) */}
      {softness > 0.35 && (
        <>
          <circle cx={cx - eyeDx - 4} cy={eyeY + 18} r={6} fill={blush} opacity={softness * 0.7} />
          <circle cx={cx + eyeDx + 4} cy={eyeY + 18} r={6} fill={blush} opacity={softness * 0.7} />
        </>
      )}
      {/* 눈 — 웃는 눈이면 곡선, 또렷하면 원 */}
      {eyeSmile > 0.55 ? (
        <>
          <path
            d={`M ${cx - eyeDx - eyeR} ${eyeY} Q ${cx - eyeDx} ${eyeY - eyeR * 1.4} ${cx - eyeDx + eyeR} ${eyeY}`}
            stroke="#2b2320" strokeWidth={2.4} fill="none" strokeLinecap="round"
          />
          <path
            d={`M ${cx + eyeDx - eyeR} ${eyeY} Q ${cx + eyeDx} ${eyeY - eyeR * 1.4} ${cx + eyeDx + eyeR} ${eyeY}`}
            stroke="#2b2320" strokeWidth={2.4} fill="none" strokeLinecap="round"
          />
        </>
      ) : (
        <>
          <circle cx={cx - eyeDx} cy={eyeY} r={eyeR} fill="#2b2320" />
          <circle cx={cx + eyeDx} cy={eyeY} r={eyeR} fill="#2b2320" />
          <circle cx={cx - eyeDx + 1.5} cy={eyeY - 1.5} r={eyeR * 0.3} fill="#fff" />
          <circle cx={cx + eyeDx + 1.5} cy={eyeY - 1.5} r={eyeR * 0.3} fill="#fff" />
        </>
      )}
      {/* 안경 (개성 스타일) */}
      {showGlasses && (
        <g stroke="#5a4a40" strokeWidth={2} fill="none">
          <circle cx={cx - eyeDx} cy={eyeY} r={eyeR + 6} />
          <circle cx={cx + eyeDx} cy={eyeY} r={eyeR + 6} />
          <line x1={cx - eyeDx + eyeR + 6} y1={eyeY} x2={cx + eyeDx - eyeR - 6} y2={eyeY} />
        </g>
      )}
      {/* 귀걸이 */}
      {showEarring && (
        <>
          <circle cx={cx - faceRx + 2} cy={faceCy + 14} r={2.5} fill="#d9a441" />
          <circle cx={cx + faceRx - 2} cy={faceCy + 14} r={2.5} fill="#d9a441" />
        </>
      )}
      {/* 코 */}
      <path
        d={`M ${cx} ${eyeY + 12} Q ${cx + 3} ${eyeY + 18} ${cx} ${eyeY + 20}`}
        stroke="#d9b49a" strokeWidth={2} fill="none" strokeLinecap="round"
      />
      {/* 입 */}
      <path
        d={`M ${cx - 12} ${faceCy + 26} Q ${cx} ${faceCy + 26 + smile} ${cx + 12} ${faceCy + 26}`}
        stroke="#c96a5e" strokeWidth={3} fill="none" strokeLinecap="round"
      />
    </svg>
  );
}
