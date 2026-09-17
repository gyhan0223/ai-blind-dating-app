/**
 * verify-identity 핵심 흐름 — 순수 모듈 (Deno Edge Function / Node selftest 겸용). Issue #6.
 *
 * Edge handler(verify-identity/index.ts)는 JWT 검증·베타 입장·rate limit 만 하고 이 함수를 부른다.
 * Provider · DB · Auth · 시계는 전부 주입된다 → selftest 가 Provider 결과(성공/실패/지연/오류)와
 * DB·Auth 의 부분 실패를 제어하면서 "Provider 결과 → 서버 검증 → identity 연결 → 계정 복구" 전이를 검증한다.
 *
 * 서버가 지키는 것
 *   1. 본인확인 세션은 서버가 만든다 (identity_verification_sessions). 클라이언트는 우리 세션 id(requestId)만 안다.
 *      confirm/recover 는 세션이 (호출자 JWT 의 사용자 소유 · 만료 전 · 아직 쓰지 않음) 일 때만 진행한다.
 *      같은 세션의 동시 confirm 은 조건부 갱신(pending→checking)으로 하나만 Provider 에 닿는다.
 *   2. 생년월일·성별·identityKey 는 클라이언트 입력이 아니라 Provider 결과에서만 가져온다.
 *      클라이언트 입력(name/birthDate/carrier)은 Provider 에 전달만 하고 저장·판단에 쓰지 않는다.
 *   3. 성인 판정은 주입된 시계로 한다 (기존 정책: 만 19세 이상, identityCore.isAdult).
 *   4. identity 연결은 DB 의 UNIQUE(identity_key_hash) · UNIQUE(user_id) 와 조건부 갱신(user_id is null)을 최종 방어선으로 쓴다.
 *      "0행 갱신" 도 실패로 다루어 두 계정이 같은 identity 로 인증 완료 표시되는 일이 없게 한다.
 *   5. recover 는 confirm 이 세션에 남긴 서버 검증 결과만 쓴다 (Provider 재호출 없음 · 클라이언트가 대상 계정을 고를 수 없음).
 *      전화번호는 OTP 로 소유가 확인된 auth 세션 값만 쓰고, 현재 계정이 "identity 연결 전 빈 계정" 일 때만 지운다.
 *   6. Auth 삭제 → Auth 번호 이동 사이의 부분 실패는 "새 계정 없음 · 기존 계정 그대로" 로 남아 재로그인 → 재인증 → 복구로 이어진다.
 *   7. raw identityKey · 이름 · 전화번호 전체 · 인증번호 · Provider 응답 전문은 응답·이벤트·로그 어디에도 넣지 않는다.
 */
import type { IdentityRequestInput, IdentityVerificationProvider } from './IdentityVerificationProvider.ts';
import { decideIdentityOutcome, hashIdentityKey, isAdult, maskPhone, type ExistingIdentity, type IdentityOutcome } from './identityCore.ts';

// ---------------------------------------------------------------------------
// 주입 인터페이스
// ---------------------------------------------------------------------------

export type SessionStatus = 'pending' | 'checking' | 'completed' | 'existing_account' | 'recovered' | 'failed' | 'expired';

export type SessionRow = {
  id: string;
  userId: string;
  provider: string;
  providerSessionId: string | null;
  status: SessionStatus;
  outcome: IdentityOutcome | 'underage' | null;
  identityKeyHash: string | null;
  birthDate: string | null;
  gender: 'male' | 'female' | null;
  ownerUserId: string | null;
  attempts: number;
  expiresAt: string; // ISO
  checkingSince: string | null;
};

export type SessionPatch = Partial<Pick<SessionRow, 'status' | 'outcome' | 'identityKeyHash' | 'birthDate' | 'gender' | 'ownerUserId' | 'attempts' | 'expiresAt' | 'checkingSince'>> & {
  consumedAt?: string | null;
};

export type IdentityRow = { id: string; userId: string | null; banned: boolean };

