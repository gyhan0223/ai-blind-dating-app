import type { SupabaseClient } from '@supabase/supabase-js';

/** 신고 운영 (#15) — 서버 전용. 상태 변경은 RPC admin_moderate_user 로만 (감사 기록). */

export type ModerationAction = 'warn' | 'suspend' | 'unsuspend' | 'ban' | 'unban' | 'dismiss' | 'note';

export const REASON_LABEL: Record<string, string> = {
  unpleasant_conversation: '불쾌한 대화',
  sexual_remarks: '성적인 발언',
  harassment: '성희롱·괴롭힘',
  threat: '위협',
  stalking: '스토킹',
  scam_money: '금전 요구·사기',
  personal_info_request: '개인정보 요구',
  impersonation: '사칭',
  false_info: '허위 정보',
  underage: '미성년 의심',
  spam: '스팸',
  other: '기타',
};

export const STATUS_LABEL: Record<string, string> = {
  pending: '대기',
  reviewing: '확인 중',
  actioned: '조치 완료',
  dismissed: '기각',
  resolved: '처리 완료(구)',
};

export type UserSummary = {
  user_id: string;
  status: string;
  suspended_until: string | null;
  reported_30d: number;
  reporter_30d: number;
  sanctions: number;
  signals_30d: number;
};

export async function moderateUser(
  db: SupabaseClient,
  input: { userId: string; action: ModerationAction; reason: string | null; reportId: string | null; actor: string; days: number | null },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await db.rpc('admin_moderate_user', {
    p_user_id: input.userId,
    p_action: input.action,
    p_reason: input.reason,
    p_report_id: input.reportId,
    p_actor: input.actor,
    p_days: input.days,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function loadUserSummaries(db: SupabaseClient, userIds: string[]): Promise<Map<string, UserSummary>> {
  if (userIds.length === 0) return new Map();
  const { data } = await db.from('moderation_user_summary').select('*').in('user_id', userIds);
  return new Map(((data ?? []) as UserSummary[]).map((s) => [s.user_id, s]));
}
