/**
 * 얼굴 인증 확정 Edge Function.
 *
 * 1. 사용자가 private bucket 에 올린 3장(정면/좌/우)이 실제 존재하는지 확인
 * 2. 모의 라이브니스 통과 처리 + 모의 특징 벡터 생성
 *    (실서비스: 온디바이스 라이브니스 SDK + 얼굴 임베딩 모델로 교체)
 * 3. face_verifications approved + users.face_verified 갱신
 *
 * 사용자 얼굴 이미지는 이 함수 밖으로 절대 나가지 않는다.
 */
import { requireFaceProviderKind } from '../_shared/env/env.ts';
import { corsHeaders, json, requireUser, serviceClient } from '../_shared/http.ts';

const POSES = ['front', 'left', 'right'] as const;

/**
 * 얼굴 인증 provider 를 cold start 에서 확정한다 (Issue #3 보완 — fail-closed):
 *   development / staging → FACE_VERIFICATION_PROVIDER 미설정이면 mock
 *                           (모의 라이브니스 통과 + 모의 특징 벡터)
 *   production            → 실제 provider 필수. 미설정·mock 이면 requireFaceProviderKind 가,
 *                           구현되지 않은 이름이면 아래 검사가 throw 하여 함수가 아예 뜨지 않는다.
 * 즉 실제 라이브니스 provider 가 구현되기 전까지 production 에서는 이 함수를 직접 호출해도
 * face_verifications approved / users.face_verified=true 를 만들 수 없다.
 * 실서비스 provider 연동 시 여기서 kind 분기를 추가한다.
 */
const FACE_PROVIDER_KIND = requireFaceProviderKind();
if (FACE_PROVIDER_KIND !== 'mock') {
  throw new Error(`[face] 구현되지 않은 FACE_VERIFICATION_PROVIDER 입니다: ${FACE_PROVIDER_KIND}`);
}

/** 사용자별 결정적 모의 특징 벡터 (mock provider 전용 — production 은 위 가드로 차단) */
async function mockFeatureVector(userId: string): Promise<number[]> {
  const bytes = new TextEncoder().encode(userId);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest.slice(0, 16)).map((b) => Number((b / 255).toFixed(4)));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => null);
  const paths = body?.paths as Record<string, string> | undefined;
  if (!paths) return json({ error: 'invalid_body' }, 400);

  const db = serviceClient();

  // 경로 검증: 반드시 본인 폴더의 pose 파일이어야 한다
  for (const pose of POSES) {
    if (paths[pose] !== `${auth.userId}/${pose}.jpg`) {
      return json({ error: 'invalid_path' }, 400);
    }
  }

  // 실제 업로드 여부 확인
  const { data: objects, error: listErr } = await db.storage.from('faces').list(auth.userId);
  if (listErr) return json({ error: 'storage_error' }, 500);
  const names = new Set((objects ?? []).map((o) => o.name));
  for (const pose of POSES) {
    if (!names.has(`${pose}.jpg`)) return json({ verified: false, reason: 'missing_image' });
  }

  const featureVector = await mockFeatureVector(auth.userId);

  const { error: insertErr } = await db.from('face_verifications').insert({
    user_id: auth.userId,
    status: 'approved',
    front_path: paths.front,
    left_path: paths.left,
    right_path: paths.right,
    liveness_passed: true,
    provider: FACE_PROVIDER_KIND,
    feature_vector: featureVector,
  });
  if (insertErr) return json({ error: 'db_error' }, 500);

  const { error: userErr } = await db
    .from('users')
    .update({ face_verified: true })
    .eq('id', auth.userId);
  if (userErr) return json({ error: 'db_error' }, 500);

  return json({ verified: true });
});
