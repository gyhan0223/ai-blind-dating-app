/**
 * MatchingEngine 단위 테스트.
 * 실행: node --experimental-strip-types selftest.ts
 * (외부 테스트 러너 의존성을 추가하지 않기 위한 단순 assert 기반 테스트)
 */
import {
  checkDealbreakers,
  computeMatch,
  directionalScore,
  pickStrategy,
  preferenceVectorFromChoices,
  styleVectorFromFeature,
} from './MatchingEngine.ts';
import { generateIcebreaker } from './icebreaker.ts';
import type { QuestionnaireResponse, UserSnapshot } from './types.ts';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) {
    failures += 1;
    console.error(`FAIL: ${name}`);
  } else {
    console.log(`ok: ${name}`);
  }
}

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
    importance: { appearance: 3, personality: 4, values: 4, lifestyle: 3, relationship: 3 },
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
    appearancePreferenceVector: null,
    appearanceStyleVector: null,
  };
  return {
    ...base,
    ...overrides,
    profile: { ...base.profile, ...(overrides.profile ?? {}) },
    values: { ...base.values, ...(overrides.values ?? {}) },
  };
}

// --- 기본 상호성 ---
const male = makeUser({});
const female = makeUser({
  profile: { userId: 'u2', nickname: '상대', gender: 'female', seekingGender: 'male', birthYear: 1996, heightCm: 163 },
});

const result = computeMatch(male, female, NOW_YEAR);
check('상호 지향이 맞으면 eligible', result.eligible);
check('점수가 존재', result.score != null);
check('total 은 0~1', (result.score?.total ?? -1) >= 0 && (result.score?.total ?? 2) <= 1);
check('설명 문구 생성', result.reasons.length > 0);

// --- 같은 성별 지향 불일치 ---
const sameSeeking = makeUser({ profile: { userId: 'u3', gender: 'female', seekingGender: 'female' } });
check('지향 불일치는 ineligible', !computeMatch(male, sameSeeking, NOW_YEAR).eligible);

// --- Dealbreaker: 흡연 ---
const smoker = makeUser({
  profile: { userId: 'u4', gender: 'female', seekingGender: 'male', smoking: 'regular' },
});
const nonSmokerStrict = makeUser({ dealbreakers: [{ kind: 'smoking', value: { allow: false } }] });
check('흡연 dealbreaker 필터', checkDealbreakers(nonSmokerStrict, smoker, NOW_YEAR).includes('smoking'));
check('흡연 dealbreaker → ineligible', !computeMatch(nonSmokerStrict, smoker, NOW_YEAR).eligible);

// --- Dealbreaker: 나이 ---
const older = makeUser({ profile: { userId: 'u5', gender: 'female', seekingGender: 'male', birthYear: 1985 } });
const ageStrict = makeUser({ dealbreakers: [{ kind: 'age_range', value: { min: 25, max: 35 } }] });
check('나이 dealbreaker 필터', checkDealbreakers(ageStrict, older, NOW_YEAR).includes('age_range'));

// --- 양방향: 한쪽만 좋아하는 조합은 조화 평균으로 하락 ---
const enthusiastic = makeUser({
  importance: { appearance: 1, personality: 5, values: 5, lifestyle: 5, relationship: 5 },
});
const lukewarmTarget = makeUser({
  profile: { userId: 'u6', gender: 'female', seekingGender: 'male', hobbies: [], personalityKeywords: [] },
  values: { marriageIntent: 1, childrenIntent: 1, contactFrequency: 1, spendingStyle: 1 },
  responses: responses({
    p01: ['personality', 'personality.extraversion', 1],
    p03: ['personality', 'personality.planning', 1],
    l01: ['lifestyle', 'lifestyle.homebody', 1],
    r01: ['relationship', 'relationship.contact', 1],
  }),
});
const asym = computeMatch(enthusiastic, lukewarmTarget, NOW_YEAR);
if (asym.score) {
  const arith = (asym.score.aToB + asym.score.bToA) / 2;
  check('조화 평균 ≤ 산술 평균 (비대칭 벌점)', asym.score.total <= arith + 1e-9);
}

// --- 방향 점수: 잘 맞는 상대가 안 맞는 상대보다 높다 ---
const similar = makeUser({ profile: { userId: 'u7', gender: 'female', seekingGender: 'male' } });
const dissimilar = lukewarmTarget;
const simScore = directionalScore(male, similar, NOW_YEAR).score;
const disScore = directionalScore(male, dissimilar, NOW_YEAR).score;
check('유사한 상대의 방향 점수가 더 높다', simScore > disScore);

// --- 역채점 반영 ---
const reverseA = makeUser({
  responses: responses({ p02: ['personality', 'personality.extraversion', 1, true] }),
});
const reverseB = makeUser({
  profile: { userId: 'u8', gender: 'female', seekingGender: 'male' },
  responses: responses({ p01: ['personality', 'personality.extraversion', 5, false] }),
});
const revScore = directionalScore(reverseA, reverseB, NOW_YEAR);
check('역채점: 1(reverse)==5(normal) 로 해석', revScore.dimensions.personality > 0.9);

// --- 외모 취향 벡터 ---
const prefVec = preferenceVectorFromChoices([
  { soft: 1, warm: 0.8 },
  { soft: 0.6, warm: 0.4 },
]);
check('취향 벡터 평균', Math.abs((prefVec?.soft ?? 0) - 0.8) < 1e-9);
const styleVec = styleVectorFromFeature([0.1, 0.2, 0.3, 0.4, 0.5]);
check('스타일 벡터 변환', styleVec?.playful === 0.4);
check('feature 부족 시 null', styleVectorFromFeature([0.1]) == null);

// --- 전략 ---
check('high_confidence 전략', pickStrategy(0.7, 0) === 'high_confidence');
check('exploration 전략', pickStrategy(0.55, 1) === 'exploration');
check('fallback 전략', pickStrategy(0.3, 2) === 'fallback');

// --- Icebreaker ---
const ib = generateIcebreaker(male, female);
check('공통 취미 기반 icebreaker', ib.lead.includes('여행') || ib.lead.includes('영화'));
const noCommon = generateIcebreaker(male, lukewarmTarget);
check('공통점 없어도 질문 생성', noCommon.question.length > 0);

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nAll MatchingEngine tests passed');
