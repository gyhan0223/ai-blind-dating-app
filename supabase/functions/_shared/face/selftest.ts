/**
 * 얼굴 라이브니스(Didit) 서버 로직 selftest — Node 로 실행 (Deno 불필요, 외부 API 호출 없음).
 *   node --experimental-strip-types selftest.ts
 *
 * 실제 얼굴 이미지·실사용자 데이터를 fixture 로 쓰지 않는다 (uuid / 가짜 바이트만).
 *
 * 보장 항목
 *   - 비로그인 사용자의 세션 생성 거부 (index.ts 의 requireUser 와 동일한 계약을 core 가 가정 — userId 필수)
 *   - Secret 누락 시 fail-closed (웹훅 500, provider factory throw)
 *   - 모바일이 성공 값을 조작해도 승인 불가 (sync 는 sessionId 외 어떤 값도 쓰지 않는다)
 *   - 올바르지 않은 웹훅 서명 / 오래된 timestamp / 변조된 body 거부
 *   - 동일 웹훅 재전송의 멱등성
 *   - 다른 사용자 session id 사용 거부
 *   - Approved / Declined / In Review 처리 (+ 중복 얼굴 의심 → in_review)
 *   - Provider API 장애 시 승인되지 않음
 *   - 이전 이벤트가 승인 상태를 되돌리지 않음
 *   - Provider 응답이 불완전할 때 승인되지 않음
 *   - reference image: https 만, MIME/크기 제한, private 경로 저장
 */
import { decideTransition, mapDiditStatus, parseDiditDecision, parseWebhookEvent, referenceImagePath, resolveOutcome } from './faceCore.ts';
import { downloadImage } from './diditClient.ts';
import {
  canonicalWebhookBody,
  computeDiditSignatureV2,
  timingSafeEqualHex,
  verifyDiditWebhook,
} from './diditWebhookVerifier.ts';
import { handleDiditWebhook } from './diditWebhookCore.ts';
import type { BeginSessionResult, FaceDb, FaceRow, FaceRowPatch } from './faceDb.ts';
import { silentLogger } from './faceDb.ts';
import {
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
// 인메모리 DB (0013 트리거 규칙을 흉내낸다: approved sticky, stale event 거부, liveness_passed 유지)
// ---------------------------------------------------------------------------

class MemoryFaceDb implements FaceDb {
  rows: FaceRow[] = [];
  verifiedUsers = new Set<string>();
  stored: { path: string; bytes: number; contentType: string }[] = [];
  private seq = 0;
  failStore = false;
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
      livenessPassed: false,
      referencePath: null,
      expiresAt: null,
      attemptCount: mine.length + 1,
      createdAt: new Date(),
    };
    this.rows.push(row);
    return { action: 'create', id: row.id, attemptCount: row.attemptCount };
  }

  async attachProviderSession(rowId: string, input: { providerSessionId: string; expiresAt: Date; providerStatus: string | null }) {
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
    if (patch.livenessPassed !== undefined) row.livenessPassed = patch.livenessPassed;
    if (patch.referencePath !== undefined) row.referencePath = patch.referencePath;
    if (patch.expiresAt !== undefined) row.expiresAt = patch.expiresAt;
    return { ok: true };
  }

  async setUserFaceVerified(userId: string) {
    this.verifiedUsers.add(userId);
    return { ok: true };
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
}

// ---------------------------------------------------------------------------
// 가짜 Provider (Didit 응답 형태를 시뮬레이션 — 실제 호출 없음)
// ---------------------------------------------------------------------------

type FakeDecisionJson = Record<string, unknown> | null;

class FakeProvider implements FaceLivenessProvider {
  readonly kind = 'didit' as const;
  createResult: ProviderSessionResult = { ok: true, sessionId: 'sess-1', sessionToken: 'tok-1', expiresAt: null };
  decisionJson: FakeDecisionJson = null;
  decisionDown = false;
  imageOk = true;
  createCalls = 0;
  decisionCalls = 0;

