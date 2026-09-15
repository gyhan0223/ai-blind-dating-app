/**
 * 선호 조건·Dealbreaker 순수 로직 (#25) — React Native / Supabase 에 의존하지 않는다.
 * Node selftest(scripts/preferences-core-selftest.mjs)로 검증한다.
 *
 *  * 화면 상태(PreferencesFormState) ↔ 서버 저장 형식(preference_settings 행 + dealbreakers 행) 변환
 *  * 서버 RPC preferences_save 에 넘길 payload 만들기 — 허용 키만, appearance_importance 없음 (#39)
 *  * 입력 검증 (나이·키 범위) — 서버 제약과 같은 규칙
 */

export type AgeDirection = 'any' | 'older' | 'same' | 'younger';
export type SmokingPref = 'any' | 'prefer_non';

export const IMPORTANCE_KEYS = ['personality_importance', 'values_importance', 'lifestyle_importance', 'relationship_importance'] as const;
export type ImportanceKey = (typeof IMPORTANCE_KEYS)[number];

export type PreferencesFormState = {
  ageMin: string;
  ageMax: string;
  ageDirection: AgeDirection;
  ageStrict: boolean;
  heightMin: string;
  heightMax: string;
  regions: string[];
  regionStrict: boolean;
  smokingPref: SmokingPref;
  smokingStrict: boolean;
  marriageStrict: boolean;
  childrenStrict: boolean;
  keywords: string[];
  importance: Record<ImportanceKey, number>;
};

export const DEFAULT_PREFERENCES_STATE: PreferencesFormState = {
  ageMin: '',
  ageMax: '',
  ageDirection: 'any',
  ageStrict: false,
  heightMin: '',
  heightMax: '',
  regions: [],
  regionStrict: false,
  smokingPref: 'any',
  smokingStrict: false,
  marriageStrict: false,
  childrenStrict: false,
  keywords: [],
  importance: { personality_importance: 3, values_importance: 3, lifestyle_importance: 3, relationship_importance: 3 },
};

/** 서버 preference_settings 행 (읽기용 — 클라이언트가 쓰는 컬럼만) */
export type PreferenceSettingsRow = {
  age_min: number | null;
  age_max: number | null;
  age_direction: string | null;
  height_min: number | null;
  height_max: number | null;
  regions: string[] | null;
  smoking_pref: string | null;
  personality_keywords: string[] | null;
  personality_importance: number | null;
  values_importance: number | null;
  lifestyle_importance: number | null;
  relationship_importance: number | null;
};

export type DealbreakerRow = { kind: string; value: Record<string, unknown> | null };

function num(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** 나이·키 범위 검증 — 서버 check 제약과 동일 */
export function validatePreferences(s: PreferencesFormState): { agesValid: boolean; heightsValid: boolean; valid: boolean } {
  const aMin = num(s.ageMin);
  const aMax = num(s.ageMax);
  const hMin = num(s.heightMin);
  const hMax = num(s.heightMax);
  const inRange = (v: number | null, lo: number, hi: number) => v == null || (v >= lo && v <= hi);
  const agesValid =
    (s.ageMin.trim() === '' || aMin != null) && (s.ageMax.trim() === '' || aMax != null) &&
    inRange(aMin, 19, 80) && inRange(aMax, 19, 80) && (aMin == null || aMax == null || aMin <= aMax);
  const heightsValid =
    (s.heightMin.trim() === '' || hMin != null) && (s.heightMax.trim() === '' || hMax != null) &&
    inRange(hMin, 130, 220) && inRange(hMax, 130, 220) && (hMin == null || hMax == null || hMin <= hMax);
  return { agesValid, heightsValid, valid: agesValid && heightsValid };
}

/** RPC preferences_save 의 p_settings — 허용 키만 (appearance_importance 없음) */
export function settingsPayload(s: PreferencesFormState): Record<string, unknown> {
  return {
    age_min: num(s.ageMin),
    age_max: num(s.ageMax),
    age_direction: s.ageDirection,
    height_min: num(s.heightMin),
    height_max: num(s.heightMax),
    regions: s.regions,
    smoking_pref: s.smokingPref,
    personality_keywords: s.keywords,
    personality_importance: s.importance.personality_importance,
    values_importance: s.importance.values_importance,
    lifestyle_importance: s.importance.lifestyle_importance,
    relationship_importance: s.importance.relationship_importance,
  };
}

/** RPC preferences_save 의 p_dealbreakers — 켜진 항목만. 값이 없는 조건(나이 미입력·지역 미선택)은 켜져 있어도 보내지 않는다 */
export function dealbreakerPayload(s: PreferencesFormState): DealbreakerRow[] {
  const rows: DealbreakerRow[] = [];
  const aMin = num(s.ageMin);
  const aMax = num(s.ageMax);
  if (s.ageStrict && (aMin != null || aMax != null)) rows.push({ kind: 'age_range', value: { min: aMin, max: aMax } });
  if (s.regionStrict && s.regions.length > 0) rows.push({ kind: 'regions', value: { codes: s.regions } });
  if (s.smokingStrict) rows.push({ kind: 'smoking', value: { allow: false } });
  if (s.marriageStrict) rows.push({ kind: 'marriage_intent', value: { min: 2 } });
  if (s.childrenStrict) rows.push({ kind: 'children_intent', value: { maxGap: 2 } });
  return rows;
}

const AGE_DIRECTIONS: AgeDirection[] = ['any', 'older', 'same', 'younger'];

/** 서버 행 → 화면 상태 (수정 화면 초기값). 알 수 없는 값은 기본값으로 */
export function stateFromRows(settings: PreferenceSettingsRow | null, dealbreakers: DealbreakerRow[]): PreferencesFormState {
  const kinds = new Set(dealbreakers.map((d) => d.kind));
  const importance = { ...DEFAULT_PREFERENCES_STATE.importance };
  for (const k of IMPORTANCE_KEYS) {
    const v = settings?.[k];
    if (typeof v === 'number' && v >= 1 && v <= 5) importance[k] = v;
  }
  const dir = settings?.age_direction;
  return {
    ageMin: settings?.age_min != null ? String(settings.age_min) : '',
    ageMax: settings?.age_max != null ? String(settings.age_max) : '',
    ageDirection: AGE_DIRECTIONS.includes(dir as AgeDirection) ? (dir as AgeDirection) : 'any',
    ageStrict: kinds.has('age_range'),
    heightMin: settings?.height_min != null ? String(settings.height_min) : '',
    heightMax: settings?.height_max != null ? String(settings.height_max) : '',
    regions: Array.isArray(settings?.regions) ? settings!.regions!.filter((r) => typeof r === 'string') : [],
    regionStrict: kinds.has('regions'),
    smokingPref: settings?.smoking_pref === 'prefer_non' ? 'prefer_non' : 'any',
    smokingStrict: kinds.has('smoking'),
    marriageStrict: kinds.has('marriage_intent'),
    childrenStrict: kinds.has('children_intent'),
    keywords: Array.isArray(settings?.personality_keywords) ? settings!.personality_keywords!.filter((r) => typeof r === 'string') : [],
    importance,
  };
}

/** 두 상태가 같은 저장 결과를 내는지 (변경 없음 판단 → 불필요한 저장·이벤트 방지) */
export function preferencesEqual(a: PreferencesFormState, b: PreferencesFormState): boolean {
  return JSON.stringify([settingsPayload(a), dealbreakerPayload(a)]) === JSON.stringify([settingsPayload(b), dealbreakerPayload(b)]);
}
