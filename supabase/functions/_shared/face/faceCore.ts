/**
 * 얼굴 라이브니스 도메인 핵심 로직 — 순수 모듈 (Deno Edge Function / Node selftest 겸용).
 * Deno 전역·npm 의존 없음. Provider(Didit) 응답을 "내부 도메인 상태" 로 바꾸는 유일한 지점이다.
 *
 * 보안 원칙
 *   - 클라이언트가 보낸 어떤 값도 승인 판단에 쓰지 않는다. 승인은 서명 검증된 웹훅 + 서버가 직접
 *     조회한 Decision 결과로만 결정된다.
 *   - fail-closed: payload 가 불완전하거나 알 수 없는 형태면 절대 approved 로 해석하지 않는다.
 *   - approved 는 sticky — 뒤늦게 도착한 오래된 이벤트가 승인을 되돌리지 못한다 (DB 트리거가 최종 방어).
 *   - 중복 얼굴(Face Search 1:N) 의심은 자동 승인하지 않고 in_review 로 둔다. 어떤 계정과 유사한지는
 *     저장·노출하지 않으며 사유 코드만 남긴다.
 *   - 라이브니스는 "실제 사람이 카메라 앞에 있다" 만 확인한다. 실명·생년월일·성인 여부를 증명하지 않는다.
 */

// ---------------------------------------------------------------------------
// 내부 도메인 상태
// ---------------------------------------------------------------------------

export type FaceVerificationStatus = 'pending' | 'approved' | 'rejected' | 'in_review' | 'expired';

export const FACE_VERIFICATION_STATUSES: readonly FaceVerificationStatus[] = [
  'pending',
  'approved',
  'rejected',
  'in_review',
  'expired',
];

/** 사유 코드 — DB provider_reason 에 저장되는 값. 사용자 노출 문구는 모바일이 코드별로 결정한다. */
export type FaceReasonCode =
  | 'liveness_approved'
  | 'liveness_declined'
  | 'face_search_match'
  | 'in_review'
  | 'session_expired'
  | 'session_abandoned'
  | 'superseded'
  | 'provider_create_failed'
  | 'decision_unavailable'
  | 'decision_incomplete'
  | 'reference_image_unavailable';

// ---------------------------------------------------------------------------
// 세션 생성 제한 (Provider 워크플로의 "세션 안 재시도 최대 3회" 와 별개로, 세션 자체의 생성 횟수)
// ---------------------------------------------------------------------------

export const FACE_SESSION_MAX_PER_HOUR = 5;
export const FACE_SESSION_MAX_PER_DAY = 10;
/** Provider 응답에 만료 시각이 없을 때 서버가 가정하는 세션 유효 시간 */
export const FACE_SESSION_DEFAULT_TTL_MS = 30 * 60 * 1000;
/** 웹훅 타임스탬프 허용 오차 (Didit 문서 기준 5분) */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;
/** reference image 최대 크기 / 허용 MIME */
export const REFERENCE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const REFERENCE_IMAGE_ALLOWED_TYPES: readonly string[] = ['image/jpeg', 'image/png'];

// ---------------------------------------------------------------------------
// Didit 상태 문자열 → 도메인 상태
// (Didit 세션 상태: Not Started / In Progress / In Review / Approved / Declined / Abandoned / Expired / Kyc Expired)
// ---------------------------------------------------------------------------

export function mapDiditStatus(raw: unknown): FaceVerificationStatus | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  switch (s) {
    case 'approved':
      return 'approved';
    case 'declined':
      return 'rejected';
    case 'in review':
      return 'in_review';
    case 'not started':
    case 'in progress':
      return 'pending';
    case 'abandoned':
    case 'expired':
    case 'kyc expired':
      return 'expired';
    default:
      return null;
  }
}

/** 웹훅만으로 처리해도 되는 상태(중간 상태) vs Decision 재조회가 필요한 최종 상태 */
export function requiresDecisionLookup(status: FaceVerificationStatus): boolean {
  return status === 'approved' || status === 'rejected' || status === 'in_review';
}

// ---------------------------------------------------------------------------
// Decision 파싱 — Provider 응답 전체를 저장하지 않고 필요한 최소 필드만 뽑는다.
// ---------------------------------------------------------------------------

