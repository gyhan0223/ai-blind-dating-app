/**
 * MatchingEngine — 양방향 궁합 계산의 단일 진입점.
 *
 * 설계 원칙
 *  * 절대적 외모 점수는 존재하지 않는다. 모든 값은 "관계·방향" 예측이다.
 *  * A→B 와 B→A 를 따로 계산하고, 최종 점수는 조화 평균 —
 *    한쪽만 높은 조합은 우선순위가 내려간다.
 *  * Dealbreaker 는 점수가 아니라 필터다.
 *  * 초기 버전은 단순 weighted scoring. 각 차원 계산 함수를 교체하면
 *    (예: 임베딩 기반 외모 취향, LLM 대화 궁합) 그대로 업그레이드된다.
 */
import type {
  Dealbreaker,
  DimensionScores,
  MatchResult,
  MatchScore,
  QuestionnaireResponse,
  RecommendationStrategy,
  StyleVector,
  UserSnapshot,
} from './types.ts';

// ---------------------------------------------------------------------------
// 유틸
// ---------------------------------------------------------------------------

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** 1~5 두 값의 유사도 (0~1) */
function likertSimilarity(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null || b == null) return null;
  return clamp01(1 - Math.abs(a - b) / 4);
}

function average(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v != null);
  if (present.length === 0) return null;
  return present.reduce((s, v) => s + v, 0) / present.length;
}

function harmonicMean(a: number, b: number): number {
  if (a <= 0 || b <= 0) return 0;
  return (2 * a * b) / (a + b);
}

/** 만 나이 근사 (출생연도 기준) */
export function approximateAge(birthYear: number, nowYear: number): number {
  return nowYear - birthYear;
}

/** axis 별 평균 응답값 (역채점 반영, 1~5) */
function axisMeans(responses: QuestionnaireResponse[], category: QuestionnaireResponse['category']) {
  const byAxis = new Map<string, number[]>();
  for (const r of responses) {
    if (r.category !== category) continue;
    const v = r.reverse ? 6 - r.value : r.value;
    const arr = byAxis.get(r.axis) ?? [];
    arr.push(v);
    byAxis.set(r.axis, arr);
  }
  const means = new Map<string, number>();
  for (const [axis, arr] of byAxis) {
    means.set(axis, arr.reduce((s, v) => s + v, 0) / arr.length);
  }
  return means;
}

/** 두 사용자의 axis 평균 유사도 (0~1) */
function categorySimilarity(
  a: QuestionnaireResponse[],
  b: QuestionnaireResponse[],
  category: QuestionnaireResponse['category'],
): number | null {
  const ma = axisMeans(a, category);
  const mb = axisMeans(b, category);
  const sims: (number | null)[] = [];
  for (const [axis, va] of ma) {
    const vb = mb.get(axis);
    if (vb != null) sims.push(likertSimilarity(va, vb));
  }
  return average(sims);
}

/** 코사인 유사도 (공통 키 기준, 0~1 로 정규화) */
function vectorAffinity(pref: StyleVector | null, style: StyleVector | null): number | null {
  if (!pref || !style) return null;
  const keys = Object.keys(pref).filter((k) => style[k] != null);
  if (keys.length === 0) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const k of keys) {
    dot += pref[k] * style[k];
    na += pref[k] ** 2;
    nb += style[k] ** 2;
  }
  if (na === 0 || nb === 0) return null;
  return clamp01(dot / (Math.sqrt(na) * Math.sqrt(nb)));
}

function overlapRatio(a: string[], b: string[]): number | null {
  if (a.length === 0 || b.length === 0) return null;
  const setB = new Set(b);
  const shared = a.filter((v) => setB.has(v)).length;
  return shared / Math.min(a.length, b.length);
}

// ---------------------------------------------------------------------------
// Dealbreaker — 조건이 맞지 않으면 제외
// ---------------------------------------------------------------------------

