import type { Database } from "better-sqlite3";
import {
  DEFAULT_WEIGHTS,
  DRINKING,
  EDUCATIONS,
  FACE_DIMS,
  JOBS,
  MBTIS,
  RELIGIONS,
  SMOKING,
} from "./types";

// 데모 사용자 시드 — 추천/매칭이 바로 동작하도록 가상 사용자 풀을 만든다.
// is_demo=1 로 표시되며 실제 서비스 배포 시 제거 대상.

const FEMALE_NAMES = [
  "서연", "지우", "하은", "민서", "수아", "예린", "지민", "채원", "다은", "가은",
  "유진", "소율", "예나", "시은", "윤서", "혜원", "나연", "지현", "수빈", "은채",
];
const MALE_NAMES = [
  "민준", "서준", "도윤", "시우", "주원", "지호", "준서", "건우", "현우", "우진",
  "선우", "연우", "정우", "승현", "태윤", "지환", "동현", "재윤", "성민", "규민",
];
const SEED_REGIONS = ["서울", "서울", "서울", "경기", "경기", "인천", "부산", "대전"];

// 시드는 결정적으로 생성한다 (매 실행 동일한 데모 풀).
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedDemoUsers(d: Database) {
  const rand = mulberry32(20260816);
  const pick = <T,>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)];
  const vec = () => FACE_DIMS.map(() => Math.round(rand() * 100) / 100);
  const axis = () => Math.round(rand() * 100) / 100;

  const insert = d.prepare(`
    INSERT INTO users (
      phone, name, gender, birth_year, region, height_cm, job, education,
      smoking, drinking, religion, mbti,
      lifestyle, personality, values_json, rel_style, weights, dealbreakers,
      face_vec, face_pref_vec, phone_verified, face_verified, is_demo, onboarded
    ) VALUES (
      @phone, @name, @gender, @birth_year, @region, @height_cm, @job, @education,
      @smoking, @drinking, @religion, @mbti,
      @lifestyle, @personality, @values_json, @rel_style, @weights, @dealbreakers,
      @face_vec, @face_pref_vec, 1, 1, 1, 1
    )
  `);

  const tx = d.transaction(() => {
    let n = 0;
    for (const gender of ["F", "M"] as const) {
      const names = gender === "F" ? FEMALE_NAMES : MALE_NAMES;
      for (const name of names) {
        n++;
        const birthYear = 1992 + Math.floor(rand() * 12); // 만 22~34세 부근
        const height =
          gender === "F"
            ? 155 + Math.floor(rand() * 18)
            : 168 + Math.floor(rand() * 20);
        const smoking = rand() < 0.8 ? "비흡연" : pick(SMOKING);
        const w = {
          physical: 15 + Math.floor(rand() * 30),
          personality: 15 + Math.floor(rand() * 25),
          values: 10 + Math.floor(rand() * 20),
          lifestyle: 5 + Math.floor(rand() * 15),
          relationship: 5 + Math.floor(rand() * 10),
          conversation: 5,
        };
        const sum = Object.values(w).reduce((a, b) => a + b, 0);
        const weights = Object.fromEntries(
          Object.entries(w).map(([k, v]) => [k, Math.round((v / sum) * 100)])
        );
        insert.run({
          phone: `demo-${gender}-${String(n).padStart(3, "0")}`,
          name,
          gender,
          birth_year: birthYear,
          region: pick(SEED_REGIONS),
          height_cm: height,
          job: pick(JOBS),
          education: pick(EDUCATIONS),
          smoking,
          drinking: pick(DRINKING),
          religion: pick(RELIGIONS),
          mbti: pick(MBTIS),
          lifestyle: JSON.stringify({
            morningType: axis(), homeDate: axis(), travelFreq: axis(),
            exerciseFreq: axis(), contactFreq: axis(), drinkingParty: axis(),
            spending: axis(), weekendOut: axis(),
          }),
          personality: JSON.stringify({
            conflictDirect: axis(), expressive: axis(), planned: axis(),
            togetherness: axis(), humor: axis(),
          }),
          values_json: JSON.stringify({
            marriageIntent: axis(), marriageTiming: axis(), kidsIntent: axis(),
            longDistanceOk: axis(), pastMatters: axis(),
          }),
          rel_style: JSON.stringify({
            contactDesire: axis(), affection: axis(), dateFreq: axis(),
            personalTime: axis(), friendBoundary: axis(),
          }),
          weights: JSON.stringify({ ...DEFAULT_WEIGHTS, ...weights }),
          dealbreakers: JSON.stringify({
            noSmoking: rand() < 0.4,
            minAge: 20,
            maxAge: 45,
            regions: [],
            religionRequired: null,
            kidsMustAlign: false,
          }),
          face_vec: JSON.stringify(vec()),
          face_pref_vec: JSON.stringify(vec()),
        });
      }
    }
  });
  tx();
}
