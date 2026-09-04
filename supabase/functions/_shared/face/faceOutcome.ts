/**
 * Provider Decision → DB 반영 (start-face-liveness 의 sync 와 didit-webhook 이 공유하는 유일한 승인 경로).
 *
 *   1) 서버가 Provider 에서 직접 Decision 을 조회한다 (웹훅/클라이언트가 전달한 status 는 힌트일 뿐)
 *   2) faceCore.resolveOutcome 으로 보수적 도메인 판정 (중복 얼굴 의심 → in_review 등)
 *   3) decideTransition 으로 stale/terminal 이벤트를 걸러낸다 (DB 트리거가 최종 방어)
 *   4) approved 이면: reference image 를 서버에서 다운로드해 private storage 에 저장 → users.face_verified=true
 *
 * 로그에는 세션 id 축약값과 고정 코드만 남긴다 (URL·토큰·점수 외 개인정보 없음).
 */
import {
  decideTransition,
  type FaceVerificationStatus,
  type LivenessDecision,
  resolveOutcome,
  shortId,
} from './faceCore.ts';
import type { FaceDb, FaceLogger, FaceRow } from './faceDb.ts';
import type { FaceLivenessProvider } from './FaceLivenessProvider.ts';

export type ApplyDecisionResult =
  | { applied: true; status: FaceVerificationStatus; faceVerified: boolean }
  | { applied: false; reason: 'duplicate' | 'stale' | 'terminal' | 'db_rejected'; status: FaceVerificationStatus };

export async function applyDecisionToRow(input: {
  row: FaceRow;
  decision: LivenessDecision;
  eventAt: Date | null;
  db: FaceDb;
  provider: FaceLivenessProvider;
  log: FaceLogger;
}): Promise<ApplyDecisionResult> {
  const { row, decision, db, provider, log } = input;
  const outcome = resolveOutcome(decision);

  const verdict = decideTransition(
    { status: row.status, providerEventAt: row.providerEventAt, providerStatus: row.providerStatus },
    { status: outcome.status, eventAt: input.eventAt, providerStatus: decision.providerStatus },
  );
  if (verdict !== 'apply') {
    log.info(`[face] session ${shortId(row.providerSessionId)} event ignored (${verdict})`);
    return { applied: false, reason: verdict, status: row.status };
  }

  const patch = {
    status: outcome.status,
    providerStatus: decision.providerStatus,
    providerEventAt: input.eventAt ?? new Date(),
    // liveness_passed 는 true 로만 올라간다 (DB 트리거가 false 로 되돌리는 것을 막는다)
    livenessPassed: row.livenessPassed || outcome.livenessPassed,
    livenessScore: decision.livenessScore,
    livenessMethod: decision.livenessMethod,
    providerReason: outcome.reason,
  };

  // approved 는 reference image 를 먼저 확보한 뒤 한 번의 갱신으로 반영한다
  let referencePath: string | null = row.referencePath;
  if (outcome.status === 'approved' && !referencePath && decision.referenceImageUrl) {
    const img = await provider.fetchReferenceImage(decision.referenceImageUrl);
    if (img.ok) {
      const stored = await db.storeReferenceImage(row.userId, img.bytes, img.contentType);
      if (stored.ok) referencePath = stored.path;
      else log.warn(`[face] session ${shortId(row.providerSessionId)} reference image store failed`);
    } else {
      log.warn(`[face] session ${shortId(row.providerSessionId)} reference image fetch failed (${img.reason})`);
    }
  }

  const updated = await db.updateRow(row.id, {
    ...patch,
    ...(referencePath ? { referencePath } : {}),
    ...(outcome.status === 'approved' && !referencePath ? { providerReason: 'reference_image_unavailable' as const } : {}),
  });
  if (!updated.ok) {
    log.warn(`[face] session ${shortId(row.providerSessionId)} update rejected: ${updated.error}`);
    return { applied: false, reason: 'db_rejected', status: row.status };
  }

  let faceVerified = false;
  if (outcome.status === 'approved') {
    const res = await db.setUserFaceVerified(row.userId);
    faceVerified = res.ok;
    if (!res.ok) log.error(`[face] session ${shortId(row.providerSessionId)} users.face_verified update failed`);
  }

  log.info(`[face] session ${shortId(row.providerSessionId)} → ${outcome.status} (${outcome.reason})`);
  return { applied: true, status: outcome.status, faceVerified };
}
