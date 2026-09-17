import type { AdminRole, AdminSession } from './adminAuthCore';
import { ADMIN_PASSWORD_MIN_LENGTH, isValidEmail } from './adminAuthCore';
import { recordAdminAudit } from './audit';
import { adminClient } from './supabaseAdmin';
import { supabaseAdminAuthProvider } from './supabaseAdminAuth';

/**
 * 관리자 멤버 관리 (#27) — owner 전용. 서버 액션이 requireOwner 뒤에 부른다.
 * 역할·상태 변경과 마지막 owner 보호는 DB RPC(0033)가 행 잠금 아래에서 판정한다. 실행자 id 는 세션에서만 온다.
 * 초기 비밀번호는 owner 가 입력해 Auth 에만 전달된다 (저장·로그·감사 기록 없음). 새 관리자는 첫 로그인에서 MFA 를 등록해야 한다.
 */
export type AdminMemberRow = {
  user_id: string;
  display_name: string;
  role: AdminRole;
  status: 'active' | 'disabled';
  mfa_verified_at: string | null;
  sessions_revoked_at: string | null;
  created_at: string;
};

export async function loadAdminMembers(): Promise<AdminMemberRow[]> {
  const { data } = await adminClient().from('admin_members').select('user_id, display_name, role, status, mfa_verified_at, sessions_revoked_at, created_at').order('created_at');
  return (data ?? []) as AdminMemberRow[];
}

type Result = { ok: true } | { ok: false; reason: string };

function rpcResult(data: unknown, error: { message: string } | null): Result {
  if (error) return { ok: false, reason: 'unavailable' };
  const r = data as { ok?: boolean; reason?: string } | null;
  return r?.ok ? { ok: true } : { ok: false, reason: r?.reason ?? 'unavailable' };
}

export async function addAdminMember(session: AdminSession, input: { email: string; displayName: string; role: AdminRole; password: string }): Promise<Result> {
  if (!session.userId) return { ok: false, reason: 'legacy_session' }; // 구 로그인 세션은 관리자를 만들 수 없다 (bootstrap 스크립트 사용)
  const email = input.email.trim().toLowerCase();
  if (!isValidEmail(email)) return { ok: false, reason: 'invalid_email' };
  if (!input.displayName.trim()) return { ok: false, reason: 'invalid_name' };
  if (input.role !== 'owner' && input.role !== 'viewer') return { ok: false, reason: 'invalid_role' };
  if (input.password.length < ADMIN_PASSWORD_MIN_LENGTH) return { ok: false, reason: 'weak_password' };
  const provider = supabaseAdminAuthProvider();
  const created = await provider.createAdminUser(email, input.password);
  if (!created.ok) return { ok: false, reason: created.reason };
  const { data, error } = await adminClient().rpc('admin_member_add', { p_actor: session.userId, p_target: created.userId, p_display_name: input.displayName.trim(), p_role: input.role });
  const r = rpcResult(data, error);
  if (!r.ok) {
    // membership 이 만들어지지 않은 Auth 계정은 남기지 않는다
    await adminClient().auth.admin.deleteUser(created.userId).catch(() => {});
  }
  return r;
}

export async function setAdminRole(session: AdminSession, target: string, role: AdminRole): Promise<Result> {
  if (!session.userId) return { ok: false, reason: 'legacy_session' };
  const { data, error } = await adminClient().rpc('admin_member_set_role', { p_actor: session.userId, p_target: target, p_role: role });
  return rpcResult(data, error);
}

export async function setAdminStatus(session: AdminSession, target: string, status: 'active' | 'disabled'): Promise<Result> {
  if (!session.userId) return { ok: false, reason: 'legacy_session' };
  const { data, error } = await adminClient().rpc('admin_member_set_status', { p_actor: session.userId, p_target: target, p_status: status });
  return rpcResult(data, error);
}

export async function revokeAdminSessions(session: AdminSession, target: string): Promise<Result> {
  if (!session.userId) return { ok: false, reason: 'legacy_session' };
  const { data, error } = await adminClient().rpc('admin_member_revoke_sessions', { p_actor: session.userId, p_target: target, p_reason: 'owner_revoke' });
  return rpcResult(data, error);
}

/** 다른 관리자의 MFA 초기화 (분실) — owner 만. factor 삭제 + 세션 취소. 대상은 다음 로그인에서 다시 등록한다 */
export async function resetAdminMfa(session: AdminSession, target: string): Promise<Result> {
  if (!session.userId) return { ok: false, reason: 'legacy_session' };
  const { data: isOwner } = await adminClient().from('admin_members').select('role, status').eq('user_id', session.userId).maybeSingle();
  if (!isOwner || isOwner.role !== 'owner' || isOwner.status !== 'active') return { ok: false, reason: 'forbidden' };
  const { data: member } = await adminClient().from('admin_members').select('user_id').eq('user_id', target).maybeSingle();
  if (!member) return { ok: false, reason: 'not_found' };
  const provider = supabaseAdminAuthProvider();
  if (!(await provider.deleteAllFactors(target))) return { ok: false, reason: 'unavailable' };
  const revoke = await revokeAdminSessions(session, target);
  await recordAdminAudit(session, 'admin_mfa_reset', 'admin_member', target, { by: 'owner', sessions_revoked: revoke.ok });
  return { ok: true };
}

export const MEMBER_ERROR_LABEL: Record<string, string> = {
  forbidden: 'owner 권한이 필요합니다.',
  last_owner: '마지막 활성 owner 는 강등·비활성화할 수 없습니다. 먼저 다른 owner 를 지정하세요.',
  already_member: '이미 관리자입니다.',
  already_exists: '이 이메일의 Auth 계정이 이미 있습니다. 앱 사용자와 관리자는 별도 계정을 씁니다.',
  app_user_not_allowed: '앱 사용자 계정은 관리자가 될 수 없습니다. 관리자 전용 이메일 계정을 만드세요.',
  auth_user_not_found: 'Auth 계정을 찾을 수 없습니다.',
  invalid_email: '이메일 형식이 올바르지 않습니다.',
  invalid_name: '표시 이름을 입력하세요.',
  invalid_role: '역할은 owner 또는 viewer 입니다.',
  weak_password: `초기 비밀번호는 ${ADMIN_PASSWORD_MIN_LENGTH}자 이상이어야 합니다.`,
  legacy_session: '구 공유 비밀번호 세션으로는 관리자를 관리할 수 없습니다. 개인 계정으로 로그인하세요.',
  unavailable: 'DB/Auth 에 연결할 수 없어 처리하지 않았습니다.',
  rejected: 'Auth 가 계정 생성을 거부했습니다 (비밀번호 정책·이메일 확인).',
  not_found: '대상을 찾을 수 없습니다.',
};
