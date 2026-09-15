import { revalidatePath } from 'next/cache';
import React from 'react';
import { requireAdmin } from '@/lib/adminAuth';
import { recordAdminAudit } from '@/lib/audit';
import { loadUserSummaries, type ModerationAction, moderateUser, REASON_LABEL, STATUS_LABEL } from '@/lib/moderation';
import { adminClient } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

/**
 * 신고 처리 (#15) — 긴급 우선 정렬, 피신고자 반복 패턴, 조치는 RPC(감사 기록)로만.
 * 사유별 기본 조치 기준: docs/moderation-policy.md 2절.
 */
async function setReviewing(formData: FormData) {
  'use server';
  const { requireAdmin: guard } = await import('@/lib/adminAuth');
  const session = await guard();
  const id = String(formData.get('id'));
  const db = adminClient();
  await db.from('reports').update({ status: 'reviewing' }).eq('id', id).eq('status', 'pending');
  await recordAdminAudit(session.actor, 'report_reviewing', 'report', id, {});
  revalidatePath('/reports');
}

async function act(formData: FormData) {
  'use server';
  const { requireAdmin: guard } = await import('@/lib/adminAuth');
  const session = await guard();
  const id = String(formData.get('id'));
  const action = String(formData.get('action')) as ModerationAction;
  const days = formData.get('days') ? Number(formData.get('days')) : null;
  const reason = String(formData.get('reason') ?? '').trim() || null;
  if (!['warn', 'suspend', 'ban', 'dismiss'].includes(action)) return;
  const db = adminClient();
  const { data: report } = await db.from('reports').select('id, reported_id, status').eq('id', id).maybeSingle();
  if (!report || report.status === 'actioned' || report.status === 'dismissed') return;
  const res = await moderateUser(db, { userId: report.reported_id, action, reason, reportId: id, actor: session.actor, days });
  await recordAdminAudit(session.actor, 'report_action', 'report', id, { action, days, ok: res.ok });
  revalidatePath('/reports');
  revalidatePath('/users');
}

export default async function ReportsPage() {
  await requireAdmin();
  const db = adminClient();
  const { data: reports } = await db
    .from('reports')
    .select('id, reporter_id, reported_id, reason, detail, status, severity, action_taken, admin_note, created_at, handled_at')
    .order('created_at', { ascending: false })
    .limit(300);
  const rows = reports ?? [];
  // 긴급 + 미처리 먼저
  rows.sort((a, b) => {
    const openA = a.status === 'pending' || a.status === 'reviewing';
    const openB = b.status === 'pending' || b.status === 'reviewing';
    if (openA !== openB) return openA ? -1 : 1;
    if (openA && a.severity !== b.severity) return a.severity === 'urgent' ? -1 : 1;
    return 0;
  });

  const userIds = Array.from(new Set(rows.flatMap((r) => [r.reporter_id, r.reported_id])));
  const [{ data: profiles }, summaries] = await Promise.all([
    db.from('profiles').select('user_id, nickname').in('user_id', userIds.length > 0 ? userIds : ['00000000-0000-0000-0000-000000000000']),
    loadUserSummaries(db, userIds),
  ]);
  const nickname = new Map((profiles ?? []).map((p) => [p.user_id, p.nickname]));
  const openCount = rows.filter((r) => r.status === 'pending' || r.status === 'reviewing').length;
  const urgentCount = rows.filter((r) => (r.status === 'pending' || r.status === 'reviewing') && r.severity === 'urgent').length;

  return (
    <div>
      <h1>신고</h1>
      <p className="muted">
        미처리 {openCount}건 (긴급 {urgentCount}건). 조치 기준: docs/moderation-policy.md. 모든 조치는 감사 기록으로 남습니다.
      </p>
      {rows.length === 0 && <p className="muted">접수된 신고가 없습니다.</p>}
      <table>
        <thead>
          <tr><th>일시</th><th>신고자</th><th>대상</th><th>사유</th><th>내용</th><th>상태</th><th>조치</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const target = summaries.get(r.reported_id);
            const reporter = summaries.get(r.reporter_id);
            const open = r.status === 'pending' || r.status === 'reviewing';
            return (
              <tr key={r.id}>
                <td>
                  {new Date(r.created_at).toLocaleString('ko-KR')}
                  {r.severity === 'urgent' && <div><span className="badge danger">긴급</span></div>}
                </td>
                <td>
                  {nickname.get(r.reporter_id) ?? r.reporter_id.slice(0, 8)}
                  {reporter && reporter.reporter_30d >= 5 && <div className="muted" style={{ fontSize: 12 }}>30일 신고 {reporter.reporter_30d}회</div>}
                </td>
                <td>
                  {nickname.get(r.reported_id) ?? r.reported_id.slice(0, 8)}
                  {target && (
                    <div className="muted" style={{ fontSize: 12 }}>
                      {target.status !== 'active' && <span className="badge danger" style={{ marginRight: 4 }}>{target.status}</span>}
                      피신고 {target.reported_30d}회/30일 · 제재 {target.sanctions}회 · 신호 {target.signals_30d}건
                    </div>
                  )}
                </td>
                <td>{REASON_LABEL[r.reason] ?? r.reason}</td>
                <td style={{ maxWidth: 240 }}>
                  {r.detail ?? '—'}
                  {r.admin_note && <div className="muted" style={{ fontSize: 12 }}>메모: {r.admin_note}</div>}
                </td>
                <td>
                  <span className={`badge ${open ? (r.severity === 'urgent' ? 'danger' : '') : 'muted'}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
                  {r.action_taken && r.action_taken !== 'none' && <div className="muted" style={{ fontSize: 12 }}>{r.action_taken}</div>}
                </td>
                <td>
                  {open && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 220 }}>
                      {r.status === 'pending' && (
                        <form action={setReviewing}>
                          <input type="hidden" name="id" value={r.id} />
                          <button type="submit">확인 중</button>
                        </form>
                      )}
                      <form action={act} style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        <input type="hidden" name="id" value={r.id} />
                        <input name="reason" placeholder="처리 메모" style={{ flex: '1 1 100%', fontSize: 12, padding: 4 }} />
                        <button type="submit" name="action" value="warn">경고</button>
                        <button type="submit" name="action" value="suspend" className="danger" formNoValidate>
                          <input type="hidden" name="days" value="7" />7일 정지
                        </button>
                        <button type="submit" name="action" value="ban" className="danger">영구 차단</button>
                        <button type="submit" name="action" value="dismiss">기각</button>
                      </form>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