export function checkDealbreakers(
  viewer: UserSnapshot,
  candidate: UserSnapshot,
  nowYear: number,
): Dealbreaker['kind'][] {
  const failed: Dealbreaker['kind'][] = [];
  const cand = candidate.profile;
  const candAge = approximateAge(cand.birthYear, nowYear);

  for (const rule of viewer.dealbreakers) {
    const v = rule.value as Record<string, number | string[] | boolean | null | undefined>;
    switch (rule.kind) {
      case 'age_range': {
        const min = (v.min as number | null) ?? null;
        const max = (v.max as number | null) ?? null;
        if ((min != null && candAge < min) || (max != null && candAge > max)) failed.push(rule.kind);
        break;
      }
      case 'height_range': {
        const min = (v.min as number | null) ?? null;
        const max = (v.max as number | null) ?? null;
        if ((min != null && cand.heightCm < min) || (max != null && cand.heightCm > max)) failed.push(rule.kind);
        break;
      }
      case 'smoking':
        if (v.allow === false && cand.smoking !== 'none') failed.push(rule.kind);
        break;
      case 'drinking': {
        const order = { none: 0, sometimes: 1, often: 2 } as const;
        const max = v.max as keyof typeof order | undefined;
        if (max != null && order[cand.drinking] > order[max]) failed.push(rule.kind);
        break;
      }
      case 'regions': {
        const codes = (v.codes as string[] | undefined) ?? [];
        if (codes.length > 0 && !codes.includes(cand.regionCode)) failed.push(rule.kind);
        break;
      }
      case 'marriage_intent': {
        const min = v.min as number | undefined;
        const intent = candidate.values.marriageIntent;
        if (min != null && intent != null && intent < min) failed.push(rule.kind);
        break;
      }
      case 'children_intent': {
        const maxGap = v.maxGap as number | undefined;
        const mine = viewer.values.childrenIntent;
        const theirs = candidate.values.childrenIntent;
        if (maxGap != null && mine != null && theirs != null && Math.abs(mine - theirs) > maxGap) {
          failed.push(rule.kind);
        }
        break;
      }
      case 'religion': {
        const exclude = (v.exclude as string[] | undefined) ?? [];
        if (cand.religion && exclude.includes(cand.religion)) failed.push(rule.kind);
        break;
      }
    }
  }
  return failed;
}

// ---------------------------------------------------------------------------
// 차원별 점수 (모두 0~1) — viewer 가 candidate 를 좋아할 가능성 예측
// ---------------------------------------------------------------------------

function personalityScore(viewer: UserSnapshot, candidate: UserSnapshot): number {
  const similarity = categorySimilarity(viewer.responses, candidate.responses, 'personality');
  const keywordFit = overlapRatio(viewer.preferences.personalityKeywords, candidate.profile.personalityKeywords);
  return average([similarity, keywordFit != null ? 0.4 + 0.6 * keywordFit : null]) ?? 0.5;
}

function valuesScore(viewer: UserSnapshot, candidate: UserSnapshot): number {
  const v = viewer.values;
  const c = candidate.values;
  // 결혼/자녀는 어긋날 때 갈등 비용이 커서 가중치를 높인다
  const weighted: [number | null, number][] = [
    [likertSimilarity(v.marriageIntent, c.marriageIntent), 2],
    [likertSimilarity(v.childrenIntent, c.childrenIntent), 2],
    [likertSimilarity(v.spendingStyle, c.spendingStyle), 1],
    [likertSimilarity(v.religionImportance, c.religionImportance), 1],
    [likertSimilarity(v.oppositeSexFriendsOk, c.oppositeSexFriendsOk), 1],
    [likertSimilarity(v.longDistanceOk, c.longDistanceOk), 0.5],
  ];
  let sum = 0;
  let wsum = 0;
  for (const [s, w] of weighted) {
    if (s != null) {
      sum += s * w;
      wsum += w;
    }
  }
  return wsum > 0 ? sum / wsum : 0.5;
}

function lifestyleScore(viewer: UserSnapshot, candidate: UserSnapshot): number {
  const similarity = categorySimilarity(viewer.responses, candidate.responses, 'lifestyle');
  const hobbyFit = overlapRatio(viewer.profile.hobbies, candidate.profile.hobbies);
  const sameRegion = viewer.profile.regionCode === candidate.profile.regionCode ? 1 : 0.4;
  const smokingFit =
    viewer.preferences.smokingPref === 'prefer_non'
      ? candidate.profile.smoking === 'none'
        ? 1
        : candidate.profile.smoking === 'sometimes'
          ? 0.5
          : 0.2
      : null;
  return average([similarity, hobbyFit, sameRegion, smokingFit]) ?? 0.5;
}

