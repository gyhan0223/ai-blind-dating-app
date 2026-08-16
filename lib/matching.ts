import type { Database } from "better-sqlite3";
import type {
  Dealbreakers,
  FaceVec,
  UserRow,
  Weights,
} from "./types";

// ─────────────────────────────────────────────────────────────
// 양방향 AI 매칭 엔진
//
// 원칙 (계획서 7~9, 20장):
//  - 절대적인 외모 점수는 존재하지 않는다. 오직 "A가 B를 선호할 가능성"이라는
//    관계별 방향 예측만 계산한다.
//  - A→B 와 B→A 를 모두 계산하고, 한쪽만 높은 조합은 우선순위를 낮춘다
//    (조화 평균 사용 — 비대칭 조합에 불리).
//  - Dealbreaker는 점수가 아니라 필터다.
//  - 추천은 confident / other_strength / explore 3버킷으로 섞어
//    특정 사용자가 풀에서 영구히 사라지지 않게 한다.
// ─────────────────────────────────────────────────────────────

export interface Components {
  physical: number;
  personality: number;
  values: number;
  lifestyle: number;
  relationship: number;
  conversation: number;
}

const j = <T,>(s: string, fallback: T): T => {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? { ...fallback, ...v } : fallback;
  } catch {
    return fallback;
  }
};
const jArr = (s: string): number[] => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

export const age = (birthYear: number) => new Date().getFullYear() - birthYear;

/** 두 축 집합의 유사도: 1 - 평균 절대 차이 */
function axisSimilarity(a: Record<string, number>, b: Record<string, number>): number {
  const keys = Object.keys(a).filter((k) => typeof b[k] === "number");
  if (keys.length === 0) return 0.5;
  const d = keys.reduce((s, k) => s + Math.abs((a[k] ?? 0.5) - (b[k] ?? 0.5)), 0);
  return 1 - d / keys.length;
}

/** 코사인 유사도 → 0~1 정규화. "A의 취향 벡터가 B의 특징 벡터를 선호할 가능성" */
function facePreference(pref: FaceVec, face: FaceVec): number {
  if (pref.length === 0 || face.length === 0 || pref.length !== face.length) return 0.5;
  // 취향/특징 모두 0~1 공간이므로 거리 기반이 코사인보다 안정적
  const d = pref.reduce((s, p, i) => s + Math.abs(p - face[i]), 0) / pref.length;
  return 1 - d;
}

/** 대화 궁합: 실제 대화 데이터가 쌓이기 전에는 중립(0.5) */
function conversationCompat(d: Database, aId: number, bId: number): number {
  const row = d
    .prepare(
      `SELECT COUNT(*) AS c FROM messages m
       JOIN matches mt ON mt.id = m.match_id
       WHERE m.sender_id = ? AND (mt.user_a = ? OR mt.user_b = ?)`
    )
    .get(aId, bId, bId) as { c: number };
  if (row.c === 0) return 0.5;
  // 데이터가 있으면 주고받은 양의 균형으로 근사 (Phase 2에서 정교화)
  const mine = row.c;
  const theirs = (
    d
      .prepare(
        `SELECT COUNT(*) AS c FROM messages m
         JOIN matches mt ON mt.id = m.match_id
         WHERE m.sender_id = ? AND (mt.user_a = ? OR mt.user_b = ?)`
      )
      .get(bId, aId, aId) as { c: number }
  ).c;
  if (mine + theirs === 0) return 0.5;
  const balance = 1 - Math.abs(mine - theirs) / (mine + theirs);
  return 0.4 + 0.5 * balance;
}

/** A 방향에서 본 컴포넌트별 궁합 (0~1) */
export function componentsFor(d: Database, a: UserRow, b: UserRow): Components {
  return {
    physical: facePreference(jArr(a.face_pref_vec), jArr(b.face_vec)),
    personality: axisSimilarity(j(a.personality, {}), j(b.personality, {})),
    values: axisSimilarity(j(a.values_json, {}), j(b.values_json, {})),
    lifestyle: axisSimilarity(j(a.lifestyle, {}), j(b.lifestyle, {})),
    relationship: axisSimilarity(j(a.rel_style, {}), j(b.rel_style, {})),
    conversation: conversationCompat(d, a.id, b.id),
  };
}

/** A의 개인 가중치로 A→B 예상 호감도 (0~1) */
export function directionalScore(comp: Components, weights: Weights): number {
  const total =
    weights.physical + weights.personality + weights.values +
    weights.lifestyle + weights.relationship + weights.conversation;
  if (total <= 0) return 0.5;
  const s =
    comp.physical * weights.physical +
    comp.personality * weights.personality +
    comp.values * weights.values +
    comp.lifestyle * weights.lifestyle +
    comp.relationship * weights.relationship +
    comp.conversation * weights.conversation;
  return s / total;
}

/** 양방향 종합: 조화 평균 — 한쪽만 높은 조합에 불리하게 */
export const mutualScore = (ab: number, ba: number) =>
  ab + ba === 0 ? 0 : (2 * ab * ba) / (ab + ba);

