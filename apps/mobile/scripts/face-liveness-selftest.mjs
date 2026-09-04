/**
 * 얼굴 인증(라이브니스) 화면 흐름 selftest — Node 로 실행 (Expo/RN 불필요, 외부 호출 없음).
 *   node --experimental-strip-types scripts/face-liveness-selftest.mjs
 *
 * 보장 항목
 *   - SDK 가 클라이언트에서 Approved 를 돌려줘도 즉시 다음 화면으로 가지 않는다 (processing)
 *   - 서버(DB) face_verified=true 를 확인한 뒤에만 approved
 *   - 취소 후 재시도 가능 (오류 상태는 retry 액션)
 *   - 권한 거부 → 설정 안내
 *   - 네트워크 오류 / 처리 중 timeout / 시도 횟수 초과 안내
 *   - 앱을 종료했다 다시 열어도 pending 세션이 복원된다
 *   - Expo Go(Development Build 아님) 에서 이해할 수 있는 오류
 *   - 실패 사유(중복 얼굴 의심 등)를 사용자에게 구분해 노출하지 않는다
 */
import {
  FACE_ERROR_MESSAGES,
  classifySdkErrorMessage,
  isExpoGo,
  isProcessingTimedOut,
  mapSdkResult,
  mapServerStatus,
  mapStartFailure,
  nextStateAfterSdk,
  PROCESSING_TIMEOUT_MS,
  restoreScreenState,
  shouldSyncAt,
} from '../src/services/face/faceFlowCore.ts';

let passed = 0;
let failed = 0;

function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const NOW = 1_800_000_000_000;

// ── SDK 완료 후 즉시 이동하지 않음 ─────────────────────────────────────────
const approvedBySdk = mapSdkResult({ type: 'completed', session: { sessionId: 's1', status: 'Approved' } });
eq('sdk approved → completed outcome', approvedBySdk, { kind: 'completed', sessionId: 's1', clientStatus: 'approved' });
eq('sdk approved → processing (not approved)', nextStateAfterSdk(approvedBySdk, NOW), { kind: 'processing', sessionId: 's1', startedAt: NOW });
const pendingBySdk = mapSdkResult({ type: 'completed', session: { sessionId: 's1', status: 'Pending' } });
eq('sdk pending → processing', nextStateAfterSdk(pendingBySdk, NOW).kind, 'processing');
const declinedBySdk = mapSdkResult({ type: 'completed', session: { sessionId: 's1', status: 'Declined' } });
eq('sdk declined → liveness_failed', nextStateAfterSdk(declinedBySdk, NOW), { kind: 'error', code: 'liveness_failed' });

// ── 서버 승인 확인 후에만 approved ──────────────────────────────────────────
eq('server approved + flag → approved', mapServerStatus({ status: 'approved', faceVerified: true, sessionId: 's1' }), { kind: 'approved' });
eq('server approved row but flag false → keep processing', mapServerStatus({ status: 'approved', faceVerified: false, sessionId: 's1', processing: { startedAt: NOW } }).kind, 'processing');
eq('server in_review', mapServerStatus({ status: 'in_review', faceVerified: false, sessionId: 's1' }), { kind: 'in_review', sessionId: 's1' });
eq('server rejected → generic failure (no reason exposed)', mapServerStatus({ status: 'rejected', faceVerified: false, sessionId: 's1' }), { kind: 'error', code: 'liveness_failed' });
eq('server expired', mapServerStatus({ status: 'expired', faceVerified: false, sessionId: 's1' }), { kind: 'error', code: 'session_expired' });
eq('server pending', mapServerStatus({ status: 'pending', faceVerified: false, sessionId: 's1', processing: { startedAt: NOW } }), { kind: 'processing', sessionId: 's1', startedAt: NOW });

// ── 취소 후 재시도 ─────────────────────────────────────────────────────────
const cancelled = nextStateAfterSdk(mapSdkResult({ type: 'cancelled' }), NOW);
eq('cancelled → error cancelled', cancelled, { kind: 'error', code: 'cancelled' });
eq('cancelled is retryable', FACE_ERROR_MESSAGES.cancelled.action, 'retry');

// ── 권한 거부 → 설정 안내 ──────────────────────────────────────────────────
const denied = mapSdkResult({ type: 'failed', error: { type: 'cameraAccessDenied', message: 'Camera permission denied' } });
eq('permission denied code', denied, { kind: 'error', code: 'camera_permission_denied' });
eq('permission denied → settings action', FACE_ERROR_MESSAGES.camera_permission_denied.action, 'settings');

// ── 네트워크 오류 ─────────────────────────────────────────────────────────
eq('sdk network error', mapSdkResult({ type: 'failed', error: { type: 'networkError', message: 'x' } }), { kind: 'error', code: 'network' });
eq('start network (no response)', mapStartFailure({ status: 0, body: null }), { code: 'network' });
eq('start provider outage', mapStartFailure({ status: 503, body: { error: 'provider_unavailable' } }), { code: 'provider_unavailable' });
eq('start mock provider → provider_unavailable', mapStartFailure({ status: 409, body: { error: 'provider_is_mock' } }), { code: 'provider_unavailable' });
eq('start already verified', mapStartFailure({ status: 409, body: { error: 'already_verified' } }), { code: 'already_verified' });
eq('start rate limited', mapStartFailure({ status: 429, body: { error: 'rate_limited', retryAfterSeconds: 900 } }), { code: 'too_many_attempts', retryAfterSeconds: 900 });
eq('rate limited → wait action', FACE_ERROR_MESSAGES.too_many_attempts.action, 'wait');

