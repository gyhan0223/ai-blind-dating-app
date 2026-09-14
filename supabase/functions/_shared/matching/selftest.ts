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
import { buildPublicAnswerCards, composeIntro, normalizeRelationshipGoal } from './publicPrompts.ts';
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

// --- #39: 비공개 가치관 응답은 icebreaker 문구에 새지 않는다 ---
const privateHeavyA = makeUser({
  profile: { hobbies: [] },
  values: { spendingStyle: 5, personalTimeNeed: 5 },
});
const privateHeavyB = makeUser({
  profile: { userId: 'u9', gender: 'female', seekingGender: 'male', hobbies: [] },
  values: { spendingStyle: 5, personalTimeNeed: 5 },
});
const leak = generateIcebreaker(privateHeavyA, privateHeavyB);
check('icebreaker 가 비공개 소비/개인시간 응답을 언급하지 않는다', !leak.lead.includes('경험에') && !leak.lead.includes('자기만의 시간'));
const sameGoalA = makeUser({ profile: { hobbies: [], relationshipGoal: 'serious' } });
const sameGoalB = makeUser({ profile: { userId: 'u10', gender: 'female', seekingGender: 'male', hobbies: [], relationshipGoal: 'serious' } });
check('공개 연애 목적이 같으면 그 사실만 언급', generateIcebreaker(sameGoalA, sameGoalB).lead.includes('연애 목적'));

// --- #39: 추천 이유는 확인된 데이터에서만 — 근거 없으면 빈 배열 ---
const strangerA = makeUser({
  profile: { hobbies: [], regionCode: 'seoul' },
  responses: responses({ p01: ['personality', 'personality.extraversion', 1] }),
  values: { marriageIntent: 1, childrenIntent: 1, spendingStyle: 1, contactFrequency: 1, dateFrequency: 1, personalTimeNeed: 1 },
});
const strangerB = makeUser({
  profile: { userId: 'u11', gender: 'female', seekingGender: 'male', hobbies: [], regionCode: 'busan' },
  responses: responses({ p01: ['personality', 'personality.extraversion', 5] }),
  values: { marriageIntent: 5, childrenIntent: 5, spendingStyle: 5, contactFrequency: 5, dateFrequency: 5, personalTimeNeed: 5 },
});
const strangerResult = computeMatch(strangerA, strangerB, NOW_YEAR);
check('공통점이 확인되지 않으면 이유를 지어내지 않는다', strangerResult.eligible && strangerResult.reasons.length === 0);
check('추천 이유에 보장/궁합 표현 없음', !result.reasons.some((r) => r.includes('잘 맞아요') || r.includes('어울릴')));
const goalMatch = computeMatch(
  makeUser({ ...strangerA, profile: { ...strangerA.profile, relationshipGoal: 'marriage_minded' } }),
  makeUser({ ...strangerB, profile: { ...strangerB.profile, relationshipGoal: 'marriage_minded' } }),
  NOW_YEAR,
);
check('연애 목적이 같으면 공개 사실로 이유 생성', goalMatch.reasons.includes('연애 목적이 같아요'));

// --- #39: 외모 응답·벡터가 없어도(신규 가입 경로) 추천 계산이 된다 ---
check('외모 벡터 null 이어도 eligible + 점수', result.eligible && result.score != null && male.appearancePreferenceVector == null);

// --- #39: 카드 공개 답변 allowlist (선택지 코드 → 라벨) ---
const cards = buildPublicAnswerCards({
  day_off: ['cafe', 'not_an_option', 'rest_home', 'walk'], // 허용 코드만, max 2
  together: 'food_tour', // 문자열 하나도 허용
  important: ['honest_talk', 'honest_talk'], // 중복 제거, max 1
  unknown_key: ['cafe'], // 알 수 없는 질문은 버림
  hidden: '노출되면 안 되는 자유 텍스트',
});
check('허용된 질문만 카드에 실린다', cards.length === 3 && !cards.some((c) => c.id === 'unknown_key' || c.id === 'hidden'));
check('허용 코드만 · 최대 개수 적용', cards[0].id === 'day_off' && cards[0].values.join(',') === 'cafe,rest_home');
check('라벨로 변환', cards[0].answer === '카페 가기 · 집에서 푹 쉬기');
check('문자열 하나도 허용', cards[1].values.join(',') === 'food_tour' && cards[1].answer === '맛집 탐방');
check('중복 제거 + max 1', cards[2].values.length === 1);
check('질문 문구가 함께 실린다', cards[0].question.length > 0);
check('배열/비객체 답변은 빈 배열', buildPublicAnswerCards(['x']).length === 0 && buildPublicAnswerCards(null).length === 0);
check('relationship_goal 허용값만', normalizeRelationshipGoal('serious') === 'serious' && normalizeRelationshipGoal('x') == null);

// --- #39: 소개 문장 조합 (규칙 기반) ---
const intro = composeIntro('serious', { day_off: ['rest_home', 'cafe'], important: 'honest_talk' });
check('소개 문장 조합', intro === '진지한 연애를 원해요. 쉬는 날엔 주로 집에서 푹 쉬기 · 카페 가기. 연애에서 중요하게 생각하는 건 솔직한 대화.');
check('고른 것이 없으면 null', composeIntro(null, {}) == null && composeIntro('bogus', { hidden: 'x' }) == null);
check('자유 텍스트는 문장에 들어가지 않는다', !(composeIntro('serious', { day_off: '내 맘대로 쓴 글' }) ?? '').includes('내 맘대로'));
