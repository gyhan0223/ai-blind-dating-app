/**
 * Provider Decision → DB 반영 (start-face-liveness 의 sync · didit-webhook · 관리자 검토가 공유하는 유일한 승인 경로).
 *
 *   1) 서버가 Provider 에서 직접 Decision 을 조회한다 (웹훅/클라이언트가 전달한 status 는 힌트일 뿐)
 *   2) faceCore.resolveOutcome 으로 보수적 도메인 판정 (중복 얼굴 의심 → in_review 등)
 *   3) decideTransition 으로 stale/terminal 이벤트를 걸러낸다 (DB 트리거가 최종 방어)
 *   4) approved 이면: reference image 를 서버에서 다운로드해 private storage 에 저장한 뒤
 *      DB RPC(face_liveness_approve) 하나로 face_verifications.approved + verified_at + users.face_verified=true 를
 *      한 트랜잭션에 반영한다. reference image 를 확보하지 못하면 승인하지 않고 in_review(reference_image_unavailable).
 *   5) 이미 approved 인데 users.face_verified=false / reference_path 없음 같은 비정상 상태는 repairApprovedRow 가
 *      같은 경로로 복구한다 (RPC 는 멱등).
 *
 * 로그에는 세션 id 축약값과 고정 코드만 남긴다 (URL·토큰·점수 외 개인정보 없음).
 */
import {
  decideTransition,
  type FaceReasonCode,
  type FaceVerificationStatus,
  type LivenessDecision,
  resolveOutcome,
  shortId,
} from './faceCore.ts';
import type { FaceDb, FaceLogger, FaceRow } from './faceDb.ts';
import type { FaceLivenessProvider } from './FaceLivenessProvider.ts';

export type ApplyDecisionResult =
  | { applied: true; status: FaceVerificationStatus; faceVerified: boolean; reason: FaceReasonCode | null }
  | {
      applied: false;
      reason: 'duplicate' | 'stale' | 'terminal' | 'db_rejected' | 'already_verified' | 'precondition_failed' | 'superseded';
      status: FaceVerificationStatus;
      faceVerified: boolean;
    };

type Ctx = {
  row: FaceRow;
  decision: LivenessDecision;
  eventAt: Date | null;
  db: FaceDb;
  provider: FaceLivenessProvider;
  log: FaceLogger;
};

export type ReferenceImageResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'missing_url' | 'insecure_url' | 'http_error' | 'bad_type' | 'too_large' | 'network_error' | 'timeout' | 'store_failed' };

/**
 * reference image 확보 — 이미 저장된 경로가 있으면 재사용, 없으면 서명 URL 에서 다운로드해 같은 경로에 upsert 한다.
 * (storage 저장 뒤 RPC 가 실패해도 다음 시도가 같은 경로에 다시 저장하므로 안전하다)
 */
export async function ensureReferenceImage(input: {
  row: FaceRow;
  decision: LivenessDecision;
  db: FaceDb;
  provider: FaceLivenessProvider;
  log: FaceLogger;
}): Promise<ReferenceImageResult> {
  const { row, decision, db, provider, log } = input;
  if (row.referencePath) return { ok: true, path: row.referencePath };
  if (!decision.referenceImageUrl) return { ok: false, reason: 'missing_url' };

  const img = await provider.fetchReferenceImage(decision.referenceImageUrl);
  if (!img.ok) {
    log.warn(`[face] session ${shortId(row.providerSessionId)} reference image fetch failed (${img.reason})`);
    return { ok: false, reason: img.reason };
  }
  const stored = await db.storeReferenceImage(row.userId, row.id, img.bytes, img.contentType);
  if (!stored.ok) {
    log.warn(`[face] session ${shortId(row.providerSessionId)} reference image store failed`);
    return { ok: false, reason: 'store_failed' };
  }
  return { ok: true, path: stored.path };
}

