/**
 * 얼굴 인증(라이브니스) 화면 흐름 핵심 로직 — 순수 모듈 (React Native / Expo 전역에 의존하지 않음).
 * Node selftest(scripts/face-liveness-selftest.mjs)로 검증한다.
 *
 * 원칙
 *   - SDK 가 클라이언트에서 Approved 를 돌려줘도 그것은 "화면 상태" 용일 뿐이다.
 *     다음 온보딩 단계로 넘어가는 유일한 조건은 서버(DB)의 users.face_verified=true 다.
 *   - 외부 SDK 타입은 이 모듈 안에서 내부 상태/오류 코드로 변환한다. 화면은 내부 코드만 본다.
 *   - 실패해도 온보딩 전체가 아니라 얼굴 인증만 다시 시도한다.
 *   - 중복 얼굴 의심 등 어떤 사유든 "어떤 계정과 비슷한지" 는 사용자에게 보여주지 않는다.
 */

// ---------------------------------------------------------------------------
// 내부 도메인 타입 (서버 face_verifications.status 와 동일)
// ---------------------------------------------------------------------------

export type FaceVerificationStatus = 'pending' | 'approved' | 'rejected' | 'in_review' | 'expired';

export type FaceErrorCode =
  | 'camera_permission_denied'
  | 'unsupported_device'
  | 'sdk_unavailable'
  | 'cancelled'
  | 'network'
  | 'no_face'
  | 'multiple_faces'
  | 'lighting'
  | 'face_occluded'
  | 'liveness_failed'
  | 'processing_timeout'
  | 'too_many_attempts'
  | 'session_expired'
  | 'provider_unavailable'
  | 'already_verified'
  | 'unknown';

export type FaceErrorAction = 'retry' | 'settings' | 'wait' | 'continue';

export type FaceErrorMessage = { title: string; body: string; action: FaceErrorAction };

/** 사용자 노출 문구 (한국어). 기술 용어·Provider 이름·유사 계정 정보는 넣지 않는다. */
export const FACE_ERROR_MESSAGES: Record<FaceErrorCode, FaceErrorMessage> = {
  camera_permission_denied: {
    title: '카메라 권한이 필요해요',
    body: '얼굴 확인은 카메라로만 할 수 있어요. 설정에서 카메라를 허용한 뒤 다시 시도해 주세요.',
    action: 'settings',
  },
  unsupported_device: {
    title: '이 기기에서는 얼굴 확인을 할 수 없어요',
    body: '전면 카메라가 있는 다른 기기에서 다시 시도해 주세요.',
    action: 'retry',
  },
  sdk_unavailable: {
    title: '이 빌드에서는 얼굴 확인을 실행할 수 없어요',
    body: 'Expo Go 나 일반 미리보기에서는 카메라 인증 모듈이 없어요. 개발 빌드(Development Build)나 스토어 빌드로 실행해 주세요.',
    action: 'retry',
  },
  cancelled: {
    title: '얼굴 확인을 중단했어요',
    body: '준비가 되면 다시 시작할 수 있어요. 이미 입력한 정보는 그대로 남아 있어요.',
    action: 'retry',
  },
  network: {
    title: '네트워크 연결을 확인해 주세요',
    body: '인터넷 연결이 불안정해요. 연결을 확인한 뒤 다시 시도해 주세요.',
    action: 'retry',
  },
  no_face: {
    title: '얼굴을 찾지 못했어요',
    body: '화면의 안내선 안에 얼굴 전체가 들어오도록 해주세요.',
    action: 'retry',
  },
  multiple_faces: {
    title: '얼굴이 여러 개 보여요',
    body: '본인 혼자 화면에 나오도록 해주세요.',
    action: 'retry',
  },
  lighting: {
    title: '조명이 너무 어둡거나 밝아요',
    body: '얼굴이 또렷하게 보이는 밝은 곳에서, 역광을 피해 다시 시도해 주세요.',
    action: 'retry',
  },
  face_occluded: {
    title: '얼굴이 가려져 있어요',
    body: '마스크, 선글라스, 손 등으로 얼굴을 가리지 말고 다시 시도해 주세요.',
    action: 'retry',
  },
  liveness_failed: {
    title: '얼굴 확인을 완료하지 못했어요',
    body: '안내에 따라 실제 얼굴로 다시 시도해 주세요. 사진이나 화면 속 얼굴은 확인되지 않아요.',
    action: 'retry',
  },
  processing_timeout: {
    title: '확인 결과 처리가 늦어지고 있어요',
    body: '결과가 준비되면 자동으로 반영돼요. 잠시 후 다시 확인해 주세요.',
    action: 'wait',
  },
  too_many_attempts: {
    title: '시도 횟수를 초과했어요',
    body: '잠시 후 다시 시도할 수 있어요. 안전을 위해 짧은 시간에 여러 번 시도할 수 없어요.',
    action: 'wait',
  },
  session_expired: {
    title: '확인 시간이 지났어요',
    body: '얼굴 확인을 처음부터 다시 시작해 주세요.',
    action: 'retry',
  },
  provider_unavailable: {
    title: '지금은 얼굴 확인을 할 수 없어요',
    body: '확인 서비스에 일시적인 문제가 있어요. 잠시 후 다시 시도해 주세요.',
    action: 'retry',
  },
  already_verified: {
    title: '이미 얼굴 확인을 마쳤어요',
    body: '다음 단계로 이동할게요.',
    action: 'continue',
  },
  unknown: {
    title: '얼굴 확인 중 문제가 생겼어요',
    body: '잠시 후 다시 시도해 주세요.',
    action: 'retry',
  },
};

