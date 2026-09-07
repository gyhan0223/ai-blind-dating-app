/**
 * 얼굴 라이브니스(Didit v3) 서버 로직 selftest — Node 로 실행 (Deno 불필요, 외부 API 호출 없음).
 *   node --experimental-strip-types selftest.ts
 *
 * 실제 얼굴 이미지·실사용자 데이터·실제 Didit 응답을 fixture 로 쓰지 않는다 (uuid / 가짜 바이트 / 공식 문서 구조를 축약한 JSON 만).
 *
 * 보장 항목
 *   - Didit Sessions API 경로가 전부 v3 이고 v2 로 fallback 하지 않는다
 *   - V3 Decision 파서: liveness_checks[] 기반 · session_id/workflow_id/vendor_data 대조 · 노드 0개/여러 개 fail-closed ·
 *     matches[]/warnings[] 중복 의심 · Resubmitted/Awaiting User · 점수 범위 · https 이미지만
 *   - 비로그인/타 사용자/클라이언트 조작으로는 승인 불가
 *   - 웹훅: 서명·타임스탬프·변조 거부, event_id 멱등(재조회 없음), 순서 역전, 세션 이벤트가 아닌 webhook_type 무시,
 *     status.updated 와 data.updated 동일 처리, 503 로 끝난 이벤트는 재시도가 다시 처리
 *   - 승인은 reference image 확보 후 RPC 한 번으로 행+사용자 플래그를 함께 반영 (image 실패 → in_review, 재시도 가능)
 *   - RPC 부분 실패 / 승인 행인데 사용자 플래그 없음 / reference_path 없음 → 자동 복구
 *   - 관리자 검토: liveness Approved · liveness_passed · reference_path 없이는 승인 불가, 거절 시 플래그 false, audit 기록
 *   - Didit 이 같은 vendor_data 의 미완료 세션을 다시 돌려줘도 provider_session_id 충돌 없이 이어진다
 */
import {
  decideTransition,
  DIDIT_API_VERSION,
  mapDiditStatus,
  parseDiditDecision,
  parseWebhookEvent,
  providerStatusRequiresUserAction,
  referenceImagePath,
  resolveOutcome,
} from './faceCore.ts';
import { DIDIT_SESSION_CREATE_PATH, diditDecisionPath, diditDeletePath, deleteDiditSession, downloadImage, getDiditDecision } from './diditClient.ts';
import {
  canonicalWebhookBody,
  computeDiditSignatureV2,
  timingSafeEqualHex,
  verifyDiditWebhook,
} from './diditWebhookVerifier.ts';
import { handleDiditWebhook } from './diditWebhookCore.ts';
import { handleAdminFaceReview } from './adminReviewCore.ts';
import type {
  AdminReviewInput,
  AdminReviewResult,
  ApproveInput,
  ApproveResult,
  BeginSessionResult,
  FaceDb,
  FaceRow,
  FaceRowPatch,
  WebhookEventRecord,
} from './faceDb.ts';
import { silentLogger } from './faceDb.ts';
import {
  type DecisionContext,
  type FaceLivenessProvider,
  getFaceLivenessProvider,
  loadDiditConfig,
  type ProviderDecisionResult,
  type ProviderSessionResult,
} from './FaceLivenessProvider.ts';
import { handleStartFaceLiveness } from './startFaceLivenessCore.ts';

let passed = 0;
let failed = 0;

function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function ok(name: string, cond: boolean) {
  eq(name, cond, true);
}

// ---------------------------------------------------------------------------
// 인메모리 FaceDb — DB 트리거/RPC(face_liveness_approve · face_liveness_admin_review) 의 규칙을 그대로 흉내 낸다
// ---------------------------------------------------------------------------

class MemoryFaceDb implements FaceDb {
  rows: FaceRow[] = [];
  verifiedUsers = new Set<string>();
  stored: { path: string; bytes: number; contentType: string }[] = [];
  events = new Map<string, WebhookEventRecord>();
  reviews: { rowId: string; action: string; previousStatus: string; newStatus: string; actor: string; note: string | null }[] = [];
  private seq = 0;
  failStore = false;
  /** RPC 부분 실패 시뮬레이션 — true 면 승인 RPC 가 아무것도 바꾸지 않고 실패한다 */
  failApprove = false;
  approveCalls = 0;
  now: () => Date = () => new Date();

  async beginSession(userId: string, provider: string, limits: { maxPerHour: number; maxPerDay: number }): Promise<BeginSessionResult> {
    if (this.verifiedUsers.has(userId)) return { action: 'already_verified' };
    const reusable = this.rows.find(
      (r) => r.userId === userId && r.status === 'pending' && r.providerSessionId && r.expiresAt && r.expiresAt.getTime() > this.now().getTime() + 60_000,
    );
    if (reusable) return { action: 'reuse', id: reusable.id, providerSessionId: reusable.providerSessionId!, expiresAt: reusable.expiresAt!.toISOString() };
    const mine = this.rows.filter((r) => r.userId === userId);
    if (mine.length >= limits.maxPerHour) return { action: 'rate_limited', reason: 'hourly', retryAfterSeconds: 600 };
    this.seq += 1;
    const row: FaceRow = {
      id: `row-${this.seq}`,
      userId,
      status: 'pending',
      provider,
      providerSessionId: null,
      providerStatus: null,
      providerEventAt: null,
      providerReason: null,
      livenessPassed: false,
      livenessScore: null,
      livenessMethod: null,
      referencePath: null,
      expiresAt: null,
      attemptCount: mine.length + 1,
      createdAt: new Date(),
    };
    this.rows.push(row);
    return { action: 'create', id: row.id, attemptCount: row.attemptCount };
  }

  async attachProviderSession(rowId: string, input: { providerSessionId: string; expiresAt: Date; providerStatus: string | null }) {
    if (this.rows.some((r) => r.providerSessionId === input.providerSessionId)) throw new Error('unique_violation');
    const row = this.rows.find((r) => r.id === rowId)!;
    row.providerSessionId = input.providerSessionId;
    row.expiresAt = input.expiresAt;
    row.providerStatus = input.providerStatus;
  }

  async getRowBySessionId(id: string) {
    return this.rows.find((r) => r.providerSessionId === id) ?? null;
  }
  async getRowById(id: string) {
    return this.rows.find((r) => r.id === id) ?? null;
  }
  async getLatestForUser(userId: string) {
    return [...this.rows].reverse().find((r) => r.userId === userId) ?? null;
  }

  async updateRow(rowId: string, patch: FaceRowPatch): Promise<{ ok: true } | { ok: false; error: string }> {
    const row = this.rows.find((r) => r.id === rowId);
    if (!row) return { ok: false, error: 'not_found' };
    if (row.status === 'approved' && patch.status && patch.status !== 'approved') return { ok: false, error: 'approved_immutable' };
    if (row.livenessPassed && patch.livenessPassed === false) return { ok: false, error: 'liveness_passed_cleared' };
    if (row.providerEventAt && patch.providerEventAt && patch.providerEventAt.getTime() < row.providerEventAt.getTime()) {
      return { ok: false, error: 'stale_event' };
    }
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.providerStatus !== undefined) row.providerStatus = patch.providerStatus;
    if (patch.providerEventAt !== undefined) row.providerEventAt = patch.providerEventAt;
    if (patch.providerReason !== undefined) row.providerReason = patch.providerReason;
    if (patch.livenessPassed !== undefined) row.livenessPassed = patch.livenessPassed;
    if (patch.livenessScore !== undefined) row.livenessScore = patch.livenessScore;
    if (patch.livenessMethod !== undefined) row.livenessMethod = patch.livenessMethod;
    if (patch.referencePath !== undefined) row.referencePath = patch.referencePath;
    if (patch.expiresAt !== undefined) row.expiresAt = patch.expiresAt;
    return { ok: true };
  }

  /** face_liveness_approve RPC 와 같은 규칙 (0014 마이그레이션) */
  async approveVerification(input: ApproveInput): Promise<ApproveResult> {
    this.approveCalls += 1;
    if (this.failApprove) return { ok: false, reason: 'rpc_error' };
    const row = this.rows.find((r) => r.id === input.rowId);
    if (!row) return { ok: false, reason: 'row_not_found' };
    if (row.userId !== input.userId) return { ok: false, reason: 'user_mismatch' };
    if (!row.providerSessionId || row.providerSessionId !== input.providerSessionId) return { ok: false, reason: 'session_mismatch' };
    if (!input.referencePath.startsWith(`${row.userId}/liveness/`)) return { ok: false, reason: 'reference_missing' };
    if (!(input.livenessPassed || row.livenessPassed)) return { ok: false, reason: 'liveness_not_passed' };
    if (row.status === 'rejected') return { ok: false, reason: 'rejected_row' };
    let changed = false;
    if (row.status !== 'approved' || row.referencePath !== input.referencePath || !row.livenessPassed) {
      row.status = 'approved';
      row.livenessPassed = true;
      row.referencePath = input.referencePath;
      row.livenessScore = input.livenessScore ?? row.livenessScore;
      row.livenessMethod = input.livenessMethod ?? row.livenessMethod;
      row.providerStatus = input.providerStatus ?? row.providerStatus;
      row.providerEventAt = new Date(Math.max(row.providerEventAt?.getTime() ?? 0, input.providerEventAt.getTime()));
      row.providerReason = input.reason;
      changed = true;
    }
    if (!this.verifiedUsers.has(row.userId)) {
      this.verifiedUsers.add(row.userId);
      changed = true;
    }
    return { ok: true, faceVerified: true, changed };
  }

  /** face_liveness_admin_review RPC 와 같은 규칙 */
  async adminReview(input: AdminReviewInput): Promise<AdminReviewResult> {
    const row = this.rows.find((r) => r.id === input.rowId);
    if (!row) return { ok: false, reason: 'row_not_found' };
    if (input.action === 'approve') {
      if (row.status !== 'in_review') return { ok: false, reason: 'invalid_state' };
      if (!row.livenessPassed) return { ok: false, reason: 'liveness_not_passed' };
      const ref = input.referencePath ?? row.referencePath;
      if (!ref) return { ok: false, reason: 'reference_missing' };
      const prev = row.status;
      const res = await this.approveVerification({
        rowId: row.id,
        userId: row.userId,
        providerSessionId: row.providerSessionId ?? '',
        referencePath: ref,
        livenessPassed: true,
        livenessScore: input.livenessScore ?? null,
        livenessMethod: input.livenessMethod ?? null,
        providerStatus: input.providerStatus ?? null,
        providerEventAt: this.now(),
        reason: 'admin_approved',
      });
      if (!res.ok) return res;
      this.reviews.push({ rowId: row.id, action: 'approve', previousStatus: prev, newStatus: 'approved', actor: input.actor, note: input.note });
      return { ok: true, status: 'approved', faceVerified: true };
    }
    if (row.status !== 'in_review' && row.status !== 'pending') return { ok: false, reason: 'invalid_state' };
    const prev = row.status;
    row.status = 'rejected';
    row.providerReason = 'admin_rejected';
    if (!this.rows.some((r) => r.userId === row.userId && r.status === 'approved')) this.verifiedUsers.delete(row.userId);
    this.reviews.push({ rowId: row.id, action: 'reject', previousStatus: prev, newStatus: 'rejected', actor: input.actor, note: input.note });
    return { ok: true, status: 'rejected', faceVerified: false };
  }

  async storeReferenceImage(userId: string, bytes: Uint8Array, contentType: string) {
    if (this.failStore) return { ok: false as const };
    const path = referenceImagePath(userId, contentType);
    this.stored.push({ path, bytes: bytes.byteLength, contentType });
    return { ok: true as const, path };
  }
  async isUserFaceVerified(userId: string) {
    return this.verifiedUsers.has(userId);
  }
  async hasProcessedWebhookEvent(eventId: string) {
    return this.events.has(eventId);
  }
  async markWebhookEventProcessed(record: WebhookEventRecord) {
    if (!this.events.has(record.eventId)) this.events.set(record.eventId, record);
  }
}

