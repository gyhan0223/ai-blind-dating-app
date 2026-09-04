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
 *   → 200 { ok: true, status, faceVerified }
 *   → 404 { error: 'session_not_found' }       (없거나 다른 사용자의 세션)
 *   → 503 { error: 'provider_unavailable' }
 *
 * 세션 토큰은 응답으로 한 번만 전달되고 어디에도 저장되지 않는다.
 * 유효한 pending 세션이 있어도 토큰을 다시 줄 수 없으므로, 이전 세션은 superseded 로 만료하고 새로 만든다
 * (rate limit 안에서). 이전 세션의 웹훅이 뒤늦게 승인으로 오면 그 행이 approved 가 되며 문제 없다.
 */
import { FACE_SESSION_DEFAULT_TTL_MS, FACE_SESSION_MAX_PER_DAY, FACE_SESSION_MAX_PER_HOUR, shortId } from './faceCore.ts';
import type { FaceDb, FaceLogger } from './faceDb.ts';
import { applyDecisionToRow } from './faceOutcome.ts';
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

  await db.attachProviderSession(begin.id, {
    providerSessionId: created.sessionId,
    expiresAt,
    providerStatus: 'Not Started',
  });
  log.info(`[face] session ${shortId(created.sessionId)} created (attempt ${begin.attemptCount})`);

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
    return { status: 200, body: { ok: true, status: 'approved', faceVerified: await db.isUserFaceVerified(userId) } };
  }
  if (row.status === 'rejected' || row.status === 'expired') {
    return { status: 200, body: { ok: true, status: row.status, faceVerified: false } };
  }

  const decision = await provider.getDecision(sessionId);
  if (!decision.ok) {
    // Provider 장애 / 불완전한 응답 → 승인하지 않는다 (fail-closed). 상태는 그대로 pending/in_review.
    log.warn(`[face] session ${shortId(sessionId)} decision unavailable (${decision.reason}${decision.detail ? `:${decision.detail}` : ''})`);
    return { status: 503, body: { error: 'provider_unavailable', status: row.status } };
  }

  const applied = await applyDecisionToRow({ row, decision: decision.decision, eventAt: deps.now(), db, provider, log });
  const status = applied.status;
  const faceVerified = status === 'approved' ? await db.isUserFaceVerified(userId) : false;
  return { status: 200, body: { ok: true, status, faceVerified } };
}
