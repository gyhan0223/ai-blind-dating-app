import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import React from 'react';
import { requireAdmin } from '@/lib/adminAuth';
import {
  ADMIN_ERROR_LABEL,
  type AdminFaceAction,
  callAdminFaceReview,
  loadFaceReviewQueue,
  REASON_LABEL,
  shortId,
} from '@/lib/faceReview';
import { adminClient } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

/**
 * 얼굴 인증 검토 — in_review(중복 얼굴 의심 · 참조 이미지 미확보 등) 해소 경로.
 *
 * - 승인 조건은 서버(admin-face-review)가 강제한다: Didit 라이브니스 Approved · liveness_passed · reference_path.
 *   조건이 없으면 관리자도 승인할 수 없다.
 * - 중복으로 매칭된 상대 사용자 정보·얼굴 이미지는 조회/표시하지 않는다. 세션 id 는 앞 8자만 보여준다.
 * - 처리자(로그인한 운영자 이름, #27)·시각·결과는 face_verification_reviews 와 admin_audit_log 에 기록된다.
 */


async function runAction(formData: FormData) {
  'use server';
  const { requireAdmin: guard } = await import('@/lib/adminAuth');
  const { recordAdminAudit } = await import('@/lib/audit');
  const session = await guard();
  const action = String(formData.get('action') ?? '');
  const rowId = String(formData.get('rowId') ?? '');
  const note = String(formData.get('note') ?? '').trim().slice(0, 500);
  if (!['approve', 'reject', 'repair'].includes(action) || !rowId) redirect('/face-reviews?error=invalid');
  const res = await callAdminFaceReview({ action: action as AdminFaceAction, rowId, actor: session.actor, note: note || null });
  await recordAdminAudit(session.actor, 'face_review', 'face_verification', rowId, { action, ok: res.ok, result: res.ok ? res.status : res.error });
  revalidatePath('/face-reviews');
  redirect(res.ok ? `/face-reviews?done=${encodeURIComponent(res.status)}` : `/face-reviews?error=${encodeURIComponent(res.error)}`);
}

export default async function FaceReviewsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; done?: string }>;
}) {
  await requireAdmin();
  const params = await searchParams;
  const db = adminClient();
  const { pending, inconsistent, audits, nickname } = await loadFaceReviewQueue(db);

  return (
    <div>
      <h1>얼굴 인증 검토</h1>
      <p className="muted">
        중복 얼굴 의심 등으로 <code>in_review</code> 인 사용자를 승인/거절합니다. 승인은 서버가 Didit 결과를 다시 조회해
        라이브니스 Approved · 참조 이미지 확보를 확인한 뒤에만 반영됩니다. 유사 계정 정보와 얼굴 이미지는 표시하지 않습니다.
      </p>
      {params.error && <p className="error">{ADMIN_ERROR_LABEL[params.error] ?? `처리 실패: ${params.error}`}</p>}
      {params.done && <p className="muted">처리 완료: {params.done}</p>}

      <h2>검토 대기 ({pending.length})</h2>
      {pending.length === 0 && <p className="muted">검토 대기 중인 얼굴 인증이 없습니다.</p>}
      {pending.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>접수</th><th>사용자</th><th>세션</th><th>사유</th><th>시도</th><th>라이브니스</th><th>참조 이미지</th><th></th>
            </tr>
          </thead>
          <tbody>
            {pending.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.created_at).toLocaleString('ko-KR')}</td>
                <td>
                  {nickname.get(r.user_id) ?? '—'}
                  <div className="muted" style={{ fontSize: 12 }}>{shortId(r.user_id)}</div>
                </td>
                <td><code>{shortId(r.provider_session_id)}</code></td>
                <td>
                  {REASON_LABEL[r.provider_reason ?? ''] ?? r.provider_reason ?? '—'}
                  <div className="muted" style={{ fontSize: 12 }}>{r.provider_status ?? ''}</div>
                </td>
                <td>{r.attempt_count}</td>
                <td>{r.liveness_passed ? '통과' : '미통과'}</td>
                <td>{r.reference_path ? '있음' : '없음'}</td>
                <td>
                  <form action={runAction} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input type="hidden" name="rowId" value={r.id} />
                    <input name="note" placeholder="비고 (선택)" maxLength={500} style={{ width: 140 }} />
                    <button className="primary" type="submit" name="action" value="approve" disabled={!r.liveness_passed}>
                      승인
                    </button>
                    <button className="danger" type="submit" name="action" value="reject">
                      거절
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>복구 필요 ({inconsistent.length})</h2>
      <p className="muted">
        행은 approved 인데 사용자 플래그가 없거나 참조 이미지가 없는 비정상 상태입니다. 앱의 재확인/웹훅 재전송으로도
        자동 복구되며, 여기서 바로 복구를 시도할 수 있습니다.
      </p>
      {inconsistent.length === 0 && <p className="muted">없음</p>}
      {inconsistent.length > 0 && (
        <table>
          <thead>
            <tr><th>사용자</th><th>세션</th><th>face_verified</th><th>참조 이미지</th><th></th></tr>
          </thead>
          <tbody>
            {inconsistent.map((r) => (
              <tr key={r.face_verification_id}>
                <td>
                  {nickname.get(r.user_id) ?? '—'}
                  <div className="muted" style={{ fontSize: 12 }}>{shortId(r.user_id)}</div>
                </td>
                <td><code>{shortId(r.provider_session_id)}</code></td>
                <td>{r.face_verified ? 'true' : 'false'}</td>
                <td>{r.reference_path ? '있음' : '없음'}</td>
                <td>
                  <form action={runAction}>
                    <input type="hidden" name="rowId" value={r.face_verification_id} />
                    <button type="submit" name="action" value="repair">복구</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>최근 처리 기록</h2>
      {audits.length === 0 && <p className="muted">기록 없음</p>}
      {audits.length > 0 && (
        <table>
          <thead>
            <tr><th>시각</th><th>처리자</th><th>사용자</th><th>결과</th><th>비고</th></tr>
          </thead>
          <tbody>
            {audits.map((a) => (
              <tr key={a.id}>
                <td>{new Date(a.created_at).toLocaleString('ko-KR')}</td>
                <td>{a.actor}</td>
                <td>{nickname.get(a.user_id) ?? shortId(a.user_id)}</td>
                <td>
                  <span className={`badge ${a.action === 'reject' ? 'danger' : ''}`}>
                    {a.previous_status} → {a.new_status}
                  </span>
                </td>
                <td>{a.note ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