// ---------------------------------------------------------------------------
// 화면 상태
// ---------------------------------------------------------------------------

export type FaceScreenState =
  | { kind: 'loading' }
  | { kind: 'intro' }
  | { kind: 'starting' }
  | { kind: 'sdk' }
  | { kind: 'processing'; sessionId: string; startedAt: number }
  | { kind: 'in_review'; sessionId: string | null }
  | { kind: 'approved' }
  | { kind: 'error'; code: FaceErrorCode; retryAfterSeconds?: number };

export const initialFaceScreenState: FaceScreenState = { kind: 'loading' };

// ---------------------------------------------------------------------------
// 서버 응답 → 상태
// ---------------------------------------------------------------------------

export type StartResponseLike = { status: number; body: Record<string, unknown> | null };

/** start-face-liveness 의 오류 응답을 내부 오류 코드로 */
export function mapStartFailure(res: StartResponseLike): { code: FaceErrorCode; retryAfterSeconds?: number } {
  const err = typeof res.body?.error === 'string' ? res.body.error : '';
  if (res.status === 401) return { code: 'unknown' };
  if (err === 'already_verified') return { code: 'already_verified' };
  if (err === 'rate_limited') {
    const retry = typeof res.body?.retryAfterSeconds === 'number' ? res.body.retryAfterSeconds : undefined;
    return { code: 'too_many_attempts', retryAfterSeconds: retry };
  }
  if (err === 'provider_is_mock') return { code: 'provider_unavailable' };
  if (err === 'provider_unavailable' || res.status === 503 || res.status === 502) return { code: 'provider_unavailable' };
  if (res.status === 0) return { code: 'network' };
  return { code: 'unknown' };
}

/**
 * 서버가 알려준 최종 상태(DB / sync) → 화면 상태.
 * approved 라도 faceVerified(users.face_verified) 가 true 일 때만 approved 로 본다.
 */
export function mapServerStatus(input: {
  status: FaceVerificationStatus;
  faceVerified: boolean;
  sessionId: string | null;
  processing?: { startedAt: number };
}): FaceScreenState {
  switch (input.status) {
    case 'approved':
      if (input.faceVerified) return { kind: 'approved' };
      // 승인 행은 있는데 사용자 플래그가 아직 아니라면 서버 처리 중 — 계속 기다린다
      return input.sessionId
        ? { kind: 'processing', sessionId: input.sessionId, startedAt: input.processing?.startedAt ?? 0 }
        : { kind: 'intro' };
    case 'in_review':
      return { kind: 'in_review', sessionId: input.sessionId };
    case 'rejected':
      // 사유(라이브니스 실패/중복 의심 등)는 구분해 보여주지 않는다
      return { kind: 'error', code: 'liveness_failed' };
    case 'expired':
      return { kind: 'error', code: 'session_expired' };
    case 'pending':
    default:
      return input.sessionId
        ? { kind: 'processing', sessionId: input.sessionId, startedAt: input.processing?.startedAt ?? 0 }
        : { kind: 'intro' };
  }
}

// ---------------------------------------------------------------------------
// SDK 결과 → 내부 결과 (외부 타입을 여기서 끊는다)
// ---------------------------------------------------------------------------

/** @didit-protocol/sdk-react-native VerificationResult 와 호환되는 최소 형태 */
export type SdkResultLike =
  | { type: 'completed'; session: { sessionId: string; status: string } }
  | { type: 'cancelled'; session?: { sessionId: string; status: string } }
  | { type: 'failed'; error: { type: string; message: string }; session?: { sessionId: string; status: string } };

export type SdkOutcome =
  | { kind: 'completed'; sessionId: string; clientStatus: 'approved' | 'declined' | 'pending' }
  | { kind: 'cancelled' }
  | { kind: 'error'; code: FaceErrorCode };

/** SDK 오류 메시지에서 사용자 안내에 필요한 범주만 추정한다 (메시지 원문은 보여주지 않는다) */
export function classifySdkErrorMessage(message: string): FaceErrorCode | null {
  const m = message.toLowerCase();
  if (/multiple face|more than one face|several faces|여러/.test(m)) return 'multiple_faces';
  if (/no face|face not (found|detected)|얼굴을 찾/.test(m)) return 'no_face';
  if (/too dark|too bright|lighting|illumination|low light|glare|어둡|밝/.test(m)) return 'lighting';
  if (/occlu|mask|covered|sunglass|가려/.test(m)) return 'face_occluded';
  if (/unsupported|not supported|no camera|front camera/.test(m)) return 'unsupported_device';
  if (/attempt|retry|too many|limit/.test(m)) return 'too_many_attempts';
  if (/liveness|spoof|presentation attack/.test(m)) return 'liveness_failed';
  if (/network|connection|timed? ?out|offline/.test(m)) return 'network';
  if (/permission|camera access/.test(m)) return 'camera_permission_denied';
  if (/expired/.test(m)) return 'session_expired';
  return null;
}

