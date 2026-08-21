import type { SupabaseClient } from '@supabase/supabase-js';

async function count(db: SupabaseClient, table: string, filter?: (q: any) => any): Promise<number> {
  let query = db.from(table).select('*', { count: 'exact', head: true });
  if (filter) query = filter(query);
  const { count: n } = await query;
  return n ?? 0;
}

async function distinctUsers(db: SupabaseClient, table: string, column: string, filter?: (q: any) => any): Promise<number> {
  let query = db.from(table).select(column).limit(10000);
  if (filter) query = filter(query);
  const { data } = await query;
  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  return new Set(rows.map((r) => r[column])).size;
}

export type FunnelStep = { label: string; value: number };

export async function loadDashboardStats(db: SupabaseClient) {
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  const [
    totalUsers,
    activeUsers,
    onboardingCompleted,
    recommendationsCount,
    usersWithRecommendation,
    usersWhoLiked,
    matchesCount,
    chatsStarted,
    meetupMutual,
    meetupCompleted,
    secondDateYes,
    pendingReports,
  ] = await Promise.all([
    count(db, 'users'),
    count(db, 'users', (q) => q.gte('last_active_at', weekAgo)),
    count(db, 'users', (q) => q.eq('onboarding_completed', true)),
    count(db, 'recommendations'),
    distinctUsers(db, 'recommendations', 'user_id'),
    distinctUsers(db, 'likes', 'from_user_id'),
    count(db, 'matches'),
    count(db, 'conversation_metrics', (q) => q.gt('total_messages', 0)),
    count(db, 'matches', (q) => q.in('meetup_state', ['mutual_interest', 'scheduled', 'completed'])),
    count(db, 'matches', (q) => q.eq('meetup_state', 'completed')),
    count(db, 'meetup_feedback', (q) => q.eq('met_again_intent', 'yes')),
    count(db, 'reports', (q) => q.eq('status', 'pending')),
  ]);

  const funnel: FunnelStep[] = [
    { label: '가입', value: totalUsers },
    { label: '온보딩 완료', value: onboardingCompleted },
    { label: '추천 확인', value: usersWithRecommendation },
    { label: '호감 표현', value: usersWhoLiked },
    { label: '매치', value: matchesCount },
    { label: '대화 시작', value: chatsStarted },
    { label: '만남 희망(상호)', value: meetupMutual },
    { label: '실제 만남', value: meetupCompleted },
    { label: '재만남 희망', value: secondDateYes },
  ];

  return {
    totalUsers,
    activeUsers,
    onboardingCompleted,
    recommendationsCount,
    matchesCount,
    chatsStarted,
    meetupMutual,
    meetupCompleted,
    pendingReports,
    funnel,
  };
}
