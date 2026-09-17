/**
 * 본인 인증 Edge Function — 1인 1계정 보장의 서버 측 진입점 (얇은 handler).
 *
 * users.identity_verified / age_verified 와 user_identities 는 클라이언트가 직접
 * 수정할 수 없으므로 (DB 트리거 + RLS 무정책) 반드시 이 함수를 통해 갱신된다.
 *
 * POST { action: 'request', name, birthDate, carrier }
 *   → { requestId }                                  (requestId = 서버 세션 id, 10분)
 * POST { action: 'confirm', requestId, code, name, birthDate, carrier }
 *   → { verified: true,  result: 'created' | 'already_verified' | 'relinked' }
 *   → { verified: false, result: 'existing_account', maskedPhone }   ← 복구 flow 로 (15분 안에 recover)
 *   → { verified: false, result: 'blocked' | 'underage' | 'failed', reason }
 *   → 400 invalid_session | session_expired | too_many_attempts · 409 session_in_progress | identity_mismatch · 503 provider_unavailable
 * POST { action: 'recover', requestId }
 *   → 기존 계정에 현재 로그인 전화번호를 연결 (confirm 이 세션에 남긴 서버 검증 결과로만 — 사용자가 확인한 뒤 호출)
 *   → { recovered: true }  이후 클라이언트는 재로그인해야 한다.
 *
 * 흐름·규칙·테스트는 _shared/identity/verifyIdentityCore.ts (selftest.ts 가 Provider/DB/Auth/시계를 주입해 검증).
 * 여기서는 JWT 검증 · 폐쇄 베타 입장 · rate limit 만 하고 코어를 부른다.
 *
 * 개인정보: raw identityKey / DI / 본인확인 응답 전문은 저장·로그하지 않는다.
 */
import { requireIdentityProviderKind, requireIdentitySecret } from '../_shared/env/env.ts';
import { enforceBetaAccess } from '../_shared/beta.ts';
import { corsHeaders, json, requireUser, serviceClient } from '../_shared/http.ts';
import { enforceRateLimit } from '../_shared/rateLimit.ts';
import { getIdentityProvider } from '../_shared/identity/IdentityVerificationProvider.ts';
import { supabaseIdentityAuth, supabaseIdentityDb } from '../_shared/identity/supabaseIdentityDeps.ts';
import { runVerifyIdentity } from '../_shared/identity/verifyIdentityCore.ts';

/**
 * cold start 시 secret 검증 (Issue #3 — fail-fast, 자동 fallback 금지):
 *   development                → 미설정이면 개발 fixture secret 사용 (seed 해시와 일치)
 *   staging / production       → IDENTITY_HASH_SECRET 미설정·개발 기본값·32자 미만이면
 *                                여기서 throw 되어 함수가 아예 요청을 받지 않는다.
 *   APP_ENV 누락/알 수 없는 값 → production 취급 (fail-closed)
 * secret 값 자체는 로그/오류 어디에도 출력하지 않는다.
 */
const IDENTITY_SECRET = requireIdentitySecret();

/**
 * 본인확인 Provider 도 cold start 에서 확정한다 (Issue #3 보완 — fail-closed):
 *   development / staging → IDENTITY_PROVIDER 미설정이면 Mock (개발 fixture)
 *   production            → 실제 provider 이름 필수. 미설정·mock·미구현 이름이면
 *                           여기서 throw 되어 함수가 요청을 받지 않는다.
 * Mock 은 verificationId 미검증 + 아무 6자리 코드 통과 구조이므로,
 * 이 가드가 production 에서 그 경로 자체를 제거한다.
 */
const PROVIDER_KIND = requireIdentityProviderKind();
const provider = getIdentityProvider(PROVIDER_KIND);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'invalid_body' }, 400);

  const db = serviceClient();

  // 폐쇄 베타 (#26): 입장 허가 없는 계정은 본인확인을 시작할 수 없다 (게이트가 꺼져 있으면 모두 허용). fail-closed
  const beta = await enforceBetaAccess(db, auth.userId, 'verify-identity');
  if (beta) return beta;

  // 남용 방지 (#27): 사용자당 request 5회/10분 · confirm/recover 10회/시간. RPC 불가 시 503 (fail-closed)
  const rl = body.action === 'request'
    ? await enforceRateLimit(db, 'verify-identity:request', auth.userId, 5, 600, 'verify-identity')
    : await enforceRateLimit(db, 'verify-identity:confirm', auth.userId, 10, 3600, 'verify-identity');
  if (rl) return rl;

  const res = await runVerifyIdentity(
    {
      userId: auth.userId,
      action: String(body.action ?? ''),
      requestId: body.requestId,
      code: body.code,
      name: body.name,
      birthDate: body.birthDate,
      carrier: body.carrier,
    },
    {
      provider,
      providerKind: PROVIDER_KIND,
      db: supabaseIdentityDb(db),
      auth: supabaseIdentityAuth(db),
      identitySecret: IDENTITY_SECRET,
      now: () => new Date(),
    },
  );
  return json(res.body, res.status);
});