export interface IdentityDb {
  createSession(input: { userId: string; provider: string; providerSessionId: string | null; expiresAt: string }): Promise<{ id: string } | null>;
  getSession(id: string): Promise<SessionRow | null>;
  /** 조건부 점유: (id, user_id) 가 맞고 expires_at > now 이며 status=pending 이거나 (checking 이면서 checking_since < staleBefore) 일 때만 checking 으로. 아니면 null */
  claimSession(id: string, userId: string, nowIso: string, staleBeforeIso: string): Promise<SessionRow | null>;
  /** status 가 expectStatus 일 때만 갱신. 갱신된 행이 없으면 false */
  updateSession(id: string, patch: SessionPatch, expectStatus: SessionStatus): Promise<boolean>;
  findIdentityByHash(hash: string): Promise<IdentityRow | null>;
  findIdentityByUser(userId: string): Promise<IdentityRow | null>;
  getUser(userId: string): Promise<{ status: string; phone: string | null; identityVerified: boolean } | null>;
  insertIdentity(row: { userId: string; identityKeyHash: string; birthDate: string; gender: 'male' | 'female' | null; verifiedAt: string }): Promise<'ok' | 'conflict' | 'error'>;
  /** user_id is null 인 행만 재연결. 갱신된 행 수 */
  relinkIdentity(id: string, userId: string, birthDate: string, gender: 'male' | 'female' | null, verifiedAt: string): Promise<number>;
  markUserVerified(userId: string): Promise<boolean>;
  upsertPrivateProfile(userId: string, birthDate: string, phoneE164: string | null): Promise<boolean>;
  setUserPhone(userId: string, phoneE164: string, atIso: string): Promise<boolean>;
  reactivateIfDeleted(userId: string): Promise<boolean>;
  logEvent(userId: string | null, eventType: DeviceEventType, meta: Record<string, string | number | boolean>): Promise<void>;
}

export type DeviceEventType = 'verification_failure' | 'duplicate_identity_attempt' | 'banned_identity_attempt' | 'account_recovery' | 'signup_success';

export interface IdentityAuth {
  /** auth.users 의 전화번호 (E.164) 와 OTP 확인 여부. 없으면 null */
  getUser(userId: string): Promise<{ phoneE164: string | null; phoneConfirmed: boolean } | null>;
  deleteUser(userId: string): Promise<boolean>;
  /** 기존 계정에 새 전화번호를 연결 (phone_confirm) */
  updateUserPhone(userId: string, phoneE164: string): Promise<boolean>;
}

export type VerifyDeps = {
  provider: IdentityVerificationProvider;
  providerKind: string;
  db: IdentityDb;
  auth: IdentityAuth;
  identitySecret: string;
  now: () => Date;
  /** 인증번호 입력 대기 (기본 10분) */
  sessionTtlSeconds?: number;
  /** existing_account → recover 허용 창 (기본 15분) */
  recoveryTtlSeconds?: number;
  /** checking 점유가 이 시간보다 오래되면 죽은 요청으로 보고 다시 점유할 수 있다 (기본 120초) */
  checkingLeaseSeconds?: number;
  /** Provider 실패(틀린 코드 등) 허용 횟수 (기본 5) */
  maxAttempts?: number;
};

export type VerifyRequest = {
  userId: string;
  action: string;
  requestId?: unknown;
  code?: unknown;
  name?: unknown;
  birthDate?: unknown;
  carrier?: unknown;
};

export type VerifyResponse = { status: number; body: Record<string, unknown> };

export const DEFAULT_SESSION_TTL_SECONDS = 10 * 60;
export const DEFAULT_RECOVERY_TTL_SECONDS = 15 * 60;
export const DEFAULT_CHECKING_LEASE_SECONDS = 120;
export const DEFAULT_MAX_ATTEMPTS = 5;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BIRTH_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Provider 가 준 실패 사유는 코드 형태만 응답에 싣는다 (문장·개인정보·전문이 섞이지 않게) */
export function sanitizeReason(reason: unknown): string {
  return typeof reason === 'string' && /^[a-z0-9_]{1,40}$/.test(reason) ? reason : 'failed';
}

function normalizeAuthPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, '');
  return digits ? `+${digits}` : null;
}

function iso(d: Date): string {
  return d.toISOString();
}

function addSeconds(d: Date, s: number): Date {
  return new Date(d.getTime() + s * 1000);
}

// ---------------------------------------------------------------------------
// 진입점
// ---------------------------------------------------------------------------