export type LivenessDecision = {
  /** Provider 원본 세션 상태 문자열 (예: "Approved") */
  providerStatus: string;
  /** 도메인 상태 (중복 얼굴 의심 등 보정 전) */
  status: FaceVerificationStatus;
  /** liveness.status === "Approved" */
  livenessPassed: boolean;
  livenessScore: number | null;
  livenessMethod: string | null;
  /** 검증된 얼굴 reference image 의 서명 URL (https 만). 서버에서만 다운로드하며 DB/로그에 남기지 않는다 */
  referenceImageUrl: string | null;
  /** Face Search 1:N 중복 의심 — 어떤 계정과 유사한지는 취급하지 않는다 */
  duplicateSuspected: boolean;
};

export type DecisionParseResult =
  | { ok: true; decision: LivenessDecision }
  | { ok: false; reason: 'invalid_payload' | 'session_mismatch' | 'unknown_status' | 'missing_liveness' };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function asScore(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 100) return null; // 범위 밖 점수는 신뢰하지 않는다
  return Math.round(n * 100) / 100;
}

function isHttpsUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
}

const FACE_SEARCH_KEYS = ['face_search', 'face_search_1n', 'face_search_1_n', 'duplicate_face', 'duplicate_check'];

/**
 * Face Search(1:N) 결과 유무만 판단한다. 매칭된 상대 정보는 읽지 않고 버린다.
 * Provider 워크플로 설정(권장 임계값)이 이미 판정한 status/matches 만 본다 — 로컬 임계값을 두지 않는다.
 */
function detectDuplicateSuspicion(root: Record<string, unknown>): boolean {
  for (const key of FACE_SEARCH_KEYS) {
    const v = root[key];
    if (!isRecord(v)) continue;
    const st = asString(v.status)?.toLowerCase();
    if (st === 'declined' || st === 'in review') return true;
    const matches = v.matches ?? v.results ?? v.duplicates;
    if (Array.isArray(matches) && matches.length > 0) return true;
    if (typeof v.match_count === 'number' && v.match_count > 0) return true;
  }
  const warnings = root.warnings;
  if (Array.isArray(warnings)) {
    for (const w of warnings) {
      const code = isRecord(w) ? asString(w.risk) ?? asString(w.code) : asString(w);
      if (code && /DUPLICATE|FACE_SEARCH|MULTIPLE_ACCOUNT/i.test(code)) return true;
    }
  }
  return false;
}

/**
 * Didit Session Decision(GET /v2/session/{id}/decision/) 또는 웹훅의 decision 객체를 파싱한다.
 *  - session_id 가 기대값과 다르면 거부 (다른 세션의 결과를 붙이는 실수/공격 방지)
 *  - liveness 객체가 없으면 어떤 상태든 승인으로 해석하지 않는다 (missing_liveness)
 */
export function parseDiditDecision(json: unknown, expectedSessionId: string): DecisionParseResult {
  if (!isRecord(json)) return { ok: false, reason: 'invalid_payload' };
  const root = isRecord(json.decision) ? json.decision : json;

  const sessionId = asString(root.session_id) ?? asString(json.session_id);
  if (!sessionId || sessionId !== expectedSessionId) return { ok: false, reason: 'session_mismatch' };

  const providerStatus = asString(root.status) ?? asString(json.status);
  const status = mapDiditStatus(providerStatus);
  if (!providerStatus || !status) return { ok: false, reason: 'unknown_status' };

  const liveness = isRecord(root.liveness) ? root.liveness : null;
  if (!liveness) {
    // 라이브니스 결과가 없는 응답은 승인 근거가 될 수 없다. (Declined/Expired 는 그 자체로 처리 가능)
    if (status === 'approved' || status === 'in_review') return { ok: false, reason: 'missing_liveness' };
    return {
      ok: true,
      decision: {
        providerStatus,
        status,
        livenessPassed: false,
        livenessScore: null,
        livenessMethod: null,
        referenceImageUrl: null,
        duplicateSuspected: detectDuplicateSuspicion(root),
      },
    };
  }

  const livenessStatus = asString(liveness.status)?.toLowerCase() ?? null;
  const livenessPassed = livenessStatus === 'approved';
  const referenceImage = liveness.reference_image ?? liveness.reference_image_url;

  return {
    ok: true,
    decision: {
      providerStatus,
      status,
      livenessPassed,
      livenessScore: asScore(liveness.score),
      livenessMethod: asString(liveness.method),
      referenceImageUrl: isHttpsUrl(referenceImage) ? referenceImage : null,
      duplicateSuspected: detectDuplicateSuspicion(root),
    },
  };
}

// ---------------------------------------------------------------------------
// 최종 도메인 판정 — Decision 을 저장할 상태/사유로 바꾼다 (보수적).
// ---------------------------------------------------------------------------

