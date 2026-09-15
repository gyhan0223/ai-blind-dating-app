/**
 * 선호 조건 순수 로직 selftest (#25) — Node 로 실행 (Expo/RN 불필요).
 *   node --experimental-strip-types scripts/preferences-core-selftest.mjs
 */
import {
  DEFAULT_PREFERENCES_STATE,
  dealbreakerPayload,
  preferencesEqual,
  settingsPayload,
  stateFromRows,
  validatePreferences,
} from '../src/lib/preferencesCore.ts';

let passed = 0;
let failed = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL ${name}: expected ${e}, got ${a}`);
  }
}

// 검증 — 서버 제약과 동일
eq('빈 값은 유효', validatePreferences(DEFAULT_PREFERENCES_STATE).valid, true);
eq('나이 역전 무효', validatePreferences({ ...DEFAULT_PREFERENCES_STATE, ageMin: '35', ageMax: '30' }).agesValid, false);
eq('나이 범위 밖 무효', validatePreferences({ ...DEFAULT_PREFERENCES_STATE, ageMin: '18' }).agesValid, false);
eq('키 범위', validatePreferences({ ...DEFAULT_PREFERENCES_STATE, heightMin: '120' }).heightsValid, false);
eq('숫자 아님 무효', validatePreferences({ ...DEFAULT_PREFERENCES_STATE, ageMin: 'abc' }).agesValid, false);
eq('정상', validatePreferences({ ...DEFAULT_PREFERENCES_STATE, ageMin: '27', ageMax: '35', heightMin: '160', heightMax: '185' }).valid, true);

// payload — 허용 키만, appearance_importance 없음
const s1 = { ...DEFAULT_PREFERENCES_STATE, ageMin: '27', ageMax: '', regions: ['seoul'], smokingPref: 'prefer_non', keywords: ['warm'], importance: { ...DEFAULT_PREFERENCES_STATE.importance, values_importance: 5 } };
const p1 = settingsPayload(s1);
eq('settings payload', p1, {
  age_min: 27, age_max: null, age_direction: 'any', height_min: null, height_max: null, regions: ['seoul'], smoking_pref: 'prefer_non',
  personality_keywords: ['warm'], personality_importance: 3, values_importance: 5, lifestyle_importance: 3, relationship_importance: 3,
});
eq('appearance_importance 없음', 'appearance_importance' in p1, false);

// dealbreaker — 켜져도 값 없으면 제외
eq('값 없는 나이 조건은 제외', dealbreakerPayload({ ...DEFAULT_PREFERENCES_STATE, ageStrict: true }), []);
eq('값 없는 지역 조건은 제외', dealbreakerPayload({ ...DEFAULT_PREFERENCES_STATE, regionStrict: true }), []);
eq('전체', dealbreakerPayload({ ...s1, ageStrict: true, regionStrict: true, smokingStrict: true, marriageStrict: true, childrenStrict: true }), [
  { kind: 'age_range', value: { min: 27, max: null } },
  { kind: 'regions', value: { codes: ['seoul'] } },
  { kind: 'smoking', value: { allow: false } },
  { kind: 'marriage_intent', value: { min: 2 } },
  { kind: 'children_intent', value: { maxGap: 2 } },
]);

// 서버 행 → 상태 (round trip)
const row = { age_min: 27, age_max: 35, age_direction: 'older', height_min: null, height_max: 185, regions: ['seoul', 'gyeonggi'], smoking_pref: 'prefer_non', personality_keywords: ['warm'], personality_importance: 4, values_importance: 5, lifestyle_importance: 3, relationship_importance: 2 };
const st = stateFromRows(row, [{ kind: 'age_range', value: { min: 27, max: 35 } }, { kind: 'smoking', value: { allow: false } }]);
eq('행 → 상태', st, {
  ageMin: '27', ageMax: '35', ageDirection: 'older', ageStrict: true, heightMin: '', heightMax: '185', regions: ['seoul', 'gyeonggi'], regionStrict: false,
  smokingPref: 'prefer_non', smokingStrict: true, marriageStrict: false, childrenStrict: false, keywords: ['warm'],
  importance: { personality_importance: 4, values_importance: 5, lifestyle_importance: 3, relationship_importance: 2 },
});
eq('상태 → payload 왕복', settingsPayload(st), { ...row, regions: ['seoul', 'gyeonggi'] });
eq('행 없음 → 기본값', stateFromRows(null, []), DEFAULT_PREFERENCES_STATE);
eq('알 수 없는 값은 기본값', stateFromRows({ ...row, age_direction: 'weird', smoking_pref: 'x', personality_importance: 9 }, []).ageDirection, 'any');
eq('중요도 범위 밖은 기본값', stateFromRows({ ...row, personality_importance: 9 }, []).importance.personality_importance, 3);

// 변경 없음 판단
eq('같은 상태', preferencesEqual(st, { ...st }), true);
eq('입력 문자열 공백 차이는 같은 값', preferencesEqual(st, { ...st, ageMin: ' 27 ' }), true);
eq('다른 상태', preferencesEqual(st, { ...st, smokingStrict: false }), false);

console.log(`preferences core selftest: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
