/**
 * MatchingEngine / recommend 코어 단위 테스트.
 * 실행: node --experimental-strip-types selftest.ts
 * (외부 테스트 러너 의존성을 추가하지 않기 위한 단순 assert 기반 테스트)
 *
 * 마지막에 failures > 0 이면 process.exit(1) — 실패가 있는데 성공으로 끝나지 않는다.
 * (임시로 check('__must_fail__', false) 를 넣고 exit code 1 이 나오는지 확인한 뒤 제거했다)
 */
import type { DataSource, NewRecommendationRow, StoredRecommendation, UserAccountRow } from './dataSource.ts';
import {
  buildReasons,
  checkDealbreakers,
  computeMatch,
  directionalScore,
  pickStrategy,
  rankCandidates,
  sanitizeImportance,
  tieBreakKey,
} from './MatchingEngine.ts';
import { buildPublicAnswerCards, composeIntro, normalizeRelationshipGoal } from './publicPrompts.ts';
import { accountEligible, addDays, CARD_FIELDS, CONVERSATION_SLOT_LIMIT, excludedByRecommendationHistory, MAX_CANDIDATES_SCANNED, RECOMMENDATION_COOLDOWN_DAYS, runDailyRecommendation } from './recommend.ts';
import { runDailyRecommendationWithClaim, type ClaimClient } from './runWithClaim.ts';
import { loadSnapshots } from './snapshot.ts';
import { buildStarterCache, GENERAL_QUESTIONS, generateStarterQuestions, parseStarterCache, STARTER_MAX, STARTER_MIN } from './starterQuestions.ts';
import type { QuestionnaireResponse, UserSnapshot } from './types.ts';

let failures = 0;
let passes = 0;
function check(name: string, cond: boolean) {
  if (!cond) {
    failures += 1;
    console.error(`FAIL: ${name}`);
  } else {
    passes += 1;
    console.log(`ok: ${name}`);
  }
}
const approx = (a: number | null | undefined, b: number, eps = 1e-9) => a != null && Math.abs(a - b) < eps;

const NOW_YEAR = 2026;

function responses(values: Record<string, [QuestionnaireResponse['category'], string, number, boolean?]>): QuestionnaireResponse[] {
  return Object.entries(values).map(([questionId, [category, axis, value, reverse]]) => ({
    questionId,
    category,
    axis,
    value,
    reverse: reverse ?? false,
  }));
}

function makeUser(overrides: Partial<UserSnapshot> & { profile?: Partial<UserSnapshot['profile']> }): UserSnapshot {
  const base: UserSnapshot = {
    profile: {
      userId: 'u1',
      nickname: '테스트',
      birthYear: 1995,
      gender: 'male',
      seekingGender: 'female',
      regionCode: 'seoul',
      heightCm: 175,
      jobGroup: 'it',
      smoking: 'none',
      drinking: 'sometimes',
      religion: null,
      hobbies: ['travel', 'movies'],
      personalityKeywords: ['calm'],
    },
    values: {
      marriageIntent: 4,
      childrenIntent: 3,
      longDistanceOk: 2,
      contactFrequency: 4,
      dateFrequency: 3,
      personalTimeNeed: 3,
      oppositeSexFriendsOk: 3,
      spendingStyle: 3,
      religionImportance: 1,
    },
    responses: responses({
      p01: ['personality', 'personality.extraversion', 4],
      p03: ['personality', 'personality.planning', 4],
      l01: ['lifestyle', 'lifestyle.homebody', 3],
      r01: ['relationship', 'relationship.contact', 4],
    }),
    importance: { personality: 4, values: 4, lifestyle: 3, relationship: 3 },
    preferences: {
      ageMin: null,
      ageMax: null,
      heightMin: null,
      heightMax: null,
      regions: [],
      smokingPref: 'any',
      personalityKeywords: [],
    },
    dealbreakers: [],
  };
  return {
    ...base,
    ...overrides,
    profile: { ...base.profile, ...(overrides.profile ?? {}) },
    values: { ...base.values, ...(overrides.values ?? {}) },
  };
}

const female = (over: Partial<UserSnapshot> & { profile?: Partial<UserSnapshot['profile']> } = {}) =>
  makeUser({ ...over, profile: { userId: 'u2', nickname: '상대', gender: 'female', seekingGender: 'male', birthYear: 1996, heightCm: 163, ...(over.profile ?? {}) } });

// ===========================================================================
// 기본 상호성
// ===========================================================================
const male = makeUser({});
const partner = female();
const result = computeMatch(male, partner, NOW_YEAR);
check('상호 지향이 맞으면 eligible', result.eligible);
check('점수가 존재 (scored)', result.score?.basis === 'scored' && result.score.total != null);
check('total 은 0~1', (result.score?.total ?? -1) >= 0 && (result.score?.total ?? 2) <= 1);
check('설명 문구 생성 (공통 취미·지역)', result.reasons.length > 0);

const sameSeeking = makeUser({ profile: { userId: 'u3', gender: 'female', seekingGender: 'female' } });
check('지향 불일치는 ineligible', !computeMatch(male, sameSeeking, NOW_YEAR).eligible);

// ===========================================================================
// #40 외모 데이터 완전 제외
// ===========================================================================
{
  const snapA = makeUser({});
  const snapB = female();
  // 타입에 외모 필드가 없지만, 과거 코드 경로가 남아 있지 않은지 "추가 속성" 을 억지로 넣어 확인
  const withJunk = (u: UserSnapshot, extra: Record<string, unknown>) => ({ ...u, ...extra }) as unknown as UserSnapshot;
  const r0 = computeMatch(snapA, snapB, NOW_YEAR);
  const r1 = computeMatch(
    withJunk(snapA, { appearancePreferenceVector: { soft: 1 }, importance: { ...snapA.importance, appearance: 5 } }),
    withJunk(snapB, { appearanceStyleVector: { soft: 1 }, importance: { ...snapB.importance, appearance: 1 } }),
    NOW_YEAR,
  );
  check('외모 벡터·중요도가 있어도 A→B/B→A/total 동일', r0.score?.aToB === r1.score?.aToB && r0.score?.bToA === r1.score?.bToA && r0.score?.total === r1.score?.total);
  check('외모가 있어도 reasons 동일', JSON.stringify(r0.reasons) === JSON.stringify(r1.reasons));
  check('dimensions 에 appearance 키 없음', !('appearance' in (r0.score?.dimensions ?? {})));
  check('sanitizeImportance 는 appearance 를 버린다', !('appearance' in sanitizeImportance({ appearance: 5, personality: 2 })));
  check('sanitizeImportance 기본값·범위', sanitizeImportance({ personality: 2, values: 9, lifestyle: 'x', relationship: NaN }).values === 3 && sanitizeImportance(null).lifestyle === 3);
}

