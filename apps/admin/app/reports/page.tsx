import { revalidatePath } from 'next/cache';
import React from 'react';
import { requireAdmin } from '@/lib/adminAuth';
import { adminClient } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

const REASON_LABEL: Record<string, string> = {
  unpleasant_conversation: '불쾌한 대화',
  sexual_remarks: '성적인 발언',
  threat: '위협',
  impersonation: '사칭',
  spam: '스팸',
  other: '기타',
};

async function setReportStatus(formData: FormData) {
  'use server';
  const { requireAdmin: guard } = await import('@/lib/adminAuth');
  await guard();
  const id = String(formData.get('id'));
  const status = String(formData.get('status'));
  if (!['pending', 'reviewing', 'resolved'].includes(status)) return;
  const db = adminClient();
  await db.from('reports').update({ status }).eq('id', id);
  revalidatePath('/reports');
}

export default async function ReportsPage() {
  await requireAdmin();
  const db = adminClient();
  const { data: reports } = await db
    .from('reports')
    .select('id, reporter_id, reported_id, reason, detail, status, created_at')
    .order('created_at', { ascending: false })
    .limit(200);

  const userIds = Array.from(
    new Set((reports ?? []).flatMap((r) => [r.reporter_id, r.reported_id])),
  );
  const { data: profiles } = await db
    .from('profiles')
    .select('user_id, nickname')
    .in('user_id', userIds.length > 0 ? userIds : ['00000000-0000-0000-0000-000000000000']);
  const nickname = new Map((profiles ?? []).map((p) => [p.user_id, p.nickname]));

  return (
    <div>
      <h1>신고</h1>
      {(reports ?? []).length === 0 && <p className="muted">접수된 신고가 없습니다.</p>}
      <table>
        <thead>
          <tr><th>일시</th><th>신고자</th><th>대상</th><th>사유</th><th>내용</th><th>상태</th><th></th></tr>
        </thead>
        <tbody>
          {(reports ?? []).map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.created_at).toLocaleString('ko-KR')}</td>
              <td>{nickname.get(r.reporter_id) ?? r.reporter_id.slice(0, 8)}</td>
              <td>{nickname.get(r.reported_id) ?? r.reported_id.slice(0, 8)}</td>
              <td>{REASON_LABEL[r.reason] ?? r.reason}</td>
              <td style={{ maxWidth: 240 }}>{r.detail ?? '—'}</td>
              <td>
                <span className={`badge ${r.status === 'pending' ? 'danger' : r.status === 'resolved' ? '' : 'muted'}`}>
                  {r.status}
                </span>
              </td>
              <td>
                <div style={{ display: 'flex', gap: 6 }}>
                  {r.status !== 'reviewing' && (
                    <form action={setReportStatus}>
                      <input type="hidden" name="id" value={r.id} />
                      <input type="hidden" name="status" value="reviewing" />
                      <button type="submit">확인 중</button>
                    </form>
                  )}
                  {r.status !== 'resolved' && (
                    <form action={setReportStatus}>
                      <input type="hidden" name="id" value={r.id} />
                      <input type="hidden" name="status" value="resolved" />
                      <button className="primary" type="submit">처리 완료</button>
                    </form>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