// ---------------------------------------------------------------------------
// 가짜 Provider (Didit v3 응답 형태를 시뮬레이션 — 실제 호출 없음)
// ---------------------------------------------------------------------------

const WORKFLOW = 'wf-liveness-only-test';

class FakeProvider implements FaceLivenessProvider {
  readonly kind = 'didit' as const;
  readonly workflowId = WORKFLOW;
  createResult: ProviderSessionResult = { ok: true, sessionId: 'sess-1', sessionToken: 'tok-1', expiresAt: null, providerStatus: 'Not Started' };
  decisionJson: Record<string, unknown> | null = null;
  decisionDown = false;
  imageOk = true;
  createCalls = 0;
  decisionCalls = 0;
  imageCalls = 0;

  async createSession(): Promise<ProviderSessionResult> {
    this.createCalls += 1;
    return this.createResult;
  }
  async getDecision(sessionId: string, ctx: DecisionContext): Promise<ProviderDecisionResult> {
    this.decisionCalls += 1;
    if (this.decisionDown) return { ok: false, reason: 'provider_error', httpStatus: 503 };
    const parsed = parseDiditDecision(this.decisionJson, { sessionId, workflowId: this.workflowId, userId: ctx.userId });
    if (!parsed.ok) return { ok: false, reason: 'invalid_decision', detail: parsed.reason };
    return { ok: true, decision: parsed.decision };
  }
  async fetchReferenceImage() {
    this.imageCalls += 1;
    if (!this.imageOk) return { ok: false as const, reason: 'http_error' as const };
    return { ok: true as const, bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), contentType: 'image/jpeg' };
  }
  async deleteSession() {
    return { ok: true };
  }
}

const USER_A = '55555555-5555-5555-5555-555555555555';
const USER_B = '66666666-6666-6666-6666-666666666666';
const SECRET = 'test-webhook-secret-not-real';

/** Didit v3 GET /v3/session/{id}/decision/ 응답을 Liveness-only 워크플로 기준으로 축약한 fixture (개인정보 없음) */
function livenessNode(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    node_id: 'node-liveness-1',
    status: 'Approved',
    method: 'active',
    score: 96.4,
    reference_image: 'https://example.invalid/ref.jpg',
    video_url: null,
    matches: [],
    warnings: [],
    ...extra,
  };
}

function v3Decision(sessionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: sessionId,
    session_kind: 'user',
    session_number: 1,
    session_url: 'https://verify.didit.me/session/test',
    status: 'Approved',
    environment: 'sandbox',
    workflow_id: WORKFLOW,
    workflow_version: 3,
    features: ['LIVENESS'],
    vendor_data: USER_A,
    metadata: null,
    liveness_checks: [livenessNode()],
    warnings: [],
    reviews: [],
    created_at: '2026-09-04T00:00:00Z',
    ...extra,
  };
}

async function signedWebhook(body: Record<string, unknown>, secret = SECRET) {
  const rawBody = JSON.stringify(body);
  const signatureV2 = await computeDiditSignatureV2(secret, body);
  return { rawBody, headers: { signatureV2, timestamp: String(body.created_at ?? '') } };
}

const NOW = new Date('2026-09-04T00:00:00Z');
const nowSec = Math.floor(NOW.getTime() / 1000);

function makeDeps(db: MemoryFaceDb, provider: FakeProvider) {
  db.now = () => NOW;
  return { db, provider, now: () => NOW, log: silentLogger };
}

/** V3 웹훅 payload 축약 (event_id · webhook_type 포함) */
function v3Event(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: 'evt-1',
    webhook_type: 'status.updated',
    session_id: 'sess-1',
    status: 'Approved',
    workflow_id: WORKFLOW,
    vendor_data: USER_A,
    created_at: nowSec,
    timestamp: nowSec,
    ...extra,
  };
}