// ===========================================================================
// #40 누락 응답 · 재정규화
// ===========================================================================
{
  // 한 차원만 유효: 설문·가치관·취미·키워드 모두 없음 → lifestyle 만 (지역 비교는 항상 가능)
  const bare = makeUser({
    profile: { hobbies: [], personalityKeywords: [] },
    responses: [],
    values: {
      marriageIntent: null, childrenIntent: null, longDistanceOk: null, contactFrequency: null, dateFrequency: null,
      personalTimeNeed: null, oppositeSexFriendsOk: null, spendingStyle: null, religionImportance: null,
    },
    importance: { personality: 5, values: 5, lifestyle: 1, relationship: 5 },
  });
  const bareF = female({ profile: { hobbies: [], personalityKeywords: [], regionCode: 'busan' }, responses: [], values: bare.values });
  const d = directionalScore(bare, bareF, NOW_YEAR);
  check('한 차원만 유효하면 그 차원만 반영 (available=[lifestyle])', d.availableDimensions.join(',') === 'lifestyle');
  check('나머지 차원은 null (중립값 대입 없음)', d.dimensions.personality == null && d.dimensions.values == null && d.dimensions.relationship == null);
  check('base = 유효 차원 점수 그대로 (다른 지역 0.4)', approx(d.base, 0.4));
  check('score = clamp(base + adjustment)', approx(d.score, 0.4 + d.adjustment));

  // 수동 계산: personality=0.8(imp 4), values=null, lifestyle=0.6(imp 2), relationship=null → (0.8*4+0.6*2)/6
  const manualA = makeUser({
    profile: { hobbies: [], personalityKeywords: ['calm', 'honest'], regionCode: 'seoul' },
    responses: [],
    values: {
      marriageIntent: null, childrenIntent: null, longDistanceOk: null, contactFrequency: null, dateFrequency: null,
      personalTimeNeed: null, oppositeSexFriendsOk: null, spendingStyle: null, religionImportance: null,
    },
    importance: { personality: 4, values: 3, lifestyle: 2, relationship: 5 },
    preferences: { ageMin: null, ageMax: null, heightMin: null, heightMax: null, regions: [], smokingPref: 'any', personalityKeywords: ['calm', 'honest'] },
  });
  const manualB = female({ profile: { hobbies: [], personalityKeywords: ['calm', 'honest'], regionCode: 'seoul' }, responses: [], values: manualA.values });
  const md = directionalScore(manualA, manualB, NOW_YEAR);
  // personality: keywordFit=1 → 0.4+0.6 = 1.0 ; lifestyle: sameRegion=1 → 1.0 ; 나머지 null → base = (1*4 + 1*2)/6 = 1
  check('재정규화 수동 계산 일치 (personality·lifestyle 만)', md.availableDimensions.join(',') === 'personality,lifestyle' && approx(md.base, 1));
  const manualB2 = female({ profile: { hobbies: [], personalityKeywords: ['humor'], regionCode: 'busan' }, responses: [], values: manualA.values });
  const md2 = directionalScore(manualA, manualB2, NOW_YEAR);
  // personality: keywordFit=0 → 0.4 ; lifestyle: 0.4 → base = (0.4*4 + 0.4*2)/6 = 0.4
  check('재정규화 수동 계산 일치 (분모는 유효 중요도 합)', approx(md2.base, (0.4 * 4 + 0.4 * 2) / 6));

  // 실제 0점 ≠ 누락: 가치관이 정반대(유사도 0)면 values=0 이 분모에 포함된다
  const opp = female({ values: { marriageIntent: 1, childrenIntent: 1, spendingStyle: 1, religionImportance: 5, oppositeSexFriendsOk: 1, longDistanceOk: 5 } });
  const extreme = makeUser({ values: { marriageIntent: 5, childrenIntent: 5, spendingStyle: 5, religionImportance: 1, oppositeSexFriendsOk: 5, longDistanceOk: 1 } });
  const od = directionalScore(extreme, opp, NOW_YEAR);
  check('실제 0점은 누락이 아니다 (values=0 이 available 에 포함)', od.dimensions.values === 0 && od.availableDimensions.includes('values'));

  // 모든 비교 데이터 누락 → conditions_only, 자동 탈락 아님
  const emptyA = makeUser({ profile: { hobbies: [], personalityKeywords: [], regionCode: 'seoul' }, responses: [], values: bare.values });
  const emptyB = female({ profile: { hobbies: [], personalityKeywords: [], regionCode: 'seoul' }, responses: [], values: bare.values });
  // 지역 비교는 항상 가능하므로 lifestyle 만 남는다 → 아직 scored. 지역까지 같아도 lifestyle 은 1.0 이므로 scored.
  // conditions_only 는 계산 함수를 직접 검증: available 이 비면 base null
  const cd = directionalScore(emptyA, emptyB, NOW_YEAR);
  check('공개 지역만 비교 가능해도 scored (lifestyle=1.0)', cd.availableDimensions.join(',') === 'lifestyle' && approx(cd.base, 1));
  const forced = { ...emptyA, profile: { ...emptyA.profile, regionCode: undefined as unknown as string } };
  const forcedB = { ...emptyB, profile: { ...emptyB.profile, regionCode: undefined as unknown as string } };
  // regionCode 가 없으면 sameRegion 은 (undefined === undefined) → 1 이므로 여전히 값이 있다. conditions_only 는 computeMatch 로 검증:
  const cm = computeMatch(forced, forcedB, NOW_YEAR);
  check('필수 조건 통과 후보는 데이터가 없어도 eligible', cm.eligible && cm.score != null);

  // NaN/Infinity/문자열 응답·가중치 → 순위에 들어가지 않음
  const dirty = makeUser({
    responses: responses({ p01: ['personality', 'personality.extraversion', NaN], p03: ['personality', 'personality.planning', Infinity] }),
    values: { marriageIntent: 'high' as unknown as number, childrenIntent: -Infinity },
    importance: { personality: NaN, values: Infinity, lifestyle: -3 as number, relationship: 'x' as unknown as number },
  });
  const dd = directionalScore(dirty, female(), NOW_YEAR);
  const allFinite = [dd.base, dd.score, ...Object.values(dd.dimensions)].every((v) => v == null || Number.isFinite(v));
  check('유효하지 않은 숫자로 NaN/Infinity 가 생기지 않는다', allFinite);
  check('잘못된 응답은 무시되어 personality 유사도가 null (키워드 없음)', dd.dimensions.personality == null);
}

// ===========================================================================
// 필수 조건(Dealbreaker) vs soft preference · 판단 불가
// ===========================================================================
{
  const smoker = female({ profile: { userId: 'u4', smoking: 'regular' } });
  const strict = makeUser({ dealbreakers: [{ kind: 'smoking', value: { allow: false } }] });
  check('흡연 dealbreaker 필터', checkDealbreakers(strict, smoker, NOW_YEAR).includes('smoking'));
  check('A 만 필수 조건 불일치 → ineligible', !computeMatch(strict, smoker, NOW_YEAR).eligible);
  const strictF = female({ dealbreakers: [{ kind: 'smoking', value: { allow: false } }] });
  const maleSmoker = makeUser({ profile: { smoking: 'sometimes' } });
  check('B 만 필수 조건 불일치 → ineligible', !computeMatch(maleSmoker, strictF, NOW_YEAR).eligible);

  const soft = makeUser({ preferences: { ...male.preferences, smokingPref: 'prefer_non' } });
  const softRes = computeMatch(soft, smoker, NOW_YEAR);
  check('soft preference(비흡연이면 좋겠어요) 불일치는 제외가 아니라 감점', softRes.eligible && (softRes.score?.aToB ?? 1) < (computeMatch(soft, female(), NOW_YEAR).score?.aToB ?? 0));

  const older = female({ profile: { userId: 'u5', birthYear: 1985 } });
  const ageStrict = makeUser({ dealbreakers: [{ kind: 'age_range', value: { min: 25, max: 35 } }] });
  check('나이 dealbreaker 필터', checkDealbreakers(ageStrict, older, NOW_YEAR).includes('age_range'));
  const ageSoft = makeUser({ preferences: { ...male.preferences, ageMin: 25, ageMax: 35 } });
  check('나이 soft preference 불일치는 eligible', computeMatch(ageSoft, older, NOW_YEAR).eligible);

  const needMarriage = makeUser({ dealbreakers: [{ kind: 'marriage_intent', value: { min: 3 } }] });
  const unknownMarriage = female({ values: { marriageIntent: null } });
  check('필수 조건 평가값 누락(marriage_intent null) → 조용히 통과시키지 않는다', checkDealbreakers(needMarriage, unknownMarriage, NOW_YEAR).includes('marriage_intent'));
  const needChildren = makeUser({ dealbreakers: [{ kind: 'children_intent', value: { maxGap: 1 } }] });
  check('children_intent 한쪽 누락 → 실패', checkDealbreakers(needChildren, female({ values: { childrenIntent: null } }), NOW_YEAR).includes('children_intent'));
  check('children_intent 양쪽 있고 범위 내 → 통과', checkDealbreakers(needChildren, female({ values: { childrenIntent: 3 } }), NOW_YEAR).length === 0);
}

// ===========================================================================
// 양방향: 한쪽만 좋아하는 조합은 조화 평균으로 하락 · 유사한 상대가 더 높다 · 역채점
// ===========================================================================
const enthusiastic = makeUser({ importance: { personality: 5, values: 5, lifestyle: 5, relationship: 5 } });
const lukewarmTarget = female({
  profile: { userId: 'u6', hobbies: [], personalityKeywords: [] },
  values: { marriageIntent: 1, childrenIntent: 1, contactFrequency: 1, spendingStyle: 1 },
  responses: responses({
    p01: ['personality', 'personality.extraversion', 1],
    p03: ['personality', 'personality.planning', 1],
    l01: ['lifestyle', 'lifestyle.homebody', 1],
    r01: ['relationship', 'relationship.contact', 1],
  }),
});
const asym = computeMatch(enthusiastic, lukewarmTarget, NOW_YEAR);
if (asym.score?.aToB != null && asym.score.bToA != null && asym.score.total != null) {
  const arith = (asym.score.aToB + asym.score.bToA) / 2;
  check('조화 평균 ≤ 산술 평균 (비대칭 벌점)', asym.score.total <= arith + 1e-9);
}
const similar = female({ profile: { userId: 'u7' } });
check('유사한 상대의 방향 점수가 더 높다', (directionalScore(male, similar, NOW_YEAR).score ?? 0) > (directionalScore(male, lukewarmTarget, NOW_YEAR).score ?? 1));
const reverseA = makeUser({ responses: responses({ p02: ['personality', 'personality.extraversion', 1, true] }) });
const reverseB = female({ profile: { userId: 'u8' }, responses: responses({ p01: ['personality', 'personality.extraversion', 5, false] }) });
check('역채점: 1(reverse)==5(normal) 로 해석', (directionalScore(reverseA, reverseB, NOW_YEAR).dimensions.personality ?? 0) > 0.9);

// ===========================================================================
// 전략 라벨 (스키마 호환)
// ===========================================================================
const scoredOf = (total: number) => ({ basis: 'scored' as const, total, aToB: total, bToA: total, dimensions: { personality: null, values: null, lifestyle: null, relationship: null } });
check('high_confidence 라벨', pickStrategy(scoredOf(0.7), 0) === 'high_confidence');
check('exploration 라벨', pickStrategy(scoredOf(0.55), 1) === 'exploration');
check('fallback 라벨', pickStrategy(scoredOf(0.3), 2) === 'fallback');
check('conditions_only 는 fallback', pickStrategy({ ...scoredOf(0), basis: 'conditions_only', total: null }, 0) === 'fallback');