export async function runVerifyIdentity(req: VerifyRequest, deps: VerifyDeps): Promise<VerifyResponse> {
  const authUser = await deps.auth.getUser(req.userId);
  if (!authUser) return { status: 401, body: { error: 'unauthorized' } };
  const authPhoneE164 = authUser.phoneConfirmed ? normalizeAuthPhone(authUser.phoneE164) : null;

  const input: IdentityRequestInput = {
    name: typeof req.name === 'string' ? req.name : '',
    birthDate: typeof req.birthDate === 'string' ? req.birthDate : '',
    phoneE164: authPhoneE164,
    carrier: typeof req.carrier === 'string' ? req.carrier : '',
  };

  if (req.action === 'request') return startSession(req, input, deps);
  if (req.action === 'confirm') return confirmSession(req, input, authPhoneE164, deps);
  if (req.action === 'recover') return recoverAccount(req, authPhoneE164, deps);
  return { status: 400, body: { error: 'unknown_action' } };
}

// ---------------------------------------------------------------------------
// request — Provider 세션 시작 + 서버 세션 행
// ---------------------------------------------------------------------------

async function startSession(req: VerifyRequest, input: IdentityRequestInput, deps: VerifyDeps): Promise<VerifyResponse> {
  if (!input.name.trim() || !BIRTH_RE.test(input.birthDate)) return { status: 400, body: { error: 'invalid_input' } };
  let providerSession: { verificationId: string; redirectUrl: string | null };
  try {
    providerSession = await deps.provider.startVerification(input);
  } catch {
    return { status: 503, body: { error: 'provider_unavailable' } };
  }
  const now = deps.now();
  const row = await deps.db.createSession({
    userId: req.userId,
    provider: deps.providerKind,
    providerSessionId: providerSession.verificationId,
    expiresAt: iso(addSeconds(now, deps.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS)),
  });
  if (!row) return { status: 500, body: { error: 'session_create_failed' } };
  return { status: 200, body: { requestId: row.id, redirectUrl: providerSession.redirectUrl } };
}

// ---------------------------------------------------------------------------
// confirm — 세션 점유 → Provider 결과 → 성인 판정 → identity 분기 → 연결
// ---------------------------------------------------------------------------

function replayOutcome(session: SessionRow, ownerPhoneMasked: string | null): VerifyResponse {
  switch (session.outcome) {
    case 'created':
    case 'already_verified':
    case 'relinked':
      return { status: 200, body: { verified: true, result: session.outcome, ageVerified: true } };
    case 'existing_account':
      return { status: 200, body: { verified: false, result: 'existing_account', maskedPhone: ownerPhoneMasked } };
    case 'blocked':
      return { status: 200, body: { verified: false, result: 'blocked', reason: 'blocked' } };
    case 'underage':
      return { status: 200, body: { verified: false, result: 'underage', reason: 'underage' } };
    default:
      return { status: 400, body: { error: 'invalid_session' } };
  }
}

/** 세션을 점유하지 못했을 때 왜인지 — 소유자가 아니면 존재 여부와 무관하게 invalid_session */
async function explainUnclaimable(sessionId: string, userId: string, now: Date, deps: VerifyDeps): Promise<VerifyResponse> {
  const s = await deps.db.getSession(sessionId);
  if (!s || s.userId !== userId) {
    if (s) await deps.db.logEvent(userId, 'verification_failure', { reason: 'session_not_owned' });
    return { status: 400, body: { error: 'invalid_session' } };
  }
  if (s.status === 'checking') return { status: 409, body: { error: 'session_in_progress' } };
  if (s.status === 'completed' || s.status === 'existing_account') {
    // 같은 사용자의 재전송(응답 유실 뒤 재시도) — 다시 연결하지 않고 저장된 결과를 돌려준다
    const owner = s.ownerUserId ? await deps.db.getUser(s.ownerUserId) : null;
    return replayOutcome(s, maskPhone(owner?.phone));
  }
  if (s.status === 'failed') return { status: 400, body: { error: 'too_many_attempts' } };
  if (s.status === 'recovered') return { status: 400, body: { error: 'invalid_session' } };
  if (s.status === 'pending' && new Date(s.expiresAt).getTime() <= now.getTime()) {
    await deps.db.updateSession(s.id, { status: 'expired' }, 'pending');
    return { status: 400, body: { error: 'session_expired' } };
  }
  return { status: 400, body: { error: 'session_expired' } };
}