/** 승인 확정 — reference image 확보 → RPC 한 번으로 행 + users.face_verified 반영 */
async function finalizeApproval(ctx: Ctx, reason: FaceReasonCode): Promise<ApplyDecisionResult> {
  const { row, decision, db, log } = ctx;
  const eventAt = ctx.eventAt ?? new Date();

  if (!decision.livenessPassed || !row.providerSessionId) {
    // 승인 조건이 더 이상 성립하지 않는다 (Provider 가 판정을 바꿨거나 세션이 없는 행) — 절대 승인하지 않는다
    log.error(`[face] session ${shortId(row.providerSessionId)} approval precondition failed`);
    return { applied: false, reason: 'precondition_failed', status: row.status, faceVerified: false };
  }

  const ref = await ensureReferenceImage(ctx);
  if (!ref.ok) {
    if (row.status === 'approved') {
      // 이미 approved 인 행은 되돌릴 수 없다 — 사용자 플래그는 그대로 두고(false) 다음 sync/웹훅/관리자 복구에서 재시도
      log.error(`[face] session ${shortId(row.providerSessionId)} approved row without reference image (${ref.reason})`);
      return { applied: false, reason: 'precondition_failed', status: 'approved', faceVerified: false };
    }
    // Provider 가 Approved 여도 reference image 없이는 최종 승인하지 않는다 → in_review (재처리 가능)
    const marked = await db.updateRow(row.id, {
      status: 'in_review',
      providerStatus: decision.providerStatus,
      providerEventAt: eventAt,
      livenessPassed: true,
      livenessScore: decision.livenessScore,
      livenessMethod: decision.livenessMethod,
      providerReason: 'reference_image_unavailable',
    });
    if (!marked.ok) {
      log.warn(`[face] session ${shortId(row.providerSessionId)} update rejected: ${marked.error}`);
      return { applied: false, reason: 'db_rejected', status: row.status, faceVerified: false };
    }
    log.info(`[face] session ${shortId(row.providerSessionId)} → in_review (reference_image_unavailable:${ref.reason})`);
    return { applied: true, status: 'in_review', faceVerified: false, reason: 'reference_image_unavailable' };
  }

  const approved = await db.approveVerification({
    rowId: row.id,
    userId: row.userId,
    providerSessionId: row.providerSessionId,
    referencePath: ref.path,
    livenessPassed: true,
    livenessScore: decision.livenessScore,
    livenessMethod: decision.livenessMethod,
    providerStatus: decision.providerStatus,
    providerEventAt: eventAt,
    reason,
  });
  if (!approved.ok) {
    if (approved.reason === 'superseded') {
      // #11: 다른 세션이 먼저 승인됐다 — RPC 가 이 행을 expired/superseded 로 마감했고(정리 큐 등록), 방금 저장한 이미지는 세션별 경로라 현재 인증을 건드리지 않는다
      log.info(`[face] session ${shortId(row.providerSessionId)} superseded by a newer approved session`);
      return { applied: false, reason: 'superseded', status: 'expired', faceVerified: await db.isUserFaceVerified(row.userId) };
    }
    // 행/사용자 갱신은 RPC 안에서 함께 롤백된다 — 다음 sync/웹훅이 같은 경로로 재시도한다
    log.error(`[face] session ${shortId(row.providerSessionId)} approve rpc rejected (${approved.reason})`);
    return { applied: false, reason: 'db_rejected', status: row.status, faceVerified: false };
  }
  log.info(`[face] session ${shortId(row.providerSessionId)} → approved (${reason}${approved.changed ? '' : ', no-op'})`);
  return { applied: true, status: 'approved', faceVerified: true, reason };
}