// ===========================================================================
// 추천 이유 — 공개 사실만
// ===========================================================================
{
  const pubA = makeUser({ profile: { hobbies: ['travel'], personalityKeywords: ['calm'], regionCode: 'seoul', relationshipGoal: 'serious', publicAnswers: { day_off: ['cafe', 'walk'], important: 'honest_talk' } } });
  const pubB = female({ profile: { hobbies: ['travel'], personalityKeywords: ['honest'], regionCode: 'seoul', relationshipGoal: 'serious', publicAnswers: { day_off: ['walk'], important: 'respect' } } });
  const r = buildReasons(pubA, pubB);
  check('공통 취미·같은 지역·같은 목적 (최대 3개)', r.length === 3 && r.includes('공통 관심사가 있어요') && r.includes('같은 지역을 선택했어요') && r.includes('연애 목적이 같아요'));
  check('"가까운 지역" 처럼 거리를 단정하는 문구 없음', !r.some((x) => x.includes('가까')));
  const promptOnly = makeUser({ profile: { hobbies: [], personalityKeywords: [], regionCode: 'seoul', relationshipGoal: 'serious', publicAnswers: { day_off: ['cafe', 'walk'], together: 'food_tour' } } });
  const promptOnlyB = female({ profile: { hobbies: [], personalityKeywords: [], regionCode: 'busan', relationshipGoal: 'take_it_slow', publicAnswers: { day_off: ['walk'], together: ['movie'] } } });
  const pr = buildReasons(promptOnly, promptOnlyB);
  check('공개 질문의 공통 선택지 → 이유', pr.length === 1 && pr[0] === '쉬는 날 보내는 방식이 겹쳐요');
  const bogus = female({ profile: { hobbies: [], personalityKeywords: [], regionCode: 'busan', relationshipGoal: 'take_it_slow', publicAnswers: { day_off: ['not_a_code'], hidden: ['cafe'] } } });
  const bogusA = makeUser({ profile: { hobbies: [], personalityKeywords: [], regionCode: 'seoul', relationshipGoal: 'serious', publicAnswers: { day_off: ['not_a_code'], hidden: ['cafe'] } } });
  check('허용되지 않은 질문/코드는 공통이어도 이유가 되지 않는다', buildReasons(bogusA, bogus).length === 0);

  // 비공개 응답만 바꿔도 reasons 불변 (내부 점수는 달라질 수 있다)
  const privA1 = makeUser({ profile: { hobbies: ['travel'], regionCode: 'seoul' } });
  const privA2 = makeUser({
    profile: { hobbies: ['travel'], regionCode: 'seoul' },
    values: { marriageIntent: 1, childrenIntent: 1, spendingStyle: 1, contactFrequency: 1 },
    responses: responses({ p01: ['personality', 'personality.extraversion', 1] }),
  });
  const target = female({ profile: { hobbies: ['travel'], regionCode: 'seoul' } });
  const m1 = computeMatch(privA1, target, NOW_YEAR);
  const m2 = computeMatch(privA2, target, NOW_YEAR);
  check('비공개 응답만 바꾸면 내부 점수는 달라질 수 있다', m1.score?.total !== m2.score?.total);
  check('비공개 응답만 바꿔도 사용자용 reasons 는 동일', JSON.stringify(m1.reasons) === JSON.stringify(m2.reasons));
  check('reasons 에 설문/점수 기반 문구 없음', !m1.reasons.some((x) => x.includes('질문에') || x.includes('비슷하게 답')));

  const strangerA = makeUser({ profile: { hobbies: [], personalityKeywords: [], regionCode: 'seoul', relationshipGoal: 'serious' } });
  const strangerB = female({ profile: { hobbies: [], personalityKeywords: [], regionCode: 'busan', relationshipGoal: 'take_it_slow' } });
  const sr = computeMatch(strangerA, strangerB, NOW_YEAR);
  check('공개 근거가 없으면 reasons=[] (지어내지 않는다)', sr.eligible && sr.reasons.length === 0);
  check('보장/궁합 표현 없음', ![...r, ...pr, ...m1.reasons].some((x) => x.includes('잘 맞') || x.includes('어울릴') || x.includes('궁합')));
}

// ===========================================================================
// 결정적 tie-break · 입력 순서 무관
// ===========================================================================
{
  const viewer = 'viewer-1';
  const day = '2026-09-14';
  const same = scoredOf(0.5);
  const mk = (id: string) => ({ id, result: { eligible: true, failedDealbreakers: [], score: same, reasons: [] }, payload: id });
  const ids = ['c1', 'c2', 'c3', 'c4', 'c5'];
  const a = rankCandidates(ids.map(mk), viewer, day).map((c) => c.id);
  const b = rankCandidates([...ids].reverse().map(mk), viewer, day).map((c) => c.id);
  const c = rankCandidates([ids[2], ids[0], ids[4], ids[1], ids[3]].map(mk), viewer, day).map((c) => c.id);
  check('동점 후보 입력 순서를 바꿔도 순위 동일', a.join() === b.join() && a.join() === c.join());
  check('tie-break 는 (viewer, 날짜, 후보) 해시 오름차순', a.map((id) => tieBreakKey(viewer, day, id)).every((k, i, arr) => i === 0 || arr[i - 1] <= k));
  check('날짜가 바뀌면 순서가 달라질 수 있다 (재현 가능하지만 고정 편향 아님)', tieBreakKey(viewer, day, 'c1') !== tieBreakKey(viewer, '2026-09-15', 'c1'));
  const mixed = [
    { id: 'low', result: { eligible: true, failedDealbreakers: [], score: scoredOf(0.3), reasons: [] }, payload: 0 },
    { id: 'cond', result: { eligible: true, failedDealbreakers: [], score: { ...scoredOf(0), basis: 'conditions_only' as const, total: null }, reasons: [] }, payload: 0 },
    { id: 'high', result: { eligible: true, failedDealbreakers: [], score: scoredOf(0.9), reasons: [] }, payload: 0 },
    { id: 'no', result: { eligible: false, failedDealbreakers: [], score: null, reasons: [] }, payload: 0 },
  ];
  check('scored(총점순) → conditions_only, ineligible 제외', rankCandidates(mixed, viewer, day).map((c) => c.id).join() === 'high,low,cond');
}

// ===========================================================================
// 대화 시작 질문 (#41) — 공개 답변·취미만 입력, 공통/상대만/일반 구분, LLM 없음
// ===========================================================================
{
  const both = { hobbies: ['travel'], publicAnswers: { day_off: ['cafe', 'walk'], important: 'honest_talk' } };
  const other = { hobbies: ['travel', 'music'], publicAnswers: { day_off: ['cafe', 'culture'], together: ['food_tour'], important: 'respect' } };
  const qs = generateStarterQuestions(both, other);
  check('시작 질문은 2~3개', qs.length >= STARTER_MIN && qs.length <= STARTER_MAX);
  check('둘 다 고른 카페 → shared 질문 ("둘 다")', qs.some((q) => q.id === 'shared:day_off:cafe' && q.basis === 'shared' && q.text.startsWith('둘 다')));
  check('상대만 고른 전시·공연 → partner 질문 (공통점 주장 없음)', (() => {
    const q = qs.find((x) => x.id === 'partner:day_off:culture');
    return !!q && q.basis === 'partner' && !q.text.includes('둘 다') && q.text.includes('전시');
  })());
  check('공통 근거가 먼저, 상대 근거가 뒤 (결정적 순서)', qs[0].basis === 'shared' && qs.findIndex((q) => q.basis === 'partner') > qs.findIndex((q) => q.basis === 'shared'));
  check('같은 입력 → 같은 출력', JSON.stringify(generateStarterQuestions(both, other)) === JSON.stringify(qs));
  check('내가 골랐지만 상대가 안 고른 항목(walk)은 질문 근거가 아니다', !qs.some((q) => q.value === 'walk'));
  check('상대 관점(방향)에 따라 partner 질문이 다르다', generateStarterQuestions(other, both).some((q) => q.id === 'partner:day_off:walk'));

  const none = generateStarterQuestions({ hobbies: [], publicAnswers: {} }, { hobbies: [], publicAnswers: null });
  check('공개 정보가 없으면 일반 질문만 (허위 공통점 없음)', none.length >= STARTER_MIN && none.every((q) => q.basis === 'general' && GENERAL_QUESTIONS.includes(q.text)) && !none.some((q) => q.text.includes('둘 다')));
  const one = generateStarterQuestions({ hobbies: [], publicAnswers: {} }, { hobbies: [], publicAnswers: { together: 'movie' } });
  check('근거 질문이 하나면 일반 질문으로 2개를 채운다', one.length === STARTER_MIN && one[0].basis === 'partner' && one[1].basis === 'general');
  const junk = generateStarterQuestions({ hobbies: ['travel'], publicAnswers: { day_off: ['cafe'] } }, { hobbies: ['travel'], publicAnswers: { day_off: ['cafe', 'not_an_option'], secret: '자유 텍스트', important: 42 } });
  check('허용된 질문 id·선택지 코드만 사용 (알 수 없는 키/값 무시)', junk.every((q) => q.basis !== 'general' ? (q.promptId === 'day_off' || q.promptId === 'hobby') : true) && !junk.some((q) => q.text.includes('자유 텍스트')));
  check('공통 취미(여행)도 shared 근거', junk.some((q) => q.id === 'shared:hobby:travel'));
  check('입력 타입에 비공개 필드가 없다 (values/responses 없이 호출 가능)', Object.keys(both).join() === 'hobbies,publicAnswers');

  const cache = buildStarterCache(qs, new Date('2026-09-14T00:00:00Z'));
  check('v2 캐시 파싱', parseStarterCache(cache)?.questions.length === qs.length && parseStarterCache(JSON.parse(JSON.stringify(cache)))?.version === 2);
  check('과거 lead/question 캐시는 무효 (다시 노출하지 않음)', parseStarterCache({ lead: '두 분 모두 경험에 투자하는 편이에요', question: '?' }) === null);
  check('깨진 캐시는 무효', parseStarterCache({ version: 2, questions: [{ id: 'x' }] }) === null && parseStarterCache({ version: 2, questions: [] }) === null && parseStarterCache(null) === null);
}