export function mapSdkResult(result: SdkResultLike): SdkOutcome {
  switch (result.type) {
    case 'completed': {
      const s = result.session.status;
      const clientStatus = s === 'Approved' ? 'approved' : s === 'Declined' ? 'declined' : 'pending';
      return { kind: 'completed', sessionId: result.session.sessionId, clientStatus };
    }
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'failed': {
      switch (result.error.type) {
        case 'cameraAccessDenied':
          return { kind: 'error', code: 'camera_permission_denied' };
        case 'networkError':
          return { kind: 'error', code: 'network' };
        case 'sessionExpired':
          return { kind: 'error', code: 'session_expired' };
        case 'notInitialized':
          return { kind: 'error', code: 'sdk_unavailable' };
        case 'retryBlocked':
          return { kind: 'error', code: 'too_many_attempts' };
        case 'apiError':
          return { kind: 'error', code: classifySdkErrorMessage(result.error.message) ?? 'provider_unavailable' };
        default:
          return { kind: 'error', code: classifySdkErrorMessage(result.error.message) ?? 'unknown' };
      }
    }
    default:
      return { kind: 'error', code: 'unknown' };
  }
}

/**
 * SDK 완료 결과 → 다음 화면 상태.
 * 어떤 클라이언트 상태(Approved 포함)도 즉시 approved 로 만들지 않는다 — 항상 processing 으로 가서
 * 서버 확인을 기다린다. Declined 만 즉시 실패 안내 (서버도 rejected 로 기록한다).
 */
export function nextStateAfterSdk(outcome: SdkOutcome, now: number): FaceScreenState {
  switch (outcome.kind) {
    case 'completed':
      if (outcome.clientStatus === 'declined') return { kind: 'error', code: 'liveness_failed' };
      return { kind: 'processing', sessionId: outcome.sessionId, startedAt: now };
    case 'cancelled':
      return { kind: 'error', code: 'cancelled' };
    case 'error':
      return { kind: 'error', code: outcome.code };
  }
}

// ---------------------------------------------------------------------------
// 처리 중(processing) 폴링 계획
//   - DB 상태(RLS 로 본인 행 조회)는 POLL_INTERVAL_MS 마다 확인
//   - 서버 재조회(sync) 는 SYNC_AT_MS 시점마다 한 번씩 (웹훅 지연 대비)
//   - PROCESSING_TIMEOUT_MS 가 지나면 "처리 지연" 안내 (pending 은 유지되고 앱을 다시 열면 복원된다)
// ---------------------------------------------------------------------------

export const POLL_INTERVAL_MS = 2000;
export const SYNC_AT_MS: readonly number[] = [0, 6000, 15000, 30000, 50000];
export const PROCESSING_TIMEOUT_MS = 60000;

export function shouldSyncAt(elapsedMs: number, syncsDone: number): boolean {
  if (syncsDone >= SYNC_AT_MS.length) return false;
  return elapsedMs >= SYNC_AT_MS[syncsDone];
}

export function isProcessingTimedOut(elapsedMs: number): boolean {
  return elapsedMs >= PROCESSING_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// 앱 재시작 시 상태 복원 (DB 의 최신 본인 행 기준)
// ---------------------------------------------------------------------------

export type FaceVerificationRowLike = {
  status: FaceVerificationStatus;
  provider_session_id: string | null;
  expires_at: string | null;
  created_at: string;
};

/** pending 세션이 아직 유효하면 processing 으로 복원해 결과를 이어서 기다린다 */
export function restoreScreenState(
  row: FaceVerificationRowLike | null,
  faceVerified: boolean,
  now: number,
): FaceScreenState {
  if (faceVerified) return { kind: 'approved' };
  if (!row) return { kind: 'intro' };
  if (row.status === 'pending') {
    const expires = row.expires_at ? Date.parse(row.expires_at) : NaN;
    const stillValid = !!row.provider_session_id && Number.isFinite(expires) && expires > now;
    if (!stillValid) return { kind: 'intro' };
    return { kind: 'processing', sessionId: row.provider_session_id as string, startedAt: now };
  }
  if (row.status === 'in_review') return { kind: 'in_review', sessionId: row.provider_session_id };
  if (row.status === 'approved') {
    // 행은 approved 인데 users.face_verified 가 아직 아니면 잠깐 더 기다린다
    return row.provider_session_id ? { kind: 'processing', sessionId: row.provider_session_id, startedAt: now } : { kind: 'intro' };
  }
  // rejected / expired → 다시 시작 가능
  return { kind: 'intro' };
}

/** Expo Go(storeClient) 에서는 네이티브 SDK 모듈이 없다 */
export function isExpoGo(executionEnvironment: string | undefined | null): boolean {
  return executionEnvironment === 'storeClient';
}