function relationshipScore(viewer: UserSnapshot, candidate: UserSnapshot): number {
  const similarity = categorySimilarity(viewer.responses, candidate.responses, 'relationship');
  const contactFit = likertSimilarity(viewer.values.contactFrequency, candidate.values.contactFrequency);
  const dateFit = likertSimilarity(viewer.values.dateFrequency, candidate.values.dateFrequency);
  const timeFit = likertSimilarity(viewer.values.personalTimeNeed, candidate.values.personalTimeNeed);
  return average([similarity, contactFit, dateFit, timeFit]) ?? 0.5;
}

function appearanceScore(viewer: UserSnapshot, candidate: UserSnapshot): number {
  // 데이터가 없으면 중립(0.5) — 외모 정보 부재가 벌점이 되어서는 안 된다
  return vectorAffinity(viewer.appearancePreferenceVector, candidate.appearanceStyleVector) ?? 0.5;
}

/** 선호 조건(나이/키) 충족 시의 보정 (제외가 아니라 가감점) */
function preferenceFitAdjustment(viewer: UserSnapshot, candidate: UserSnapshot, nowYear: number): number {
  const p = viewer.preferences;
  const cand = candidate.profile;
  const candAge = approximateAge(cand.birthYear, nowYear);
  let adjustment = 0;
  if (p.ageMin != null || p.ageMax != null) {
    const inRange = (p.ageMin == null || candAge >= p.ageMin) && (p.ageMax == null || candAge <= p.ageMax);
    adjustment += inRange ? 0.03 : -0.05;
  }
  if (p.ageDirection && p.ageDirection !== 'any') {
    const myAge = approximateAge(viewer.profile.birthYear, nowYear);
    const fits =
      p.ageDirection === 'older'
        ? candAge > myAge
        : p.ageDirection === 'younger'
          ? candAge < myAge
          : candAge === myAge;
    adjustment += fits ? 0.03 : -0.03;
  }
  if (p.heightMin != null || p.heightMax != null) {
    const inRange =
      (p.heightMin == null || cand.heightCm >= p.heightMin) &&
      (p.heightMax == null || cand.heightCm <= p.heightMax);
    adjustment += inRange ? 0.03 : -0.05;
  }
  if (p.regions.length > 0) {
    adjustment += p.regions.includes(cand.regionCode) ? 0.02 : -0.03;
  }
  return adjustment;
}

// ---------------------------------------------------------------------------
// 방향 점수 + 종합
// ---------------------------------------------------------------------------

export function directionalScore(
  viewer: UserSnapshot,
  candidate: UserSnapshot,
  nowYear: number,
): { score: number; dimensions: DimensionScores } {
  const dimensions: DimensionScores = {
    appearance: appearanceScore(viewer, candidate),
    personality: personalityScore(viewer, candidate),
    values: valuesScore(viewer, candidate),
    lifestyle: lifestyleScore(viewer, candidate),
    relationship: relationshipScore(viewer, candidate),
  };

  // viewer 의 중요도(1~5)를 가중치로 정규화
  const imp = viewer.importance;
  const weights: [number, number][] = [
    [dimensions.appearance ?? 0.5, imp.appearance],
    [dimensions.personality, imp.personality],
    [dimensions.values, imp.values],
    [dimensions.lifestyle, imp.lifestyle],
    [dimensions.relationship, imp.relationship],
  ];
  const wsum = weights.reduce((s, [, w]) => s + w, 0);
  const base = weights.reduce((s, [d, w]) => s + d * w, 0) / (wsum || 1);

  const score = clamp01(base + preferenceFitAdjustment(viewer, candidate, nowYear));
  return { score, dimensions };
}

