/**
 * start-face-liveness 핵심 로직 — 순수 모듈 (의존성 주입, Node selftest 겸용).
 *
 * POST { action?: 'start' }
 *   → 200 { ok: true, sessionId, sessionToken, expiresAt, attemptCount }
 *   → 409 { error: 'already_verified' }
 *   → 409 { error: 'provider_is_mock' }        (development/staging 에서 FACE_VERIFICATION_PROVIDER=mock)
 *   → 429 { error: 'rate_limited', reason, retryAfterSeconds }
 *   → 503 { error: 'provider_unavailable' }     (Didit 세션 생성 실패 — fail-closed, 행은 expired 로 마감)
 *
 * POST { action: 'sync', sessionId }
 *   서버가 Provider Decision 을 직접 조회해 DB 에 반영한다 (웹훅 지연 대비). 클라이언트가 보낸 값은
 *   sessionId(본인 소유 확인용) 뿐이며, 승인 여부는 오직 Provider 응답으로 결정된다.
 *   → 200 { ok: true, status, faceVerified, userActionRequired }
 *        userActionRequired: Provider 가 Resubmitted / Awaiting User 를 알렸다 — 앱은 무한 대기 대신 다시 시작을 안내한다
 *   → 404 { error: 'session_not_found' }       (없거나 다른 사용자의 세션)
 *   → 503 { error: 'provider_unavailable' }
 *
 * 세션 토큰은 응답으로 한 번만 전달되고 어디에도 저장되지 않는다.
 * 유효한 pending 세션이 있어도 토큰을 다시 줄 수 없으므로, 이전 세션은 superseded 로 만료하고 새로 만든다
 * (rate limit 안에서). Didit v3 는 같은 vendor_data 의 미완료 세션(Not Started/In Progress/Resubmitted/Awaiting User)이
 * 있으면 새 세션 대신 그 세션을 다시 돌려줄 수 있다 — 이 경우 같은 session_id 를 가진 기존 행을 다시 pending 으로
 * 열고 방금 만든 행을 superseded 로 마감한다 (provider_session_id UNIQUE 충돌 방지).
 * 이전 세션의 웹훅이 뒤늦게 승인으로 오면 그 행이 approved 가 되며 문제 없다.
 */
import {
  FACE_SESSION_DEFAULT_TTL_MS,
  FACE_SESSION_MAX_PER_DAY,
  FACE_SESSION_MAX_PER_HOUR,
  providerStatusRequiresUserAction,
  shortId,
} from './faceCore.ts';
import type { FaceDb, FaceLogger } from './faceDb.ts';
import { applyDecisionToRow, repairApprovedRow } from './faceOutcome.ts';
import type { FaceLivenessProvider } from './FaceLivenessProvider.ts';

export type StartFaceLivenessDeps = {
  provider: FaceLivenessProvider;
  db: FaceDb;
  now: () => Date;
  log: FaceLogger;
  limits?: { maxPerHour: number; maxPerDay: number };
};

export type HandlerResponse = { status: number; body: Record<string, unknown> };

export type StartFaceLivenessRequest = {
  /** 서버가 JWT 로 검증한 사용자 id — 클라이언트 body 의 값은 절대 쓰지 않는다 */
  userId: string;
  body: unknown;
};

