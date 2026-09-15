/**
 * 온보딩 후 프로필·선호 조건·가치관 수정 (#25) — 서버 호출 모음.
 *
 *  * 공개 프로필(profiles): 본인 행 update (RLS). 성별·출생연도는 온보딩 완료 뒤 서버 트리거가 잠근다 (0024) — 화면에도 보내지 않는다.
 *  * 선호 조건 + Dealbreaker: RPC preferences_save 한 번 (한 트랜잭션 — 중간 실패 시 기존 값 유지).
 *  * 가치관(private_profiles): 본인 행 upsert.
 *  * 변경 이벤트(profile_updated / values_updated / preferences_updated)는 서버 트리거/RPC 가 남긴다 — 클라이언트는 기록하지 않는다.
 *  * 반영 시점: 추천은 생성 시점의 값을 읽으므로 "다음 소개" 부터 반영된다. 오늘 이미 받은 소개는 바뀌지 않는다.
 */
import { dealbreakerPayload, type DealbreakerRow, type PreferenceSettingsRow, type PreferencesFormState, settingsPayload, stateFromRows } from './preferencesCore';
import { supabase } from './supabase';

async function requireUserId(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  const id = data.user?.id;
  if (!id) throw new Error('로그인이 필요합니다.');
  return id;
}

/** 본인확인 결과(출생연도·성별) — 있으면 프로필 입력에서 잠근다. 없으면 null (Mock provider 등) */
export async function fetchIdentityFacts(): Promise<{ birthYear: number | null; gender: 'male' | 'female' | null } | null> {
  const { data, error } = await supabase.rpc('identity_facts_self');
  if (error) return null;
  const row = (Array.isArray(data) ? data[0] : data) as { birth_year: number | null; gender: string | null } | undefined;
  if (!row) return null;
  return {
    birthYear: typeof row.birth_year === 'number' ? row.birth_year : null,
    gender: row.gender === 'male' || row.gender === 'female' ? row.gender : null,
  };
}

// ---------------------------------------------------------------------------
// 공개 프로필
// ---------------------------------------------------------------------------
export type EditableProfile = {
  nickname: string;
  seeking_gender: 'male' | 'female';
  region_code: string;
  height_cm: number;
  job_group: string;
  smoking: string;
  drinking: string;
  education: string | null;
  religion: string | null;
  mbti: string | null;
  exercise: string | null;
  hobbies: string[];
  personality_keywords: string[];
};

export type ProfileRow = EditableProfile & { user_id: string; birth_year: number; gender: 'male' | 'female' };

export async function fetchMyProfile(): Promise<ProfileRow | null> {
  const userId = await requireUserId();
  const { data, error } = await supabase
    .from('profiles')
    .select('user_id, nickname, birth_year, gender, seeking_gender, region_code, height_cm, job_group, smoking, drinking, education, religion, mbti, exercise, hobbies, personality_keywords')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return (data as ProfileRow | null) ?? null;
}

/** 공개 프로필 수정 — 잠긴 컬럼(gender/birth_year)은 보내지 않는다 */
export async function updateMyProfile(patch: EditableProfile): Promise<void> {
  const userId = await requireUserId();
  const { error } = await supabase.from('profiles').update(patch).eq('user_id', userId);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// 선호 조건 + Dealbreaker
// ---------------------------------------------------------------------------
export async function fetchMyPreferences(): Promise<PreferencesFormState> {
  const userId = await requireUserId();
  const [settingsRes, dealbreakersRes] = await Promise.all([
    supabase
      .from('preference_settings')
      .select('age_min, age_max, age_direction, height_min, height_max, regions, smoking_pref, personality_keywords, personality_importance, values_importance, lifestyle_importance, relationship_importance')
      .eq('user_id', userId)
      .maybeSingle(),
    supabase.from('dealbreakers').select('kind, value').eq('user_id', userId),
  ]);
  if (settingsRes.error) throw settingsRes.error;
  if (dealbreakersRes.error) throw dealbreakersRes.error;
  return stateFromRows((settingsRes.data as PreferenceSettingsRow | null) ?? null, (dealbreakersRes.data as DealbreakerRow[] | null) ?? []);
}

/** 선호 설정 + Dealbreaker 를 한 번에 저장 (RPC — 원자적). 실패하면 기존 값이 그대로 남는다 */
export async function savePreferences(state: PreferencesFormState): Promise<void> {
  const { error } = await supabase.rpc('preferences_save', {
    p_settings: settingsPayload(state),
    p_dealbreakers: dealbreakerPayload(state),
  });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// 가치관 (비공개)
// ---------------------------------------------------------------------------
export type ValuesFormValues = {
  values: Record<string, number>;
  pastRelationships: string | null;
  shareSensitive: boolean;
};

export async function fetchMyValues(): Promise<ValuesFormValues | null> {
  const userId = await requireUserId();
  const { data, error } = await supabase
    .from('private_profiles')
    .select('marriage_intent, children_intent, long_distance_ok, contact_frequency, date_frequency, personal_time_need, opposite_sex_friends_ok, spending_style, religion_importance, sensitive_answers, sensitive_visibility')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as Record<string, unknown>;
  const values: Record<string, number> = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'number') values[k] = v;
  }
  const sensitive = (row.sensitive_answers ?? {}) as Record<string, unknown>;
  const visibility = (row.sensitive_visibility ?? {}) as Record<string, unknown>;
  return {
    values,
    pastRelationships: typeof sensitive.past_relationships === 'string' ? sensitive.past_relationships : null,
    shareSensitive: visibility.past_relationships === true,
  };
}

export async function saveMyValues(v: ValuesFormValues): Promise<void> {
  const userId = await requireUserId();
  const sensitiveAnswers: Record<string, string> = {};
  if (v.pastRelationships) sensitiveAnswers.past_relationships = v.pastRelationships;
  const { error } = await supabase.from('private_profiles').upsert({
    user_id: userId,
    ...v.values,
    sensitive_answers: sensitiveAnswers,
    sensitive_visibility: { past_relationships: v.pastRelationships ? v.shareSensitive : false },
  });
  if (error) throw error;
}