export function computeMatch(a: UserSnapshot, b: UserSnapshot, nowYear: number): MatchResult {
  // 성별 상호 조건은 후보 조회 단계에서 거르지만, 안전망으로 한 번 더 확인
  const orientationOk =
    a.profile.seekingGender === b.profile.gender && b.profile.seekingGender === a.profile.gender;
  if (!orientationOk) {
    return { eligible: false, failedDealbreakers: [], score: null, reasons: [] };
  }

  const aFailed = checkDealbreakers(a, b, nowYear);
  const bFailed = checkDealbreakers(b, a, nowYear);
  if (aFailed.length > 0 || bFailed.length > 0) {
    return {
      eligible: false,
      failedDealbreakers: [
        ...aFailed.map((kind) => ({ direction: 'aToB' as const, kind })),
        ...bFailed.map((kind) => ({ direction: 'bToA' as const, kind })),
      ],
      score: null,
      reasons: [],
    };
  }

  const aToB = directionalScore(a, b, nowYear);
  const bToA = directionalScore(b, a, nowYear);

  const dimensions: DimensionScores = {
    appearance: average([aToB.dimensions.appearance ?? null, bToA.dimensions.appearance ?? null]) ?? undefined,
    personality: (aToB.dimensions.personality + bToA.dimensions.personality) / 2,
    values: (aToB.dimensions.values + bToA.dimensions.values) / 2,
    lifestyle: (aToB.dimensions.lifestyle + bToA.dimensions.lifestyle) / 2,
    relationship: (aToB.dimensions.relationship + bToA.dimensions.relationship) / 2,
  };

  const score: MatchScore = {
    total: harmonicMean(aToB.score, bToA.score),
    aToB: aToB.score,
    bToA: bToA.score,
    dimensions,
  };

  return { eligible: true, failedDealbreakers: [], score, reasons: buildReasons(a, b, dimensions) };
}

// ---------------------------------------------------------------------------
// 카드 설명 문구 — 원시 점수 대신 사람이 읽을 이유를 보여준다
// ---------------------------------------------------------------------------

const DIMENSION_PHRASES: Record<string, string> = {
  personality: '성격의 결이 잘 맞아요',
  values: '연애에서 중요하게 생각하는 부분이 비슷해요',
  lifestyle: '생활 패턴이 비슷해요',
  relationship: '연애 스타일이 잘 맞아요',
};

export function buildReasons(a: UserSnapshot, b: UserSnapshot, dimensions: DimensionScores): string[] {
  const reasons: string[] = [];

  const ranked = (Object.entries(DIMENSION_PHRASES) as [keyof DimensionScores, string][])
    .map(([key, phrase]) => ({ key, phrase, value: (dimensions[key] as number | undefined) ?? 0 }))
    .sort((x, y) => y.value - x.value);
  for (const item of ranked.slice(0, 2)) {
    if (item.value >= 0.55) reasons.push(item.phrase);
  }

  const sharedHobbies = a.profile.hobbies.filter((h) => b.profile.hobbies.includes(h));
  if (sharedHobbies.length > 0) {
    reasons.push('공통 관심사가 있어요');
  }
  if (a.profile.regionCode === b.profile.regionCode) {
    reasons.push('가까운 지역에 살고 있어요');
  }
  if (reasons.length === 0) {
    reasons.push('서로 다른 매력이 잘 어울릴 수 있는 조합이에요');
  }
  return reasons.slice(0, 3);
}

// ---------------------------------------------------------------------------
// 추천 전략 — Exploit / Explore / Fallback (§30)
// ---------------------------------------------------------------------------

export function pickStrategy(total: number, rank: number): RecommendationStrategy {
  if (total >= 0.62 && rank === 0) return 'high_confidence';
  if (total >= 0.5) return 'exploration';
  return 'fallback';
}

// ---------------------------------------------------------------------------
// 외모 취향/스타일 벡터 헬퍼 (MVP 모의 — 임베딩으로 교체 예정)
// ---------------------------------------------------------------------------

/** A/B 테스트 선택 기록 → 취향 벡터 (선택 자산 벡터의 평균) */
export function preferenceVectorFromChoices(chosen: StyleVector[]): StyleVector | null {
  if (chosen.length === 0) return null;
  const sum: StyleVector = {};
  for (const vec of chosen) {
    for (const [k, v] of Object.entries(vec)) {
      sum[k] = (sum[k] ?? 0) + v;
    }
  }
  const out: StyleVector = {};
  for (const [k, v] of Object.entries(sum)) {
    out[k] = v / chosen.length;
  }
  return out;
}

/**
 * 사용자별 결정적 모의 스타일 벡터.
 * 얼굴 임베딩 모델 도입 전까지 face_verifications.feature_vector 를 시드로 사용한다.
 */
export function styleVectorFromFeature(feature: number[] | null): StyleVector | null {
  if (!feature || feature.length < 4) return null;
  return {
    soft: feature[0],
    warm: feature[1],
    bold: feature[2],
    playful: feature[3],
  };
}