function bodyRecord(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export async function handleStartFaceLiveness(
  req: StartFaceLivenessRequest,
  deps: StartFaceLivenessDeps,
): Promise<HandlerResponse> {
  // index.ts 의 requireUser 가 JWT 를 검증하지만, core 도 빈 사용자 id 로는 아무것도 하지 않는다 (defense in depth)
  if (typeof req.userId !== 'string' || req.userId.trim() === '') {
    return { status: 401, body: { error: 'unauthorized' } };
  }
  const body = bodyRecord(req.body);
  const action = typeof body.action === 'string' ? body.action : 'start';

  if (action === 'sync') return syncSession(req.userId, body, deps);
  if (action !== 'start') return { status: 400, body: { error: 'unknown_action' } };
  return startSession(req.userId, deps);
}

async function startSession(userId: string, deps: StartFaceLivenessDeps): Promise<HandlerResponse> {
  const { db, provider, log } = deps;
  const limits = deps.limits ?? { maxPerHour: FACE_SESSION_MAX_PER_HOUR, maxPerDay: FACE_SESSION_MAX_PER_DAY };

  if (provider.kind === 'mock') {
    // Mock 은 SDK 가 받을 수 있는 실제 토큰을 만들 수 없다 → 개발 버튼(complete-face-verification) 안내
    return { status: 409, body: { error: 'provider_is_mock' } };
  }

  let begin = await db.beginSession(userId, provider.kind, limits);

  if (begin.action === 'reuse') {
    // 토큰은 재발급할 수 없으므로 이전 pending 세션을 superseded 로 마감하고 새로 만든다
    await db.updateRow(begin.id, { status: 'expired', providerReason: 'superseded' });
    begin = await db.beginSession(userId, provider.kind, limits);
  }

  switch (begin.action) {
    case 'already_verified':
      return { status: 409, body: { error: 'already_verified' } };
    case 'rate_limited':
      return { status: 429, body: { error: 'rate_limited', reason: begin.reason, retryAfterSeconds: begin.retryAfterSeconds } };
    case 'reuse':
      // 직전에 superseded 처리했으므로 정상적으로는 도달하지 않는다 — 안전하게 재시도 안내
      return { status: 409, body: { error: 'session_in_progress' } };
    case 'create':
      break;
  }

  const created = await provider.createSession({ userId });
  if (!created.ok) {
    await db.updateRow(begin.id, { status: 'expired', providerReason: 'provider_create_failed' });
    if (created.reason === 'mock_provider') return { status: 409, body: { error: 'provider_is_mock' } };
    log.error(`[face] provider session create failed (http ${created.httpStatus ?? '-'})`);
    return { status: 503, body: { error: 'provider_unavailable' } };
  }

  const parsedExpiry = created.expiresAt ? new Date(created.expiresAt) : null;
  const expiresAt =
    parsedExpiry && Number.isFinite(parsedExpiry.getTime())
      ? parsedExpiry
      : new Date(deps.now().getTime() + FACE_SESSION_DEFAULT_TTL_MS);
  const providerStatus = created.providerStatus ?? 'Not Started';

  // Didit 이 같은 vendor_data 의 미완료 세션을 그대로 돌려준 경우 — 기존 행을 다시 연다
  const existing = await db.getRowBySessionId(created.sessionId);
  let rowId = begin.id;
  if (existing) {
    if (existing.userId !== userId || existing.status === 'approved') {
      // 다른 사용자의 세션 id 이거나 이미 승인된 세션이 다시 왔다 — 절대 붙이지 않는다 (fail-closed)
      await db.updateRow(begin.id, { status: 'expired', providerReason: 'provider_create_failed' });
      log.error(`[face] provider returned session ${shortId(created.sessionId)} that cannot be attached`);
      return { status: 503, body: { error: 'provider_unavailable' } };
    }
    await db.updateRow(begin.id, { status: 'expired', providerReason: 'superseded' });
    const reopened = await db.updateRow(existing.id, {
      status: 'pending',
      expiresAt,
      providerStatus,
      providerReason: null,
    });
    if (!reopened.ok) {
      log.error(`[face] session ${shortId(created.sessionId)} reopen rejected (${reopened.error})`);
      return { status: 503, body: { error: 'provider_unavailable' } };
    }
    rowId = existing.id;
    log.info(`[face] session ${shortId(created.sessionId)} reused by provider (attempt ${begin.attemptCount})`);
  } else {
    await db.attachProviderSession(rowId, {
      providerSessionId: created.sessionId,
      expiresAt,
      providerStatus,
    });
    log.info(`[face] session ${shortId(created.sessionId)} created (attempt ${begin.attemptCount})`);
  }

  return {
    status: 200,
    body: {
      ok: true,
      sessionId: created.sessionId,
      sessionToken: created.sessionToken,
      expiresAt: expiresAt.toISOString(),
      attemptCount: begin.attemptCount,
    },
  };
}

async function syncSession(
  userId: string,
  body: Record<string, unknown>,
  deps: StartFaceLivenessDeps,
): Promise<HandlerResponse> {
  const { db, provider, log } = deps;
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  if (!sessionId) return { status: 400, body: { error: 'invalid_body' } };

  const row = await db.getRowBySessionId(sessionId);
  // 다른 사용자의 세션 id 로는 아무 정보도 얻을 수 없다 (존재 여부조차 404)
  if (!row || row.userId !== userId) return { status: 404, body: { error: 'session_not_found' } };

  if (row.status === 'approved') {
    // 행은 approved 인데 사용자 플래그가 없는 부분 실패 상태면 여기서 복구한다 (멱등)
    const repaired = await repairApprovedRow({ row, db, provider, log, now: deps.now });
    if (repaired.providerUnavailable) return { status: 503, body: { error: 'provider_unavailable', status: 'approved' } };
    return { status: 200, body: { ok: true, status: 'approved', faceVerified: repaired.faceVerified, userActionRequired: false } };
  }
  if (row.status === 'rejected' || row.status === 'expired') {
    // 종료된 세션 — 사용자가 다른 세션으로 이미 인증됐을 수 있으므로(superseded, #11) 플래그는 실제 값을 돌려준다
    return { status: 200, body: { ok: true, status: row.status, faceVerified: await db.isUserFaceVerified(userId), userActionRequired: false } };
  }

  const decision = await provider.getDecision(sessionId, { userId: row.userId });
  if (!decision.ok) {
    // Provider 장애 / 불완전한 응답 → 승인하지 않는다 (fail-closed). 상태는 그대로 pending/in_review.
    log.warn(`[face] session ${shortId(sessionId)} decision unavailable (${decision.reason}${decision.detail ? `:${decision.detail}` : ''})`);
    return { status: 503, body: { error: 'provider_unavailable', status: row.status } };
  }

  const applied = await applyDecisionToRow({ row, decision: decision.decision, eventAt: deps.now(), db, provider, log });
  const status = applied.status;
  // faceVerified 는 항상 users.face_verified 의 실제 값 — 이 세션이 다른 세션에 대체(superseded)됐어도 사용자는 인증된 상태일 수 있다 (#11)
  const faceVerified = await db.isUserFaceVerified(userId);
  const userActionRequired =
    status === 'pending' && (decision.decision.userActionRequired || providerStatusRequiresUserAction(row.providerStatus));
  return { status: 200, body: { ok: true, status, faceVerified, userActionRequired } };
}
