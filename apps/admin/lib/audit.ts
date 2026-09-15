import { adminClient } from './supabaseAdmin';

/**
 * 관리자 감사 기록 (#27) — 모든 변경 조치는 admin_audit_record RPC(service role) 로 남긴다.
 *  * detail 에는 개인정보(전화번호·이메일·메시지 원문)를 넣지 않는다 — id·결과·수치만.
 *  * 기록 실패가 조치 자체를 막지는 않는다 (조치는 도메인 테이블에 남는다). 실패는 콘솔에만.
 */
export async function recordAdminAudit(
  actor: string,
  action: string,
  targetType: string | null,
  targetId: string | null,
  detail: Record<string, unknown> = {},
): Promise<void> {
  try {
    const db = adminClient();
    const { error } = await db.rpc('admin_audit_record', {
      p_actor: actor,
      p_action: action,
      p_target_type: targetType,
      p_target_id: targetId,
      p_detail: detail,
    });
    if (error) console.error(`[audit] ${action} not recorded: ${error.message}`);
  } catch (e) {
    console.error(`[audit] ${action} not recorded: ${e instanceof Error ? e.message : 'error'}`);
  }
}

export type AuditRow = {
  id: number;
  actor: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: Record<string, unknown>;
  created_at: string;
};

export const AUDIT_ACTION_LABEL: Record<string, string> = {
  admin_login: '로그인',
  admin_logout: '로그아웃',
  admin_login_failed: '로그인 실패',
  admin_login_locked: '로그인 잠금',
  user_status_set: '사용자 상태 변경',
  user_purge_now: '즉시 익명화',
  report_reviewing: '신고 확인 중',
  report_action: '신고 조치',
  face_review: '얼굴 검토',
  deletion_request_handle: '삭제 요청 처리',
  beta_gate_set: '베타 게이트 변경',
  beta_cohort_create: 'cohort 생성',
  beta_cohort_update: 'cohort 변경',
  beta_invite_create: '초대코드 생성',
  beta_invite_disable: '초대코드 비활성',
  beta_admit_user: '베타 입장(개별)',
  beta_admit_waitlist: '베타 입장(대기자)',
};