export async function applyDecisionToRow(input: Ctx): Promise<ApplyDecisionResult> {
  const { row, decision, db, log } = input;

  if (row.status === 'approved') {
    // 승인은 sticky. 사용자 플래그까지 반영됐으면 할 일 없음, 아니면 부분 실패 복구 (멱등 RPC)
    if (await db.isUserFaceVerified(row.userId)) {
      return { applied: false, reason: 'already_verified', status: 'approved', faceVerified: true };
    }
    return finalizeApproval(input, 'liveness_approved');
  }

  // #11: 이 사용자가 이미 다른 세션으로 인증됐다면 이 세션은 대체된 것이다 — 이미지를 내려받지 않고 종료 처리한다 (정리 큐는 DB 트리거)
  if (row.status !== 'rejected' && (await db.isUserFaceVerified(row.userId))) {
    const closed = await db.updateRow(row.id, {
      status: 'expired',
      providerStatus: decision.providerStatus,
      providerEventAt: input.eventAt ?? new Date(),
      providerReason: 'superseded',
    });
    if (!closed.ok) log.warn(`[face] session ${shortId(row.providerSessionId)} superseded close rejected: ${closed.error}`);
    log.info(`[face] session ${shortId(row.providerSessionId)} ignored (superseded — user already verified)`);
    return { applied: false, reason: 'superseded', status: closed.ok ? 'expired' : row.status, faceVerified: true };
  }

  const outcome = resolveOutcome(decision);
  const verdict = decideTransition(
    { status: row.status, providerEventAt: row.providerEventAt, providerStatus: row.providerStatus },
    { status: outcome.status, eventAt: input.eventAt, providerStatus: decision.providerStatus },
  );
  if (verdict !== 'apply') {
    log.info(`[face] session ${shortId(row.providerSessionId)} event ignored (${verdict})`);
    return { applied: false, reason: verdict, status: row.status, faceVerified: false };
  }

  if (outcome.status === 'approved') return finalizeApproval(input, outcome.reason ?? 'liveness_approved');

  const updated = await db.updateRow(row.id, {
    status: outcome.status,
    providerStatus: decision.providerStatus,
    providerEventAt: input.eventAt ?? new Date(),
    // liveness_passed 는 true 로만 올라간다 (DB 트리거가 false 로 되돌리는 것을 막는다)
    livenessPassed: row.livenessPassed || outcome.livenessPassed,
    livenessScore: decision.livenessScore,
    livenessMethod: decision.livenessMethod,
    providerReason: outcome.reason,
  });
  if (!updated.ok) {
    log.warn(`[face] session ${shortId(row.providerSessionId)} update rejected: ${updated.error}`);
    return { applied: false, reason: 'db_rejected', status: row.status, faceVerified: false };
  }
  log.info(`[face] session ${shortId(row.providerSessionId)} → ${outcome.status} (${outcome.reason ?? '-'})`);
  return { applied: true, status: outcome.status, faceVerified: false, reason: outcome.reason };
}

export type RepairResult = { status: 'approved'; faceVerified: boolean; providerUnavailable: boolean };

/**
 * 비정상 approved 행 복구 — 행은 approved 인데 users.face_verified=false 이거나 reference_path 가 없는 경우.
 *   - reference_path 와 liveness_passed 가 있으면 Provider 호출 없이 RPC 만 다시 실행한다 (멱등)
 *   - reference_path 가 없으면 Decision 을 다시 조회해(새 서명 URL) 이미지 저장 후 RPC
 */
export async function repairApprovedRow(input: {
  row: FaceRow;
  db: FaceDb;
  provider: FaceLivenessProvider;
  log: FaceLogger;
  now: () => Date;
}): Promise<RepairResult> {
  const { row, db, provider, log } = input;
  if (await db.isUserFaceVerified(row.userId)) return { status: 'approved', faceVerified: true, providerUnavailable: false };

  if (row.referencePath && row.livenessPassed && row.providerSessionId) {
    const res = await db.approveVerification({
      rowId: row.id,
      userId: row.userId,
      providerSessionId: row.providerSessionId,
      referencePath: row.referencePath,
      livenessPassed: true,
      livenessScore: row.livenessScore,
      livenessMethod: row.livenessMethod,
      providerStatus: row.providerStatus,
      providerEventAt: row.providerEventAt ?? input.now(),
      reason: 'liveness_approved',
    });
    if (!res.ok) log.error(`[face] session ${shortId(row.providerSessionId)} repair rpc rejected (${res.reason})`);
    else log.info(`[face] session ${shortId(row.providerSessionId)} repaired users.face_verified`);
    return { status: 'approved', faceVerified: res.ok, providerUnavailable: false };
  }

  if (!row.providerSessionId) return { status: 'approved', faceVerified: false, providerUnavailable: false };
  const decision = await provider.getDecision(row.providerSessionId, { userId: row.userId });
  if (!decision.ok) {
    log.warn(`[face] session ${shortId(row.providerSessionId)} repair decision unavailable (${decision.reason})`);
    return { status: 'approved', faceVerified: false, providerUnavailable: true };
  }
  const applied = await applyDecisionToRow({ row, decision: decision.decision, eventAt: input.now(), db, provider, log });
  return { status: 'approved', faceVerified: applied.faceVerified, providerUnavailable: false };
}
