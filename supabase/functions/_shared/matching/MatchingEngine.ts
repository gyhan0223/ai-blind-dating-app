/**
 * MatchingEngine — 양방향 점수 계산의 단일 진입점.
 *
 * 설계 원칙 (#40)
 *  * 외모 차원은 존재하지 않는다. 얼굴 임베딩·외모 취향·외모 중요도는 입력 계약에도, 계산에도 없다.
 *  * 활성 차원: personality / values / lifestyle / relationship.
 *    이 쌍에서 비교 가능한 정보가 없는 차원은 null(unavailable) 이며 중립값으로 채우지 않는다.
 *    base = Σ(유효 차원 점수 × viewer 중요도) / Σ(유효 차원 중요도)  — 유효 차원만으로 재정규화.
 *  * A→B 와 B→A 를 따로 계산하고, 최종 점수는 조화 평균 — 한쪽만 높은 조합은 우선순위가 내려간다.
 *  * 양방향 중 한쪽이라도 base 가 없으면 total 은 null 이고 basis='conditions_only' —
 *    필수 조건을 통과한 후보를 자동 탈락시키지 않으며, 순위는 결정적 tie-break 로 정한다.
 *  * Dealbreaker(필수 조건) 는 점수가 아니라 필터다. soft preference(“~면 좋겠어요”) 는 가감점이다.
 *  * 카드 설명 문구는 공개된 사실(취미·지역·연애 목적·공개 질문 답변·스스로 고른 키워드)에서만 만든다.
 *    비공개 응답(설문·가치관)이나 차원 점수로 문구를 만들지 않는다.
 *  * 어떤 값도 사용자에게 "궁합 확률·정확도" 로 표현하지 않는다. total 은 내부 정렬용 숫자다.
 */
import { PUBLIC_PROMPTS, pickAllowedValues } from './publicPrompts.ts';
import type {
  ActiveDimension,
  Dealbreaker,
  DimensionScores,
  DirectionalScore,
  ImportanceWeights,
  MatchResult,
  MatchScore,
  QuestionnaireResponse,
  RecommendationStrategy,
  UserSnapshot,
} from './types.ts';
import { ACTIVE_DIMENSIONS } from './types.ts';

// ---------------------------------------------------------------------------
// 유틸 — 숫자 검증
// ---------------------------------------------------------------------------

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** 유한한 숫자만 통과 (NaN/Infinity/문자열 거부) */
function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 리커트 1~5 응답 검증 — 범위 밖·비수치는 "응답 없음" 으로 본다 (응답을 만들어내지 않는다) */
function likertOrNull(v: unknown): number | null {
  const n = finiteOrNull(v);
  return n != null && n >= 1 && n <= 5 ? n : null;
}

/** 1~5 두 값의 유사도 (0~1). 한쪽이라도 없으면 null */
function likertSimilarity(a: unknown, b: unknown): number | null {
  const x = likertOrNull(a);
  const y = likertOrNull(b);
  if (x == null || y == null) return null;
  return clamp01(1 - Math.abs(x - y) / 4);
}

function average(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (present.length === 0) return null;
  return present.reduce((s, v) => s + v, 0) / present.length;
}

function harmonicMean(a: number, b: number): number {
  if (a <= 0 || b <= 0) return 0;
  return (2 * a * b) / (a + b);
}

/** 만 나이 근사 (출생연도 기준) — 성인 여부 판단에는 쓰지 않는다 (그건 서버 본인확인 age_verified) */
export function approximateAge(birthYear: number, nowYear: number): number {
  return nowYear - birthYear;
}

/** 중요도 1~5 정수로 정규화 — 잘못된 값은 기본 3 (응답을 만드는 것이 아니라 가중치 기본값) */
export const DEFAULT_IMPORTANCE = 3;
export function sanitizeImportance(raw: Partial<Record<string, unknown>> | null | undefined): ImportanceWeights {
  const out = {} as ImportanceWeights;
  for (const dim of ACTIVE_DIMENSIONS) {
    const n = finiteOrNull(raw?.[dim]);
    out[dim] = n != null && n >= 1 && n <= 5 ? Math.round(n) : DEFAULT_IMPORTANCE;
  }
  return out;
}

