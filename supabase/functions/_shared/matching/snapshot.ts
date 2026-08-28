/**
 * DB → UserSnapshot 로더 (Edge Function 전용, service role).
 * 클라이언트에는 이 데이터가 절대 그대로 내려가지 않는다 —
 * 추천 카드는 별도 스냅샷(card)으로만 전달된다.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { preferenceVectorFromChoices, styleVectorFromFeature } from './MatchingEngine.ts';
import type { Dealbreaker, StyleVector, UserSnapshot } from './types.ts';

/** 외모 취향 테스트 자산 벡터 — 모바일 앱 constants/faceTestAssets.ts 와 동기 유지 */
const FACE_TEST_VECTORS: Record<string, StyleVector> = {
  ft01: { soft: 0.9, warm: 0.8, bold: 0.2, playful: 0.4 },
  ft02: { soft: 0.2, warm: 0.3, bold: 0.9, playful: 0.3 },
  ft03: { soft: 0.7, warm: 0.5, bold: 0.4, playful: 0.8 },
  ft04: { soft: 0.4, warm: 0.7, bold: 0.6, playful: 0.2 },
  ft05: { soft: 0.8, warm: 0.4, bold: 0.3, playful: 0.6 },
  ft06: { soft: 0.3, warm: 0.6, bold: 0.8, playful: 0.5 },
  ft07: { soft: 0.6, warm: 0.9, bold: 0.3, playful: 0.7 },
  ft08: { soft: 0.5, warm: 0.2, bold: 0.7, playful: 0.2 },
  ft09: { soft: 0.7, warm: 0.6, bold: 0.5, playful: 0.3 },
  ft10: { soft: 0.4, warm: 0.5, bold: 0.4, playful: 0.9 },
  ft11: { soft: 0.9, warm: 0.7, bold: 0.1, playful: 0.5 },
  ft12: { soft: 0.2, warm: 0.4, bold: 0.9, playful: 0.6 },
};

const DEFAULT_IMPORTANCE = { appearance: 3, personality: 3, values: 3, lifestyle: 3, relationship: 3 };

/** 여러 사용자의 스냅샷을 한 번에 로드한다. */
export async function loadSnapshots(db: SupabaseClient, userIds: string[]): Promise<Map<string, UserSnapshot>> {
  if (userIds.length === 0) return new Map();

  const [profilesRes, privatesRes, responsesRes, questionsRes, prefsRes, dealbreakersRes, appearanceRes, facesRes] =
    await Promise.all([
      db.from('profiles').select('*').in('user_id', userIds),
      db.from('private_profiles').select('*').in('user_id', userIds),
      db.from('questionnaire_responses').select('user_id, question_id, value').in('user_id', userIds),
      db.from('questionnaire_questions').select('id, category, axis, reverse'),
      db.from('preference_settings').select('*').in('user_id', userIds),
      db.from('dealbreakers').select('user_id, kind, value').in('user_id', userIds),
      db.from('appearance_preference_events').select('user_id, selected').in('user_id', userIds),
      db
        .from('face_verifications')
        .select('user_id, feature_vector, created_at')
        .in('user_id', userIds)
        .eq('status', 'approved')
        .order('created_at', { ascending: false }),
    ]);

  const questionMeta = new Map(
    (questionsRes.data ?? []).map((q) => [q.id as string, q as { id: string; category: string; axis: string; reverse: boolean }]),
  );

  const snapshots = new Map<string, UserSnapshot>();
  for (const profile of profilesRes.data ?? []) {
    const uid = profile.user_id as string;
    const priv = (privatesRes.data ?? []).find((p) => p.user_id === uid) ?? {};
    const prefs = (prefsRes.data ?? []).find((p) => p.user_id === uid);
    const userResponses = (responsesRes.data ?? [])
      .filter((r) => r.user_id === uid)
      .flatMap((r) => {
        const meta = questionMeta.get(r.question_id as string);
        if (!meta) return [];
        return [
          {
            questionId: r.question_id as string,
            category: meta.category as 'personality' | 'lifestyle' | 'relationship',
            axis: meta.axis,
            reverse: meta.reverse,
            value: r.value as number,
          },
        ];
      });
    const chosenVectors = (appearanceRes.data ?? [])
      .filter((e) => e.user_id === uid)
      .map((e) => FACE_TEST_VECTORS[e.selected as string])
      .filter((v): v is StyleVector => v != null);
    const face = (facesRes.data ?? []).find((f) => f.user_id === uid);

    snapshots.set(uid, {
      profile: {
        userId: uid,
        nickname: profile.nickname,
        birthYear: profile.birth_year,
        gender: profile.gender,
        seekingGender: profile.seeking_gender,
        regionCode: profile.region_code,
        heightCm: profile.height_cm,
        jobGroup: profile.job_group,
        smoking: profile.smoking,
        drinking: profile.drinking,
        religion: profile.religion,
        hobbies: profile.hobbies ?? [],
        personalityKeywords: profile.personality_keywords ?? [],
      },
      values: {
        marriageIntent: priv.marriage_intent,
        childrenIntent: priv.children_intent,
        longDistanceOk: priv.long_distance_ok,
        contactFrequency: priv.contact_frequency,
        dateFrequency: priv.date_frequency,
        personalTimeNeed: priv.personal_time_need,
        oppositeSexFriendsOk: priv.opposite_sex_friends_ok,
        spendingStyle: priv.spending_style,
        religionImportance: priv.religion_importance,
      },
      responses: userResponses,
      importance: prefs
        ? {
            appearance: prefs.appearance_importance,
            personality: prefs.personality_importance,
            values: prefs.values_importance,
            lifestyle: prefs.lifestyle_importance,
            relationship: prefs.relationship_importance,
          }
        : DEFAULT_IMPORTANCE,
      preferences: {
        ageMin: prefs?.age_min ?? null,
        ageMax: prefs?.age_max ?? null,
        ageDirection: prefs?.age_direction ?? 'any',
        heightMin: prefs?.height_min ?? null,
        heightMax: prefs?.height_max ?? null,
        regions: prefs?.regions ?? [],
        smokingPref: prefs?.smoking_pref ?? 'any',
        personalityKeywords: prefs?.personality_keywords ?? [],
      },
      dealbreakers: ((dealbreakersRes.data ?? []).filter((d) => d.user_id === uid) as unknown[]).map(
        (d) => d as Dealbreaker,
      ),
      appearancePreferenceVector: preferenceVectorFromChoices(chosenVectors),
      appearanceStyleVector: styleVectorFromFeature((face?.feature_vector as number[] | null) ?? null),
    });
  }
  return snapshots;
}