// ── 처리 중 timeout / sync 스케줄 ──────────────────────────────────────────
eq('sync at 0', shouldSyncAt(0, 0), true);
eq('no second sync before 6s', shouldSyncAt(3000, 1), false);
eq('second sync at 6s', shouldSyncAt(6000, 1), true);
eq('no sync after schedule exhausted', shouldSyncAt(999999, 5), false);
eq('not timed out before limit', isProcessingTimedOut(PROCESSING_TIMEOUT_MS - 1), false);
eq('timed out at limit', isProcessingTimedOut(PROCESSING_TIMEOUT_MS), true);
eq('timeout → wait action', FACE_ERROR_MESSAGES.processing_timeout.action, 'wait');

// ── 앱 재시작 시 pending 복원 ─────────────────────────────────────────────
const future = new Date(NOW + 10 * 60 * 1000).toISOString();
const past = new Date(NOW - 60 * 1000).toISOString();
eq('restore verified user → approved', restoreScreenState(null, true, NOW), { kind: 'approved' });
eq('restore no row → intro', restoreScreenState(null, false, NOW), { kind: 'intro' });
eq('restore valid pending → processing', restoreScreenState({ status: 'pending', provider_session_id: 's1', expires_at: future, created_at: past }, false, NOW), { kind: 'processing', sessionId: 's1', startedAt: NOW });
eq('restore expired pending → intro', restoreScreenState({ status: 'pending', provider_session_id: 's1', expires_at: past, created_at: past }, false, NOW), { kind: 'intro' });
eq('restore pending without session → intro', restoreScreenState({ status: 'pending', provider_session_id: null, expires_at: future, created_at: past }, false, NOW), { kind: 'intro' });
eq('restore in_review', restoreScreenState({ status: 'in_review', provider_session_id: 's1', expires_at: null, created_at: past }, false, NOW), { kind: 'in_review', sessionId: 's1' });
eq('restore rejected → intro (retry)', restoreScreenState({ status: 'rejected', provider_session_id: 's1', expires_at: null, created_at: past }, false, NOW), { kind: 'intro' });
eq('restore approved row but flag false → processing', restoreScreenState({ status: 'approved', provider_session_id: 's1', expires_at: null, created_at: past }, false, NOW).kind, 'processing');

// ── Development Build 아님 ─────────────────────────────────────────────────
eq('expo go detected', isExpoGo('storeClient'), true);
eq('dev build not expo go', isExpoGo('standalone'), false);
eq('bare not expo go', isExpoGo('bare'), false);
eq('sdk notInitialized → sdk_unavailable', mapSdkResult({ type: 'failed', error: { type: 'notInitialized', message: '' } }), { kind: 'error', code: 'sdk_unavailable' });
eq('sdk_unavailable message mentions development build', FACE_ERROR_MESSAGES.sdk_unavailable.body.includes('개발 빌드'), true);

// ── 기타 SDK 오류 분류 ────────────────────────────────────────────────────
eq('sdk session expired', mapSdkResult({ type: 'failed', error: { type: 'sessionExpired', message: '' } }), { kind: 'error', code: 'session_expired' });
eq('sdk retry blocked', mapSdkResult({ type: 'failed', error: { type: 'retryBlocked', message: '' } }), { kind: 'error', code: 'too_many_attempts' });
eq('sdk api error generic', mapSdkResult({ type: 'failed', error: { type: 'apiError', message: 'Server error' } }), { kind: 'error', code: 'provider_unavailable' });
eq('classify no face', classifySdkErrorMessage('No face detected'), 'no_face');
eq('classify multiple faces', classifySdkErrorMessage('Multiple faces found'), 'multiple_faces');
eq('classify lighting', classifySdkErrorMessage('Image too dark'), 'lighting');
eq('classify occluded', classifySdkErrorMessage('Face is covered by mask'), 'face_occluded');
eq('classify unsupported', classifySdkErrorMessage('Device not supported'), 'unsupported_device');
eq('classify liveness', classifySdkErrorMessage('Liveness check failed'), 'liveness_failed');
eq('classify unknown', classifySdkErrorMessage('???'), null);
eq('sdk unknown with no face message', mapSdkResult({ type: 'failed', error: { type: 'unknown', message: 'no face found' } }), { kind: 'error', code: 'no_face' });

// ── 사용자 문구: 유사 계정 정보/Provider 이름 없음 ─────────────────────────
for (const [code, msg] of Object.entries(FACE_ERROR_MESSAGES)) {
  const text = `${msg.title} ${msg.body}`;
  eq(`message ${code} has no provider/duplicate leak`, /didit|중복|유사|다른 계정/i.test(text), false);
  eq(`message ${code} is korean`, /[가-힣]/.test(text), true);
}

console.log(`face flow selftest: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