async function main() {
  // ── API 경로 v3 통일 ───────────────────────────────────────────────────
  eq('api version v3', DIDIT_API_VERSION, 'v3');
  eq('create path v3', DIDIT_SESSION_CREATE_PATH, '/v3/session/');
  eq('decision path v3', diditDecisionPath('abc def'), '/v3/session/abc%20def/decision/');
  eq('delete path v3', diditDeletePath('s1'), '/v3/session/s1/delete/');
  ok('no v2 path anywhere', ![DIDIT_SESSION_CREATE_PATH, diditDecisionPath('x'), diditDeletePath('x')].some((p) => p.includes('/v2/')));
  {
    const calls: string[] = [];
    const fakeFetch = async (input: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${input}`);
      if (input.endsWith('/delete/')) return new Response(JSON.stringify({ message: 'deleted' }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify(v3Decision('s1')), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const deps = { apiKey: 'k', fetch: fakeFetch };
    const d = await getDiditDecision(deps, 's1');
    ok('client fetches v3 decision', d.ok && calls[0] === 'GET https://verification.didit.me/v3/session/s1/decision/');
    const del = await deleteDiditSession(deps, 's1');
    eq('client delete 200 json is success', del, { ok: true, httpStatus: 200 });
    ok('client delete uses v3', calls[1] === 'DELETE https://verification.didit.me/v3/session/s1/delete/');
    const del204 = await deleteDiditSession({ apiKey: 'k', fetch: async () => new Response(null, { status: 204 }) }, 's1');
    eq('client delete 204 is success', del204.ok, true);
    const del404 = await deleteDiditSession({ apiKey: 'k', fetch: async () => new Response('{}', { status: 404 }) }, 's1');
    eq('client delete 404 fails', del404, { ok: false, httpStatus: 404 });
    const notJson = await getDiditDecision({ apiKey: 'k', fetch: async () => new Response('[]', { status: 200 }) }, 's1');
    eq('client non-object decision → invalid_response', notJson, { ok: false, reason: 'invalid_response', httpStatus: 200 });
    let threw = false;
    try {
      await getDiditDecision({ apiKey: 'k', baseUrl: 'http://insecure.invalid', fetch: fakeFetch }, 's1');
    } catch {
      threw = true;
    }
    ok('client refuses http base url', threw);
  }

  // ── 도메인 매핑 ──────────────────────────────────────────────────────
  eq('map Approved', mapDiditStatus('Approved'), 'approved');
  eq('map Declined', mapDiditStatus('Declined'), 'rejected');
  eq('map In Review', mapDiditStatus('In Review'), 'in_review');
  eq('map In Progress', mapDiditStatus('In Progress'), 'pending');
  eq('map Awaiting User → pending', mapDiditStatus('Awaiting User'), 'pending');
  eq('map Resubmitted → pending', mapDiditStatus('Resubmitted'), 'pending');
  eq('map Abandoned', mapDiditStatus('Abandoned'), 'expired');
  eq('map Kyc Expired', mapDiditStatus('Kyc Expired'), 'expired');
  eq('map unknown', mapDiditStatus('Verified'), null);
  eq('map non-string', mapDiditStatus(1), null);
  ok('user action required statuses', providerStatusRequiresUserAction('Resubmitted') && providerStatusRequiresUserAction('awaiting user') && !providerStatusRequiresUserAction('Approved'));

  // ── V3 Decision 파싱 (fail-closed) ────────────────────────────────────
  const expectA = { sessionId: 's1', workflowId: WORKFLOW, userId: USER_A };
  const d1 = parseDiditDecision(v3Decision('s1'), expectA);
  ok('v3 approved parses', d1.ok && d1.decision.status === 'approved' && d1.decision.livenessPassed && d1.decision.livenessScore === 96.4 && d1.decision.livenessMethod === 'active');
  ok('v3 reference url https', d1.ok && d1.decision.referenceImageUrl === 'https://example.invalid/ref.jpg');
  ok('v3 approved no duplicate', d1.ok && !d1.decision.duplicateSuspected && d1.decision.duplicateSignal === null && !d1.decision.userActionRequired);

  const dLivenessDeclined = parseDiditDecision(v3Decision('s1', { liveness_checks: [livenessNode({ status: 'Declined', score: 12 })] }), expectA);
  ok('v3 top-level Approved but liveness Declined → livenessPassed false', dLivenessDeclined.ok && !dLivenessDeclined.decision.livenessPassed);

  eq('v3 liveness_checks missing → missing_liveness', parseDiditDecision(v3Decision('s1', { liveness_checks: undefined }), expectA), { ok: false, reason: 'missing_liveness' });
  eq('v3 liveness_checks empty → missing_liveness', parseDiditDecision(v3Decision('s1', { liveness_checks: [] }), expectA), { ok: false, reason: 'missing_liveness' });
  eq('v3 multiple liveness nodes → fail-closed', parseDiditDecision(v3Decision('s1', { liveness_checks: [livenessNode(), livenessNode({ node_id: 'n2' })] }), expectA), { ok: false, reason: 'multiple_liveness' });
  eq('v3 legacy single liveness object is not accepted', parseDiditDecision(v3Decision('s1', { liveness_checks: undefined, liveness: livenessNode() }), expectA), { ok: false, reason: 'missing_liveness' });
  eq('v3 non-object liveness node → invalid_payload', parseDiditDecision(v3Decision('s1', { liveness_checks: ['x'] }), expectA), { ok: false, reason: 'invalid_payload' });
  eq('v3 session mismatch', parseDiditDecision(v3Decision('s1'), { ...expectA, sessionId: 's2' }), { ok: false, reason: 'session_mismatch' });
  eq('v3 workflow mismatch', parseDiditDecision(v3Decision('s1', { workflow_id: 'wf-other' }), expectA), { ok: false, reason: 'workflow_mismatch' });
  eq('v3 workflow missing when expected', parseDiditDecision(v3Decision('s1', { workflow_id: undefined }), expectA), { ok: false, reason: 'workflow_mismatch' });
  eq('v3 vendor_data mismatch', parseDiditDecision(v3Decision('s1', { vendor_data: USER_B }), expectA), { ok: false, reason: 'vendor_mismatch' });
  eq('v3 vendor_data missing when expected', parseDiditDecision(v3Decision('s1', { vendor_data: null }), expectA), { ok: false, reason: 'vendor_mismatch' });
  eq('v3 invalid payload', parseDiditDecision('nope', expectA), { ok: false, reason: 'invalid_payload' });
  eq('v3 unknown status', parseDiditDecision(v3Decision('s1', { status: 'Verified' }), expectA), { ok: false, reason: 'unknown_status' });

  const dDeclined = parseDiditDecision(v3Decision('s1', { status: 'Declined', liveness_checks: [livenessNode({ status: 'Declined', score: 8.2 })] }), expectA);
  ok('v3 Declined → rejected', dDeclined.ok && dDeclined.decision.status === 'rejected' && !dDeclined.decision.livenessPassed);
  const dDeclinedNoLiveness = parseDiditDecision(v3Decision('s1', { status: 'Declined', liveness_checks: [] }), expectA);
  ok('v3 Declined without liveness still parses (not approvable)', dDeclinedNoLiveness.ok && dDeclinedNoLiveness.decision.status === 'rejected');
  const dReview = parseDiditDecision(v3Decision('s1', { status: 'In Review' }), expectA);
  ok('v3 In Review → in_review', dReview.ok && dReview.decision.status === 'in_review');
  eq('v3 In Review without liveness → missing_liveness', parseDiditDecision(v3Decision('s1', { status: 'In Review', liveness_checks: [] }), expectA), { ok: false, reason: 'missing_liveness' });

  const dNoRef = parseDiditDecision(v3Decision('s1', { liveness_checks: [livenessNode({ reference_image: null })] }), expectA);
  ok('v3 reference image missing → null', dNoRef.ok && dNoRef.decision.referenceImageUrl === null && dNoRef.decision.livenessPassed);
  const dHttp = parseDiditDecision(v3Decision('s1', { liveness_checks: [livenessNode({ reference_image: 'http://insecure.invalid/ref.jpg' })] }), expectA);
  ok('v3 http reference url dropped', dHttp.ok && dHttp.decision.referenceImageUrl === null);
  const dScore = parseDiditDecision(v3Decision('s1', { liveness_checks: [livenessNode({ score: 250 })] }), expectA);
  ok('v3 out-of-range score dropped', dScore.ok && dScore.decision.livenessScore === null);
  const dScoreStr = parseDiditDecision(v3Decision('s1', { liveness_checks: [livenessNode({ score: '77.5' })] }), expectA);
  ok('v3 numeric string score kept', dScoreStr.ok && dScoreStr.decision.livenessScore === 77.5);
  const dNegScore = parseDiditDecision(v3Decision('s1', { liveness_checks: [livenessNode({ score: -1 })] }), expectA);
  ok('v3 negative score dropped', dNegScore.ok && dNegScore.decision.livenessScore === null);

  const matchItem = { session_id: 'other-session', vendor_data: USER_B, score: 99.1, image: 'https://example.invalid/other.jpg' };
  const dDup = parseDiditDecision(v3Decision('s1', { liveness_checks: [livenessNode({ matches: [matchItem] })] }), expectA);
  ok('v3 matches[] → duplicateSuspected (matches)', dDup.ok && dDup.decision.duplicateSuspected && dDup.decision.duplicateSignal === 'matches');
  ok('v3 matched account details are not retained', dDup.ok && !JSON.stringify(dDup.decision).includes('other-session') && !JSON.stringify(dDup.decision).includes(USER_B));
  const dWarn = parseDiditDecision(v3Decision('s1', { warnings: [{ feature: 'LIVENESS', risk: 'POSSIBLE_DUPLICATE_FACE', log_type: 'warning' }] }), expectA);
  ok('v3 root warning duplicate → duplicateSuspected (warning)', dWarn.ok && dWarn.decision.duplicateSuspected && dWarn.decision.duplicateSignal === 'warning');
  const dNodeWarn = parseDiditDecision(v3Decision('s1', { liveness_checks: [livenessNode({ warnings: [{ risk: 'FACE_SEARCH_MATCH_FOUND' }] })] }), expectA);
  ok('v3 node warning duplicate → duplicateSuspected', dNodeWarn.ok && dNodeWarn.decision.duplicateSuspected);
  const dOtherWarn = parseDiditDecision(v3Decision('s1', { warnings: [{ risk: 'LOW_FACE_QUALITY' }] }), expectA);
  ok('v3 unrelated warning is not duplicate', dOtherWarn.ok && !dOtherWarn.decision.duplicateSuspected);

  const dResub = parseDiditDecision(v3Decision('s1', { status: 'Resubmitted', liveness_checks: [] }), expectA);
  ok('v3 Resubmitted → pending + user action', dResub.ok && dResub.decision.status === 'pending' && dResub.decision.userActionRequired && !dResub.decision.livenessPassed);
  const dAwait = parseDiditDecision(v3Decision('s1', { status: 'Awaiting User', liveness_checks: [livenessNode({ status: 'Approved' })] }), expectA);
  ok('v3 Awaiting User → pending + user action (never approved)', dAwait.ok && dAwait.decision.status === 'pending' && dAwait.decision.userActionRequired);
  const dNested = parseDiditDecision({ session_id: 's1', status: 'Approved', decision: v3Decision('s1') }, expectA);
  ok('v3 webhook decision nested under decision key', dNested.ok && dNested.decision.livenessPassed);
  const dNoExpect = parseDiditDecision(v3Decision('s1', { workflow_id: undefined, vendor_data: undefined }), { sessionId: 's1' });
  ok('parser without expectations only checks session', dNoExpect.ok);

  // ── 판정 (보수적) ─────────────────────────────────────────────────────
  if (d1.ok) eq('outcome approved', resolveOutcome(d1.decision), { status: 'approved', livenessPassed: true, reason: 'liveness_approved' });
  if (dDup.ok) eq('outcome matches → in_review', resolveOutcome(dDup.decision), { status: 'in_review', livenessPassed: true, reason: 'face_search_match' });
  if (dWarn.ok) eq('outcome warning → in_review', resolveOutcome(dWarn.decision).status, 'in_review');
  if (dLivenessDeclined.ok) {
    eq('outcome incomplete → in_review', resolveOutcome(dLivenessDeclined.decision), { status: 'in_review', livenessPassed: false, reason: 'decision_incomplete' });
  }
  if (dDeclined.ok) eq('outcome declined', resolveOutcome(dDeclined.decision).status, 'rejected');
  if (dResub.ok) eq('outcome resubmitted → pending/resubmission_requested', resolveOutcome(dResub.decision), { status: 'pending', livenessPassed: false, reason: 'resubmission_requested' });
  if (dAwait.ok) eq('outcome awaiting user → pending/awaiting_user', resolveOutcome(dAwait.decision), { status: 'pending', livenessPassed: false, reason: 'awaiting_user' });
  const dDupDeclined = parseDiditDecision(v3Decision('s1', { status: 'Declined', liveness_checks: [livenessNode({ matches: [{}] })] }), expectA);
  if (dDupDeclined.ok) eq('outcome duplicate + declined → rejected', resolveOutcome(dDupDeclined.decision), { status: 'rejected', livenessPassed: true, reason: 'face_search_match' });
  const dReviewDup = parseDiditDecision(v3Decision('s1', { status: 'In Review', liveness_checks: [livenessNode({ matches: [{}] })] }), expectA);
  if (dReviewDup.ok) eq('outcome in review + matches → in_review face_search_match', resolveOutcome(dReviewDup.decision).reason, 'face_search_match');

  // ── 전이 규칙 ─────────────────────────────────────────────────────────
  const t1 = new Date('2026-09-04T00:00:00Z');
  const t2 = new Date('2026-09-04T00:05:00Z');
  eq('transition approved sticky', decideTransition({ status: 'approved', providerEventAt: t1, providerStatus: 'Approved' }, { status: 'rejected', eventAt: t2, providerStatus: 'Declined' }), 'terminal');
  eq('transition stale', decideTransition({ status: 'in_review', providerEventAt: t2, providerStatus: 'In Review' }, { status: 'rejected', eventAt: t1, providerStatus: 'Declined' }), 'stale');
  eq('transition duplicate', decideTransition({ status: 'in_review', providerEventAt: t2, providerStatus: 'In Review' }, { status: 'in_review', eventAt: t2, providerStatus: 'In Review' }), 'duplicate');
  eq('transition apply', decideTransition({ status: 'pending', providerEventAt: t1, providerStatus: 'In Progress' }, { status: 'approved', eventAt: t2, providerStatus: 'Approved' }), 'apply');
  eq('transition apply without timestamps', decideTransition({ status: 'pending', providerEventAt: null, providerStatus: null }, { status: 'approved', eventAt: null, providerStatus: 'Approved' }), 'apply');

  // ── 웹훅 서명 (X-Signature-V2 canonical JSON) ─────────────────────────
  eq('canonical sorted compact', canonicalWebhookBody({ b: 1, a: { d: 2.0, c: '한글' }, e: [1.5, null] }), '{"a":{"c":"한글","d":2},"b":1,"e":[1.5,null]}');
  ok('timing safe equal', timingSafeEqualHex('abcd', 'ABCD') && !timingSafeEqualHex('abcd', 'abce') && !timingSafeEqualHex('', ''));

  const event = v3Event();
  const good = await signedWebhook(event);
  const v1 = await verifyDiditWebhook({ rawBody: good.rawBody, headers: good.headers, secret: SECRET, nowSeconds: nowSec });
  ok('webhook valid signature', v1.ok);
  const reordered = JSON.stringify({ vendor_data: USER_A, timestamp: nowSec, created_at: nowSec, workflow_id: WORKFLOW, webhook_type: 'status.updated', status: 'Approved', session_id: 'sess-1', event_id: 'evt-1' }, null, 2);
  ok('webhook re-serialized body still valid', (await verifyDiditWebhook({ rawBody: reordered, headers: good.headers, secret: SECRET, nowSeconds: nowSec })).ok);
  eq('webhook bad signature', (await verifyDiditWebhook({ rawBody: good.rawBody, headers: { ...good.headers, signatureV2: 'deadbeef' }, secret: SECRET, nowSeconds: nowSec })), { ok: false, reason: 'bad_signature' });
  eq('webhook wrong secret', (await verifyDiditWebhook({ rawBody: good.rawBody, headers: good.headers, secret: 'other', nowSeconds: nowSec })), { ok: false, reason: 'bad_signature' });
  eq('webhook tampered body', (await verifyDiditWebhook({ rawBody: good.rawBody.replace('Approved', 'Declined'), headers: good.headers, secret: SECRET, nowSeconds: nowSec })), { ok: false, reason: 'bad_signature' });
  eq('webhook stale (6 min old)', (await verifyDiditWebhook({ rawBody: good.rawBody, headers: good.headers, secret: SECRET, nowSeconds: nowSec + 360 })), { ok: false, reason: 'stale_timestamp' });
  eq('webhook future (6 min)', (await verifyDiditWebhook({ rawBody: good.rawBody, headers: good.headers, secret: SECRET, nowSeconds: nowSec - 360 })), { ok: false, reason: 'stale_timestamp' });
  eq('webhook missing signature', (await verifyDiditWebhook({ rawBody: good.rawBody, headers: { signatureV2: null, timestamp: good.headers.timestamp }, secret: SECRET, nowSeconds: nowSec })), { ok: false, reason: 'missing_signature' });
  eq('webhook missing secret', (await verifyDiditWebhook({ rawBody: good.rawBody, headers: good.headers, secret: '', nowSeconds: nowSec })), { ok: false, reason: 'missing_secret' });
  eq('webhook invalid json', (await verifyDiditWebhook({ rawBody: '{not json', headers: good.headers, secret: SECRET, nowSeconds: nowSec })), { ok: false, reason: 'invalid_json' });
  const noTs = await signedWebhook({ session_id: 'x', status: 'Approved', webhook_type: 'status.updated' });
  eq('webhook missing timestamp', (await verifyDiditWebhook({ rawBody: noTs.rawBody, headers: { signatureV2: noTs.headers.signatureV2, timestamp: null }, secret: SECRET, nowSeconds: nowSec })), { ok: false, reason: 'missing_timestamp' });

  const ev = parseWebhookEvent(event);
  ok('webhook event parsed', !!ev && ev.kind === 'session' && ev.sessionId === 'sess-1' && ev.status === 'approved' && ev.eventId === 'evt-1' && ev.eventAt?.getTime() === nowSec * 1000);
  eq('webhook event invalid (no session id)', parseWebhookEvent({ status: 'Approved', webhook_type: 'status.updated' }), null);
  eq('webhook data.updated is a session event', parseWebhookEvent(v3Event({ webhook_type: 'data.updated' }))?.kind, 'session');
  eq('webhook transaction event unsupported', parseWebhookEvent({ event_id: 'e', webhook_type: 'transaction.status.updated', transaction_id: 't', status: 'APPROVED', created_at: nowSec }), { kind: 'unsupported', webhookType: 'transaction.status.updated', eventId: 'e' });
  eq('webhook user entity event unsupported', parseWebhookEvent({ webhook_type: 'user.status.updated', vendor_user_id: USER_A, status: 'BLOCKED', session_id: 'sess-1' })?.kind, 'unsupported');
  eq('webhook without webhook_type unsupported', parseWebhookEvent({ session_id: 'sess-1', status: 'Approved' })?.kind, 'unsupported');

  // ── 설정 fail-closed ─────────────────────────────────────────────────
  eq('didit config missing names only', loadDiditConfig(() => undefined), { ok: false, missing: ['DIDIT_API_KEY', 'DIDIT_WORKFLOW_ID', 'DIDIT_WEBHOOK_SECRET'], invalid: [] });
  eq('didit config rejects http base url', loadDiditConfig((n) => (n === 'DIDIT_API_BASE_URL' ? 'http://x' : 'v')), { ok: false, missing: [], invalid: ['DIDIT_API_BASE_URL'] });
  let threw = false;
  try {
    getFaceLivenessProvider('didit', () => undefined, async () => new Response('{}'));
  } catch (e) {
    threw = true;
    ok('provider factory error has no secret values', !String(e).includes('secret-value'));
  }
  ok('provider factory throws without secrets', threw);
  threw = false;
  try {
    getFaceLivenessProvider('acme', () => 'x', async () => new Response('{}'));
  } catch {
    threw = true;
  }
  ok('provider factory rejects unknown kind', threw);
  eq('provider factory mock kind', getFaceLivenessProvider('mock', () => undefined, async () => new Response('{}')).kind, 'mock');
  {
    const real = getFaceLivenessProvider('didit', (n) => ({ DIDIT_API_KEY: 'k', DIDIT_WORKFLOW_ID: WORKFLOW, DIDIT_WEBHOOK_SECRET: 's' })[n], async (input: string) =>
      new Response(JSON.stringify(v3Decision('s1', { workflow_id: input.includes('wrong') ? 'other' : WORKFLOW })), { status: 200 }));
    eq('didit provider exposes workflow id', real.workflowId, WORKFLOW);
    const good1 = await real.getDecision('s1', { userId: USER_A });
    ok('didit provider decision ok', good1.ok);
    const badUser = await real.getDecision('s1', { userId: USER_B });
    eq('didit provider vendor mismatch → invalid_decision', badUser, { ok: false, reason: 'invalid_decision', detail: 'vendor_mismatch' });
  }

  // ── start: 세션 생성 ─────────────────────────────────────────────────
  {
    const db = new MemoryFaceDb();
    const provider = new FakeProvider();
    // 이 블록은 세션 재사용/타 사용자 세션 시나리오까지 포함해 행을 더 만들므로 시간당 상한을 7 로 둔다
    const deps = { ...makeDeps(db, provider), limits: { maxPerHour: 7, maxPerDay: 10 } };

    const r0 = await handleStartFaceLiveness({ userId: '', body: {} }, deps);
    eq('start with empty user id → 401', r0.status, 401);
    eq('start with empty user id never reaches provider', provider.createCalls, 0);
    eq('start with empty user id creates no row', db.rows.length, 0);

    const r1 = await handleStartFaceLiveness({ userId: USER_A, body: {} }, deps);
    eq('start ok status', r1.status, 200);
    eq('start returns token once', r1.body.sessionToken, 'tok-1');
    eq('start attempt 1', r1.body.attemptCount, 1);
    ok('start row attached', db.rows.some((r) => r.providerSessionId === 'sess-1' && r.status === 'pending' && r.expiresAt !== null));
    ok('start default ttl 30m', db.rows[0].expiresAt!.getTime() === NOW.getTime() + 30 * 60 * 1000);

    provider.createResult = { ok: true, sessionId: 'sess-2', sessionToken: 'tok-2', expiresAt: '2026-09-04T01:00:00Z', providerStatus: 'Not Started' };
    const r2 = await handleStartFaceLiveness({ userId: USER_A, body: {} }, deps);
    eq('start again ok', r2.status, 200);
    eq('start supersedes previous', db.rows.find((r) => r.providerSessionId === 'sess-1')!.status, 'expired');
    eq('start provider expiry honored', r2.body.expiresAt, '2026-09-04T01:00:00.000Z');

    // Didit 이 같은 vendor_data 의 미완료 세션(sess-2) 을 그대로 돌려준 경우 — 기존 행을 다시 열고 충돌 없이 이어진다
    provider.createResult = { ok: true, sessionId: 'sess-2', sessionToken: 'tok-2b', expiresAt: null, providerStatus: 'In Progress' };
    const r2b = await handleStartFaceLiveness({ userId: USER_A, body: {} }, deps);
    eq('start reuse by provider ok', r2b.status, 200);
    eq('start reuse returns same session id', r2b.body.sessionId, 'sess-2');
    eq('start reuse row unique', db.rows.filter((r) => r.providerSessionId === 'sess-2').length, 1);
    ok('start reuse reopened row pending', db.rows.find((r) => r.providerSessionId === 'sess-2')!.status === 'pending');
    ok('start reuse superseded fresh row', db.rows.filter((r) => r.providerSessionId === null).every((r) => r.status === 'expired' && r.providerReason === 'superseded'));

    // 다른 사용자의 세션 id 가 돌아오면 절대 붙이지 않는다
    db.rows.push({ ...db.rows[0], id: 'row-b', userId: USER_B, providerSessionId: 'sess-b', status: 'pending' });
    provider.createResult = { ok: true, sessionId: 'sess-b', sessionToken: 'tok-x', expiresAt: null, providerStatus: null };
    const rb = await handleStartFaceLiveness({ userId: USER_A, body: {} }, deps);
    eq('start foreign session id → 503', rb.status, 503);
    ok('start foreign session not attached to A', db.rows.filter((r) => r.providerSessionId === 'sess-b').every((r) => r.userId === USER_B));

    provider.createResult = { ok: true, sessionId: 'sess-3', sessionToken: 'tok-3', expiresAt: null, providerStatus: null };
    const r3 = await handleStartFaceLiveness({ userId: USER_A, body: { userId: USER_B, status: 'approved', approved: true } }, deps);
    eq('start ignores client body', r3.status, 200);
    ok('start rows belong to jwt user', db.rows.filter((r) => r.id !== 'row-b').every((r) => r.userId === USER_A));
    ok('client cannot approve via start', !db.verifiedUsers.has(USER_A) && !db.verifiedUsers.has(USER_B));

    provider.createResult = { ok: false, reason: 'provider_error', httpStatus: 502 };
    const r4 = await handleStartFaceLiveness({ userId: USER_A, body: {} }, deps);
    eq('start provider outage → 503', r4.status, 503);
    eq('start provider outage reason', r4.body.error, 'provider_unavailable');
    ok('start outage row closed', db.rows.filter((r) => r.providerSessionId === null).every((r) => r.status === 'expired'));

    provider.createResult = { ok: true, sessionId: 'sess-5', sessionToken: 'tok-5', expiresAt: null, providerStatus: null };
    eq('start 7th row allowed', (await handleStartFaceLiveness({ userId: USER_A, body: {} }, deps)).status, 200);
    provider.createResult = { ok: true, sessionId: 'sess-6', sessionToken: 'tok-6', expiresAt: null, providerStatus: null };
    const r5 = await handleStartFaceLiveness({ userId: USER_A, body: {} }, deps);
    eq('start rate limited', r5.status, 429);

    db.verifiedUsers.add(USER_B);
    const r6 = await handleStartFaceLiveness({ userId: USER_B, body: {} }, deps);
    eq('start already verified', r6.status, 409);

    const mockDeps = { ...deps, provider: getFaceLivenessProvider('mock', () => undefined, async () => new Response('{}')) };
    const r7 = await handleStartFaceLiveness({ userId: USER_A, body: {} }, mockDeps);
    eq('start mock provider refused', r7.body.error, 'provider_is_mock');

    eq('start unknown action', (await handleStartFaceLiveness({ userId: USER_A, body: { action: 'approve' } }, deps)).status, 400);
  }

  // ── sync: 서버가 Decision 을 직접 조회해 승인 ─────────────────────────
  {
    const db = new MemoryFaceDb();
    const provider = new FakeProvider();
    const deps = makeDeps(db, provider);
    await handleStartFaceLiveness({ userId: USER_A, body: {} }, deps);

    provider.decisionJson = v3Decision('sess-1');
    const other = await handleStartFaceLiveness({ userId: USER_B, body: { action: 'sync', sessionId: 'sess-1' } }, deps);
    eq('sync other user session rejected', other.status, 404);
    ok('sync other user did not approve', !db.verifiedUsers.has(USER_A) && !db.verifiedUsers.has(USER_B));

    provider.decisionDown = true;
    const down = await handleStartFaceLiveness({ userId: USER_A, body: { action: 'sync', sessionId: 'sess-1' } }, deps);
    eq('sync provider down → 503', down.status, 503);
    ok('sync provider down not approved', !db.verifiedUsers.has(USER_A));
    provider.decisionDown = false;

    provider.decisionJson = v3Decision('sess-1', { liveness_checks: [] });
    const incomplete = await handleStartFaceLiveness({ userId: USER_A, body: { action: 'sync', sessionId: 'sess-1' } }, deps);
    eq('sync incomplete decision → 503', incomplete.status, 503);
    ok('sync incomplete not approved', !db.verifiedUsers.has(USER_A) && db.rows[0].status === 'pending');

    provider.decisionJson = v3Decision('sess-1', { workflow_id: 'wf-other' });
    eq('sync workflow mismatch → 503 (fail-closed)', (await handleStartFaceLiveness({ userId: USER_A, body: { action: 'sync', sessionId: 'sess-1' } }, deps)).status, 503);
    provider.decisionJson = v3Decision('sess-1', { vendor_data: USER_B });
    eq('sync vendor mismatch → 503 (fail-closed)', (await handleStartFaceLiveness({ userId: USER_A, body: { action: 'sync', sessionId: 'sess-1' } }, deps)).status, 503);
    ok('sync mismatches never approve', !db.verifiedUsers.has(USER_A));

    // Awaiting User / Resubmitted → pending + userActionRequired (무한 대기 방지)
    provider.decisionJson = v3Decision('sess-1', { status: 'Awaiting User', liveness_checks: [] });
    const awaiting = await handleStartFaceLiveness({ userId: USER_A, body: { action: 'sync', sessionId: 'sess-1' } }, deps);
    eq('sync awaiting user', awaiting.body, { ok: true, status: 'pending', faceVerified: false, userActionRequired: true });
    eq('sync awaiting user reason stored', db.rows[0].providerReason, 'awaiting_user');
    provider.decisionJson = v3Decision('sess-1', { status: 'Resubmitted', liveness_checks: [] });
    const resub = await handleStartFaceLiveness({ userId: USER_A, body: { action: 'sync', sessionId: 'sess-1' } }, deps);
    eq('sync resubmitted', resub.body, { ok: true, status: 'pending', faceVerified: false, userActionRequired: true });
    eq('sync resubmitted reason stored', db.rows[0].providerReason, 'resubmission_requested');
    ok('sync resubmitted not approved', !db.verifiedUsers.has(USER_A));

    provider.decisionJson = v3Decision('sess-1', { status: 'In Review' });
    const rev = await handleStartFaceLiveness({ userId: USER_A, body: { action: 'sync', sessionId: 'sess-1', status: 'approved', faceVerified: true } }, deps);
    eq('sync in review', rev.body, { ok: true, status: 'in_review', faceVerified: false, userActionRequired: false });
    ok('sync in review not verified', !db.verifiedUsers.has(USER_A));

    provider.decisionJson = v3Decision('sess-1', { liveness_checks: [livenessNode({ status: 'Declined' })] });
    const inc = await handleStartFaceLiveness({ userId: USER_A, body: { action: 'sync', sessionId: 'sess-1' } }, deps);
    eq('sync top-level approved but liveness declined → in_review', inc.body.status, 'in_review');
    eq('sync decision_incomplete reason', db.rows[0].providerReason, 'decision_incomplete');

    provider.decisionJson = v3Decision('sess-1');
    const appr = await handleStartFaceLiveness({ userId: USER_A, body: { action: 'sync', sessionId: 'sess-1' } }, deps);
    eq('sync approved', appr.body, { ok: true, status: 'approved', faceVerified: true, userActionRequired: false });
    eq('sync reference stored in private liveness path', db.stored.map((s) => s.path), [`${USER_A}/liveness/reference.jpg`]);
    eq('sync row reference_path', db.rows[0].referencePath, `${USER_A}/liveness/reference.jpg`);
    eq('sync approve rpc called once', db.approveCalls, 1);
    eq('sync approved reason', db.rows[0].providerReason, 'liveness_approved');

    const calls = provider.decisionCalls;
    const again = await handleStartFaceLiveness({ userId: USER_A, body: { action: 'sync', sessionId: 'sess-1' } }, deps);
    eq('sync after approval idempotent', again.body.status, 'approved');
    eq('sync after approval no provider call', provider.decisionCalls, calls);
    eq('sync after approval no extra rpc', db.approveCalls, 1);
  }

  // ── 웹훅 핸들러 ───────────────────────────────────────────────────────
  {
    const db = new MemoryFaceDb();
    const provider = new FakeProvider();
    const deps = { ...makeDeps(db, provider), webhookSecret: SECRET };
    await handleStartFaceLiveness({ userId: USER_A, body: {} }, deps);

    const bad = await handleDiditWebhook(good, { ...deps, webhookSecret: '' });
    eq('webhook secret missing → 500', bad.status, 500);

    const badSig = await handleDiditWebhook({ rawBody: good.rawBody, headers: { ...good.headers, signatureV2: 'ff' } }, deps);
    eq('webhook bad signature → 401', badSig.status, 401);
    ok('webhook bad signature no approval', !db.verifiedUsers.has(USER_A));

    const old = await signedWebhook(v3Event({ created_at: nowSec - 3600, timestamp: nowSec - 3600 }));
    eq('webhook stale → 401', (await handleDiditWebhook(old, deps)).status, 401);

    eq('webhook tampered → 401', (await handleDiditWebhook({ rawBody: good.rawBody.replace(USER_A, USER_B), headers: good.headers }, deps)).status, 401);

    // 세션 이벤트가 아닌 webhook_type → 무시 (DB 조회/Decision 조회 없음)
    const txn = await signedWebhook({ event_id: 'evt-txn', webhook_type: 'transaction.status.updated', transaction_id: 'txn-1', status: 'APPROVED', session_id: 'sess-1', created_at: nowSec, timestamp: nowSec });
    eq('webhook transaction event ignored', (await handleDiditWebhook(txn, deps)).body, { ignored: 'unsupported_event' });
    const entity = await signedWebhook({ event_id: 'evt-user', webhook_type: 'user.status.updated', vendor_user_id: USER_A, status: 'BLOCKED', created_at: nowSec, timestamp: nowSec });
    eq('webhook entity event ignored', (await handleDiditWebhook(entity, deps)).body, { ignored: 'unsupported_event' });
    eq('webhook non-session events never call provider', provider.decisionCalls, 0);
    ok('webhook non-session events untouched row', db.rows[0].status === 'pending' && db.rows[0].providerStatus === 'Not Started');

    const unknown = await signedWebhook(v3Event({ event_id: 'evt-unknown', session_id: 'nope' }));
    eq('webhook unknown session ignored', (await handleDiditWebhook(unknown, deps)).body, { ignored: 'unknown_session' });

    const mismatch = await signedWebhook(v3Event({ event_id: 'evt-vendor', vendor_data: USER_B }));
    eq('webhook vendor mismatch ignored', (await handleDiditWebhook(mismatch, deps)).body, { ignored: 'vendor_mismatch' });
    const wfMismatch = await signedWebhook(v3Event({ event_id: 'evt-wf', workflow_id: 'wf-other' }));
    eq('webhook workflow mismatch ignored', (await handleDiditWebhook(wfMismatch, deps)).body, { ignored: 'workflow_mismatch' });
    ok('webhook mismatches no approval', !db.verifiedUsers.has(USER_A));
    eq('webhook mismatches never call provider', provider.decisionCalls, 0);

    const progress = await signedWebhook(v3Event({ event_id: 'evt-progress', status: 'In Progress', created_at: nowSec - 100, timestamp: nowSec - 100 }));
    eq('webhook in progress ok', (await handleDiditWebhook(progress, deps)).status, 200);
    eq('webhook in progress row still pending', db.rows[0].status, 'pending');
    eq('webhook in progress provider status', db.rows[0].providerStatus, 'In Progress');

    // Awaiting User / Resubmitted 웹훅 → pending 유지 + 사유 코드, 승인 없음, Decision 조회 없음
    const awaiting = await signedWebhook(v3Event({ event_id: 'evt-await', status: 'Awaiting User', created_at: nowSec - 90, timestamp: nowSec - 90 }));
    eq('webhook awaiting user ok', (await handleDiditWebhook(awaiting, deps)).body, { ok: true, status: 'pending' });
    eq('webhook awaiting user reason', db.rows[0].providerReason, 'awaiting_user');
    const resub = await signedWebhook(v3Event({ event_id: 'evt-resub', status: 'Resubmitted', created_at: nowSec - 80, timestamp: nowSec - 80 }));
    eq('webhook resubmitted ok', (await handleDiditWebhook(resub, deps)).body, { ok: true, status: 'pending' });
    eq('webhook resubmitted reason', db.rows[0].providerReason, 'resubmission_requested');
    eq('webhook intermediate states no provider call', provider.decisionCalls, 0);
    ok('webhook intermediate states not approved', !db.verifiedUsers.has(USER_A));

    // Approved 웹훅이지만 Provider 장애 → 503, event_id 미기록 → 재전송이 다시 처리된다
    provider.decisionDown = true;
    const outage = await handleDiditWebhook(good, deps);
    eq('webhook approved + provider down → 503', outage.status, 503);
    ok('webhook provider down not approved', !db.verifiedUsers.has(USER_A) && db.rows[0].status === 'pending');
    ok('webhook 503 does not record event id', !db.events.has('evt-1'));
    provider.decisionDown = false;

    provider.decisionJson = v3Decision('sess-1', { status: 'In Review' });
    const inReview = await handleDiditWebhook(await signedWebhook(v3Event({ event_id: 'evt-review', status: 'In Review', created_at: nowSec - 50, timestamp: nowSec - 50 })), deps);
    eq('webhook in review', inReview.body, { ok: true, status: 'in_review' });

    // data.updated 도 세션 이벤트로 같은 경로를 탄다 (여전히 서버 재조회)
    provider.decisionJson = v3Decision('sess-1', { status: 'In Review' });
    const dataUpdated = await handleDiditWebhook(await signedWebhook(v3Event({ event_id: 'evt-data', webhook_type: 'data.updated', status: 'In Review', created_at: nowSec - 45, timestamp: nowSec - 45 })), deps);
    eq('webhook data.updated handled as session event', dataUpdated.status, 200);
    eq('webhook data.updated row still in_review', db.rows[0].status, 'in_review');

    // 중복 얼굴 matches → in_review, 승인 없음. 상대 정보는 어디에도 남지 않는다
    provider.decisionJson = v3Decision('sess-1', { liveness_checks: [livenessNode({ matches: [{ session_id: 'other', vendor_data: USER_B }] })] });
    const dup = await handleDiditWebhook(await signedWebhook(v3Event({ event_id: 'evt-dup', created_at: nowSec - 40, timestamp: nowSec - 40 })), deps);
    eq('webhook duplicate face → in_review', dup.body, { ok: true, status: 'in_review' });
    ok('webhook duplicate face not verified', !db.verifiedUsers.has(USER_A));
    eq('webhook duplicate face reason', db.rows[0].providerReason, 'face_search_match');
    ok('webhook duplicate face liveness_passed recorded', db.rows[0].livenessPassed);
    ok('webhook duplicate stores no match details', !JSON.stringify(db.rows).includes(USER_B) && !JSON.stringify(db.rows).includes('other'));

    // 실제 Approved (event_id evt-1) → approved + reference image + users.face_verified (RPC 한 번)
    provider.decisionJson = v3Decision('sess-1');
    const approved = await handleDiditWebhook(good, deps);
    eq('webhook approved', approved.body, { ok: true, status: 'approved' });
    ok('webhook approved sets face_verified', db.verifiedUsers.has(USER_A));
    eq('webhook approved reference stored', db.stored.length, 1);
    eq('webhook approved rpc once', db.approveCalls, 1);
    ok('webhook approved event recorded', db.events.has('evt-1') && db.events.get('evt-1')!.outcome === 'ok:approved');

    // 같은 event_id 재전송 → duplicate, Decision 재조회 없음
    const calls = provider.decisionCalls;
    const dupSend = await handleDiditWebhook(good, deps);
    eq('webhook event_id resend idempotent', dupSend.body, { duplicate: true });
    eq('webhook resend no provider call', provider.decisionCalls, calls);
    eq('webhook resend no extra image', db.stored.length, 1);
    eq('webhook resend no extra rpc', db.approveCalls, 1);
    // 같은 event_id 인데 body 가 다르게(재서명) 와도 event_id 기준으로 중복
    const dupAlt = await signedWebhook(v3Event({ status: 'Declined', created_at: nowSec + 5, timestamp: nowSec + 5 }));
    eq('webhook same event_id different body still duplicate', (await handleDiditWebhook(dupAlt, deps)).body, { duplicate: true });
    ok('webhook same event_id kept approval', db.rows[0].status === 'approved');

    // event_id 없는 구형 payload 재전송도 created_at+status 로 duplicate
    const { event_id: _dropped, ...legacyBody } = v3Event();
    const legacy = await signedWebhook(legacyBody);
    eq('webhook legacy resend duplicate', (await handleDiditWebhook(legacy, deps)).body, { duplicate: true, status: 'approved' });

    // 이전(오래된) Declined 이벤트가 뒤늦게 와도 승인 유지
    const stale = await signedWebhook(v3Event({ event_id: 'evt-stale', status: 'Declined', created_at: nowSec - 30, timestamp: nowSec - 30 }));
    provider.decisionJson = v3Decision('sess-1', { status: 'Declined', liveness_checks: [livenessNode({ status: 'Declined' })] });
    const staleRes = await handleDiditWebhook(stale, deps);
    eq('webhook stale declined ignored', staleRes.body.status, 'approved');
    eq('webhook stale keeps row approved', db.rows[0].status, 'approved');

    const later = await signedWebhook(v3Event({ event_id: 'evt-later', status: 'Declined', created_at: nowSec + 30, timestamp: nowSec + 30 }));
    const laterRes = await handleDiditWebhook(later, deps);
    eq('webhook later declined does not revert approval', laterRes.body, { ignored: 'already_approved', status: 'approved', faceVerified: true });
    ok('webhook approval sticky', db.rows[0].status === 'approved' && db.verifiedUsers.has(USER_A));
    eq('webhook later declined no provider call', provider.decisionCalls, calls);
  }

  // ── 순서 역전: In Review(늦게 도착) 가 Approved 를 되돌리지 못하고, pending 행에서도 오래된 이벤트는 무시 ─
  {
    const db = new MemoryFaceDb();
    const provider = new FakeProvider();
    const deps = { ...makeDeps(db, provider), webhookSecret: SECRET };
    await handleStartFaceLiveness({ userId: USER_A, body: {} }, deps);
    provider.decisionJson = v3Decision('sess-1', { status: 'In Review' });
    const newer = await handleDiditWebhook(await signedWebhook(v3Event({ event_id: 'evt-n', status: 'In Review', created_at: nowSec, timestamp: nowSec })), deps);
    eq('order: newer in review applied', newer.body.status, 'in_review');
    const older = await handleDiditWebhook(await signedWebhook(v3Event({ event_id: 'evt-o', status: 'In Progress', created_at: nowSec - 120, timestamp: nowSec - 120 })), deps);
    eq('order: older event ignored', older.body, { ignored: 'stale_event', status: 'in_review' });
    eq('order: row keeps newer status', db.rows[0].providerStatus, 'In Review');
  }

  // ── Declined / Expired 웹훅 ───────────────────────────────────────────
  {
    const db = new MemoryFaceDb();
    const provider = new FakeProvider();
    const deps = { ...makeDeps(db, provider), webhookSecret: SECRET };
    await handleStartFaceLiveness({ userId: USER_A, body: {} }, deps);

    provider.decisionJson = v3Decision('sess-1', { status: 'Declined', liveness_checks: [livenessNode({ status: 'Declined', score: 8.2 })] });
    const declined = await handleDiditWebhook(await signedWebhook(v3Event({ event_id: 'evt-d', status: 'Declined' })), deps);
    eq('webhook declined', declined.body, { ok: true, status: 'rejected' });
    ok('webhook declined not verified', !db.verifiedUsers.has(USER_A));

    // 거절된 행은 이후 Approved 가 와도 자동 승인되지 않는다 (RPC rejected_row)
    provider.decisionJson = v3Decision('sess-1');
    const lateApprove = await handleDiditWebhook(await signedWebhook(v3Event({ event_id: 'evt-late', created_at: nowSec + 10, timestamp: nowSec + 10 })), deps);
    eq('webhook approved after rejected → 503 (rpc rejected)', lateApprove.status, 503);
    ok('rejected row stays rejected', db.rows[0].status === 'rejected' && !db.verifiedUsers.has(USER_A));

    provider.createResult = { ok: true, sessionId: 'sess-2', sessionToken: 'tok-2', expiresAt: null, providerStatus: null };
    eq('retry after decline', (await handleStartFaceLiveness({ userId: USER_A, body: {} }, deps)).status, 200);

    const abandoned = await handleDiditWebhook(await signedWebhook(v3Event({ event_id: 'evt-a', session_id: 'sess-2', status: 'Abandoned', created_at: nowSec + 10, timestamp: nowSec + 10 })), deps);
    eq('webhook abandoned → expired', abandoned.body, { ok: true, status: 'expired' });

    const weird = await handleDiditWebhook(await signedWebhook(v3Event({ event_id: 'evt-w', session_id: 'sess-2', status: 'Something', created_at: nowSec + 20, timestamp: nowSec + 20 })), deps);
    eq('webhook unknown status ignored', weird.body.ignored, 'unknown_status');

    const mockRes = await handleDiditWebhook(good, { ...deps, provider: getFaceLivenessProvider('mock', () => undefined, async () => new Response('{}')) });
    eq('webhook mock provider → 503', mockRes.status, 503);
  }

  // ── reference image 실패 → 승인 금지(in_review) → 다음 sync 에서 재시도 성공 ─
  {
    const db = new MemoryFaceDb();
    const provider = new FakeProvider();
    provider.imageOk = false;
    const deps = { ...makeDeps(db, provider), webhookSecret: SECRET };
    await handleStartFaceLiveness({ userId: USER_A, body: {} }, deps);
    provider.decisionJson = v3Decision('sess-1');
    const res = await handleDiditWebhook(good, deps);
    eq('image fetch failed → in_review, not approved', res.body, { ok: true, status: 'in_review' });
    eq('image failed reason', db.rows[0].providerReason, 'reference_image_unavailable');
    ok('image failed liveness_passed recorded', db.rows[0].livenessPassed);
    eq('no image stored', db.stored.length, 0);
    ok('face_verified NOT set', !db.verifiedUsers.has(USER_A));
    eq('no approve rpc', db.approveCalls, 0);

    // 앱 sync 재시도 — 여전히 실패면 in_review 유지
    const still = await handleStartFaceLiveness({ userId: USER_A, body: { action: 'sync', sessionId: 'sess-1' } }, deps);
    eq('image still failing → in_review', still.body.status, 'in_review');
    // 이미지 복구 후 sync → approved
    provider.imageOk = true;
    const fixed = await handleStartFaceLiveness({ userId: USER_A, body: { action: 'sync', sessionId: 'sess-1' } }, deps);
    eq('image recovered → approved', fixed.body, { ok: true, status: 'approved', faceVerified: true, userActionRequired: false });
    eq('image recovered stored path', db.rows[0].referencePath, `${USER_A}/liveness/reference.jpg`);

    // Provider 가 reference_image 자체를 주지 않는 경우
    const db2 = new MemoryFaceDb();
    const p2 = new FakeProvider();
    const deps2 = { ...makeDeps(db2, p2), webhookSecret: SECRET };
    await handleStartFaceLiveness({ userId: USER_A, body: {} }, deps2);
    p2.decisionJson = v3Decision('sess-1', { liveness_checks: [livenessNode({ reference_image: null })] });
    const noUrl = await handleStartFaceLiveness({ userId: USER_A, body: { action: 'sync', sessionId: 'sess-1' } }, deps2);
    eq('no reference url → in_review', noUrl.body.status, 'in_review');
    ok('no reference url not verified', !db2.verifiedUsers.has(USER_A));
    // storage 저장 실패
    const db3 = new MemoryFaceDb();
    db3.failStore = true;
    const p3 = new FakeProvider();
    const deps3 = { ...makeDeps(db3, p3), webhookSecret: SECRET };
    await handleStartFaceLiveness({ userId: USER_A, body: {} }, deps3);
    p3.decisionJson = v3Decision('sess-1');
    eq('store failed → in_review', (await handleDiditWebhook(good, deps3)).body.status, 'in_review');
    ok('store failed not verified', !db3.verifiedUsers.has(USER_A));
    db3.failStore = false;
    eq('store recovered → approved', (await handleStartFaceLiveness({ userId: USER_A, body: { action: 'sync', sessionId: 'sess-1' } }, deps3)).body.status, 'approved');
  }

  // ── 승인 RPC 부분 실패 → 재시도로 복구 (storage 는 같은 경로에 다시 저장) ─
  {
    const db = new MemoryFaceDb();
    const provider = new FakeProvider();
    const deps = { ...makeDeps(db, provider), webhookSecret: SECRET };
    await handleStartFaceLiveness({ userId: USER_A, body: {} }, deps);
    provider.decisionJson = v3Decision('sess-1');
    db.failApprove = true;
    const failed = await handleDiditWebhook(good, deps);
    eq('rpc failure → 503 (retry)', failed.status, 503);
    ok('rpc failure row untouched', db.rows[0].status === 'pending' && !db.verifiedUsers.has(USER_A));
    ok('rpc failure event not recorded', !db.events.has('evt-1'));
    eq('rpc failure image stored once', db.stored.length, 1);
    db.failApprove = false;
    const retry = await handleDiditWebhook(good, deps);
    eq('rpc retry → approved', retry.body, { ok: true, status: 'approved' });
    ok('rpc retry face_verified', db.verifiedUsers.has(USER_A));
    eq('rpc retry same storage path', new Set(db.stored.map((s) => s.path)).size, 1);
  }

  // ── 비정상 데이터 복구: approved 행인데 users.face_verified=false / reference_path 없음 ─
  {
    const db = new MemoryFaceDb();
    const provider = new FakeProvider();
    const deps = { ...makeDeps(db, provider), webhookSecret: SECRET };
    await handleStartFaceLiveness({ userId: USER_A, body: {} }, deps);
    provider.decisionJson = v3Decision('sess-1');
    await handleStartFaceLiveness({ userId: USER_A, body: { action: 'sync', sessionId: 'sess-1' } }, deps);
    ok('setup approved', db.rows[0].status === 'approved' && db.verifiedUsers.has(USER_A));

    // (a) 사용자 플래그만 사라진 상태 → sync 가 Provider 호출 없이 RPC 로 복구
    db.verifiedUsers.delete(USER_A);
    const calls = provider.decisionCalls;
    const repaired = await handleStartFaceLiveness({ userId: USER_A, body: { action: 'sync', sessionId: 'sess-1' } }, deps);
    eq('repair flag via sync', repaired.body, { ok: true, status: 'approved', faceVerified: true, userActionRequired: false });
    eq('repair flag without provider call', provider.decisionCalls, calls);
    ok('repair flag restored', db.verifiedUsers.has(USER_A));

    // (b) 플래그 + reference_path 모두 없음 → Decision 재조회 → 이미지 저장 → RPC
    db.verifiedUsers.delete(USER_A);
    db.rows[0].referencePath = null;
    const stored = db.stored.length;
    const repaired2 = await handleStartFaceLiveness({ userId: USER_A, body: { action: 'sync', sessionId: 'sess-1' } }, deps);
    eq('repair missing reference via sync', repaired2.body.faceVerified, true);
    eq('repair missing reference re-downloaded', db.stored.length, stored + 1);
    eq('repair missing reference path set', db.rows[0].referencePath, `${USER_A}/liveness/reference.jpg`);

    // (c) 웹훅 경로에서도 복구 (Approved 재전송)
    db.verifiedUsers.delete(USER_A);
    const viaWebhook = await handleDiditWebhook(await signedWebhook(v3Event({ event_id: 'evt-repair', created_at: nowSec + 60, timestamp: nowSec + 60 })), deps);
    eq('repair via webhook', viaWebhook.body, { ignored: 'already_approved', status: 'approved', faceVerified: true });
    ok('repair via webhook restored', db.verifiedUsers.has(USER_A));

    // (d) 복구 중 Provider 장애 → 503, 승인 행은 그대로 (무한 대기 대신 앱이 재시도)
    db.verifiedUsers.delete(USER_A);
    db.rows[0].referencePath = null;
    provider.decisionDown = true;
    eq('repair provider down → 503', (await handleStartFaceLiveness({ userId: USER_A, body: { action: 'sync', sessionId: 'sess-1' } }, deps)).status, 503);
    provider.decisionDown = false;
    // (e) Provider 가 판정을 바꿔 liveness 미승인 → 절대 플래그를 세우지 않는다
    provider.decisionJson = v3Decision('sess-1', { liveness_checks: [livenessNode({ status: 'Declined' })] });
    const changed = await handleStartFaceLiveness({ userId: USER_A, body: { action: 'sync', sessionId: 'sess-1' } }, deps);
    eq('repair with liveness no longer approved → not verified', changed.body.faceVerified, false);
    ok('repair never verifies without liveness', !db.verifiedUsers.has(USER_A));
  }

  // ── 관리자 검토 (in_review 해소) ──────────────────────────────────────
  {
    const db = new MemoryFaceDb();
    const provider = new FakeProvider();
    const deps = { ...makeDeps(db, provider), webhookSecret: SECRET };
    await handleStartFaceLiveness({ userId: USER_A, body: {} }, deps);
    provider.decisionJson = v3Decision('sess-1', { liveness_checks: [livenessNode({ matches: [{ session_id: 'other' }] })] });
    await handleStartFaceLiveness({ userId: USER_A, body: { action: 'sync', sessionId: 'sess-1' } }, deps);
    const rowId = db.rows[0].id;
    ok('admin setup in_review', db.rows[0].status === 'in_review' && db.rows[0].livenessPassed);

    eq('admin unknown action → 400', (await handleAdminFaceReview({ body: { action: 'ban', rowId, actor: 'ops' } }, deps)).status, 400);
    eq('admin missing actor → 400', (await handleAdminFaceReview({ body: { action: 'approve', rowId } }, deps)).status, 400);
    eq('admin unknown row → 404', (await handleAdminFaceReview({ body: { action: 'approve', rowId: 'nope', actor: 'ops' } }, deps)).status, 404);

    // Provider 가 liveness 를 승인하지 않은 상태면 관리자도 승인 불가
    provider.decisionJson = v3Decision('sess-1', { status: 'In Review', liveness_checks: [livenessNode({ status: 'Declined', matches: [{}] })] });
    const notLive = await handleAdminFaceReview({ body: { action: 'approve', rowId, actor: 'ops' } }, deps);
    eq('admin approve without liveness approved → 409', notLive.status, 409);
    eq('admin approve without liveness reason', notLive.body.error, 'liveness_not_approved');
    ok('admin approve refused keeps in_review', db.rows[0].status === 'in_review' && !db.verifiedUsers.has(USER_A));

    // Provider 장애 → 503
    provider.decisionDown = true;
    eq('admin approve provider down → 503', (await handleAdminFaceReview({ body: { action: 'approve', rowId, actor: 'ops' } }, deps)).status, 503);
    provider.decisionDown = false;

    // reference image 를 확보하지 못하면 관리자도 승인 불가
    provider.decisionJson = v3Decision('sess-1', { status: 'In Review', liveness_checks: [livenessNode({ matches: [{}] })] });
    provider.imageOk = false;
    const noRef = await handleAdminFaceReview({ body: { action: 'approve', rowId, actor: 'ops' } }, deps);
    eq('admin approve without reference → 409', noRef.body.error, 'reference_image_unavailable');
    ok('admin approve without reference not verified', !db.verifiedUsers.has(USER_A));
    provider.imageOk = true;

    // 조건 충족 → 승인 (RPC + audit)
    const approved = await handleAdminFaceReview({ body: { action: 'approve', rowId, actor: 'ops-kim', note: '쌍둥이 확인' } }, deps);
    eq('admin approve ok', approved.body, { ok: true, status: 'approved', faceVerified: true });
    ok('admin approve sets face_verified', db.verifiedUsers.has(USER_A));
    eq('admin approve reason', db.rows[0].providerReason, 'admin_approved');
    eq('admin approve audit', db.reviews, [{ rowId, action: 'approve', previousStatus: 'in_review', newStatus: 'approved', actor: 'ops-kim', note: '쌍둥이 확인' }]);
    ok('admin response has no match details', !JSON.stringify(approved.body).includes('other'));
    eq('admin approve again → 409 invalid_state', (await handleAdminFaceReview({ body: { action: 'approve', rowId, actor: 'ops' } }, deps)).body.error, 'invalid_state');

    // decision_incomplete (liveness_passed=false) 행은 승인 불가
    const db2 = new MemoryFaceDb();
    const p2 = new FakeProvider();
    const deps2 = { ...makeDeps(db2, p2), webhookSecret: SECRET };
    await handleStartFaceLiveness({ userId: USER_A, body: {} }, deps2);
    p2.decisionJson = v3Decision('sess-1', { liveness_checks: [livenessNode({ status: 'Declined' })] });
    await handleStartFaceLiveness({ userId: USER_A, body: { action: 'sync', sessionId: 'sess-1' } }, deps2);
    ok('admin setup decision_incomplete', db2.rows[0].status === 'in_review' && !db2.rows[0].livenessPassed);
    p2.decisionJson = v3Decision('sess-1', { status: 'In Review' });
    eq('admin approve with liveness_passed=false → 409', (await handleAdminFaceReview({ body: { action: 'approve', rowId: db2.rows[0].id, actor: 'ops' } }, deps2)).body.error, 'liveness_not_passed');
    ok('admin approve with liveness_passed=false not verified', !db2.verifiedUsers.has(USER_A));

    // 거절 → rejected, 플래그 false, audit; 이후 사용자는 새 세션으로 재시도 가능
    const rejected = await handleAdminFaceReview({ body: { action: 'reject', rowId: db2.rows[0].id, actor: 'ops', note: null } }, deps2);
    eq('admin reject ok', rejected.body, { ok: true, status: 'rejected', faceVerified: false });
    eq('admin reject row', db2.rows[0].status, 'rejected');
    eq('admin reject reason', db2.rows[0].providerReason, 'admin_rejected');
    ok('admin reject not verified', !db2.verifiedUsers.has(USER_A));
    eq('admin reject audit', db2.reviews.map((r) => r.action), ['reject']);
    p2.createResult = { ok: true, sessionId: 'sess-2', sessionToken: 'tok-2', expiresAt: null, providerStatus: null };
    eq('user can retry after admin reject', (await handleStartFaceLiveness({ userId: USER_A, body: {} }, deps2)).status, 200);
    eq('admin reject twice → 409', (await handleAdminFaceReview({ body: { action: 'reject', rowId: db2.rows[0].id, actor: 'ops' } }, deps2)).status, 409);

    // repair 액션
    db.verifiedUsers.delete(USER_A);
    const repaired = await handleAdminFaceReview({ body: { action: 'repair', rowId, actor: 'ops' } }, deps);
    eq('admin repair ok', repaired.body, { ok: true, status: 'approved', faceVerified: true });
    eq('admin repair on non-approved → 409', (await handleAdminFaceReview({ body: { action: 'repair', rowId: db2.rows[0].id, actor: 'ops' } }, deps2)).status, 409);
  }

  // ── reference image 다운로드 제한 ─────────────────────────────────────
  {
    const fakeFetch = (status: number, type: string, size: number) => async () =>
      new Response(new Uint8Array(size), { status, headers: { 'content-type': type } });
    const opts = { maxBytes: 1024, allowedTypes: ['image/jpeg', 'image/png'] };
    eq('image http url rejected', (await downloadImage(fakeFetch(200, 'image/jpeg', 10), 'http://x/y.jpg', opts)), { ok: false, reason: 'insecure_url' });
    eq('image bad type', (await downloadImage(fakeFetch(200, 'video/mp4', 10), 'https://x/y.mp4', opts)), { ok: false, reason: 'bad_type' });
    eq('image too large', (await downloadImage(fakeFetch(200, 'image/jpeg', 2048), 'https://x/y.jpg', opts)), { ok: false, reason: 'too_large' });
    eq('image http error', (await downloadImage(fakeFetch(403, 'image/jpeg', 10), 'https://x/y.jpg', opts)), { ok: false, reason: 'http_error' });
    const okImg = await downloadImage(fakeFetch(200, 'image/png; charset=binary', 10), 'https://x/y.png', opts);
    ok('image ok png', okImg.ok && okImg.contentType === 'image/png' && okImg.bytes.byteLength === 10);
    eq('reference path jpeg', referenceImagePath(USER_A, 'image/jpeg'), `${USER_A}/liveness/reference.jpg`);
    eq('reference path png', referenceImagePath(USER_A, 'image/png'), `${USER_A}/liveness/reference.png`);
  }

  console.log(`face selftest: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