const cards = buildPublicAnswerCards({ day_off: ['cafe', 'not_an_option', 'rest_home', 'walk'], together: 'food_tour', important: ['honest_talk', 'honest_talk'], unknown_key: ['cafe'], hidden: '자유 텍스트' });
check('허용된 질문만 카드에 실린다', cards.length === 3 && !cards.some((c) => c.id === 'unknown_key' || c.id === 'hidden'));
check('허용 코드만 · 최대 개수 적용 · 라벨 변환', cards[0].values.join(',') === 'cafe,rest_home' && cards[0].answer === '카페 가기 · 집에서 푹 쉬기');
check('배열/비객체 답변은 빈 배열', buildPublicAnswerCards(['x']).length === 0 && buildPublicAnswerCards(null).length === 0);
check('relationship_goal 허용값만', normalizeRelationshipGoal('serious') === 'serious' && normalizeRelationshipGoal('x') == null);
check('소개 문장 조합', composeIntro('serious', { day_off: ['rest_home', 'cafe'], important: 'honest_talk' }) === '진지한 연애를 원해요. 쉬는 날엔 주로 집에서 푹 쉬기 · 카페 가기. 연애에서 중요하게 생각하는 건 솔직한 대화.');
check('자유 텍스트는 문장에 들어가지 않는다', !(composeIntro('serious', { day_off: '내 맘대로 쓴 글' }) ?? '').includes('내 맘대로'));

// ===========================================================================
// recommend 코어 — in-memory DataSource (연결 흐름은 supabase/tests/recommendation_db_test.mjs 가 실제 DB 로 검증)
// ===========================================================================
type Fixture = {
  users: UserAccountRow[];
  profiles: Record<string, unknown>[];
  privates: Record<string, unknown>[];
  prefs: Record<string, unknown>[];
  blocks: { blocker_id: string; blocked_id: string }[];
  reports: { reporter_id: string; reported_id: string }[];
  likes: { from: string; to: string }[];
  matches: { a: string; b: string; status?: 'active' | 'closed' | 'blocked' }[];
  recs: (StoredRecommendation & { user_id: string; for_date: string })[];
  failStages?: Set<string>;
};

function account(id: string, over: Partial<UserAccountRow> = {}): UserAccountRow {
  return { id, status: 'active', onboarding_completed: true, identity_verified: true, face_verified: true, age_verified: true, ...over };
}
function profileRow(id: string, gender: 'male' | 'female', over: Record<string, unknown> = {}) {
  return {
    user_id: id, nickname: `닉${id}`, birth_year: 1995, gender, seeking_gender: gender === 'male' ? 'female' : 'male',
    region_code: 'seoul', height_cm: 170, job_group: 'it', smoking: 'none', drinking: 'sometimes', religion: null,
    hobbies: ['travel'], personality_keywords: ['calm'], intro: null, relationship_goal: 'serious', public_answers: { day_off: ['cafe'] }, ...over,
  };
}

function memoryDataSource(f: Fixture): DataSource & { inserted: NewRecommendationRow[]; expired: string[]; touched: Set<string> } {
  const fail = (stage: string) => {
    if (f.failStages?.has(stage)) throw new Error(`simulated failure: ${stage}`);
  };
  const inserted: NewRecommendationRow[] = [];
  const expired: string[] = [];
  const touched = new Set<string>();
  const ds: DataSource = {
    async profiles(ids) { touched.add('profiles'); return f.profiles.filter((p) => ids.includes(p.user_id as string)); },
    async privateProfiles(ids) { touched.add('private_profiles'); return f.privates.filter((p) => ids.includes(p.user_id as string)); },
    async questionnaireResponses() { touched.add('questionnaire_responses'); return []; },
    async questionnaireQuestions() { touched.add('questionnaire_questions'); return []; },
    async preferenceSettings(ids) { touched.add('preference_settings'); return f.prefs.filter((p) => ids.includes(p.user_id as string)); },
    async dealbreakers() { touched.add('dealbreakers'); return []; },
    async userAccounts(ids) { fail('users'); touched.add('users'); return f.users.filter((u) => ids.includes(u.id)); },
    async activeMatchCounts(ids) {
      fail('slots'); touched.add('slots');
      const out: Record<string, number> = {};
      for (const id of ids) out[id] = f.matches.filter((m) => (m.status ?? 'active') === 'active' && (m.a === id || m.b === id)).length;
      return out;
    },
    async blockPairs(userId) { fail('blocks'); return f.blocks.filter((b) => b.blocker_id === userId || b.blocked_id === userId); },
    async reportPairs(userId) { fail('reports'); return f.reports.filter((r) => r.reporter_id === userId || r.reported_id === userId); },
    async likedUserIds(userId) { fail('likes'); return f.likes.filter((l) => l.from === userId).map((l) => l.to); },
    async matchedUserIds(userId) { fail('matches'); return f.matches.filter((m) => m.a === userId || m.b === userId).map((m) => (m.a === userId ? m.b : m.a)); },
    async pastRecommendations(userId) { fail('recs'); return f.recs.filter((r) => r.user_id === userId).map((r) => ({ candidate_id: r.candidate_id, status: r.status, for_date: r.for_date })); },
    async recommendationsForDate(userId, forDate) { fail('recs'); return f.recs.filter((r) => r.user_id === userId && r.for_date === forDate); },
    async candidateIdsPage(gender, seekingGender, offset, limit) {
      fail('candidates');
      const eligibleIds = f.profiles
        .filter((p) => p.gender === gender && p.seeking_gender === seekingGender)
        .map((p) => p.user_id as string)
        .filter((id) => accountEligible(f.users.find((u) => u.id === id)))
        .sort();
      return eligibleIds.slice(offset, offset + limit);
    },
    async insertRecommendation(row) {
      inserted.push(row);
      const stored = { id: `rec-${inserted.length}`, status: 'pending', strategy: row.strategy, card: row.card, candidate_id: row.candidate_id, user_id: row.user_id, for_date: row.for_date };
      f.recs.push(stored);
      return stored;
    },
    async expireRecommendations(ids) { expired.push(...ids); for (const r of f.recs) if (ids.includes(r.id)) r.status = 'expired'; },
  };
  return Object.assign(ds, { inserted, expired, touched });
}

const ME = 'me';
const baseFixture = (): Fixture => ({
  users: [account(ME), account('f1'), account('f2'), account('f3')],
  profiles: [profileRow(ME, 'male'), profileRow('f1', 'female'), profileRow('f2', 'female', { hobbies: ['games'] }), profileRow('f3', 'female', { region_code: 'busan', hobbies: [] })],
  privates: [{ user_id: ME, marriage_intent: 4 }, { user_id: 'f1', marriage_intent: 4 }, { user_id: 'f2', marriage_intent: 2 }, { user_id: 'f3', marriage_intent: 1 }],
  prefs: [],
  blocks: [], reports: [], likes: [], matches: [], recs: [],
});
const RUN = { userId: ME, today: '2026-09-14', nowYear: NOW_YEAR, dailyLimit: 1 };