/** axis 별 평균 응답값 (역채점 반영, 1~5). 잘못된 응답은 무시 */
function axisMeans(responses: QuestionnaireResponse[], category: QuestionnaireResponse['category']) {
  const byAxis = new Map<string, number[]>();
  for (const r of responses) {
    if (r.category !== category) continue;
    const raw = likertOrNull(r.value);
    if (raw == null) continue;
    const v = r.reverse ? 6 - raw : raw;
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

/** 두 사용자의 axis 평균 유사도 (0~1). 공통 축이 없으면 null */
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

function overlapRatio(a: string[], b: string[]): number | null {
  if (a.length === 0 || b.length === 0) return null;
  const setB = new Set(b);
  const shared = a.filter((v) => setB.has(v)).length;
  return shared / Math.min(a.length, b.length);
}

// ---------------------------------------------------------------------------
// Dealbreaker — 필수 조건. 맞지 않으면 제외 (점수 아님)
//   평가에 필요한 값이 없으면 통과시키지 않고 실패로 본다 (조용한 통과 금지):
//     - marriage_intent 규칙: 후보의 marriageIntent 가 없으면 실패 (unknown)
//     - children_intent 규칙: 양쪽 childrenIntent 중 하나라도 없으면 실패 (unknown)
//   나이·키·흡연·음주·지역은 profiles 의 not null 컬럼이라 항상 평가 가능하다.
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
    const v = (rule.value ?? {}) as Record<string, unknown>;
    switch (rule.kind) {
      case 'age_range': {
        const min = finiteOrNull(v.min);
        const max = finiteOrNull(v.max);
        if ((min != null && candAge < min) || (max != null && candAge > max)) failed.push(rule.kind);
        break;
      }
      case 'height_range': {
        const min = finiteOrNull(v.min);
        const max = finiteOrNull(v.max);
        if ((min != null && cand.heightCm < min) || (max != null && cand.heightCm > max)) failed.push(rule.kind);
        break;
      }
      case 'smoking':
        if (v.allow === false && cand.smoking !== 'none') failed.push(rule.kind);
        break;
      case 'drinking': {
        const order = { none: 0, sometimes: 1, often: 2 } as const;
        const max = v.max as keyof typeof order | undefined;
        if (max != null && order[max] != null && (order[cand.drinking] ?? 2) > order[max]) failed.push(rule.kind);
        break;
      }
      case 'regions': {
        const codes = Array.isArray(v.codes) ? (v.codes as string[]) : [];
        if (codes.length > 0 && !codes.includes(cand.regionCode)) failed.push(rule.kind);
        break;
      }
      case 'marriage_intent': {
        const min = finiteOrNull(v.min);
        const intent = likertOrNull(candidate.values.marriageIntent);
        // 값이 없으면 판단 불가 → 필수 조건을 확인할 수 없으므로 통과시키지 않는다
        if (min != null && (intent == null || intent < min)) failed.push(rule.kind);
        break;
      }
      case 'children_intent': {
        const maxGap = finiteOrNull(v.maxGap);
        const mine = likertOrNull(viewer.values.childrenIntent);
        const theirs = likertOrNull(candidate.values.childrenIntent);
        if (maxGap != null && (mine == null || theirs == null || Math.abs(mine - theirs) > maxGap)) {
          failed.push(rule.kind);
        }
        break;
      }
      case 'religion': {
        const exclude = Array.isArray(v.exclude) ? (v.exclude as string[]) : [];
        if (cand.religion && exclude.includes(cand.religion)) failed.push(rule.kind);
        break;
      }
    }
  }
  return failed;
}

// ---------------------------------------------------------------------------
// 차원별 점수 (0~1 또는 null) — viewer 가 candidate 를 좋아할 가능성의 단순 규칙 예측
//   null = 이 쌍에서 해당 차원을 비교할 정보가 없다. 중립값으로 대체하지 않는다.
// ---------------------------------------------------------------------------

function personalityScore(viewer: UserSnapshot, candidate: UserSnapshot): number | null {
  const similarity = categorySimilarity(viewer.responses, candidate.responses, 'personality');
  const keywordFit = overlapRatio(viewer.preferences.personalityKeywords, candidate.profile.personalityKeywords);
  return average([similarity, keywordFit != null ? 0.4 + 0.6 * keywordFit : null]);
}

function valuesScore(viewer: UserSnapshot, candidate: UserSnapshot): number | null {
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
  return wsum > 0 ? sum / wsum : null;
}

function lifestyleScore(viewer: UserSnapshot, candidate: UserSnapshot): number | null {
  const similarity = categorySimilarity(viewer.responses, candidate.responses, 'lifestyle');
  const hobbyFit = overlapRatio(viewer.profile.hobbies, candidate.profile.hobbies);
  // 지역은 profiles 의 필수 공개 값이라 항상 비교 가능하다 (광역 코드 일치 여부만 — 실제 거리가 아니다)
  const sameRegion = viewer.profile.regionCode === candidate.profile.regionCode ? 1 : 0.4;
  const smokingFit =
    viewer.preferences.smokingPref === 'prefer_non'
      ? candidate.profile.smoking === 'none'
        ? 1
        : candidate.profile.smoking === 'sometimes'
          ? 0.5
          : 0.2
      : null;
  return average([similarity, hobbyFit, sameRegion, smokingFit]);
}

