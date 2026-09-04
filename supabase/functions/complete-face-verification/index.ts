/**
 * complete-face-verification — 개발 전용 Mock 얼굴 인증 즉시 승인 Edge Function.
 *
 * ⚠️ 이 함수는 실제 라이브니스가 아니다. 카메라가 없는 시뮬레이터/개발 빌드에서 온보딩 흐름만 검증하기 위해
 *    face_verifications approved(provider='mock') + users.face_verified=true 를 만든다.
 *
 * 실제 흐름(production)은 start-face-liveness(세션 생성) → Didit 네이티브 SDK → didit-webhook(서명 검증 +
 * 서버 재조회) 이며, 이 함수는 그 경로에 전혀 관여하지 않는다.
 *
 * fail-closed 가드 (Issue #3 원칙 유지)
 *   - FACE_VERIFICATION_PROVIDER 가 mock 이 아니면(예: didit) cold start 에서 throw → 함수가 뜨지 않는다.
 *   - production 에서는 requireFaceProviderKind 가 mock/미설정을 거부하므로 어떤 조합으로도 기동되지 않는다.
 *   - production 배포 allowlist(supabase/scripts/deploy-production.sh) 에서도 제외된다 (1차 방어).
 *   - 모바일 production 코드는 이 함수를 호출하지 않는다 (`__DEV__ && DEV_TOOLS_ENABLED` 버튼 전용).
 *
 * 과거의 정면/좌/우 3장 업로드 검사는 제거했다 — 사용자가 직접 올린 이미지는 라이브니스가 검증된 이미지가
 * 아니므로 새 흐름에서 신뢰하지 않으며 임베딩 입력으로도 쓰지 않는다. feature_vector 는 만들지 않는다 (null).
 */
import { requireFaceProviderKind } from '../_shared/env/env.ts';
import { corsHeaders, json, requireUser, serviceClient } from '../_shared/http.ts';
import { getFaceLivenessProvider } from '../_shared/face/FaceLivenessProvider.ts';
import { resolveOutcome } from '../_shared/face/faceCore.ts';

const FACE_PROVIDER_KIND = requireFaceProviderKind();
if (FACE_PROVIDER_KIND !== 'mock') {
  throw new Error(
    `[face] complete-face-verification 은 개발용 mock 전용입니다 (FACE_VERIFICATION_PROVIDER=${FACE_PROVIDER_KIND}). ` +
      '실제 provider 는 start-face-liveness / didit-webhook 을 사용하세요.',
  );
}

const provider = getFaceLivenessProvider(FACE_PROVIDER_KIND, (name) => Deno.env.get(name), (i, init) => fetch(i, init));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => ({}));
  const db = serviceClient();

  // Mock decision 을 실제 provider 와 같은 도메인 판정 경로(resolveOutcome)로 통과시킨다.
  // sessionId 에 "duplicate" 가 포함되면 중복 얼굴 의심 시나리오(in_review) 를 재현할 수 있다.
  const scenario = typeof body?.scenario === 'string' ? body.scenario : 'approved';
  const decision = await provider.getDecision(`mock-${scenario}`);
  if (!decision.ok) return json({ error: 'mock_decision_failed' }, 500);
  const outcome = resolveOutcome(decision.decision);

  const { error: insertErr } = await db.from('face_verifications').insert({
    user_id: auth.userId,
    status: outcome.status,
    liveness_passed: outcome.livenessPassed,
    provider: 'mock',
    provider_status: decision.decision.providerStatus,
    liveness_method: decision.decision.livenessMethod,
    liveness_score: decision.decision.livenessScore,
    provider_reason: outcome.reason,
    provider_event_at: new Date().toISOString(),
    feature_vector: null,
  });
  if (insertErr) return json({ error: 'db_error' }, 500);

  if (outcome.status !== 'approved') {
    return json({ verified: false, status: outcome.status });
  }

  const { error: userErr } = await db.from('users').update({ face_verified: true }).eq('id', auth.userId);
  if (userErr) return json({ error: 'db_error' }, 500);

  return json({ verified: true, status: 'approved' });
});
