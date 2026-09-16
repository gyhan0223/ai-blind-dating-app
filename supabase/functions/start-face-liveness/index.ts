/**
 * start-face-liveness — Didit 능동형 라이브니스 세션 시작 / 서버 재조회(sync) Edge Function.
 *
 * 배포 (JWT 검증 ON — 로그인한 사용자만):
 *   supabase functions deploy start-face-liveness --project-ref <PROJECT_REF>
 *
 * POST { action: 'consent', version } → { ok, version, consentedAt }   (#12 얼굴 정보 처리 별도 동의 — 서버가 버전·시각을 정한다)
 * POST { action?: 'start' }            → { ok, sessionId, sessionToken, expiresAt, attemptCount }   (현재 버전 동의가 없으면 403 consent_required)
 * POST { action: 'sync', sessionId }   → { ok, status, faceVerified }   (서버가 Didit Decision 을 직접 조회 — 동의 검사 없음)
 *
 * 보안
 *   - 사용자 id 는 Supabase JWT(requireUser) 에서만 가져온다. body 의 어떤 값도 승인 판단에 쓰지 않는다.
 *   - Didit API Key 는 서버 secret 에만 있다. 응답에는 session_token 과 session id 만 담긴다 (한 번만 전달, 저장 안 함).
 *   - production 에서 FACE_VERIFICATION_PROVIDER 가 미설정/mock/미구현이면 cold start 에서 throw → 함수가 뜨지 않는다.
 *     didit 이면서 DIDIT_* secret 이 없어도 throw (fail-closed).
 *   - 세션 생성 횟수는 DB RPC(face_liveness_begin_session) 가 사용자별로 제한한다.
 *   - 로그에는 API Key / 토큰 / 이미지 URL / 전화번호를 남기지 않는다.
 *
 * 필수 서버 환경변수: FACE_VERIFICATION_PROVIDER=didit · DIDIT_API_KEY · DIDIT_WORKFLOW_ID · DIDIT_WEBHOOK_SECRET
 * (문서: docs/face-liveness-didit.md)
 */
import { getAppEnv, requireFaceProviderKind } from '../_shared/env/env.ts';
import { enforceBetaAccess } from '../_shared/beta.ts';
import { FACE_CONSENT_POLICY, faceConsentReadiness } from '../_shared/consent/faceConsentPolicy.ts';
import { SupabaseFaceConsentDb } from '../_shared/consent/supabaseFaceConsentDb.ts';
import { corsHeaders, json, requireUser, serviceClient } from '../_shared/http.ts';
import { getFaceLivenessProvider } from '../_shared/face/FaceLivenessProvider.ts';
import { handleStartFaceLiveness } from '../_shared/face/startFaceLivenessCore.ts';
import { SupabaseFaceDb } from '../_shared/face/supabaseFaceDb.ts';

// cold start 에서 provider 확정 (fail-closed): production 은 didit + 모든 DIDIT_* secret 이 있어야 기동한다.
const provider = getFaceLivenessProvider(
  requireFaceProviderKind(),
  (name) => Deno.env.get(name),
  (input, init) => fetch(input, init),
);

const log = {
  info: (m: string) => console.log(m),
  warn: (m: string) => console.warn(m),
  error: (m: string) => console.error(m),
};

// #12: 동의 문서 준비 상태 — production 에서 draft/미확정/FACE_CONSENT_VERSION 불일치면 새 세션(얼굴 수집)을 만들지 않는다.
//      기동은 막지 않는다 (진행 중 세션의 sync 는 계속 동작해야 한다). 준비되지 않은 이유는 로그에만 (사용자 화면에 노출 안 함)
const consentReadiness = faceConsentReadiness(FACE_CONSENT_POLICY, { appEnv: getAppEnv(), configuredVersion: Deno.env.get('FACE_CONSENT_VERSION') });
if (!consentReadiness.ready) console.error(`[start-face-liveness] face consent policy not ready for ${getAppEnv()}: ${consentReadiness.reasons.join(', ')} — new sessions are refused (consent_policy_not_ready)`);
const consentPolicy = { kind: FACE_CONSENT_POLICY.kind, version: FACE_CONSENT_POLICY.version, readiness: consentReadiness };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => ({}));

  // 폐쇄 베타 (#26): 입장 허가 없는 계정은 얼굴 인증 세션을 만들 수 없다 (fail-closed)
  const db = serviceClient();
  const beta = await enforceBetaAccess(db, auth.userId, 'start-face-liveness');
  if (beta) return beta;

  try {
    const res = await handleStartFaceLiveness(
      { userId: auth.userId, body },
      { provider, db: new SupabaseFaceDb(db), consents: new SupabaseFaceConsentDb(db), consentPolicy, now: () => new Date(), log },
    );
    return json(res.body, res.status);
  } catch (err) {
    // RPC 누락(마이그레이션 미적용) 등 — 세션을 만들지 않고 실패 (메시지에 secret 없음)
    console.error(`[start-face-liveness] ${err instanceof Error ? err.message : 'error'}`);
    return json({ error: 'server_error' }, 500);
  }
});
