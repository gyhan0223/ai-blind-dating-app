/**
 * didit-webhook 핵심 로직 — 순수 모듈 (의존성 주입, Node selftest 겸용).
 *
 * 이 함수는 JWT 없이(--no-verify-jwt) 배포되므로 X-Signature-V2 검증이 유일한 호출자 인증이다.
 *
 * 처리 순서
 *   1) secret 미설정 → 500 (fail-closed)          5) vendor_data 가 있으면 행의 user_id 와 일치해야 한다
 *   2) 서명/타임스탬프/JSON 검증 실패 → 401         6) 같은 이벤트 재전송 → 200 duplicate (멱등)
 *   3) payload 최소 파싱 실패 → 400                7) 최종 상태(Approved/Declined/In Review) 는 서버가
 *   4) session_id → 행 조회, 없으면 200 ignored        Provider Decision 을 직접 재조회해 판정한다
 *                                                    (조회 실패 → 503, Didit 이 재시도)
 *   8) 중간 상태(Not Started/In Progress) 는 provider_status 만 갱신, Abandoned/Expired 는 expired
 *
 * 응답 본문과 로그에는 세션 id 축약값과 고정 코드만 담는다. 전체 payload 는 저장하지 않는다.
 */
import { parseWebhookEvent, requiresDecisionLookup, shortId } from './faceCore.ts';
import type { FaceDb, FaceLogger } from './faceDb.ts';
import { applyDecisionToRow } from './faceOutcome.ts';
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

  const row = await db.getRowBySessionId(event.sessionId);
  if (!row) {
    // 우리 DB 에 없는 세션 (다른 환경/워크플로의 이벤트). 재시도해도 소용없으므로 200 으로 받는다.
    log.warn(`[didit-webhook] unknown session ${shortId(event.sessionId)} ignored`);
    return { status: 200, body: { ignored: 'unknown_session' } };
  }
  // vendor_data 만 단독으로 신뢰하지 않는다 — 행(user_id) 이 기준이고 vendor_data 는 일치 확인용
  if (event.vendorData && event.vendorData !== row.userId) {
    log.warn(`[didit-webhook] session ${shortId(event.sessionId)} vendor_data mismatch ignored`);
    return { status: 200, body: { ignored: 'vendor_mismatch' } };
  }

  // 멱등: 같은 이벤트 재전송
  if (
    row.providerEventAt &&
    event.eventAt &&
    row.providerEventAt.getTime() === event.eventAt.getTime() &&
    row.providerStatus === event.providerStatus
  ) {
    return { status: 200, body: { duplicate: true, status: row.status } };
  }
  // 이미 승인된 세션은 어떤 이벤트로도 바뀌지 않는다
  if (row.status === 'approved') {
    return { status: 200, body: { ignored: 'already_approved', status: 'approved' } };
  }
  // out-of-order: 저장된 이벤트보다 오래된 이벤트
  if (row.providerEventAt && event.eventAt && event.eventAt.getTime() < row.providerEventAt.getTime()) {
    return { status: 200, body: { ignored: 'stale_event', status: row.status } };
  }

  if (!event.status) {
    // 알 수 없는 상태 문자열 — 승인하지 않고 그대로 둔다
    log.warn(`[didit-webhook] session ${shortId(event.sessionId)} unknown status ignored`);
    return { status: 200, body: { ignored: 'unknown_status', status: row.status } };
  }

  if (!requiresDecisionLookup(event.status)) {
    // 중간 상태 / 만료 — 웹훅 상태만 반영 (승인과 무관)
    const patch =
      event.status === 'expired'
        ? {
            status: 'expired' as const,
            providerStatus: event.providerStatus,
            providerEventAt: event.eventAt ?? deps.now(),
            providerReason: (event.providerStatus.toLowerCase() === 'abandoned' ? 'session_abandoned' : 'session_expired') as
              | 'session_abandoned'
              | 'session_expired',
          }
        : { providerStatus: event.providerStatus, providerEventAt: event.eventAt ?? deps.now() };
    const res = await db.updateRow(row.id, patch);
    return { status: 200, body: { ok: res.ok, status: event.status === 'expired' ? 'expired' : row.status } };
  }

  // 최종 상태: 웹훅의 status/decision 은 힌트일 뿐 — 서버가 Provider 에서 직접 재조회한다
  const decision = await provider.getDecision(event.sessionId);
  if (!decision.ok) {
    log.warn(`[didit-webhook] session ${shortId(event.sessionId)} decision unavailable (${decision.reason})`);
    // 승인하지 않고 503 → Didit 이 재시도한다 (fail-closed)
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
    return { status: 200, body: { ignored: applied.reason, status: applied.status } };
  }
  return { status: 200, body: { ok: true, status: applied.status } };
}