  async createSession(): Promise<ProviderSessionResult> {
    this.createCalls += 1;
    return this.createResult;
  }
  async getDecision(sessionId: string): Promise<ProviderDecisionResult> {
    this.decisionCalls += 1;
    if (this.decisionDown) return { ok: false, reason: 'provider_error', httpStatus: 503 };
    const parsed = parseDiditDecision(this.decisionJson, sessionId);
    if (!parsed.ok) return { ok: false, reason: 'invalid_decision', detail: parsed.reason };
    return { ok: true, decision: parsed.decision };
  }
  async fetchReferenceImage() {
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

function approvedDecision(sessionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: sessionId,
    status: 'Approved',
    vendor_data: USER_A,
    liveness: { status: 'Approved', method: 'ACTIVE_3D', score: 96.4, reference_image: 'https://example.invalid/ref.jpg' },
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

async function main() {
  // ── 도메인 매핑 ──────────────────────────────────────────────────────
  eq('map Approved', mapDiditStatus('Approved'), 'approved');
  eq('map Declined', mapDiditStatus('Declined'), 'rejected');
  eq('map In Review', mapDiditStatus('In Review'), 'in_review');
  eq('map In Progress', mapDiditStatus('In Progress'), 'pending');
  eq('map Abandoned', mapDiditStatus('Abandoned'), 'expired');
  eq('map Kyc Expired', mapDiditStatus('Kyc Expired'), 'expired');
  eq('map unknown', mapDiditStatus('Verified'), null);
  eq('map non-string', mapDiditStatus(1), null);

  // ── Decision 파싱 (fail-closed) ───────────────────────────────────────
  const d1 = parseDiditDecision(approvedDecision('s1'), 's1');
  ok('decision approved parses', d1.ok && d1.decision.livenessPassed && d1.decision.livenessScore === 96.4);
  ok('decision reference url https', d1.ok && d1.decision.referenceImageUrl === 'https://example.invalid/ref.jpg');
  eq('decision session mismatch', parseDiditDecision(approvedDecision('s1'), 's2'), { ok: false, reason: 'session_mismatch' });
  eq('decision missing liveness → not approvable', parseDiditDecision({ session_id: 's1', status: 'Approved' }, 's1'), {
    ok: false,
    reason: 'missing_liveness',
  });
  eq('decision invalid payload', parseDiditDecision('nope', 's1'), { ok: false, reason: 'invalid_payload' });
  eq('decision unknown status', parseDiditDecision({ session_id: 's1', status: 'Weird', liveness: {} }, 's1'), {
    ok: false,
    reason: 'unknown_status',
  });
  const dHttp = parseDiditDecision(approvedDecision('s1', { liveness: { status: 'Approved', reference_image: 'http://insecure/ref.jpg' } }), 's1');
  ok('decision http reference url dropped', dHttp.ok && dHttp.decision.referenceImageUrl === null);
  const dScore = parseDiditDecision(approvedDecision('s1', { liveness: { status: 'Approved', score: 250 } }), 's1');
  ok('decision out-of-range score dropped', dScore.ok && dScore.decision.livenessScore === null);
  const dLivenessDeclined = parseDiditDecision(approvedDecision('s1', { liveness: { status: 'Declined', score: 12 } }), 's1');
  ok('decision overall Approved but liveness Declined → livenessPassed false', dLivenessDeclined.ok && !dLivenessDeclined.decision.livenessPassed);
  const dDup = parseDiditDecision(approvedDecision('s1', { face_search: { status: 'In Review', matches: [{ session_id: 'other' }] } }), 's1');
  ok('decision face search match → duplicateSuspected', dDup.ok && dDup.decision.duplicateSuspected);
  const dWarn = parseDiditDecision(approvedDecision('s1', { warnings: [{ risk: 'POSSIBLE_DUPLICATE_FACE' }] }), 's1');
  ok('decision duplicate warning → duplicateSuspected', dWarn.ok && dWarn.decision.duplicateSuspected);
  const dNested = parseDiditDecision({ session_id: 's1', decision: approvedDecision('s1') }, 's1');
  ok('decision nested under decision key', dNested.ok && dNested.decision.livenessPassed);
  const dDeclinedNoLiveness = parseDiditDecision({ session_id: 's1', status: 'Declined' }, 's1');
  ok('decision Declined without liveness still parses (not approvable)', dDeclinedNoLiveness.ok && dDeclinedNoLiveness.decision.status === 'rejected');

  // ── 판정 (보수적) ─────────────────────────────────────────────────────
  if (d1.ok) eq('outcome approved', resolveOutcome(d1.decision), { status: 'approved', livenessPassed: true, reason: 'liveness_approved' });
  if (dDup.ok) eq('outcome duplicate → in_review', resolveOutcome(dDup.decision), { status: 'in_review', livenessPassed: true, reason: 'face_search_match' });
  if (dLivenessDeclined.ok) {
    eq('outcome incomplete → in_review', resolveOutcome(dLivenessDeclined.decision), { status: 'in_review', livenessPassed: false, reason: 'decision_incomplete' });
  }
  if (dDeclinedNoLiveness.ok) {
    eq('outcome declined', resolveOutcome(dDeclinedNoLiveness.decision).status, 'rejected');
  }
  const dDupDeclined = parseDiditDecision({ session_id: 's1', status: 'Declined', liveness: { status: 'Approved' }, face_search: { status: 'Declined' } }, 's1');
  if (dDupDeclined.ok) eq('outcome duplicate + declined → rejected', resolveOutcome(dDupDeclined.decision), { status: 'rejected', livenessPassed: true, reason: 'face_search_match' });

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

  const event = { session_id: 'sess-1', status: 'Approved', webhook_type: 'status.updated', created_at: nowSec, timestamp: nowSec, vendor_data: USER_A };
  const good = await signedWebhook(event);
  const v1 = await verifyDiditWebhook({ rawBody: good.rawBody, headers: good.headers, secret: SECRET, nowSeconds: nowSec });
  ok('webhook valid signature', v1.ok);
  // 미들웨어가 키 순서/공백을 바꿔 재직렬화해도 V2 는 통과한다
  const reordered = JSON.stringify({ vendor_data: USER_A, timestamp: nowSec, created_at: nowSec, webhook_type: 'status.updated', status: 'Approved', session_id: 'sess-1' }, null, 2);
  ok('webhook re-serialized body still valid', (await verifyDiditWebhook({ rawBody: reordered, headers: good.headers, secret: SECRET, nowSeconds: nowSec })).ok);
  eq('webhook bad signature', (await verifyDiditWebhook({ rawBody: good.rawBody, headers: { ...good.headers, signatureV2: 'deadbeef' }, secret: SECRET, nowSeconds: nowSec })), { ok: false, reason: 'bad_signature' });
  eq('webhook wrong secret', (await verifyDiditWebhook({ rawBody: good.rawBody, headers: good.headers, secret: 'other', nowSeconds: nowSec })), { ok: false, reason: 'bad_signature' });
  eq('webhook tampered body', (await verifyDiditWebhook({ rawBody: good.rawBody.replace('Approved', 'Declined'), headers: good.headers, secret: SECRET, nowSeconds: nowSec })), { ok: false, reason: 'bad_signature' });
  eq('webhook stale (6 min old)', (await verifyDiditWebhook({ rawBody: good.rawBody, headers: good.headers, secret: SECRET, nowSeconds: nowSec + 360 })), { ok: false, reason: 'stale_timestamp' });
  eq('webhook future (6 min)', (await verifyDiditWebhook({ rawBody: good.rawBody, headers: good.headers, secret: SECRET, nowSeconds: nowSec - 360 })), { ok: false, reason: 'stale_timestamp' });
  eq('webhook missing signature', (await verifyDiditWebhook({ rawBody: good.rawBody, headers: { signatureV2: null, timestamp: good.headers.timestamp }, secret: SECRET, nowSeconds: nowSec })), { ok: false, reason: 'missing_signature' });
  eq('webhook missing secret', (await verifyDiditWebhook({ rawBody: good.rawBody, headers: good.headers, secret: '', nowSeconds: nowSec })), { ok: false, reason: 'missing_secret' });
  eq('webhook invalid json', (await verifyDiditWebhook({ rawBody: '{not json', headers: good.headers, secret: SECRET, nowSeconds: nowSec })), { ok: false, reason: 'invalid_json' });
  const noTs = await signedWebhook({ session_id: 'x', status: 'Approved' });
  eq('webhook missing timestamp', (await verifyDiditWebhook({ rawBody: noTs.rawBody, headers: { signatureV2: noTs.headers.signatureV2, timestamp: null }, secret: SECRET, nowSeconds: nowSec })), { ok: false, reason: 'missing_timestamp' });
  const ev = parseWebhookEvent(event);
  ok('webhook event parsed', !!ev && ev.sessionId === 'sess-1' && ev.status === 'approved' && ev.eventAt?.getTime() === nowSec * 1000);
  eq('webhook event invalid', parseWebhookEvent({ status: 'Approved' }), null);

  // ── 설정 fail-closed ─────────────────────────────────────────────────
  eq('didit config missing names only', loadDiditConfig(() => undefined), { ok: false, missing: ['DIDIT_API_KEY', 'DIDIT_WORKFLOW_ID', 'DIDIT_WEBHOOK_SECRET'] });
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

  // ── start: 세션 생성 ─────────────────────────────────────────────────
  {
    const db = new MemoryFaceDb();
    const provider = new FakeProvider();
    const deps = makeDeps(db, provider);

    // 비로그인: index.ts 의 requireUser 가 401 을 돌려주므로 core 에는 userId 없이 도달할 수 없다.
    // core 계약상 userId 는 필수 — 빈 문자열은 세션을 만들지 않는다.
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

    // 유효한 pending 세션이 있으면 superseded 처리 후 새로 만든다 (토큰 재발급 불가 정책)
    provider.createResult = { ok: true, sessionId: 'sess-2', sessionToken: 'tok-2', expiresAt: '2026-09-04T01:00:00Z' };
    const r2 = await handleStartFaceLiveness({ userId: USER_A, body: {} }, deps);
    eq('start again ok', r2.status, 200);
    eq('start supersedes previous', db.rows.find((r) => r.providerSessionId === 'sess-1')!.status, 'expired');
    eq('start provider expiry honored', r2.body.expiresAt, '2026-09-04T01:00:00.000Z');

    // 클라이언트가 body 에 넣은 값은 무시된다
    provider.createResult = { ok: true, sessionId: 'sess-3', sessionToken: 'tok-3', expiresAt: null };
    const r3 = await handleStartFaceLiveness({ userId: USER_A, body: { userId: USER_B, status: 'approved', approved: true } }, deps);
    eq('start ignores client body', r3.status, 200);
    ok('start row belongs to jwt user', db.rows.every((r) => r.userId === USER_A));
    ok('client cannot approve via start', !db.verifiedUsers.has(USER_A) && !db.verifiedUsers.has(USER_B));

    // Provider 장애 → 503, 행은 expired/provider_create_failed 로 마감, 승인 없음
    provider.createResult = { ok: false, reason: 'provider_error', httpStatus: 502 };
    const r4 = await handleStartFaceLiveness({ userId: USER_A, body: {} }, deps);
    eq('start provider outage → 503', r4.status, 503);
    eq('start provider outage reason', r4.body.error, 'provider_unavailable');
    ok('start outage row closed', db.rows.filter((r) => r.providerSessionId === null).every((r) => r.status === 'expired'));

    // rate limit
    provider.createResult = { ok: true, sessionId: 'sess-5', sessionToken: 'tok-5', expiresAt: null };
    await handleStartFaceLiveness({ userId: USER_A, body: {} }, deps); // 5번째 행
    const r5 = await handleStartFaceLiveness({ userId: USER_A, body: {} }, deps);
    eq('start rate limited', r5.status, 429);

    // 이미 승인된 사용자
    db.verifiedUsers.add(USER_B);
    const r6 = await handleStartFaceLiveness({ userId: USER_B, body: {} }, deps);
    eq('start already verified', r6.status, 409);

    // mock provider 는 실제 세션을 만들지 않는다
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

    // 다른 사용자가 A 의 세션 id 로 sync → 404 (존재 여부 비노출)
    provider.decisionJson = approvedDecision('sess-1');
    const other = await handleStartFaceLiveness({ userId: USER_B, body: { action: 'sync', sessionId: 'sess-1' } }, deps);
    eq('sync other user session rejected', other.status, 404);
    ok('sync other user did not approve', !db.verifiedUsers.has(USER_A) && !db.verifiedUsers.has(USER_B));

    // Provider 장애 → 승인 없음
    provider.decisionDown = true;
    const down = await handleStartFaceLiveness({ userId: USER_A, body: { action: 'sync', sessionId: 'sess-1' } }, deps);
    eq('sync provider down → 503', down.status, 503);
    ok('sync provider down not approved', !db.verifiedUsers.has(USER_A));
    provider.decisionDown = false;

    // 불완전한 응답(liveness 없음) → 승인 없음
    provider.decisionJson = { session_id: 'sess-1', status: 'Approved' };
    const incomplete = await handleStartFaceLiveness({ userId: USER_A, body: { action: 'sync', sessionId: 'sess-1' } }, deps);
    eq('sync incomplete decision → 503', incomplete.status, 503);
    ok('sync incomplete not approved', !db.verifiedUsers.has(USER_A) && db.rows[0].status === 'pending');

    // 클라이언트가 status:'approved' 를 보내도 무시 — Provider 가 In Review 라면 in_review
    provider.decisionJson = { session_id: 'sess-1', status: 'In Review', liveness: { status: 'Approved', score: 80 } };
    const rev = await handleStartFaceLiveness({ userId: USER_A, body: { action: 'sync', sessionId: 'sess-1', status: 'approved', faceVerified: true } }, deps);
    eq('sync in review', rev.body, { ok: true, status: 'in_review', faceVerified: false });
    ok('sync in review not verified', !db.verifiedUsers.has(USER_A));

    // 실제 Approved → approved + reference image 저장 + face_verified
    provider.decisionJson = approvedDecision('sess-1');
    const appr = await handleStartFaceLiveness({ userId: USER_A, body: { action: 'sync', sessionId: 'sess-1' } }, deps);
    eq('sync approved', appr.body, { ok: true, status: 'approved', faceVerified: true });
    eq('sync reference stored in private liveness path', db.stored.map((s) => s.path), [`${USER_A}/liveness/reference.jpg`]);
    eq('sync row reference_path', db.rows[0].referencePath, `${USER_A}/liveness/reference.jpg`);

    // 승인 후 다시 sync 해도 Provider 를 다시 부르지 않고 approved 유지
    const calls = provider.decisionCalls;
    const again = await handleStartFaceLiveness({ userId: USER_A, body: { action: 'sync', sessionId: 'sess-1' } }, deps);
    eq('sync after approval idempotent', again.body.status, 'approved');
    eq('sync after approval no provider call', provider.decisionCalls, calls);
  }

  // ── 웹훅 핸들러 ───────────────────────────────────────────────────────
  {
    const db = new MemoryFaceDb();
    const provider = new FakeProvider();
    const deps = { ...makeDeps(db, provider), webhookSecret: SECRET };
    await handleStartFaceLiveness({ userId: USER_A, body: {} }, deps);

    // secret 누락 → 500
    const bad = await handleDiditWebhook(good, { ...deps, webhookSecret: '' });
    eq('webhook secret missing → 500', bad.status, 500);

    // 잘못된 서명 → 401
    const badSig = await handleDiditWebhook({ rawBody: good.rawBody, headers: { ...good.headers, signatureV2: 'ff' } }, deps);
    eq('webhook bad signature → 401', badSig.status, 401);
    ok('webhook bad signature no approval', !db.verifiedUsers.has(USER_A));

    // 오래된 timestamp → 401
    const old = await signedWebhook({ ...event, created_at: nowSec - 3600, timestamp: nowSec - 3600 });
    eq('webhook stale → 401', (await handleDiditWebhook(old, deps)).status, 401);

    // 변조된 body → 401
    eq('webhook tampered → 401', (await handleDiditWebhook({ rawBody: good.rawBody.replace(USER_A, USER_B), headers: good.headers }, deps)).status, 401);

    // 알 수 없는 세션 → 200 ignored
    const unknown = await signedWebhook({ ...event, session_id: 'nope' });
    eq('webhook unknown session ignored', (await handleDiditWebhook(unknown, deps)).body, { ignored: 'unknown_session' });

    // vendor_data 가 다른 사용자 → ignored (행 매핑이 우선, vendor_data 는 일치 확인용)
    const mismatch = await signedWebhook({ ...event, vendor_data: USER_B });
    eq('webhook vendor mismatch ignored', (await handleDiditWebhook(mismatch, deps)).body, { ignored: 'vendor_mismatch' });
    ok('webhook vendor mismatch no approval', !db.verifiedUsers.has(USER_A));

    // 중간 상태 → provider_status 만 갱신
    const progress = await signedWebhook({ ...event, status: 'In Progress', created_at: nowSec - 100, timestamp: nowSec - 100 });
    eq('webhook in progress ok', (await handleDiditWebhook(progress, deps)).status, 200);
    eq('webhook in progress row still pending', db.rows[0].status, 'pending');
    eq('webhook in progress provider status', db.rows[0].providerStatus, 'In Progress');

    // Approved 웹훅이지만 Provider 장애 → 503 (재시도 유도), 승인 없음
    provider.decisionDown = true;
    const outage = await handleDiditWebhook(good, deps);
    eq('webhook approved + provider down → 503', outage.status, 503);
    ok('webhook provider down not approved', !db.verifiedUsers.has(USER_A) && db.rows[0].status === 'pending');
    provider.decisionDown = false;

    // Approved 웹훅이지만 Decision 이 In Review → in_review (웹훅 status 를 믿지 않는다)
    provider.decisionJson = { session_id: 'sess-1', status: 'In Review', liveness: { status: 'Approved' } };
    const inReview = await handleDiditWebhook(await signedWebhook({ ...event, status: 'In Review', created_at: nowSec - 50, timestamp: nowSec - 50 }), deps);
    eq('webhook in review', inReview.body, { ok: true, status: 'in_review' });

    // 중복 얼굴 의심 → in_review, 승인 없음
    provider.decisionJson = approvedDecision('sess-1', { face_search: { status: 'In Review', matches: [{}] } });
    const dup = await handleDiditWebhook(await signedWebhook({ ...event, created_at: nowSec - 40, timestamp: nowSec - 40 }), deps);
    eq('webhook duplicate face → in_review', dup.body, { ok: true, status: 'in_review' });
    ok('webhook duplicate face not verified', !db.verifiedUsers.has(USER_A));

    // 실제 Approved → approved
    provider.decisionJson = approvedDecision('sess-1');
    const approved = await handleDiditWebhook(good, deps);
    eq('webhook approved', approved.body, { ok: true, status: 'approved' });
    ok('webhook approved sets face_verified', db.verifiedUsers.has(USER_A));
    eq('webhook approved reference stored', db.stored.length, 1);

    // 같은 웹훅 재전송 → duplicate, 부작용 없음
    const calls = provider.decisionCalls;
    const dupSend = await handleDiditWebhook(good, deps);
    eq('webhook resend idempotent', dupSend.body, { duplicate: true, status: 'approved' });
    eq('webhook resend no provider call', provider.decisionCalls, calls);
    eq('webhook resend no extra image', db.stored.length, 1);

    // 이전(오래된) Declined 이벤트가 뒤늦게 와도 승인 유지
    const stale = await signedWebhook({ ...event, status: 'Declined', created_at: nowSec - 30, timestamp: nowSec - 30 });
    provider.decisionJson = { session_id: 'sess-1', status: 'Declined', liveness: { status: 'Declined' } };
    const staleRes = await handleDiditWebhook(stale, deps);
    eq('webhook stale declined ignored', staleRes.body.status, 'approved');
    eq('webhook stale keeps row approved', db.rows[0].status, 'approved');

    // 최신 Declined 이벤트여도 approved 는 되돌리지 않는다
    const later = await signedWebhook({ ...event, status: 'Declined', created_at: nowSec + 30, timestamp: nowSec + 30 });
    const laterRes = await handleDiditWebhook(later, deps);
    eq('webhook later declined does not revert approval', laterRes.body, { ignored: 'already_approved', status: 'approved' });
    ok('webhook approval sticky', db.rows[0].status === 'approved' && db.verifiedUsers.has(USER_A));
  }

  // ── Declined / Expired 웹훅 ───────────────────────────────────────────
  {
    const db = new MemoryFaceDb();
    const provider = new FakeProvider();
    const deps = { ...makeDeps(db, provider), webhookSecret: SECRET };
    await handleStartFaceLiveness({ userId: USER_A, body: {} }, deps);

    provider.decisionJson = { session_id: 'sess-1', status: 'Declined', liveness: { status: 'Declined', score: 8.2, method: 'ACTIVE_3D' } };
    const declined = await handleDiditWebhook(await signedWebhook({ ...event, status: 'Declined' }), deps);
    eq('webhook declined', declined.body, { ok: true, status: 'rejected' });
    ok('webhook declined not verified', !db.verifiedUsers.has(USER_A));

    // 거절 뒤 재시도(새 세션) 가능 — rate limit 안에서
    provider.createResult = { ok: true, sessionId: 'sess-2', sessionToken: 'tok-2', expiresAt: null };
    eq('retry after decline', (await handleStartFaceLiveness({ userId: USER_A, body: {} }, deps)).status, 200);

    const abandoned = await handleDiditWebhook(await signedWebhook({ ...event, session_id: 'sess-2', status: 'Abandoned', created_at: nowSec + 10, timestamp: nowSec + 10 }), deps);
    eq('webhook abandoned → expired', abandoned.body, { ok: true, status: 'expired' });

    // 알 수 없는 상태 문자열 → 무시
    const weird = await handleDiditWebhook(await signedWebhook({ ...event, session_id: 'sess-2', status: 'Something', created_at: nowSec + 20, timestamp: nowSec + 20 }), deps);
    eq('webhook unknown status ignored', weird.body.ignored, 'unknown_status');

    // mock provider 로는 웹훅을 받지 않는다
    const mockRes = await handleDiditWebhook(good, { ...deps, provider: getFaceLivenessProvider('mock', () => undefined, async () => new Response('{}')) });
    eq('webhook mock provider → 503', mockRes.status, 503);
  }

  // ── 승인 시 reference image 실패해도 승인은 유지 (사유 코드 기록) ─────
  {
    const db = new MemoryFaceDb();
    const provider = new FakeProvider();
    provider.imageOk = false;
    const deps = { ...makeDeps(db, provider), webhookSecret: SECRET };
    await handleStartFaceLiveness({ userId: USER_A, body: {} }, deps);
    provider.decisionJson = approvedDecision('sess-1');
    const res = await handleDiditWebhook(good, deps);
    eq('approved without reference image', res.body, { ok: true, status: 'approved' });
    eq('no image stored', db.stored.length, 0);
    ok('face_verified still set', db.verifiedUsers.has(USER_A));
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