function relationshipScore(viewer: UserSnapshot, candidate: UserSnapshot): number | null {
  const similarity = categorySimilarity(viewer.responses, candidate.responses, 'relationship');
  const contactFit = likertSimilarity(viewer.values.contactFrequency, candidate.values.contactFrequency);
  const dateFit = likertSimilarity(viewer.values.dateFrequency, candidate.values.dateFrequency);
  const timeFit = likertSimilarity(viewer.values.personalTimeNeed, candidate.values.personalTimeNeed);
  return average([similarity, contactFit, dateFit, timeFit]);
}

const DIMENSION_FNS: Record<ActiveDimension, (v: UserSnapshot, c: UserSnapshot) => number | null> = {
  personality: personalityScore,
  values: valuesScore,
  lifestyle: lifestyleScore,
  relationship: relationshipScore,
};

/**
 * soft preference(나이 범위·연상연하·키·지역 "선호") 충족 시의 가감점 — 제외가 아니라 보정.
 * 필수 조건(Dealbreaker)과 구분된다: 선호 불일치는 여기서 감점만 받고 후보에서 빠지지 않는다.
 * base 가 있을 때만 score 에 더한다 (conditions_only 후보의 순위에는 쓰지 않는다 — 단순성 우선).
 */
export function preferenceFitAdjustment(viewer: UserSnapshot, candidate: UserSnapshot, nowYear: number): number {
  const p = viewer.preferences;
  const cand = candidate.profile;
  const candAge = approximateAge(cand.birthYear, nowYear);
  let adjustment = 0;
  const ageMin = finiteOrNull(p.ageMin);
  const ageMax = finiteOrNull(p.ageMax);
  if (ageMin != null || ageMax != null) {
    const inRange = (ageMin == null || candAge >= ageMin) && (ageMax == null || candAge <= ageMax);
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
  const hMin = finiteOrNull(p.heightMin);
  const hMax = finiteOrNull(p.heightMax);
  if (hMin != null || hMax != null) {
    const inRange = (hMin == null || cand.heightCm >= hMin) && (hMax == null || cand.heightCm <= hMax);
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

export function directionalScore(viewer: UserSnapshot, candidate: UserSnapshot, nowYear: number): DirectionalScore {
  const dimensions = {} as DimensionScores;
  const available: ActiveDimension[] = [];
  for (const dim of ACTIVE_DIMENSIONS) {
    const raw = DIMENSION_FNS[dim](viewer, candidate);
    const v = raw != null && Number.isFinite(raw) ? clamp01(raw) : null;
    dimensions[dim] = v;
    if (v != null) available.push(dim);
  }

  // 유효 차원만으로 재정규화: base = Σ(score×importance) / Σ(importance)
  const imp = sanitizeImportance(viewer.importance);
  let sum = 0;
  let wsum = 0;
  for (const dim of available) {
    sum += (dimensions[dim] as number) * imp[dim];
    wsum += imp[dim];
  }
  const base = wsum > 0 ? sum / wsum : null;
  const adjustment = preferenceFitAdjustment(viewer, candidate, nowYear);
  const score = base == null ? null : clamp01(base + adjustment);
  return { base, adjustment, score, dimensions, availableDimensions: available };
}

function averageDimension(a: number | null, b: number | null): number | null {
  return average([a, b]);
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

  const dimensions = {} as DimensionScores;
  for (const dim of ACTIVE_DIMENSIONS) {
    dimensions[dim] = averageDimension(aToB.dimensions[dim], bToA.dimensions[dim]);
  }

  const scored = aToB.score != null && bToA.score != null;
  const score: MatchScore = scored
    ? {
        basis: 'scored',
        total: harmonicMean(aToB.score as number, bToA.score as number),
        aToB: aToB.score,
        bToA: bToA.score,
        dimensions,
      }
    : { basis: 'conditions_only', total: null, aToB: aToB.score, bToA: bToA.score, dimensions };

  return { eligible: true, failedDealbreakers: [], score, reasons: buildReasons(a, b) };
}

// ---------------------------------------------------------------------------
// 카드 설명 문구 — 공개된 사실만. 비공개 응답·점수 기반 문구 없음. 근거 없으면 [].
// ---------------------------------------------------------------------------

const PROMPT_SHARED_PHRASES: Record<string, string> = {
  day_off: '쉬는 날 보내는 방식이 겹쳐요',
  together: '함께 해보고 싶은 일이 겹쳐요',
  important: '연애에서 중요하게 생각하는 것이 같아요',
};

/**
 * 공개 사실 기반 이유 (최대 3개):
 *   공통 취미 · 같은 지역 코드 선택 · 같은 공개 연애 목적 · 공개 질문의 공통 선택지(허용 코드만) · 겹치는 자기 키워드
 * 문구는 데이터 수준을 넘지 않는다 ("가깝다", "잘 맞는다", "궁합" 표현 없음).
 * 공개 프로필이 같으면 비공개 응답이 달라도 결과가 같다.
 */
export function buildReasons(a: UserSnapshot, b: UserSnapshot): string[] {
  const reasons: string[] = [];

  const sharedHobbies = a.profile.hobbies.filter((h) => b.profile.hobbies.includes(h));
  if (sharedHobbies.length > 0) reasons.push('공통 관심사가 있어요');

  if (a.profile.regionCode === b.profile.regionCode) reasons.push('같은 지역을 선택했어요');

  if (a.profile.relationshipGoal && a.profile.relationshipGoal === b.profile.relationshipGoal) {
    reasons.push('연애 목적이 같아요');
  }

  const aAnswers = (a.profile.publicAnswers ?? {}) as Record<string, unknown>;
  const bAnswers = (b.profile.publicAnswers ?? {}) as Record<string, unknown>;
  for (const prompt of PUBLIC_PROMPTS) {
    const va = pickAllowedValues(prompt, aAnswers[prompt.id]);
    const vb = pickAllowedValues(prompt, bAnswers[prompt.id]);
    if (va.length > 0 && va.some((v) => vb.includes(v))) {
      const phrase = PROMPT_SHARED_PHRASES[prompt.id];
      if (phrase) reasons.push(phrase);
    }
  }

  const sharedKeywords = a.profile.personalityKeywords.filter((k) => b.profile.personalityKeywords.includes(k));
  if (sharedKeywords.length > 0) reasons.push('스스로 고른 키워드가 겹쳐요');

  return reasons.slice(0, 3);
}

// ---------------------------------------------------------------------------
// 추천 전략 라벨 — DB check 제약(0003)·analytics 계약 호환용. 탐색 정책·정확도를 뜻하지 않는다.
// ---------------------------------------------------------------------------

export function pickStrategy(score: MatchScore | null, rank: number): RecommendationStrategy {
  if (!score || score.basis !== 'scored' || score.total == null) return 'fallback';
  if (score.total >= 0.62 && rank === 0) return 'high_confidence';
  if (score.total >= 0.5) return 'exploration';
  return 'fallback';
}

// ---------------------------------------------------------------------------
// 결정적 tie-break — 외모·인기 점수 없이 (viewer, KST 날짜, 후보 id) 해시로 순서를 고정한다.
// ---------------------------------------------------------------------------

/** FNV-1a 32bit — 재현 가능한 순서용 (암호학적 용도 아님) */
export function tieBreakKey(viewerId: string, dateKST: string, candidateId: string): number {
  const s = `${viewerId}|${dateKST}|${candidateId}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export interface RankedCandidate<T> {
  id: string;
  result: MatchResult;
  payload: T;
}

/**
 * 후보 정렬 — scored 후보(총점 내림차순) → conditions_only 후보. 같은 총점·같은 basis 는 tieBreakKey 오름차순.
 * 입력 순서에 의존하지 않는다 (동점 후보의 순서를 바꿔도 결과가 같다).
 */
export function rankCandidates<T>(
  candidates: RankedCandidate<T>[],
  viewerId: string,
  dateKST: string,
): RankedCandidate<T>[] {
  const keyOf = (c: RankedCandidate<T>) => tieBreakKey(viewerId, dateKST, c.id);
  return [...candidates]
    .filter((c) => c.result.eligible && c.result.score)
    .sort((x, y) => {
      const sx = x.result.score!;
      const sy = y.result.score!;
      const bx = sx.basis === 'scored' ? 0 : 1;
      const by = sy.basis === 'scored' ? 0 : 1;
      if (bx !== by) return bx - by;
      const tx = sx.total ?? 0;
      const ty = sy.total ?? 0;
      if (Number.isFinite(tx) && Number.isFinite(ty) && tx !== ty) return ty - tx;
      const kx = keyOf(x);
      const ky = keyOf(y);
      if (kx !== ky) return kx - ky;
      return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
    });
}