async function loadExisting(identity: IdentityRow | null, deps: VerifyDeps): Promise<{ existing: ExistingIdentity; ownerPhone: string | null }> {
  if (!identity) return { existing: null, ownerPhone: null };
  let userStatus: string | null = null;
  let ownerPhone: string | null = null;
  if (identity.userId) {
    const owner = await deps.db.getUser(identity.userId);
    userStatus = owner?.status ?? null;
    ownerPhone = owner?.phone ?? null;
  }
  return { existing: { userId: identity.userId, banned: identity.banned, userStatus }, ownerPhone };
}

async function confirmSession(req: VerifyRequest, input: IdentityRequestInput, authPhoneE164: string | null, deps: VerifyDeps): Promise<VerifyResponse> {
  const sessionId = typeof req.requestId === 'string' ? req.requestId : '';
  if (!UUID_RE.test(sessionId)) return { status: 400, body: { error: 'invalid_session' } };
  const code = typeof req.code === 'string' ? req.code : '';
  const now = deps.now();
  const lease = deps.checkingLeaseSeconds ?? DEFAULT_CHECKING_LEASE_SECONDS;

  const session = await deps.db.claimSession(sessionId, req.userId, iso(now), iso(addSeconds(now, -lease)));
  if (!session) return explainUnclaimable(sessionId, req.userId, now, deps);

  // ── Provider 결과 ───────────────────────────────────────────────────────
  let result: Awaited<ReturnType<IdentityVerificationProvider['getVerificationResult']>>;
  try {
    result = await deps.provider.getVerificationResult(session.providerSessionId ?? '', code, input);
  } catch {
    // 네트워크/Provider 장애 — 세션을 돌려놓고 재시도할 수 있게 한다 (성공으로 처리하지 않는다)
    await deps.db.updateSession(session.id, { status: 'pending', checkingSince: null }, 'checking');
    return { status: 503, body: { error: 'provider_unavailable' } };
  }

  if (!result.verified) {
    // 취소·만료·연속 실패는 세션을 끝내고, 그 외(틀린 코드 등)는 남은 횟수 안에서 다시 시도할 수 있게 pending 으로 돌린다
    const reason = sanitizeReason(result.reason);
    const attempts = session.attempts + 1;
    const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    let nextStatus: SessionStatus = 'pending';
    let responseReason = reason;
    if (reason === 'expired') nextStatus = 'expired';
    else if (reason === 'cancelled') nextStatus = 'failed';
    else if (attempts >= maxAttempts) {
      nextStatus = 'failed';
      responseReason = 'too_many_attempts';
    }
    await deps.db.updateSession(session.id, { status: nextStatus, attempts, checkingSince: null }, 'checking');
    await deps.db.logEvent(req.userId, 'verification_failure', { reason });
    return { status: 200, body: { verified: false, result: 'failed', reason: responseReason } };
  }

  // Provider 결과만 신뢰한다 — 클라이언트 birthDate/name 은 여기서 더 이상 쓰지 않는다
  if (!BIRTH_RE.test(result.birthDate) || !result.identityKey) {
    await deps.db.updateSession(session.id, { status: 'failed', checkingSince: null }, 'checking');
    return { status: 502, body: { error: 'provider_result_invalid' } };
  }
  const gender = result.gender === 'male' || result.gender === 'female' ? result.gender : null;

  if (!isAdult(result.birthDate, now)) {
    await deps.db.updateSession(session.id, { status: 'completed', outcome: 'underage', consumedAt: iso(now), checkingSince: null }, 'checking');
    return { status: 200, body: { verified: false, result: 'underage', reason: 'underage' } };
  }

  // raw identityKey 는 즉시 해시로 바꾸고 더 이상 쓰지 않는다
  const identityKeyHash = await hashIdentityKey(result.identityKey, deps.identitySecret);

  // 이 계정에 이미 다른 identity 가 연결돼 있으면 (다른 사람으로 재인증 시도) 연결하지 않는다
  const mine = await deps.db.findIdentityByUser(req.userId);
  if (mine && mine.id !== (await deps.db.findIdentityByHash(identityKeyHash))?.id) {
    await deps.db.updateSession(session.id, { status: 'failed', checkingSince: null }, 'checking');
    await deps.db.logEvent(req.userId, 'verification_failure', { reason: 'identity_mismatch' });
    return { status: 409, body: { error: 'identity_mismatch' } };
  }

  const linked = await linkIdentity(req.userId, identityKeyHash, result.birthDate, gender, now, deps);

  switch (linked.outcome) {
    case 'blocked': {
      await deps.db.updateSession(session.id, { status: 'completed', outcome: 'blocked', identityKeyHash, consumedAt: iso(now), checkingSince: null }, 'checking');
      await deps.db.logEvent(req.userId, 'banned_identity_attempt', {});
      return { status: 200, body: { verified: false, result: 'blocked', reason: 'blocked' } };
    }
    case 'existing_account': {
      // 복구는 이 세션이 남긴 서버 검증 결과로만 진행된다 (recover 창은 짧게)
      await deps.db.updateSession(
        session.id,
        {
          status: 'existing_account',
          outcome: 'existing_account',
          identityKeyHash,
          birthDate: result.birthDate,
          gender,
          ownerUserId: linked.ownerUserId,
          expiresAt: iso(addSeconds(now, deps.recoveryTtlSeconds ?? DEFAULT_RECOVERY_TTL_SECONDS)),
          consumedAt: iso(now),
          checkingSince: null,
        },
        'checking',
      );
      await deps.db.logEvent(req.userId, 'duplicate_identity_attempt', {});
      return { status: 200, body: { verified: false, result: 'existing_account', maskedPhone: maskPhone(linked.ownerPhone) } };
    }
    case 'error':
      await deps.db.updateSession(session.id, { status: 'pending', checkingSince: null }, 'checking');
      return { status: 500, body: { error: 'update_failed' } };
    case 'created':
    case 'relinked':
    case 'already_verified':
      break;
  }

  // 서버 전용 플래그 + 매칭용 생년월일 (Provider 값)
  if (!(await deps.db.markUserVerified(req.userId))) {
    await deps.db.updateSession(session.id, { status: 'pending', checkingSince: null }, 'checking');
    return { status: 500, body: { error: 'update_failed' } };
  }
  if (!(await deps.db.upsertPrivateProfile(req.userId, result.birthDate, authPhoneE164))) {
    await deps.db.updateSession(session.id, { status: 'pending', checkingSince: null }, 'checking');
    return { status: 500, body: { error: 'update_failed' } };
  }
  await deps.db.updateSession(session.id, { status: 'completed', outcome: linked.outcome, identityKeyHash, birthDate: result.birthDate, gender, consumedAt: iso(now), checkingSince: null }, 'checking');
  await deps.db.logEvent(req.userId, 'signup_success', {});
  return { status: 200, body: { verified: true, result: linked.outcome, ageVerified: true } };
}