/** Dealbreaker 필터 — viewer의 조건으로 candidate를 통과/차단 */
export function passesDealbreakers(viewer: UserRow, cand: UserRow): boolean {
  const db_ = j<Dealbreakers>(viewer.dealbreakers, {
    noSmoking: false, minAge: 19, maxAge: 99, regions: [],
    religionRequired: null, kidsMustAlign: false,
  });
  const candAge = age(cand.birth_year);
  if (candAge < db_.minAge || candAge > db_.maxAge) return false;
  if (db_.noSmoking && cand.smoking === "흡연") return false;
  if (db_.regions.length > 0 && !db_.regions.includes(cand.region)) return false;
  if (db_.religionRequired && cand.religion !== db_.religionRequired) return false;
  if (db_.kidsMustAlign) {
    const mine = j(viewer.values_json, { kidsIntent: 0.5 }).kidsIntent;
    const theirs = j(cand.values_json, { kidsIntent: 0.5 }).kidsIntent;
    if (Math.abs(mine - theirs) > 0.5) return false;
  }
  return true;
}

export interface ScoredCandidate {
  user: UserRow;
  ab: number; // 나 → 상대 예상 호감도
  ba: number; // 상대 → 나 예상 호감도
  mutual: number;
  comp: Components; // 내 방향 컴포넌트
}

/** 오늘 추천 대상 후보군 계산 (필터 + 양방향 점수) */
export function scoreCandidates(d: Database, me: UserRow): ScoredCandidate[] {
  const targetGender = me.gender === "M" ? "F" : "M";
  const rows = d
    .prepare(
      `SELECT * FROM users u
       WHERE u.gender = ? AND u.id != ? AND u.onboarded = 1
         AND u.id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?)
         AND u.id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = ?)
         AND u.id NOT IN (SELECT reported_id FROM reports WHERE reporter_id = ?)
         AND u.id NOT IN (
           SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END
           FROM matches WHERE user_a = ? OR user_b = ?
         )
         AND u.id NOT IN (
           -- 최근 7일 내 이미 추천했던 상대는 제외 (지난 추천 다시 보기는 Plus 기능)
           SELECT target_id FROM recommendations
           WHERE user_id = ? AND rec_date >= date('now', '-7 days')
         )`
    )
    .all(targetGender, me.id, me.id, me.id, me.id, me.id, me.id, me.id, me.id) as UserRow[];

  const myWeights = j<Weights>(me.weights, {
    physical: 25, personality: 25, values: 20, lifestyle: 15, relationship: 10, conversation: 5,
  });

  const out: ScoredCandidate[] = [];
  for (const cand of rows) {
    // Dealbreaker는 양방향 모두 통과해야 한다
    if (!passesDealbreakers(me, cand) || !passesDealbreakers(cand, me)) continue;
    const compAB = componentsFor(d, me, cand);
    const compBA = componentsFor(d, cand, me);
    const candWeights = j<Weights>(cand.weights, myWeights);
    const ab = directionalScore(compAB, myWeights);
    const ba = directionalScore(compBA, candWeights);
    out.push({ user: cand, ab, ba, mutual: mutualScore(ab, ba), comp: compAB });
  }
  return out;
}

export type Bucket = "confident" | "other_strength" | "explore";

/**
 * 오늘의 추천 선정.
 *  - confident: 양방향 종합 최고
 *  - other_strength: 외모 외 나머지 궁합(성격·가치관·생활·연애관)이 가장 강한 상대
 *  - explore: 중위권에서 탐색 추천 → 노출 기회 보장 (알고리즘 공정성)
 */
export function pickDaily(
  cands: ScoredCandidate[],
  limit: number
): { cand: ScoredCandidate; bucket: Bucket }[] {
  const picked: { cand: ScoredCandidate; bucket: Bucket }[] = [];
  const used = new Set<number>();
  const byMutual = [...cands].sort((x, y) => y.mutual - x.mutual);

  const take = (c: ScoredCandidate | undefined, bucket: Bucket) => {
    if (!c || used.has(c.user.id) || picked.length >= limit) return;
    used.add(c.user.id);
    picked.push({ cand: c, bucket });
  };

  take(byMutual[0], "confident");

  const nonPhysical = (c: ScoredCandidate) =>
    (c.comp.personality + c.comp.values + c.comp.lifestyle + c.comp.relationship) / 4;
  const byOther = [...cands]
    .filter((c) => !used.has(c.user.id))
    .sort((x, y) => nonPhysical(y) - nonPhysical(x));
  take(byOther[0], "other_strength");

  // 탐색: 중위권(상위 20%~70% 구간)에서 매일 날짜 기반으로 순환 선택
  const mid = byMutual.filter((c) => !used.has(c.user.id));
  if (mid.length > 0 && picked.length < limit) {
    const lo = Math.floor(mid.length * 0.2);
    const hi = Math.max(lo + 1, Math.floor(mid.length * 0.7));
    const pool = mid.slice(lo, hi);
    const daySeed = Number(new Date().toISOString().slice(0, 10).replace(/-/g, ""));
    take(pool[daySeed % pool.length] ?? mid[0], "explore");
  }

  // 남는 슬롯(Plus 추가 추천 등)은 종합 순으로 채운다
  for (const c of byMutual) {
    if (picked.length >= limit) break;
    take(c, "confident");
  }
  return picked;
}

/** 컴포넌트 중 상위 궁합 라벨 — 추천 카드에 이유로 표시 */
export function topReasons(comp: Components): string[] {
  const labels: [keyof Components, string][] = [
    ["physical", "외모 취향 궁합"],
    ["personality", "성격 궁합"],
    ["values", "가치관 궁합"],
    ["lifestyle", "생활패턴 궁합"],
    ["relationship", "연애 스타일 궁합"],
    ["conversation", "대화 성향 궁합"],
  ];
  return labels
    .map(([k, label]) => ({ label, v: comp[k] }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 3)
    .filter((x) => x.v >= 0.55)
    .map((x) => `${x.label} 높음`);
}
