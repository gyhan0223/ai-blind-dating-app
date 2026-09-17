import React from 'react';
import { requireAdmin } from '@/lib/adminAuth';
import { actorLabel, AUDIT_ACTION_LABEL, type AuditRow, loadAdminNames } from '@/lib/audit';
import { adminClient } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

type ModerationRow = { id: string; user_id: string; action: string; reason: string | null; actor: string; created_at: string; expires_at: string | null };

/** 관리자 감사 로그 (#27) — 누가 언제 무엇을 했는지. 개인정보 없이 id·결과만 */
export default async function AuditPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireAdmin();
  const params = await searchParams;
  const q = (params.q ?? '').trim();
  const db = adminClient();
  let query = db.from('admin_audit_log').select('*').order('created_at', { ascending: false }).limit(300);
  if (q) query = query.or(`actor.ilike.%${q.replace(/[%,]/g, '')}%,action.ilike.%${q.replace(/[%,]/g, '')}%,target_id.ilike.%${q.replace(/[%,]/g, '')}%`);
  const [{ data: rows }, { data: moderation }, names] = await Promise.all([
    query,
    db.from('moderation_actions').select('id, user_id, action, reason, actor, created_at, expires_at').order('created_at', { ascending: false }).limit(100),
    loadAdminNames(),
  ]);
  const audit = (rows ?? []) as AuditRow[];
  const mod = (moderation ?? []) as ModerationRow[];

  return (
    <div>
      <h1>감사 로그</h1>
      <p className="muted">
        관리자 웹의 모든 변경 조치와 로그인 이력입니다. 처리자는 인증된 관리자 계정 id(불변)로 기록되고 이름은 보조 표시입니다. 대상은 id 만 (연락처·원문 없음). 예전 공유 로그인 기록은 입력했던 이름 그대로 남아 있습니다.
      </p>
      <form method="get" style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input type="text" name="q" placeholder="처리자 · 조치 · 대상 id" defaultValue={q} />
        <button type="submit">검색</button>
      </form>

      <h2>관리자 조치 ({audit.length})</h2>
      {audit.length === 0 && <p className="muted">기록이 없습니다.</p>}
      {audit.length > 0 && (
        <table>
          <thead>
            <tr><th>일시</th><th>처리자</th><th>조치</th><th>대상</th><th>내용</th></tr>
          </thead>
          <tbody>
            {audit.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.created_at).toLocaleString('ko-KR')}</td>
                <td>{actorLabel(r.actor, names)}</td>
                <td>
                  <span className={`badge ${r.action.includes('failed') || r.action.includes('locked') ? 'danger' : ''}`}>
                    {AUDIT_ACTION_LABEL[r.action] ?? r.action}
                  </span>
                </td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {r.target_type ?? '—'} {r.target_id ? r.target_id.slice(0, 8) : ''}
                </td>
                <td className="muted" style={{ fontSize: 12, maxWidth: 320, wordBreak: 'break-all' }}>
                  {Object.keys(r.detail ?? {}).length > 0 ? JSON.stringify(r.detail) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>제재 이력 (moderation_actions, 최근 100)</h2>
      {mod.length === 0 && <p className="muted">기록이 없습니다.</p>}
      {mod.length > 0 && (
        <table>
          <thead>
            <tr><th>일시</th><th>처리자</th><th>조치</th><th>대상 사용자</th><th>사유</th><th>만료</th></tr>
          </thead>
          <tbody>
            {mod.map((m) => (
              <tr key={m.id}>
                <td>{new Date(m.created_at).toLocaleString('ko-KR')}</td>
                <td>{actorLabel(m.actor, names)}</td>
                <td><span className="badge">{m.action}</span></td>
                <td className="muted" style={{ fontSize: 12 }}>{m.user_id.slice(0, 8)}</td>
                <td style={{ maxWidth: 260 }}>{m.reason ?? '—'}</td>
                <td>{m.expires_at ? new Date(m.expires_at).toLocaleDateString('ko-KR') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