type LinkResult =
  | { outcome: 'created' | 'relinked' | 'already_verified' }
  | { outcome: 'blocked' }
  | { outcome: 'existing_account'; ownerUserId: string; ownerPhone: string | null }
  | { outcome: 'error' };

/**
 * identity 연결. 조회 → 판단 → 조건부 쓰기. 쓰기가 경쟁에 져서 실패하면(UNIQUE 위반·0행 갱신) 다시 조회해 판단한다.
 * 두 번째 판단에서도 쓰기가 필요하면 한 번 더 시도하지 않고 error 로 끝낸다 (재시도는 호출자·클라이언트 몫).
 */
async function linkIdentity(userId: string, hash: string, birthDate: string, gender: 'male' | 'female' | null, now: Date, deps: VerifyDeps): Promise<LinkResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const identity = await deps.db.findIdentityByHash(hash);
    const { existing, ownerPhone } = await loadExisting(identity, deps);
    const outcome = decideIdentityOutcome(existing, userId);
    if (outcome === 'blocked') return { outcome: 'blocked' };
    if (outcome === 'existing_account') return { outcome: 'existing_account', ownerUserId: identity!.userId!, ownerPhone };
    if (outcome === 'already_verified') return { outcome: 'already_verified' };
    if (outcome === 'created') {
      const r = await deps.db.insertIdentity({ userId, identityKeyHash: hash, birthDate, gender, verifiedAt: iso(now) });
      if (r === 'ok') return { outcome: 'created' };
      if (r === 'error') return { outcome: 'error' };
      continue; // conflict: 다른 요청이 방금 같은 identity 를 등록했다 → 재조회
    }
    // relinked — user_id is null 인 행만. 0행이면 동시에 다른 계정이 재연결한 것 → 재조회
    const n = await deps.db.relinkIdentity(identity!.id, userId, birthDate, gender, iso(now));
    if (n === 1) return { outcome: 'relinked' };
  }
  return { outcome: 'error' };
}

