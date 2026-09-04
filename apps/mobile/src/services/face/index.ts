/**
 * 얼굴 인증(라이브니스) 서비스 — 얼굴 관련 서버 호출은 전부 이 모듈을 통해서만 한다.
 *
 * 흐름
 *   startFaceLiveness()  → 서버(start-face-liveness)가 Didit 세션을 만들고 session_token 을 한 번 돌려준다
 *   runDiditLiveness()   → 네이티브 SDK 화면 (diditSdk.ts)
 *   syncFaceLiveness()   → 서버가 Didit Decision 을 직접 재조회해 DB 에 반영 (웹훅 지연 대비)
 *   getLatestFaceVerification() → RLS 로 본인 행만 조회 (상태 복원/폴링)
 *
 * 개인정보 원칙
 *   - 앱은 얼굴 이미지를 만들거나 업로드하지 않는다 (촬영·분석은 SDK, 이미지 저장은 서버 전용).
 *   - Provider API Key/Workflow ID 는 앱에 없다. 앱이 받는 것은 1회용 session_token 뿐이며 저장하지 않는다.
 *   - 로그에 토큰/세션 id/경로를 남기지 않는다.
 *   - 클라이언트는 face_verifications 를 읽을 수만 있고(본인 행), 쓰기는 서버 전용이다.
 *   - 사용자가 예전에 올린 front/left/right.jpg 는 라이브니스가 검증된 이미지가 아니므로 더 이상 사용하지 않는다.
 */
import { supabase } from '@/lib/supabase';
import {
  type FaceErrorCode,
  type FaceVerificationRowLike,
  type FaceVerificationStatus,
  mapStartFailure,
} from './faceFlowCore';

export { isDiditSdkAvailable, runDiditLiveness } from './diditSdk';
export * from './faceFlowCore';

type InvokeResult = { status: number; body: Record<string, unknown> | null };

/** supabase.functions.invoke 의 성공/실패를 { status, body } 로 정규화 (오류 본문 접근용) */
async function invokeFace(body: Record<string, unknown>): Promise<InvokeResult> {
  const { data, error } = await supabase.functions.invoke('start-face-liveness', { body });
  if (!error) return { status: 200, body: (data as Record<string, unknown>) ?? null };
  const ctx = (error as { context?: Response }).context;
  if (ctx && typeof ctx.status === 'number') {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = (await ctx.json()) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
    return { status: ctx.status, body: parsed };
  }
  // 응답 자체가 없음 (네트워크)
  return { status: 0, body: null };
}

export type StartFaceLivenessResult =
  | { ok: true; sessionId: string; sessionToken: string; expiresAt: string | null }
  | { ok: false; code: FaceErrorCode; retryAfterSeconds?: number };

/** 서버에 라이브니스 세션 생성을 요청한다. 토큰은 SDK 에 바로 넘기고 보관하지 않는다. */
export async function startFaceLiveness(): Promise<StartFaceLivenessResult> {
  const res = await invokeFace({ action: 'start' });
  if (res.status === 200 && res.body?.ok === true) {
    const sessionId = res.body.sessionId;
    const sessionToken = res.body.sessionToken;
    if (typeof sessionId === 'string' && typeof sessionToken === 'string') {
      return {
        ok: true,
        sessionId,
        sessionToken,
        expiresAt: typeof res.body.expiresAt === 'string' ? res.body.expiresAt : null,
      };
    }
    return { ok: false, code: 'unknown' };
  }
  return { ok: false, ...mapStartFailure(res) };
}

export type SyncFaceLivenessResult =
  | { ok: true; status: FaceVerificationStatus; faceVerified: boolean }
  | { ok: false; code: FaceErrorCode };

/** 서버가 Provider 결과를 직접 재조회하도록 요청한다. 응답의 status 도 화면 표시용일 뿐, 진행은 DB 확인 후. */
export async function syncFaceLiveness(sessionId: string): Promise<SyncFaceLivenessResult> {
  const res = await invokeFace({ action: 'sync', sessionId });
  if (res.status === 200 && res.body?.ok === true && typeof res.body.status === 'string') {
    return {
      ok: true,
      status: res.body.status as FaceVerificationStatus,
      faceVerified: res.body.faceVerified === true,
    };
  }
  if (res.status === 404) return { ok: false, code: 'session_expired' };
  if (res.status === 0) return { ok: false, code: 'network' };
  return { ok: false, code: 'provider_unavailable' };
}

/** 본인의 최신 얼굴 인증 행 (RLS: 본인 행만 조회 가능. 점수/경로 등은 읽지 않는다) */
export async function getLatestFaceVerification(userId: string): Promise<FaceVerificationRowLike | null> {
  const { data } = await supabase
    .from('face_verifications')
    .select('status, provider_session_id, expires_at, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as FaceVerificationRowLike | null) ?? null;
}

/**
 * 개발 전용 — Mock provider 로 즉시 승인 (complete-face-verification).
 * 반드시 `__DEV__ && DEV_TOOLS_ENABLED` 가드 안에서만 호출한다. production 서버에서는 이 함수가
 * 배포되지 않으며(allowlist 제외) 배포돼 있어도 FACE_VERIFICATION_PROVIDER=didit 이면 기동을 거부한다.
 */
export async function devMockApproveFace(scenario: 'approved' | 'duplicate' = 'approved'): Promise<{ verified: boolean; status: string }> {
  const { data, error } = await supabase.functions.invoke('complete-face-verification', { body: { scenario } });
  if (error) throw new Error('개발용 얼굴 인증 통과에 실패했어요. complete-face-verification 함수와 FACE_VERIFICATION_PROVIDER=mock 설정을 확인하세요.');
  return { verified: data?.verified === true, status: typeof data?.status === 'string' ? data.status : 'unknown' };
}
