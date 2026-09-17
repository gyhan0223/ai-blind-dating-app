import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import React from 'react';
import { requireOwner } from '@/lib/adminAuth';
import { ADMIN_PASSWORD_MIN_LENGTH, type AdminRole } from '@/lib/adminAuthCore';
import { addAdminMember, loadAdminMembers, MEMBER_ERROR_LABEL, resetAdminMfa, revokeAdminSessions, setAdminRole, setAdminStatus } from '@/lib/adminMembers';

export const dynamic = 'force-dynamic';

/**
 * 관리자 관리 (#27) — owner 전용. 역할은 owner / viewer 둘 뿐이며 초대 시스템은 없다.
 * 모든 판정(권한·마지막 owner 보호)은 DB RPC 가 실행자 id(세션)로 한다 — 폼의 어떤 값도 실행자·역할의 근거가 되지 않는다.
 */
async function addMember(formData: FormData) {
  'use server';
  const { requireOwner: guard } = await import('@/lib/adminAuth');
  const session = await guard();
  const password = String(formData.get('password') ?? '');
  if (password !== String(formData.get('password2') ?? '')) redirect('/admins?error=password_mismatch');
  const roleRaw = String(formData.get('role') ?? '');
  const role: AdminRole = roleRaw === 'owner' ? 'owner' : 'viewer';
  const res = await addAdminMember(session, { email: String(formData.get('email') ?? ''), displayName: String(formData.get('display_name') ?? ''), role, password });
  revalidatePath('/admins');
  redirect(res.ok ? '/admins?done=added' : `/admins?error=${encodeURIComponent(res.reason)}`);
}

async function memberAction(formData: FormData) {
  'use server';
  const { requireOwner: guard } = await import('@/lib/adminAuth');
  const session = await guard();
  const target = String(formData.get('user_id') ?? '');
  const op = String(formData.get('op') ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(target)) redirect('/admins?error=not_found');
  let res: { ok: true } | { ok: false; reason: string };
  switch (op) {
    case 'promote': res = await setAdminRole(session, target, 'owner'); break;
    case 'demote': res = await setAdminRole(session, target, 'viewer'); break;
    case 'disable': res = await setAdminStatus(session, target, 'disabled'); break;
    case 'enable': res = await setAdminStatus(session, target, 'active'); break;
    case 'revoke': res = await revokeAdminSessions(session, target); break;
    case 'reset_mfa': res = await resetAdminMfa(session, target); break;
    default: res = { ok: false, reason: 'invalid_op' };
  }
  revalidatePath('/admins');
  redirect(res.ok ? `/admins?done=${op}` : `/admins?error=${encodeURIComponent(res.reason)}`);
}

export default async function AdminsPage({ searchParams }: { searchParams: Promise<{ error?: string; done?: string }> }) {
  const session = await requireOwner();
  const params = await searchParams;
  const members = await loadAdminMembers();
  const activeOwners = members.filter((m) => m.role === 'owner' && m.status === 'active').length;

  return (
    <div>
      <h1>관리자 계정</h1>
      <p className="muted">
        역할은 <strong>owner</strong>(모든 조치) 와 <strong>viewer</strong>(집계·운영 상태 열람) 둘입니다. 관리자는 앱 사용자와 별도의 이메일 계정이며,
        첫 로그인에서 인증 앱(TOTP) 등록이 필수입니다. 마지막 활성 owner 는 강등·비활성화할 수 없습니다. 활성 owner: {activeOwners}명.
      </p>
      {params.error && <p className="error">{MEMBER_ERROR_LABEL[params.error] ?? (params.error === 'password_mismatch' ? '초기 비밀번호가 서로 다릅니다.' : `처리 실패: ${params.error}`)}</p>}
      {params.done && <p className="muted">처리 완료: {params.done}</p>}
      {session.legacy && <p className="error">구 공유 비밀번호 세션입니다. 관리자 계정 관리는 개인 계정으로 로그인한 owner 만 할 수 있습니다 (첫 owner 는 bootstrap 스크립트로).</p>}

      <table>
        <thead>
          <tr><th>이름</th><th>계정 id</th><th>역할</th><th>상태</th><th>MFA</th><th>등록</th><th></th></tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.user_id}>
              <td>{m.display_name}{m.user_id === session.userId && <span className="badge muted" style={{ marginLeft: 6 }}>나</span>}</td>
              <td className="muted" style={{ fontSize: 12 }}><code>{m.user_id.slice(0, 8)}</code></td>
              <td><span className={`badge ${m.role === 'owner' ? '' : 'muted'}`}>{m.role}</span></td>
              <td><span className={`badge ${m.status === 'active' ? '' : 'danger'}`}>{m.status}</span></td>
              <td className="muted" style={{ fontSize: 12 }}>{m.mfa_verified_at ? `완료 (${new Date(m.mfa_verified_at).toLocaleDateString('ko-KR')})` : '미등록'}</td>
              <td className="muted" style={{ fontSize: 12 }}>{new Date(m.created_at).toLocaleDateString('ko-KR')}</td>
              <td>
                {!session.legacy && (
                  <form action={memberAction} style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    <input type="hidden" name="user_id" value={m.user_id} />
                    {m.role === 'viewer' ? <button type="submit" name="op" value="promote">owner 로</button> : <button type="submit" name="op" value="demote">viewer 로</button>}
                    {m.status === 'active' ? <button type="submit" name="op" value="disable" className="danger">비활성화</button> : <button type="submit" name="op" value="enable">활성화</button>}
                    <button type="submit" name="op" value="revoke">세션 취소</button>
                    <button type="submit" name="op" value="reset_mfa" className="danger">MFA 초기화</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {!session.legacy && (
        <>
          <h2>관리자 추가</h2>
          <p className="muted">
            초기 비밀번호({ADMIN_PASSWORD_MIN_LENGTH}자 이상)는 Auth 에만 전달되고 어디에도 저장·기록되지 않습니다. 본인에게 안전한 경로로 전달하고,
            첫 로그인 뒤 <code>/account</code> 에서 바꾸게 하세요.
          </p>
          <form action={addMember} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input type="email" name="email" placeholder="이메일 (관리자 전용)" required style={{ width: 220 }} autoComplete="off" />
            <input type="text" name="display_name" placeholder="표시 이름" required maxLength={40} style={{ width: 140 }} autoComplete="off" />
            <select name="role" defaultValue="viewer" style={{ padding: 6 }}>
              <option value="viewer">viewer</option>
              <option value="owner">owner</option>
            </select>
            <input type="password" name="password" placeholder="초기 비밀번호" required minLength={ADMIN_PASSWORD_MIN_LENGTH} style={{ width: 160 }} autoComplete="new-password" />
            <input type="password" name="password2" placeholder="초기 비밀번호 확인" required minLength={ADMIN_PASSWORD_MIN_LENGTH} style={{ width: 160 }} autoComplete="new-password" />
            <button type="submit" className="primary">추가</button>
          </form>
        </>
      )}
    </div>
  );
}
