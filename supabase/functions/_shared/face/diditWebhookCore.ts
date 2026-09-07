/**
 * didit-webhook 핵심 로직 — 순수 모듈 (의존성 주입, Node selftest 겸용).
 *
 * 이 함수는 JWT 없이(--no-verify-jwt) 배포되므로 X-Signature-V2 검증이 유일한 호출자 인증이다.
 * Didit 콘솔의 웹훅 destination 은 반드시 **V3** 로 등록한다 (event_id · plural-array decision 구조).
 *
 * 처리 순서
 *   1) secret 미설정 → 500 (fail-closed)               7) event_id 를 이미 처리했으면 → 200 duplicate (Decision 재조회 없음)
 *   2) 서명/타임스탬프/JSON 검증 실패 → 401             8) 같은 created_at+status 재전송 → 200 duplicate (event_id 없는 구형 payload)
 *   3) payload 최소 파싱 실패 → 400                    9) 이미 approved 행: users.face_verified 가 아직 아니면 복구, 아니면 ignored
 *   4) status.updated / data.updated 이외의 webhook_type  10) 저장된 이벤트보다 오래된 이벤트 → 200 stale
 *      (user.* / business.* / transaction.* ...) → 200 ignored (세션 이벤트로 오인하지 않는다)
 *   5) session_id → 행 조회, 없으면 200 ignored        11) 최종 상태(Approved/Declined/In Review) 는 서버가 Provider Decision 을
 *   6) vendor_data / workflow_id 가 있으면 행/설정과 일치해야 한다  직접 재조회해 판정 (조회 실패 → 503, Didit 이 재시도 — event_id 미기록)
 *   12) 중간 상태(Not Started/In Progress/Awaiting User/Resubmitted) 는 provider_status·사유만 갱신, Abandoned/Expired 는 expired
 *
 * 응답 본문과 로그에는 세션 id 축약값과 고정 코드만 담는다. 전체 payload · workflow_id · application/environment 원문은
 * 저장하거나 로그에 남기지 않는다.
 */
import { pendingReasonFor, parseWebhookEvent, requiresDecisionLookup, shortId } from './faceCore.ts';
import type { FaceDb, FaceLogger } from './faceDb.ts';
import { applyDecisionToRow, repairApprovedRow } from './faceOutcome.ts';
import type { FaceLivenessProvider } from './FaceLivenessProvider.ts';
import { verifyDiditWebhook, type WebhookHeaders } from './diditWebhookVerifier.ts';
import type { HandlerResponse } from './startFaceLivenessCore.ts';

export type DiditWebhookDeps = {
  /** DIDIT_WEBHOOK_SECRET — null/빈 값이면 모든 요청 거부 */
  webhookSecret: string | null | undefined;
  provider: FaceLivenessProvider;
  db: FaceDb;
  now: () => Date;
  log: FaceLogger;
};

export type DiditWebhookRequest = { rawBody: string; headers: WebhookHeaders };