export type ResolvedOutcome = {
  status: FaceVerificationStatus;
  livenessPassed: boolean;
  reason: FaceReasonCode;
};

export function resolveOutcome(decision: LivenessDecision): ResolvedOutcome {
  // 중복 얼굴 의심: 절대 자동 승인하지 않는다. Provider 가 거절했으면 rejected, 아니면 in_review.
  if (decision.duplicateSuspected) {
    return {
      status: decision.status === 'rejected' ? 'rejected' : 'in_review',
      livenessPassed: decision.livenessPassed,
      reason: 'face_search_match',
    };
  }
  switch (decision.status) {
    case 'approved':
      // 전체 Approved 라도 liveness 가 Approved 가 아니면 승인하지 않는다 (불완전한 응답 → 검토)
      if (!decision.livenessPassed) {
        return { status: 'in_review', livenessPassed: false, reason: 'decision_incomplete' };
      }
      return { status: 'approved', livenessPassed: true, reason: 'liveness_approved' };
    case 'rejected':
      return { status: 'rejected', livenessPassed: decision.livenessPassed, reason: 'liveness_declined' };
    case 'in_review':
      return { status: 'in_review', livenessPassed: decision.livenessPassed, reason: 'in_review' };
    case 'expired':
      return { status: 'expired', livenessPassed: false, reason: 'session_expired' };
    case 'pending':
    default:
      return { status: 'pending', livenessPassed: false, reason: 'in_review' };
  }
}

// ---------------------------------------------------------------------------
// 상태 전이 판단 (DB 트리거와 같은 규칙 — 여기서 먼저 걸러 불필요한 DB 오류를 줄인다)
// ---------------------------------------------------------------------------

export type TransitionVerdict = 'apply' | 'duplicate' | 'stale' | 'terminal';

export function decideTransition(
  current: { status: FaceVerificationStatus; providerEventAt: Date | null; providerStatus: string | null },
  incoming: { status: FaceVerificationStatus; eventAt: Date | null; providerStatus: string },
): TransitionVerdict {
  if (current.status === 'approved') {
    return incoming.status === 'approved' ? 'duplicate' : 'terminal';
  }
  if (current.providerEventAt && incoming.eventAt) {
    if (incoming.eventAt.getTime() < current.providerEventAt.getTime()) return 'stale';
    if (
      incoming.eventAt.getTime() === current.providerEventAt.getTime() &&
      current.providerStatus === incoming.providerStatus &&
      current.status === incoming.status
    ) {
      return 'duplicate';
    }
  }
  return 'apply';
}

// ---------------------------------------------------------------------------
// 웹훅 payload 최소 파싱 (전체 payload 는 저장하지 않는다)
// ---------------------------------------------------------------------------

export type WebhookEvent = {
  sessionId: string;
  providerStatus: string;
  status: FaceVerificationStatus | null;
  vendorData: string | null;
  webhookType: string | null;
  /** created_at / timestamp (unix seconds) → Date */
  eventAt: Date | null;
  /** 웹훅에 decision 이 실려 오면 참고용으로 넘긴다 (승인 근거는 서버 재조회 결과) */
  decision: unknown;
};

export function parseWebhookEvent(body: unknown): WebhookEvent | null {
  if (!isRecord(body)) return null;
  const sessionId = asString(body.session_id);
  const providerStatus = asString(body.status);
  if (!sessionId || !providerStatus) return null;
  const ts =
    typeof body.created_at === 'number'
      ? body.created_at
      : typeof body.timestamp === 'number'
        ? body.timestamp
        : null;
  return {
    sessionId,
    providerStatus,
    status: mapDiditStatus(providerStatus),
    vendorData: asString(body.vendor_data),
    webhookType: asString(body.webhook_type),
    eventAt: ts !== null && Number.isFinite(ts) ? new Date(ts * 1000) : null,
    decision: body.decision ?? null,
  };
}

/** reference image 저장 경로 — 반드시 <user_id>/liveness/ 아래 (DB CHECK 와 storage 정책이 강제) */
export function referenceImagePath(userId: string, contentType: string): string {
  const ext = contentType === 'image/png' ? 'png' : 'jpg';
  return `${userId}/liveness/reference.${ext}`;
}

/** 로그용 세션 id 축약 — 전체 id/토큰/URL 은 로그에 남기지 않는다 */
export function shortId(id: string | null | undefined): string {
  if (!id) return '-';
  return id.length <= 8 ? id : `${id.slice(0, 8)}…`;
}
