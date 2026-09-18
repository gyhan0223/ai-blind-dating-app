import type { AdminSession } from './adminAuthCore.ts';
import { adminClient } from './supabaseAdmin.ts';

/**
 * 관리자 감사 기록 (#27) — 모든 변경 조치는 admin_audit_record RPC(service role) 로 남긴다.
 *  * actor = 인증된 불변 관리자 id (auth user id). 구 로그인 세션은 'legacy:<이름>'. 표시 이름은 detail.actor_name (보조 정보).
 *  * detail 에는 개인정보(전화번호·이메일·메시지 원문·OTP·secret)를 넣지 않는다 — id·결과·수치만.
 *  * 기록 실패가 조치 자체를 막지는 않는다 (조치는 도메인 테이블에 남는다). 실패는 콘솔에만 (detail 은 출력하지 않는다).
 */
export async function recordAdminAuditRaw(
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

/** 세션 기반 기록 — actor 는 세션의 불변 id, 표시 이름은 detail.actor_name */
export async function recordAdminAudit(
  session: AdminSession,
  action: string,
  targetType: string | null,
  targetId: string | null,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await recordAdminAuditRaw(session.actor, action, targetType, targetId, { ...detail, actor_name: session.displayName });
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
  admin_login_unavailable: '로그인 제한 확인 불가 (거부)',
  admin_login_not_member: '로그인 거부 (관리자 아님)',
  admin_login_disabled: '로그인 거부 (비활성 계정)',
  admin_password_ok: '비밀번호 통과 (MFA 대기)',
  admin_mfa_failed: 'MFA 코드 실패',
  admin_mfa_locked: 'MFA 잠금',
  admin_mfa_reenrolled: 'MFA 재등록 완료',
  admin_mfa_reset: 'MFA 초기화',
  admin_password_changed: '비밀번호 변경',
  admin_bootstrap: '첫 관리자 생성 (bootstrap)',
  admin_member_add: '관리자 추가',
  admin_member_role: '관리자 역할 변경',
  admin_member_status: '관리자 활성/비활성',
  admin_sessions_revoked: '관리자 세션 취소',
  user_status_set: '사용자 상태 변경',
  user_purge_now: '즉시 익명화',
  report_reviewing: '신고 확인 중',
  report_action: '신고 조치',
  face_review: '얼굴 검토',
  deletion_request_handle: '삭제 요청 처리',
  purge_retry: '삭제 작업 재시도',
  purge_stage_skip: '삭제 단계 건너뛰기',
  beta_gate_set: '베타 게이트 변경',
  beta_cohort_create: 'cohort 생성',
  beta_cohort_update: 'cohort 변경',
  beta_invite_create: '초대코드 생성',
  beta_invite_disable: '초대코드 비활성',
  beta_admit_user: '베타 입장(개별)',
  beta_admit_waitlist: '베타 입장(대기자)',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 화면용 처리자 표시 — uuid 는 관리자 이름(+id 앞 8자)으로, 구 기록/legacy 는 그대로 */
export function actorLabel(actor: string, names: Map<string, string>): string {
  if (UUID_RE.test(actor)) return `${names.get(actor) ?? '(삭제된 관리자)'} · ${actor.slice(0, 8)}`;
  return actor;
}

/** admin_members 의 표시 이름 맵 (감사·제재 기록 표시용) */
export async function loadAdminNames(): Promise<Map<string, string>> {
  try {
    const { data } = await adminClient().from('admin_members').select('user_id, display_name');
    return new Map(((data ?? []) as { user_id: string; display_name: string }[]).map((m) => [m.user_id, m.display_name]));
  } catch {
    return new Map();
  }
}
