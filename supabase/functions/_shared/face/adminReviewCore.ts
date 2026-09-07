/**
 * 관리자 얼굴 인증 검토 핵심 로직 — 순수 모듈 (의존성 주입, Node selftest 겸용).
 *
 * 호출자: admin-face-review Edge Function (service role 전용 — 관리자 웹의 서버 액션만 호출한다).
 * 공개 API 가 아니며 사용자 JWT 로는 호출할 수 없다.
 *
 * POST { action: 'approve', rowId, actor, note? }
 *   서버가 Provider Decision 을 다시 조회해 다음을 모두 만족할 때만 승인 RPC(face_liveness_admin_review → face_liveness_approve)
 *     - Decision 의 liveness_checks[0].status == Approved      (Provider 가 판정을 바꿨으면 승인 불가)
 *     - 행의 liveness_passed = true                             (서버가 이전에 기록한 값)
 *     - reference_path 존재 (없으면 이 자리에서 다운로드·저장을 시도하고, 그래도 없으면 승인 불가)
 *   → 200 { ok: true, status: 'approved', faceVerified: true }
 *   → 409 { error: 'liveness_not_approved' | 'liveness_not_passed' | 'reference_image_unavailable' | 'invalid_state' | <rpc reason> }
 *   → 503 { error: 'decision_unavailable' }
 * POST { action: 'reject', rowId, actor, note? }
 *   → 200 { ok: true, status: 'rejected', faceVerified: false }   (users.face_verified 는 false 유지)
 * POST { action: 'repair', rowId, actor }
 *   approved 인데 users.face_verified=false / reference_path 없음 인 행을 같은 승인 경로로 복구
 *
 * 중복 매칭된 상대 사용자 정보·얼굴 이미지는 어디에도 돌려주지 않는다. 감사 기록(처리자·시각·결과)은 RPC 가 남긴다.
 */
import { shortId } from './faceCore.ts';
import type { FaceDb, FaceLogger } from './faceDb.ts';
import { ensureReferenceImage, repairApprovedRow } from './faceOutcome.ts';
import type { FaceLivenessProvider } from './FaceLivenessProvider.ts';
import type { HandlerResponse } from './startFaceLivenessCore.ts';

export type AdminReviewDeps = {
  provider: FaceLivenessProvider;
  db: FaceDb;
  now: () => Date;
  log: FaceLogger;
};

export const ADMIN_ACTOR_MAX_LENGTH = 64;
export const ADMIN_NOTE_MAX_LENGTH = 500;

function bodyRecord(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t === '' || t.length > max) return null;
  return t;
}

export async function handleAdminFaceReview(req: { body: unknown }, deps: AdminReviewDeps): Promise<HandlerResponse> {
  const { db, provider, log } = deps;
  const body = bodyRecord(req.body);

  const action = typeof body.action === 'string' ? body.action : '';
  if (action !== 'approve' && action !== 'reject' && action !== 'repair') {
    return { status: 400, body: { error: 'unknown_action' } };
  }
  const rowId = cleanText(body.rowId, 64);
  const actor = cleanText(body.actor, ADMIN_ACTOR_MAX_LENGTH);
  if (!rowId || !actor) return { status: 400, body: { error: 'invalid_body' } };
  const note = body.note === undefined || body.note === null ? null : cleanText(body.note, ADMIN_NOTE_MAX_LENGTH);
  if (body.note !== undefined && body.note !== null && body.note !== '' && note === null) {
    return { status: 400, body: { error: 'invalid_body' } };
  }

  const row = await db.getRowById(rowId);
  if (!row) return { status: 404, body: { error: 'not_found' } };
  if (!row.providerSessionId) return { status: 409, body: { error: 'no_provider_session', status: row.status } };

  if (action === 'reject') {
    if (row.status !== 'in_review' && row.status !== 'pending') {
      return { status: 409, body: { error: 'invalid_state', status: row.status } };
    }
    const res = await db.adminReview({ rowId: row.id, action: 'reject', actor, note });
    if (!res.ok) return { status: 409, body: { error: res.reason, status: row.status } };
    log.info(`[face-admin] session ${shortId(row.providerSessionId)} rejected by admin`);
    return { status: 200, body: { ok: true, status: 'rejected', faceVerified: false } };
  }

  if (action === 'repair') {
    if (row.status !== 'approved') return { status: 409, body: { error: 'invalid_state', status: row.status } };
    const repaired = await repairApprovedRow({ row, db, provider, log, now: deps.now });
    if (repaired.providerUnavailable) return { status: 503, body: { error: 'decision_unavailable' } };
    return { status: 200, body: { ok: true, status: 'approved', faceVerified: repaired.faceVerified } };
  }

  // approve
  if (row.status !== 'in_review') return { status: 409, body: { error: 'invalid_state', status: row.status } };

  const decision = await provider.getDecision(row.providerSessionId, { userId: row.userId });
  if (!decision.ok) {
    log.warn(`[face-admin] session ${shortId(row.providerSessionId)} decision unavailable (${decision.reason})`);
    return { status: 503, body: { error: 'decision_unavailable' } };
  }
  if (!decision.decision.livenessPassed) return { status: 409, body: { error: 'liveness_not_approved', status: row.status } };
  if (!row.livenessPassed) return { status: 409, body: { error: 'liveness_not_passed', status: row.status } };

  const ref = await ensureReferenceImage({ row, decision: decision.decision, db, provider, log });
  if (!ref.ok) return { status: 409, body: { error: 'reference_image_unavailable', status: row.status } };

  const res = await db.adminReview({
    rowId: row.id,
    action: 'approve',
    actor,
    note,
    referencePath: ref.path,
    livenessScore: decision.decision.livenessScore,
    livenessMethod: decision.decision.livenessMethod,
    providerStatus: decision.decision.providerStatus,
  });
  if (!res.ok) return { status: 409, body: { error: res.reason, status: row.status } };
  log.info(`[face-admin] session ${shortId(row.providerSessionId)} approved by admin`);
  return { status: 200, body: { ok: true, status: 'approved', faceVerified: res.faceVerified } };
}
