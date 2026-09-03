/**
 * send-sms — Supabase Auth "Send SMS" HTTP Hook 전용 Edge Function (Issue #4).
 * Supabase Phone Auth(signInWithOtp)가 만든 OTP 를 SOLAPI 로 실제 발송한다.
 *
 * 배포 (JWT 검증 OFF — 훅은 JWT 발급 전에 호출된다):
 *   supabase functions deploy send-sms --no-verify-jwt --project-ref <PROJECT_REF>
 *
 * JWT 대신 Standard Webhooks 서명(SEND_SMS_HOOK_SECRETS)으로 호출자를 검증한다 — webhookVerifier.ts.
 * 서명 검증 실패 / 설정 누락 / 잘못된 payload 는 SOLAPI 호출 없이 오류 응답 (fail-closed).
 *
 * 남용 방지: 전화번호별 재전송 쿨다운(60초) + 시간당 상한(5건)을 DB RPC(sms_otp_rate_limit_check)로 강제한다.
 * RPC 는 Edge Runtime 이 자동 주입하는 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 로 호출한다 (별도 secret 불필요).
 * 마이그레이션 0012_sms_otp_rate_limit.sql 이 적용되어 있어야 한다 — 없으면 판정 실패 → 발송 안 함 (fail-closed).
 *
 * 필수 서버 환경변수 (supabase secrets set — 클라이언트/EXPO_PUBLIC_* 에 절대 넣지 않는다):
 *   SOLAPI_API_KEY · SOLAPI_API_SECRET · SOLAPI_SENDER_NUMBER · SEND_SMS_HOOK_SECRETS
 * 하나라도 없으면 모든 요청에 500 을 돌려준다. 로그에는 변수 "이름" 만 남긴다.
 */
import { createRpcRateLimiter, handleSendSmsRequest, loadSendSmsConfig } from './sendSmsCore.ts';
import { createWebhookVerifier } from './webhookVerifier.ts';

const config = loadSendSmsConfig((name) => Deno.env.get(name));

if (!config.ok) {
  console.error(
    `[send-sms] 설정 오류 — 누락: [${config.missing.join(', ')}] 형식 오류: [${config.invalid.join(', ')}]. ` +
      '모든 요청을 거부합니다 (fail-closed). supabase secrets set 으로 설정하세요 — docs/environments.md',
  );
}

const verifyWebhook = config.ok
  ? createWebhookVerifier(config.config.hookSecrets)
  : () => {
      throw new Error('misconfigured');
    };

const rateLimiter = createRpcRateLimiter({
  supabaseUrl: Deno.env.get('SUPABASE_URL'),
  serviceRoleKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  fetch: globalThis.fetch,
});

Deno.serve((req) => handleSendSmsRequest(req, { config, verifyWebhook, rateLimiter, fetch: globalThis.fetch }));