// ---------------------------------------------------------------------------
// recover — confirm 이 남긴 existing_account 결과로만 기존 계정에 현재 번호를 연결
// ---------------------------------------------------------------------------

async function recoverAccount(req: VerifyRequest, authPhoneE164: string | null, deps: VerifyDeps): Promise<VerifyResponse> {
  const sessionId = typeof req.requestId === 'string' ? req.requestId : '';
  if (!UUID_RE.test(sessionId)) return { status: 400, body: { error: 'invalid_session' } };
  const now = deps.now();

  const session = await deps.db.getSession(sessionId);
  if (!session || session.userId !== req.userId) {
    if (session) await deps.db.logEvent(req.userId, 'verification_failure', { reason: 'session_not_owned' });
    return { status: 400, body: { error: 'invalid_session' } };
  }
  if (session.status === 'checking') return { status: 409, body: { error: 'session_in_progress' } };
  if (session.status !== 'existing_account' || !session.ownerUserId || !session.identityKeyHash) {
    return { status: 400, body: { error: 'not_recoverable' } };
  }
  if (new Date(session.expiresAt).getTime() <= now.getTime()) {
    await deps.db.updateSession(session.id, { status: 'expired' }, 'existing_account');
    return { status: 400, body: { error: 'session_expired' } };
  }
  // 번호 소유가 OTP 로 확인된 로그인만 (이메일/개발 로그인·미확인 번호 불가)
  if (!authPhoneE164) return { status: 400, body: { error: 'phone_login_required' } };

  // 현재 계정은 identity 연결 전의 빈 계정이어야 한다 — 그렇지 않으면 다른 계정을 지우는 셈이 된다
  const me = await deps.db.getUser(req.userId);
  if (!me || me.identityVerified || (await deps.db.findIdentityByUser(req.userId))) {
    return { status: 400, body: { error: 'not_recoverable' } };
  }

  // confirm 이후 상태가 바뀌었을 수 있다 — 대상 계정을 다시 판단한다 (차단·삭제·다른 계정으로 이동)
  const identity = await deps.db.findIdentityByHash(session.identityKeyHash);
  const { existing } = await loadExisting(identity, deps);
  if (!identity || identity.userId !== session.ownerUserId || decideIdentityOutcome(existing, req.userId) !== 'existing_account') {
    await deps.db.updateSession(session.id, { status: 'failed', checkingSince: null }, 'existing_account');
    return { status: 400, body: { error: 'not_recoverable' } };
  }
  const oldUserId = session.ownerUserId;

  // 점유 — 같은 세션의 동시 recover 는 하나만 진행
  if (!(await deps.db.updateSession(session.id, { status: 'checking', checkingSince: iso(now) }, 'existing_account'))) {
    return { status: 409, body: { error: 'session_in_progress' } };
  }

  // 1) 현재 세션의 빈 신규 계정을 지워 전화번호를 해제한다 (Auth 는 전화번호 UNIQUE 라 순서를 바꿀 수 없다)
  if (!(await deps.auth.deleteUser(req.userId))) {
    await deps.db.updateSession(session.id, { status: 'existing_account', checkingSince: null }, 'checking');
    await deps.db.logEvent(oldUserId, 'account_recovery', { ok: false, stage: 'delete_new_account' });
    return { status: 500, body: { error: 'recover_failed' } };
  }
  // 이 시점부터 세션 행은 계정 삭제(cascade)로 사라졌고 호출자 JWT 도 무효다.
  // 2) 기존 계정에 번호 연결. 실패하면 "새 계정 없음 · 기존 계정 그대로" 로 남는다 → 사용자는 같은 번호로 재로그인해 다시 인증·복구한다
  if (!(await deps.auth.updateUserPhone(oldUserId, authPhoneE164))) {
    await deps.db.logEvent(oldUserId, 'account_recovery', { ok: false, stage: 'move_phone' });
    return { status: 500, body: { error: 'recover_failed' } };
  }
  // 3) 앱 DB 반영 (auth 트리거가 phone 을 동기화하지만 명시적으로도 맞춘다) + 유예 중 탈퇴 계정이면 재활성화
  await deps.db.setUserPhone(oldUserId, authPhoneE164, iso(now));
  await deps.db.reactivateIfDeleted(oldUserId);
  await deps.db.logEvent(oldUserId, 'account_recovery', { ok: true });
  return { status: 200, body: { recovered: true } };
}
