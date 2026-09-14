/**
 * DB → UserSnapshot 로더 (서버 전용).
 * 클라이언트에는 이 데이터가 절대 그대로 내려가지 않는다 — 추천 카드는 별도 스냅샷(card)으로만 전달된다.
 *
 * #40: 외모 데이터는 읽지 않는다.
 *   * appearance_preference_events 조회 없음 (외모 취향 테스트는 MVP 에서 제거)
 *   * face_verifications.feature_vector 조회 없음 (얼굴 임베딩은 생성하지 않으며 매칭 입력이 아니다)
 *   * preference_settings.appearance_importance 는 읽지 않는다 (컬럼은 보존, 가중치에서 제외)
 *   인증 플래그(identity/face/age_verified)는 users 행에서 별도로 읽는다 (dataSource.userAccounts) —
 *   얼굴 벡터 유무로 인증 여부를 판단하지 않는다.
 * 모든 조회는 DataSource 가 실패 시 throw 하므로, 일부 조회 실패가 "데이터 없음" 으로 둔갑하지 않는다.
 */
import type { DataSource } from './dataSource.ts';
import { sanitizeImportance } from './MatchingEngine.ts';
import type { Dealbreaker, UserSnapshot } from './types.ts';

function likert(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 여러 사용자의 스냅샷을 한 번에 로드한다. 조회 실패 시 throw. */
export async function loadSnapshots(ds: DataSource, userIds: string[]): Promise<Map<string, UserSnapshot>> {
  if (userIds.length === 0) return new Map();

  const [profiles, privates, responses, questions, prefsRows, dealbreakerRows] = await Promise.all([
    ds.profiles(userIds),
    ds.privateProfiles(userIds),
    ds.questionnaireResponses(userIds),
    ds.questionnaireQuestions(),
    ds.preferenceSettings(userIds),
    ds.dealbreakers(userIds),
  ]);

  const questionMeta = new Map(questions.map((q) => [q.id, q]));
  const privateByUser = new Map(privates.map((p) => [p.user_id as string, p]));
  const prefsByUser = new Map(prefsRows.map((p) => [p.user_id as string, p]));

  const snapshots = new Map<string, UserSnapshot>();
  for (const profile of profiles) {
    const uid = profile.user_id as string;
    const priv = privateByUser.get(uid) ?? {};
    const prefs = prefsByUser.get(uid);
    const userResponses = responses
      .filter((r) => r.user_id === uid)
      .flatMap((r) => {
        const meta = questionMeta.get(r.question_id);
        if (!meta) return [];
        return [
          {
            questionId: r.question_id,
            category: meta.category as 'personality' | 'lifestyle' | 'relationship',
            axis: meta.axis,
            reverse: meta.reverse,
            value: r.value,
          },
        ];
      });

    snapshots.set(uid, {
      profile: {
        userId: uid,
        nickname: profile.nickname as string,
        birthYear: profile.birth_year as number,
        gender: profile.gender as 'male' | 'female',
        seekingGender: profile.seeking_gender as 'male' | 'female',
        regionCode: profile.region_code as string,
        heightCm: profile.height_cm as number,
        jobGroup: profile.job_group as string,
        smoking: profile.smoking as 'none' | 'sometimes' | 'regular',
        drinking: profile.drinking as 'none' | 'sometimes' | 'often',
        religion: (profile.religion as string | null) ?? null,
        hobbies: (profile.hobbies as string[] | null) ?? [],
        personalityKeywords: (profile.personality_keywords as string[] | null) ?? [],
        intro: (profile.intro as string | null) ?? null,
        relationshipGoal: (profile.relationship_goal as string | null) ?? null,
        publicAnswers: (profile.public_answers as Record<string, unknown> | null) ?? null,
      },
      values: {
        marriageIntent: likert(priv.marriage_intent),
        childrenIntent: likert(priv.children_intent),
        longDistanceOk: likert(priv.long_distance_ok),
        contactFrequency: likert(priv.contact_frequency),
        dateFrequency: likert(priv.date_frequency),
        personalTimeNeed: likert(priv.personal_time_need),
        oppositeSexFriendsOk: likert(priv.opposite_sex_friends_ok),
        spendingStyle: likert(priv.spending_style),
        religionImportance: likert(priv.religion_importance),
      },
      responses: userResponses,
      // 활성 차원 중요도만 (appearance_importance 는 읽지 않는다). 미설정이면 기본 3
      importance: sanitizeImportance(
        prefs
          ? {
              personality: prefs.personality_importance,
              values: prefs.values_importance,
              lifestyle: prefs.lifestyle_importance,
              relationship: prefs.relationship_importance,
            }
          : null,
      ),
      preferences: {
        ageMin: (prefs?.age_min as number | null) ?? null,
        ageMax: (prefs?.age_max as number | null) ?? null,
        ageDirection: (prefs?.age_direction as 'any' | 'older' | 'same' | 'younger' | undefined) ?? 'any',
        heightMin: (prefs?.height_min as number | null) ?? null,
        heightMax: (prefs?.height_max as number | null) ?? null,
        regions: (prefs?.regions as string[] | null) ?? [],
        smokingPref: (prefs?.smoking_pref as 'any' | 'prefer_non' | undefined) ?? 'any',
        personalityKeywords: (prefs?.personality_keywords as string[] | null) ?? [],
      },
      dealbreakers: dealbreakerRows
        .filter((d) => d.user_id === uid)
        .map((d) => ({ kind: d.kind, value: d.value }) as Dealbreaker),
    });
  }
  return snapshots;
}
