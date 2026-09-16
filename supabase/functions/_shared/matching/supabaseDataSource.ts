/**
 * DataSource 의 supabase-js(service role) 구현 — Edge Function 전용.
 * 모든 조회는 error 를 확인하고 실패 시 throw 한다 (빈 결과로 위장하지 않는다).
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type { DataSource, NewRecommendationRow, PastRecommendation, Row, StoredRecommendation, UserAccountRow } from './dataSource.ts';

function unwrap<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  if (res.data == null) throw new Error(`${what}: no data`);
  return res.data;
}

export function supabaseDataSource(db: SupabaseClient): DataSource {
  return {
    async profiles(ids) {
      return unwrap(await db.from('profiles').select('*').in('user_id', ids), 'profiles') as Row[];
    },
    async privateProfiles(ids) {
      return unwrap(await db.from('private_profiles').select('*').in('user_id', ids), 'private_profiles') as Row[];
    },
    async questionnaireResponses(ids) {
      return unwrap(
        await db.from('questionnaire_responses').select('user_id, question_id, value').in('user_id', ids),
        'questionnaire_responses',
      ) as { user_id: string; question_id: string; value: number }[];
    },
    async questionnaireQuestions() {
      return unwrap(
        await db.from('questionnaire_questions').select('id, category, axis, reverse'),
        'questionnaire_questions',
      ) as { id: string; category: string; axis: string; reverse: boolean }[];
    },
    async preferenceSettings(ids) {
      // appearance_importance 는 읽지 않는다 (#40)
      return unwrap(
        await db
          .from('preference_settings')
          .select(
            'user_id, age_min, age_max, age_direction, height_min, height_max, regions, smoking_pref, personality_keywords, ' +
              'personality_importance, values_importance, lifestyle_importance, relationship_importance',
          )
          .in('user_id', ids),
        'preference_settings',
      ) as Row[];
    },
    async dealbreakers(ids) {
      return unwrap(await db.from('dealbreakers').select('user_id, kind, value').in('user_id', ids), 'dealbreakers') as {
        user_id: string;
        kind: string;
        value: Row;
      }[];
    },

    async userAccounts(ids) {
      if (ids.length === 0) return [];
      return unwrap(
        await db
          .from('users')
          .select('id, status, onboarding_completed, identity_verified, face_verified, age_verified')
          .in('id', ids),
        'users',
      ) as UserAccountRow[];
    },
    async activeMatchCounts(ids) {
      if (ids.length === 0) return {};
      const rows = unwrap(
        await db.from('conversation_slot_usage').select('user_id, active_matches').in('user_id', ids),
        'conversation_slot_usage',
      ) as { user_id: string; active_matches: number }[];
      const out: Record<string, number> = {};
      for (const r of rows) out[r.user_id] = Number(r.active_matches) || 0;
      return out;
    },
    async blockPairs(userId) {
      return unwrap(
        await db.from('blocks').select('blocker_id, blocked_id').or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`),
        'blocks',
      ) as { blocker_id: string; blocked_id: string }[];
    },
    async reportPairs(userId) {
      return unwrap(
        await db.from('reports').select('reporter_id, reported_id').or(`reporter_id.eq.${userId},reported_id.eq.${userId}`),
        'reports',
      ) as { reporter_id: string; reported_id: string }[];
    },
    async likedUserIds(userId) {
      const rows = unwrap(await db.from('likes').select('to_user_id').eq('from_user_id', userId), 'likes') as {
        to_user_id: string;
      }[];
      return rows.map((r) => r.to_user_id);
    },
    async matchedUserIds(userId) {
      const rows = unwrap(
        await db.from('matches').select('user_a, user_b').or(`user_a.eq.${userId},user_b.eq.${userId}`),
        'matches',
      ) as { user_a: string; user_b: string }[];
      return rows.map((m) => (m.user_a === userId ? m.user_b : m.user_a));
    },
    async pastRecommendations(userId) {
      return unwrap(
        await db.from('recommendations').select('candidate_id, status, for_date').eq('user_id', userId),
        'recommendations(past)',
      ) as PastRecommendation[];
    },

    async recommendationsForDate(userId, forDate) {
      return unwrap(
        await db
          .from('recommendations')
          .select('id, status, strategy, card, candidate_id')
          .eq('user_id', userId)
          .eq('for_date', forDate)
          .order('created_at', { ascending: true }),
        'recommendations(today)',
      ) as StoredRecommendation[];
    },
    async candidateIdsPage(gender, seekingGender, offset, limit) {
      const rows = unwrap(
        await db
          .from('profiles')
          .select('user_id, users!inner(status, onboarding_completed, identity_verified, face_verified, age_verified)')
          .eq('gender', gender)
          .eq('seeking_gender', seekingGender)
          .eq('users.status', 'active')
          .eq('users.onboarding_completed', true)
          .eq('users.identity_verified', true)
          .eq('users.face_verified', true)
          .eq('users.age_verified', true)
          .order('user_id', { ascending: true })
          .range(offset, offset + limit - 1),
        'candidates',
      ) as { user_id: string }[];
      return rows.map((r) => r.user_id);
    },
    async insertRecommendation(row: NewRecommendationRow) {
      return unwrap(
        await db.from('recommendations').insert(row).select('id, status, strategy, card, candidate_id').single(),
        'recommendations(insert)',
      ) as StoredRecommendation;
    },
    async expireRecommendations(ids) {
      if (ids.length === 0) return;
      const res = await db.from('recommendations').update({ status: 'expired' }).in('id', ids).eq('status', 'pending');
      if (res.error) throw new Error(`recommendations(expire): ${res.error.message}`);
    },
  };
}