await (async () => {
  // 정상: 외모 데이터 전혀 없는 fixture 에서 추천 1건 + 카드 allowlist
  const f = baseFixture();
  const ds = memoryDataSource(f);
  const out = await runDailyRecommendation(ds, RUN);
  check('외모 데이터 없이 추천 생성', out.kind === 'ok' && out.recommendations.length === 1);
  if (out.kind === 'ok') {
    const card = out.recommendations[0].card;
    check('카드는 allowlist 키만', Object.keys(card).every((k) => (CARD_FIELDS as readonly string[]).includes(k)) && Object.keys(card).length === CARD_FIELDS.length);
    check('카드에 점수·차원·비공개·얼굴 데이터 없음', !('score_total' in card) && !('dimensions' in card) && !('marriage_intent' in card) && !('feature_vector' in card));
    check('저장 dimensions 에 appearance 없음 + basis 있음', ds.inserted[0].dimensions.basis === 'scored' && !('appearance' in ds.inserted[0].dimensions));
    check('공통 취미(f1) 가 1순위 (f2 는 취미 다름·결혼관 다름)', out.recommendations[0].candidate_id === 'f1');
    check('reasons 는 공개 사실만', (card.reasons as string[]).every((r) => ['공통 관심사가 있어요', '같은 지역을 선택했어요', '연애 목적이 같아요', '쉬는 날 보내는 방식이 겹쳐요', '스스로 고른 키워드가 겹쳐요'].includes(r)));
  }
  check('snapshot 로더가 외모 테이블을 읽지 않는다', !ds.touched.has('appearance_preference_events') && !ds.touched.has('face_verifications'));
  check('DataSource 계약에 외모 조회 메서드가 없다', !('appearancePreferenceEvents' in ds) && !('faceFeatureVectors' in ds));

  // 같은 fixture 에서 preference_settings 의 appearance_importance 를 넣어도 결과 동일
  const f2 = baseFixture();
  f2.prefs = [{ user_id: ME, appearance_importance: 5, personality_importance: 3, values_importance: 3, lifestyle_importance: 3, relationship_importance: 3 }];
  const ds2 = memoryDataSource(f2);
  const out2 = await runDailyRecommendation(ds2, RUN);
  check('appearance_importance 값과 무관하게 같은 후보·같은 점수', out2.kind === 'ok' && out2.recommendations[0].candidate_id === 'f1' && ds2.inserted[0].score_total === ds.inserted[0].score_total);

  // 요청자 인증 미완료 → 거부
  const f3 = baseFixture();
  f3.users[0] = account(ME, { face_verified: false });
  check('요청자 얼굴 인증 미완료 → not_verified', (await runDailyRecommendation(memoryDataSource(f3), RUN)).kind === 'not_verified');
  const f3b = baseFixture();
  f3b.users[0] = account(ME, { age_verified: false });
  check('요청자 성인 확인 미완료 → not_verified', (await runDailyRecommendation(memoryDataSource(f3b), RUN)).kind === 'not_verified');
  const f3c = baseFixture();
  f3c.users[0] = account(ME, { onboarding_completed: false });
  check('요청자 온보딩 미완료 → not_ready', (await runDailyRecommendation(memoryDataSource(f3c), RUN)).kind === 'not_ready');

  // 후보 인증 미완료·정지·탈퇴·차단·신고 제외
  const f4 = baseFixture();
  f4.users = [account(ME), account('f1', { identity_verified: false }), account('f2', { status: 'suspended' }), account('f3', { status: 'deleted' })];
  const o4 = await runDailyRecommendation(memoryDataSource(f4), RUN);
  check('인증 미완료·정지·탈퇴 후보만 있으면 exhausted (조건 완화 없음)', o4.kind === 'ok' && o4.exhausted && o4.recommendations.length === 0);
  const f5 = baseFixture();
  f5.blocks = [{ blocker_id: 'f1', blocked_id: ME }];
  f5.reports = [{ reporter_id: ME, reported_id: 'f2' }];
  const o5 = await runDailyRecommendation(memoryDataSource(f5), RUN);
  check('상대가 나를 차단(역방향) + 내가 신고한 상대 제외 → f3', o5.kind === 'ok' && o5.recommendations[0]?.candidate_id === 'f3');
  const f5b = baseFixture();
  f5b.reports = [{ reporter_id: 'x', reported_id: 'f1' }];
  const o5b = await runDailyRecommendation(memoryDataSource(f5b), RUN);
  check('다른 사람의 신고만으로는 전역 제외되지 않는다', o5b.kind === 'ok' && o5b.recommendations[0]?.candidate_id === 'f1');

  // 저장된 오늘 추천 재검증
  const f6 = baseFixture();
  f6.recs = [{ id: 'old', status: 'pending', strategy: 'fallback', card: {}, candidate_id: 'f1', user_id: ME, for_date: RUN.today }];
  f6.blocks = [{ blocker_id: ME, blocked_id: 'f1' }];
  const ds6 = memoryDataSource(f6);
  const o6 = await runDailyRecommendation(ds6, RUN);
  check('오늘 저장된 pending 추천의 상대를 차단했으면 expired 처리 + 반환 안 함 + 새 추천 생성', ds6.expired.includes('old') && o6.kind === 'ok' && o6.recommendations.length === 1 && o6.recommendations[0].candidate_id !== 'f1');
  const f7 = baseFixture();
  f7.recs = [{ id: 'old', status: 'accepted', strategy: 'fallback', card: {}, candidate_id: 'f1', user_id: ME, for_date: RUN.today }];
  f7.users[1] = account('f1', { status: 'suspended' });
  const ds7 = memoryDataSource(f7);
  const o7 = await runDailyRecommendation(ds7, RUN);
  check('이미 수락한 추천의 상대가 정지되면 반환하지 않되 보존하고 오늘 한도에 포함', ds7.expired.length === 0 && o7.kind === 'ok' && o7.recommendations.length === 0 && ds7.inserted.length === 0);
  const f8 = baseFixture();
  f8.recs = [{ id: 'old', status: 'pending', strategy: 'fallback', card: {}, candidate_id: 'f1', user_id: ME, for_date: RUN.today }];
  const o8 = await runDailyRecommendation(memoryDataSource(f8), RUN);
  check('오늘 유효한 추천이 있으면 그대로 반환 (새로 만들지 않음)', o8.kind === 'ok' && o8.recommendations.length === 1 && o8.recommendations[0].id === 'old');

  const f8b = baseFixture();
  f8b.recs = [{ id: 'gone', status: 'expired', strategy: 'fallback', card: {}, candidate_id: 'f1', user_id: ME, for_date: RUN.today }];
  const ds8b = memoryDataSource(f8b);
  const o8b = await runDailyRecommendation(ds8b, RUN);
  check('오늘 expired 행은 한도에 포함되지 않고 반환되지 않는다 (새 추천 생성, f1 은 과거 추천이라 제외)', o8b.kind === 'ok' && o8b.recommendations.length === 1 && o8b.recommendations[0].candidate_id !== 'f1' && !o8b.recommendations.some((r) => r.id === 'gone'));

  // 안전 조회 실패 → 추천 진행 안 함
  for (const stage of ['blocks', 'reports', 'users', 'likes', 'candidates']) {
    const ff = baseFixture();
    ff.failStages = new Set([stage]);
    const dsf = memoryDataSource(ff);
    const of = await runDailyRecommendation(dsf, RUN);
    check(`${stage} 조회 실패 → lookup_failed, 추천 미생성`, of.kind === 'lookup_failed' && dsf.inserted.length === 0);
  }

  // 페이지네이션: 첫 100명이 전부 제외돼도 뒤의 후보를 찾는다
  const f9 = baseFixture();
  f9.profiles = [profileRow(ME, 'male')];
  f9.users = [account(ME)];
  for (let i = 0; i < 130; i += 1) {
    const id = `c${String(i).padStart(3, '0')}`;
    f9.profiles.push(profileRow(id, 'female'));
    f9.users.push(account(id));
    if (i < 120) f9.likes.push({ from: ME, to: id }); // 앞 120명은 이미 좋아요 → 제외
  }
  const o9 = await runDailyRecommendation(memoryDataSource(f9), RUN);
  check('앞 페이지가 전부 제외돼도 뒤 페이지에서 후보를 찾는다 (오판 방지)', o9.kind === 'ok' && !o9.exhausted && o9.recommendations.length === 1 && o9.scanned === 10);

  // 후보 부족 시 조건 완화 없음: 필수 조건 불일치만 있으면 exhausted
  const f10 = baseFixture();
  f10.profiles = [profileRow(ME, 'male', { smoking: 'regular' }), profileRow('f1', 'female')];
  f10.users = [account(ME), account('f1')];
  (f10 as Fixture & { db?: unknown }).db = undefined;
  const ds10 = memoryDataSource(f10);
  ds10.dealbreakers = async () => [{ user_id: 'f1', kind: 'smoking', value: { allow: false } }];
  const o10 = await runDailyRecommendation(ds10, RUN);
  check('후보의 필수 조건(비흡연) 불일치 → 제외, 완화 없이 exhausted', o10.kind === 'ok' && o10.exhausted && ds10.inserted.length === 0);

  // 동점 후보: 입력 순서를 바꿔도 같은 후보 (모든 후보 동일 데이터)
  const f11 = baseFixture();
  f11.profiles = [profileRow(ME, 'male'), ...['z9', 'a1', 'm5'].map((id) => profileRow(id, 'female'))];
  f11.users = [account(ME), account('z9'), account('a1'), account('m5')];
  f11.privates = [];
  const pick1 = await runDailyRecommendation(memoryDataSource(f11), RUN);
  const f11r = { ...f11, profiles: [...f11.profiles].reverse(), users: [...f11.users].reverse(), recs: [] };
  const pick2 = await runDailyRecommendation(memoryDataSource(f11r), RUN);
  check('동점 후보 입력 순서를 바꿔도 같은 후보 선택', pick1.kind === 'ok' && pick2.kind === 'ok' && pick1.recommendations[0].candidate_id === pick2.recommendations[0].candidate_id);

  // ===========================================================================
  // #23 재추천 주기 · 후보 상한 관측 / #22 실행권(claim) 멱등성
  // ===========================================================================
  check('addDays', addDays('2026-09-14', -30) === '2026-08-15' && addDays('2026-03-01', -1) === '2026-02-28');
  {
    const past = [
      { candidate_id: 'p-pending', status: 'pending', for_date: '2026-01-01' },
      { candidate_id: 'p-accepted', status: 'accepted', for_date: '2026-01-01' },
      { candidate_id: 'p-skip-old', status: 'skipped', for_date: addDays('2026-09-14', -RECOMMENDATION_COOLDOWN_DAYS - 1) },
      { candidate_id: 'p-skip-edge', status: 'skipped', for_date: addDays('2026-09-14', -RECOMMENDATION_COOLDOWN_DAYS) },
      { candidate_id: 'p-skip-recent', status: 'skipped', for_date: '2026-09-10' },
      { candidate_id: 'p-expired-old', status: 'expired', for_date: '2026-01-01' },
    ];
    const ex = excludedByRecommendationHistory(past, '2026-09-14');
    check('pending/accepted 는 영구 제외', ex.has('p-pending') && ex.has('p-accepted'));
    check('최근 skipped 는 제외, 30일 지난 skipped/expired 는 다시 후보', ex.has('p-skip-recent') && ex.has('p-skip-edge') && !ex.has('p-skip-old') && !ex.has('p-expired-old'));
  }
  {
    // 31일 전에 스킵한 f1 이 다시 후보가 된다 / 10일 전 스킵은 여전히 제외
    const f = baseFixture();
    f.users = [account(ME), account('f1')];
    f.profiles = [profileRow(ME, 'male'), profileRow('f1', 'female')];
    f.recs = [{ id: 'old', status: 'skipped', strategy: 'high_confidence', card: {}, candidate_id: 'f1', user_id: ME, for_date: addDays(RUN.today, -31) }];
    const o = await runDailyRecommendation(memoryDataSource(f), RUN);
    check('31일 전 스킵한 상대는 다시 추천된다', o.kind === 'ok' && o.recommendations.length === 1 && o.recommendations[0].candidate_id === 'f1');
    const f2 = { ...f, recs: [{ ...f.recs[0], for_date: addDays(RUN.today, -10) }] };
    const o2 = await runDailyRecommendation(memoryDataSource(f2), RUN);
    check('10일 전 스킵한 상대는 아직 제외 → exhausted', o2.kind === 'ok' && o2.exhausted);
    check('exhausted 결과에 capReached=false', o2.kind === 'ok' && o2.capReached === false);
  }
  {
    // 상한 도달 관측: 후보가 MAX+50명이고 모두 필수 조건 불일치 → 500명만 보고 capReached=true
    const fc = baseFixture();
    fc.users = [account(ME)];
    fc.profiles = [profileRow(ME, 'male', { smoking: 'regular' })];
    for (let i = 0; i < MAX_CANDIDATES_SCANNED + 50; i += 1) {
      const id = `c${String(i).padStart(4, '0')}`;
      fc.users.push(account(id));
      fc.profiles.push(profileRow(id, 'female'));
    }
    const dsc = memoryDataSource(fc);
    dsc.dealbreakers = async (ids) => ids.filter((i) => i !== ME).map((i) => ({ user_id: i, kind: 'smoking', value: { allow: false } }));
    const oc = await runDailyRecommendation(dsc, RUN);
    check('상한(500)에 걸리면 capReached=true 로 알린다', oc.kind === 'ok' && oc.exhausted && oc.capReached && oc.scanned === MAX_CANDIDATES_SCANNED);
  }
  {
    // insert 충돌(다른 실행이 먼저 저장) → 오늘 저장된 행을 다시 읽어 돌려준다
    const fr = baseFixture();
    const dsr = memoryDataSource(fr);
    const origInsert = dsr.insertRecommendation;
    dsr.insertRecommendation = async (row) => {
      // 경쟁 실행이 먼저 저장한 상황을 흉내 낸다
      await origInsert({ ...row, candidate_id: 'f1' });
      throw new Error('duplicate key');
    };
    const orr = await runDailyRecommendation(dsr, RUN);
    check('insert 충돌 시 빈 응답 대신 오늘 저장된 추천을 돌려준다', orr.kind === 'ok' && orr.recommendations.length === 1 && orr.recommendations[0].candidate_id === 'f1');
  }
  {
    // claim 래퍼: claimed → 실행 + finish / busy → 대기 후 저장된 행 / skip(exhausted) → 재훑기 없음
    const calls: string[] = [];
    const mk = (script: ('claimed' | 'busy' | 'skip')[], result?: string): ClaimClient => ({
      async claim() { const c = script.shift() ?? 'busy'; calls.push(`claim:${c}`); return { claim: c, result }; },
      async finish(_u, _d, r, scanned, cap) { calls.push(`finish:${r}:${scanned}:${cap}`); },
    });
    const f = baseFixture();
    const ds = memoryDataSource(f);
    const o1 = await runDailyRecommendationWithClaim(ds, mk(['claimed']), RUN, { retries: 2, waitMs: 1 });
    check('claimed → 코어 실행 → finish(ok)', o1.kind === 'ok' && o1.recommendations.length === 1 && calls.join() === 'claim:claimed,finish:ok:3:false');

    calls.length = 0;
    const o2 = await runDailyRecommendationWithClaim(ds, mk(['busy', 'busy', 'busy']), RUN, { retries: 2, waitMs: 1 });
    check('끝까지 busy → 저장된 오늘 추천을 읽는다 (새 생성 없음)', o2.kind === 'ok' && o2.recommendations.length === 1 && ds.inserted.length === 1 && calls.filter((c) => c.startsWith('finish')).length === 0);

    calls.length = 0;
    const fe = baseFixture();
    fe.users = [account(ME)];
    fe.profiles = [profileRow(ME, 'male')];
    const dse = memoryDataSource(fe);
    const o3 = await runDailyRecommendationWithClaim(dse, mk(['skip'], 'exhausted'), RUN, { retries: 0 });
    check('skip(exhausted) → 후보를 다시 훑지 않고 exhausted', o3.kind === 'ok' && o3.exhausted && !dse.touched.has('profiles') && calls.join() === 'claim:skip');

    calls.length = 0;
    const o4 = await runDailyRecommendationWithClaim(dse, mk(['claimed']), RUN, { retries: 0 });
    check('claimed + 후보 없음 → finish(exhausted)', o4.kind === 'ok' && o4.exhausted && calls[1] === 'finish:exhausted:0:false');

    calls.length = 0;
    const dsx = memoryDataSource(baseFixture());
    dsx.userAccounts = async () => { throw new Error('boom'); };
    const o5 = await runDailyRecommendationWithClaim(dsx, mk(['claimed']), RUN, { retries: 0 });
    check('코어가 lookup_failed 면 finish(lookup_failed) 로 lease 를 닫는다', o5.kind === 'lookup_failed' && calls[1] === 'finish:lookup_failed:0:false');

    calls.length = 0;
    const o6 = await runDailyRecommendationWithClaim(memoryDataSource(baseFixture()), mk(['busy']), RUN, { retries: 0 });
    check('busy + 저장된 행 없음 → inProgress', o6.kind === 'ok' && 'inProgress' in o6 && o6.inProgress === true && o6.recommendations.length === 0);
  }

  {
    // 동시 대화 3개 제한 (#24): 요청자가 가득 차면 후보를 훑지 않고 slotsFull (exhausted 아님·insert 없음)
    const f = baseFixture();
    f.matches = [{ a: ME, b: 'x1' }, { a: ME, b: 'x2' }, { a: 'x3', b: ME }, { a: ME, b: 'x4', status: 'closed' }];
    const ds = memoryDataSource(f);
    const o = await runDailyRecommendation(ds, RUN);
    check('요청자 진행 중 매치 3개 → slotsFull (closed 는 세지 않음)', o.kind === 'ok' && o.slotsFull === true && !o.exhausted && o.recommendations.length === 0);
    check('slotsFull 이면 후보를 훑지 않고 저장하지 않는다', !ds.touched.has('profiles') && ds.inserted.length === 0);
    // 종료 하나 → 자리 생김 → 다시 추천 생성
    f.matches[2].status = 'closed';
    const o2 = await runDailyRecommendation(memoryDataSource(f), RUN);
    check('자리가 생기면 추천이 다시 생성된다', o2.kind === 'ok' && !o2.slotsFull && o2.recommendations.length === 1);
    // 오늘 저장된 추천이 있으면 가득 차도 그대로 돌려준다 (새로 만들지 않음)
    const f2 = baseFixture();
    f2.matches = [{ a: ME, b: 'x1' }, { a: ME, b: 'x2' }, { a: 'x3', b: ME }];
    f2.recs = [{ id: 'today', status: 'pending', strategy: 'fallback', card: {}, candidate_id: 'f2', user_id: ME, for_date: RUN.today }];
    const o3 = await runDailyRecommendation(memoryDataSource(f2), RUN);
    check('가득 찼어도 오늘 저장된 추천은 반환 (slotsFull 표시 없음 — 한도 도달)', o3.kind === 'ok' && !o3.slotsFull && o3.recommendations.length === 1);
    // 후보가 가득 찼으면 제외 → 다른 후보
    const f3 = baseFixture();
    f3.matches = [{ a: 'f1', b: 'y1' }, { a: 'f1', b: 'y2' }, { a: 'y3', b: 'f1' }];
    const ds3 = memoryDataSource(f3);
    const o4 = await runDailyRecommendation(ds3, RUN);
    check('진행 중 매치가 가득 찬 후보(f1)는 제외되고 다른 후보가 선택된다', o4.kind === 'ok' && o4.recommendations.length === 1 && o4.recommendations[0].candidate_id !== 'f1');
    // 자리 조회 실패는 lookup_failed (자리 없음/후보 없음으로 위장하지 않는다)
    const f4 = baseFixture();
    f4.failStages = new Set(['slots']);
    const o5 = await runDailyRecommendation(memoryDataSource(f4), RUN);
    check('자리 조회 실패 → lookup_failed(slots)', o5.kind === 'lookup_failed' && o5.stage === 'slots');
    check('CONVERSATION_SLOT_LIMIT = 3', CONVERSATION_SLOT_LIMIT === 3);
    // claim 래퍼: 가득 참 → finish(slots_full) / skip(slots_full) → 재훑기 없음
    const calls: string[] = [];
    const mk = (script: ('claimed' | 'busy' | 'skip')[], result?: string): ClaimClient => ({
      async claim() { const c = script.shift() ?? 'busy'; calls.push(`claim:${c}`); return { claim: c, result }; },
      async finish(_u, _d, r, scanned, cap) { calls.push(`finish:${r}:${scanned}:${cap}`); },
    });
    f.matches[2].status = 'active';
    f.recs = [];
    const dsf = memoryDataSource(f);
    const c1 = await runDailyRecommendationWithClaim(dsf, mk(['claimed']), RUN, { retries: 0 });
    check('claimed + 가득 참 → finish(slots_full)', c1.kind === 'ok' && c1.slotsFull === true && calls.join() === 'claim:claimed,finish:slots_full:0:false');
    calls.length = 0;
    const dss = memoryDataSource(baseFixture());
    const c2 = await runDailyRecommendationWithClaim(dss, mk(['skip'], 'slots_full'), RUN, { retries: 0 });
    check('skip(slots_full) → 후보를 다시 훑지 않고 slotsFull', c2.kind === 'ok' && c2.slotsFull === true && !c2.exhausted && !dss.touched.has('profiles') && calls.join() === 'claim:skip');
  }

  // ===========================================================================
  // #23 후보 부족 관측 — 적격 후보 수 · 상한 구분 · 전략은 필수 조건 통과 후보에만 · 조회 실패는 0명이 아니다 · 중복 집계 없음
  // ===========================================================================
  {
    // 후보 0명 → 후보 부족(exhausted), 새 추천 없음, eligibleCount=0 (측정됨), capReached=false (전체 탐색 완료)
    const f0 = baseFixture();
    f0.users = [account(ME)];
    f0.profiles = [profileRow(ME, 'male')];
    const ds0 = memoryDataSource(f0);
    const o0 = await runDailyRecommendation(ds0, RUN);
    check('#23 후보 0명 → exhausted · 새 추천 없음 · eligibleCount=0 · capReached=false', o0.kind === 'ok' && o0.exhausted && ds0.inserted.length === 0 && o0.eligibleCount === 0 && o0.capReached === false && o0.createdIds.length === 0);

    // 필수 조건을 통과한 후보 1명 → 정상 추천, eligibleCount=1, createdIds=[저장된 id]
    const f1 = baseFixture();
    f1.users = [account(ME), account('f1')];
    f1.profiles = [profileRow(ME, 'male'), profileRow('f1', 'female')];
    const ds1 = memoryDataSource(f1);
    const o1 = await runDailyRecommendation(ds1, RUN);
    check('#23 적격 후보 1명 → 추천 생성 · eligibleCount=1 · createdIds 는 저장된 행 id', o1.kind === 'ok' && !o1.exhausted && o1.eligibleCount === 1 && o1.createdIds.length === 1 && o1.createdIds[0] === o1.recommendations[0].id && ds1.inserted.length === 1);

    // 후보는 있지만 "요청자 → 후보" 필수 조건 불일치 (요청자 비흡연 필수, 후보 흡연) → 추천 없음 (후보 → 요청자 방향은 기존 테스트)
    const f2 = baseFixture();
    f2.users = [account(ME), account('f1')];
    f2.profiles = [profileRow(ME, 'male'), profileRow('f1', 'female', { smoking: 'regular' })];
    const ds2 = memoryDataSource(f2);
    ds2.dealbreakers = async (ids) => ids.filter((i) => i === ME).map((i) => ({ user_id: i, kind: 'smoking', value: { allow: false } }));
    const o2 = await runDailyRecommendation(ds2, RUN);
    check('#23 요청자 쪽 필수 조건 불일치 → 추천 없음 · eligibleCount=0 (후보 존재 ≠ 적격)', o2.kind === 'ok' && o2.exhausted && o2.eligibleCount === 0 && o2.scanned === 1 && ds2.inserted.length === 0);

    // 필수 조건 판단에 필요한 응답 누락 (후보의 marriage_intent 없음) → 기존 정책대로 제외 → 추천 없음
    const f3 = baseFixture();
    f3.users = [account(ME), account('f1')];
    f3.profiles = [profileRow(ME, 'male'), profileRow('f1', 'female')];
    f3.privates = [{ user_id: ME, marriage_intent: 4 }, { user_id: 'f1', marriage_intent: null }];
    const ds3 = memoryDataSource(f3);
    ds3.dealbreakers = async (ids) => ids.filter((i) => i === ME).map((i) => ({ user_id: i, kind: 'marriage_intent', value: { min: 3 } }));
    const o3 = await runDailyRecommendation(ds3, RUN);
    check('#23 필수 조건 평가값 누락 후보는 통과시키지 않는다 → exhausted · eligibleCount=0', o3.kind === 'ok' && o3.exhausted && o3.eligibleCount === 0 && ds3.inserted.length === 0);

    // fallback(conditions_only) 도 필수 조건 통과 후보에서만: 점수가 더 높아 보이는 후보라도 필수 조건 위반이면 선택되지 않는다
    const f4 = baseFixture();
    f4.users = [account(ME), account('f1'), account('f2')];
    // f1: 설문·가치관·취미 모두 없어 conditions_only 가 되도록 / f2: 데이터는 풍부하지만 흡연 → 요청자 필수 조건 위반
    f4.profiles = [
      profileRow(ME, 'male', { hobbies: [], personality_keywords: [] }),
      profileRow('f1', 'female', { hobbies: [], personality_keywords: [], region_code: undefined as unknown as string }),
      profileRow('f2', 'female', { smoking: 'regular' }),
    ];
    f4.privates = [{ user_id: ME }, { user_id: 'f1' }, { user_id: 'f2', marriage_intent: 4 }];
    const ds4 = memoryDataSource(f4);
    ds4.dealbreakers = async (ids) => ids.filter((i) => i === ME).map((i) => ({ user_id: i, kind: 'smoking', value: { allow: false } }));
    const o4 = await runDailyRecommendation(ds4, RUN);
    check('#23 fallback 도 필수 조건 통과 후보(f1)에서만 · 위반 후보(f2)는 제외 · eligibleCount=1', o4.kind === 'ok' && o4.recommendations.length === 1 && o4.recommendations[0].candidate_id === 'f1' && o4.eligibleCount === 1);
    // 공개 지역 비교는 항상 가능해 엔진 경로에서 basis 는 scored(총점 0.4 → fallback)가 된다. conditions_only 라벨 자체는 pickStrategy 로 확인
    check('#23 낮은 총점 후보는 strategy=fallback 이지만 필수 조건 위반은 없다 (basis 는 scored/conditions_only 중 하나)', ds4.inserted.length === 1 && ds4.inserted[0].strategy === 'fallback' && ['scored', 'conditions_only'].includes(String(ds4.inserted[0].dimensions.basis)) && ds4.inserted[0].candidate_id === 'f1');
    check('#23 conditions_only(total null) 는 항상 fallback 라벨', pickStrategy({ basis: 'conditions_only', total: null, aToB: null, bToA: null, dimensions: { personality: null, values: null, lifestyle: null, relationship: null } }, 0) === 'fallback');

    // 요청자 대화 3개 → slotsFull 은 "자리 부족" (eligibleCount=null 미측정, exhausted 아님)
    const f5 = baseFixture();
    f5.matches = [{ a: ME, b: 'x1' }, { a: ME, b: 'x2' }, { a: 'x3', b: ME }];
    const o5 = await runDailyRecommendation(memoryDataSource(f5), RUN);
    check('#23 요청자 자리 부족 → slotsFull · exhausted 아님 · eligibleCount=null(미측정)', o5.kind === 'ok' && o5.slotsFull === true && !o5.exhausted && o5.eligibleCount === null);

    // 상대 대화 3개 → 그 후보만 제외되어 적격 후보 수에서 빠진다
    const f6 = baseFixture();
    f6.matches = [{ a: 'f1', b: 'y1' }, { a: 'f1', b: 'y2' }, { a: 'y3', b: 'f1' }];
    const o6 = await runDailyRecommendation(memoryDataSource(f6), RUN);
    check('#23 상대 자리 가득 → 그 후보 제외 · eligibleCount 는 나머지(2)', o6.kind === 'ok' && o6.eligibleCount === 2 && o6.recommendations[0].candidate_id !== 'f1');

    // 차단·신고 쌍·과거 매칭 상대 → 훑지도 세지도 않는다 (scanned·eligible 모두에서 제외)
    const f7 = baseFixture();
    f7.blocks = [{ blocker_id: 'f1', blocked_id: ME }];
    f7.reports = [{ reporter_id: ME, reported_id: 'f2' }];
    f7.matches = [{ a: ME, b: 'f3', status: 'closed' }];
    const o7 = await runDailyRecommendation(memoryDataSource(f7), RUN);
    check('#23 차단(상대가 나를)·신고 쌍·과거 매치(closed) 상대 제외 → exhausted · scanned=0 · eligibleCount=0', o7.kind === 'ok' && o7.exhausted && o7.scanned === 0 && o7.eligibleCount === 0);

    // 30일 재추천 경계: 정확히 30일 전 skipped 는 아직 제외, 31일 전은 다시 후보 (문서 7절과 일치)
    const f8 = baseFixture();
    f8.users = [account(ME), account('f1')];
    f8.profiles = [profileRow(ME, 'male'), profileRow('f1', 'female')];
    f8.recs = [{ id: 'old', status: 'skipped', strategy: 'fallback', card: {}, candidate_id: 'f1', user_id: ME, for_date: addDays(RUN.today, -RECOMMENDATION_COOLDOWN_DAYS) }];
    const o8 = await runDailyRecommendation(memoryDataSource(f8), RUN);
    check('#23 정확히 30일 전 skipped 는 아직 제외 (경계 포함)', o8.kind === 'ok' && o8.exhausted && o8.eligibleCount === 0);
    const f8b = { ...f8, recs: [{ ...f8.recs[0], for_date: addDays(RUN.today, -(RECOMMENDATION_COOLDOWN_DAYS + 1)) }] };
    const o8b = await runDailyRecommendation(memoryDataSource(f8b), RUN);
    check('#23 31일 전 skipped 는 다시 후보 · eligibleCount=1', o8b.kind === 'ok' && !o8b.exhausted && o8b.eligibleCount === 1);

    // 조회 실패 → lookup_failed (후보 0명·exhausted 로 집계되지 않는다)
    const f9 = baseFixture();
    f9.failStages = new Set(['candidates']);
    const o9 = await runDailyRecommendation(memoryDataSource(f9), RUN);
    check('#23 후보 조회 실패 → lookup_failed(candidates) — exhausted 아님', o9.kind === 'lookup_failed' && o9.stage === 'candidates');

    // 탐색 상한 도달 → 완전 탐색과 구분 (capReached=true, eligibleCount 는 하한)
    const fc = baseFixture();
    fc.users = [account(ME)];
    fc.profiles = [profileRow(ME, 'male', { smoking: 'regular' })];
    for (let i = 0; i < MAX_CANDIDATES_SCANNED + 50; i += 1) {
      const id = `c${String(i).padStart(4, '0')}`;
      fc.users.push(account(id));
      fc.profiles.push(profileRow(id, 'female'));
    }
    const dsc = memoryDataSource(fc);
    dsc.dealbreakers = async (ids) => ids.filter((i) => i !== ME).map((i) => ({ user_id: i, kind: 'smoking', value: { allow: false } }));
    const oc = await runDailyRecommendation(dsc, RUN);
    check('#23 상한 도달 → exhausted + capReached=true · eligibleCount=0 은 하한 (전체 후보 없음으로 단정 불가)', oc.kind === 'ok' && oc.exhausted && oc.capReached && oc.eligibleCount === 0 && oc.scanned === MAX_CANDIDATES_SCANNED);

    // claim 래퍼: finish 에 관측값(적격 수·저장 id·실패 단계)이 실린다 / skip 은 finish 를 부르지 않는다 (반복·동시·배치 중첩에도 집계 1회)
    const calls: string[] = [];
    const mk = (script: ('claimed' | 'busy' | 'skip')[], result?: string, capReached?: boolean): ClaimClient => ({
      async claim() { const c = script.shift() ?? 'busy'; calls.push(`claim:${c}`); return { claim: c, result, capReached }; },
      async finish(_u, _d, r, scanned, cap, details) { calls.push(`finish:${r}:${scanned}:${cap}:${details?.eligible ?? 'null'}:${details?.recommendationId ?? 'null'}:${details?.errorStage ?? 'null'}`); },
    });
    const fw = baseFixture();
    const dsw = memoryDataSource(fw);
    const w1 = await runDailyRecommendationWithClaim(dsw, mk(['claimed']), RUN, { retries: 0 });
    check('#23 claimed + 생성 → finish(ok, eligible=3, 저장 id)', w1.kind === 'ok' && calls.join() === `claim:claimed,finish:ok:3:false:3:${w1.recommendations[0].id}:null`);
    calls.length = 0;
    // 같은 사용자의 반복 요청·배치 중첩: skip(ok) → 저장된 행만 읽고 finish 없음 → 실행 기록·이벤트가 늘지 않는다
    const w2 = await runDailyRecommendationWithClaim(dsw, mk(['skip'], 'ok'), RUN, { retries: 0 });
    check('#23 반복 요청(skip ok) → 새 저장·finish 없음, 같은 추천 반환', w2.kind === 'ok' && w2.recommendations.length === 1 && dsw.inserted.length === 1 && calls.join() === 'claim:skip');
    calls.length = 0;
    const w3 = await runDailyRecommendationWithClaim(dsw, mk(['busy']), RUN, { retries: 0 });
    check('#23 동시 요청(busy) → 저장된 행 반환, finish 없음', w3.kind === 'ok' && w3.recommendations.length === 1 && dsw.inserted.length === 1 && calls.join() === 'claim:busy');
    calls.length = 0;
    const w4 = await runDailyRecommendationWithClaim(memoryDataSource(f0), mk(['claimed']), RUN, { retries: 0 });
    check('#23 claimed + 후보 없음 → finish(exhausted, eligible=0, id 없음)', w4.kind === 'ok' && w4.exhausted && calls.join() === 'claim:claimed,finish:exhausted:0:false:0:null:null');
    calls.length = 0;
    const w5 = await runDailyRecommendationWithClaim(memoryDataSource(f9), mk(['claimed']), RUN, { retries: 0 });
    check('#23 claimed + 조회 실패 → finish(lookup_failed, eligible=null, 단계 기록)', w5.kind === 'lookup_failed' && calls.join() === 'claim:claimed,finish:lookup_failed:0:false:null:null:candidates');
    calls.length = 0;
    const w6 = await runDailyRecommendationWithClaim(memoryDataSource(f0), mk(['skip'], 'exhausted', true), RUN, { retries: 0 });
    check('#23 skip(exhausted, cap_reached) → 다시 훑지 않고 capReached 를 그대로 전달', w6.kind === 'ok' && w6.exhausted && w6.capReached === true && calls.join() === 'claim:skip');
    const w7 = await runDailyRecommendationWithClaim(memoryDataSource(f0), mk(['skip'], 'exhausted', false), RUN, { retries: 0 });
    check('#23 skip(exhausted, 완전 탐색) → capReached=false', w7.kind === 'ok' && w7.exhausted && w7.capReached === false);
    calls.length = 0;
    const dsThrow = memoryDataSource(baseFixture());
    dsThrow.profiles = async () => { throw new Error('boom'); };
    // loadSnapshots 실패는 lookup_failed(requester_snapshot) 로 잡힌다 — 예외 전파 경로는 claim 자체가 throw 할 때
    const w8 = await runDailyRecommendationWithClaim(dsThrow, mk(['claimed']), RUN, { retries: 0 });
    check('#23 스냅샷 조회 실패 → finish(lookup_failed, requester_snapshot)', w8.kind === 'lookup_failed' && calls.join() === 'claim:claimed,finish:lookup_failed:0:false:null:null:requester_snapshot');
  }

  // loadSnapshots: 얼굴 벡터·외모 이벤트 없이 스냅샷 생성
  const snaps = await loadSnapshots(memoryDataSource(baseFixture()), [ME]);
  check('loadSnapshots 결과에 외모 필드 없음', snaps.has(ME) && !('appearancePreferenceVector' in (snaps.get(ME) as object)) && !('appearance' in snaps.get(ME)!.importance));
})();

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('All MatchingEngine tests passed');