export async function handleDiditWebhook(req: DiditWebhookRequest, deps: DiditWebhookDeps): Promise<HandlerResponse> {
  const { db, provider, log } = deps;

  if (!(deps.webhookSecret ?? '').trim()) {
    log.error('[didit-webhook] DIDIT_WEBHOOK_SECRET 미설정 — 모든 요청을 거부합니다 (fail-closed)');
    return { status: 500, body: { error: 'misconfigured' } };
  }
  if (provider.kind !== 'didit') {
    return { status: 503, body: { error: 'provider_not_didit' } };
  }

  const verified = await verifyDiditWebhook({
    rawBody: req.rawBody,
    headers: req.headers,
    secret: deps.webhookSecret,
    nowSeconds: Math.floor(deps.now().getTime() / 1000),
  });
  if (!verified.ok) {
    log.warn(`[didit-webhook] rejected: ${verified.reason}`);
    return { status: verified.reason === 'invalid_json' ? 400 : 401, body: { error: verified.reason } };
  }

  const event = parseWebhookEvent(verified.body);
  if (!event) return { status: 400, body: { error: 'invalid_payload' } };

  if (event.kind === 'unsupported') {
    // 세션 이벤트가 아니다 (entity/transaction 등). 세션 상태에 반영하지 않고 조용히 받는다.
    log.info('[didit-webhook] non-session event ignored');
    return { status: 200, body: { ignored: 'unsupported_event' } };
  }

  // 멱등 (V3 event_id): 이미 처리한 이벤트는 Provider Decision 을 다시 조회하지 않는다
  if (event.eventId && (await db.hasProcessedWebhookEvent(event.eventId))) {
    return { status: 200, body: { duplicate: true } };
  }

  const done = async (body: Record<string, unknown>, outcome: string): Promise<HandlerResponse> => {
    if (event.eventId) {
      await db.markWebhookEventProcessed({
        eventId: event.eventId,
        providerSessionId: event.sessionId,
        webhookType: event.webhookType,
        providerStatus: event.providerStatus,
        outcome,
      });
    }
    return { status: 200, body };
  };

  const row = await db.getRowBySessionId(event.sessionId);
  if (!row) {
    // 우리 DB 에 없는 세션 (다른 환경/워크플로의 이벤트). 재시도해도 소용없으므로 200 으로 받는다.
    log.warn(`[didit-webhook] unknown session ${shortId(event.sessionId)} ignored`);
    return done({ ignored: 'unknown_session' }, 'ignored:unknown_session');
  }
  // vendor_data 만 단독으로 신뢰하지 않는다 — 행(user_id) 이 기준이고 vendor_data 는 일치 확인용
  if (event.vendorData && event.vendorData !== row.userId) {
    log.warn(`[didit-webhook] session ${shortId(event.sessionId)} vendor_data mismatch ignored`);
    return done({ ignored: 'vendor_mismatch' }, 'ignored:vendor_mismatch');
  }
  // workflow_id 가 실려 오면 서버 설정과 일치해야 한다 (원문은 로그에 남기지 않는다)
  if (event.workflowId && provider.workflowId && event.workflowId !== provider.workflowId) {
    log.warn(`[didit-webhook] session ${shortId(event.sessionId)} workflow mismatch ignored`);
    return done({ ignored: 'workflow_mismatch' }, 'ignored:workflow_mismatch');
  }

  // 멱등: 같은 이벤트 재전송 (event_id 가 없는 payload 대비)
  if (
    row.providerEventAt &&
    event.eventAt &&
    row.providerEventAt.getTime() === event.eventAt.getTime() &&
    row.providerStatus === event.providerStatus
  ) {
    return done({ duplicate: true, status: row.status }, 'duplicate');
  }

  // 이미 승인된 세션은 어떤 이벤트로도 바뀌지 않는다 — 단, 부분 실패(사용자 플래그 누락)는 여기서 복구한다
  if (row.status === 'approved') {
    const repaired = await repairApprovedRow({ row, db, provider, log, now: deps.now });
    if (repaired.providerUnavailable) return { status: 503, body: { error: 'decision_unavailable' } };
    return done(
      { ignored: 'already_approved', status: 'approved', faceVerified: repaired.faceVerified },
      repaired.faceVerified ? 'ignored:already_approved' : 'ignored:already_approved_unverified',
    );
  }
  // out-of-order: 저장된 이벤트보다 오래된 이벤트
  if (row.providerEventAt && event.eventAt && event.eventAt.getTime() < row.providerEventAt.getTime()) {
    return done({ ignored: 'stale_event', status: row.status }, 'ignored:stale_event');
  }

  if (!event.status) {
    // 알 수 없는 상태 문자열 — 승인하지 않고 그대로 둔다
    log.warn(`[didit-webhook] session ${shortId(event.sessionId)} unknown status ignored`);
    return done({ ignored: 'unknown_status', status: row.status }, 'ignored:unknown_status');
  }

  if (!requiresDecisionLookup(event.status)) {
    // 중간 상태 / 만료 — 웹훅 상태만 반영 (승인과 무관)
    const eventAt = event.eventAt ?? deps.now();
    const patch =
      event.status === 'expired'
        ? {
            status: 'expired' as const,
            providerStatus: event.providerStatus,
            providerEventAt: eventAt,
            providerReason: (event.providerStatus.toLowerCase() === 'abandoned' ? 'session_abandoned' : 'session_expired') as
              | 'session_abandoned'
              | 'session_expired',
          }
        : {
            providerStatus: event.providerStatus,
            providerEventAt: eventAt,
            // Resubmitted / Awaiting User 는 사용자가 다시 진행해야 하는 pending — 사유 코드로 남겨 앱이 안내한다
            providerReason: pendingReasonFor(event.providerStatus),
          };
    const res = await db.updateRow(row.id, patch);
    const status = event.status === 'expired' ? 'expired' : row.status;
    return done({ ok: res.ok, status }, res.ok ? `ok:${status}` : 'db_rejected');
  }

  // 최종 상태: 웹훅의 status/decision 은 힌트일 뿐 — 서버가 Provider 에서 직접 재조회한다
  const decision = await provider.getDecision(event.sessionId, { userId: row.userId });
  if (!decision.ok) {
    log.warn(`[didit-webhook] session ${shortId(event.sessionId)} decision unavailable (${decision.reason}${decision.detail ? `:${decision.detail}` : ''})`);
    // 승인하지 않고 503 → Didit 이 재시도한다 (fail-closed). event_id 는 기록하지 않아 재시도가 다시 처리된다.
    return { status: 503, body: { error: 'decision_unavailable' } };
  }

  const applied = await applyDecisionToRow({
    row,
    decision: decision.decision,
    eventAt: event.eventAt ?? deps.now(),
    db,
    provider,
    log,
  });
  if (!applied.applied) {
    if (applied.reason === 'db_rejected') {
      // 승인 RPC/갱신 실패 — 503 으로 재시도 유도 (event_id 미기록)
      return { status: 503, body: { error: 'db_unavailable' } };
    }
    return done({ ignored: applied.reason, status: applied.status }, `ignored:${applied.reason}`);
  }
  return done({ ok: true, status: applied.status }, `ok:${applied.status}`);
}
