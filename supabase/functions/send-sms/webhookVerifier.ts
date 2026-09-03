/**
 * Supabase Auth HTTP Hook 의 Standard Webhooks 서명 검증 — Deno 전용 (npm:standardwebhooks).
 *
 * Supabase 는 훅 요청에 webhook-id / webhook-timestamp / webhook-signature 헤더를 붙여 보내고,
 * 서명은 `${id}.${timestamp}.${rawBody}` 의 HMAC-SHA256(base64 secret) 이다.
 * 이 함수는 JWT 없이(--no-verify-jwt) 배포되므로 이 검증이 유일한 호출자 인증이다 — 절대 생략 금지.
 */
import { Webhook } from 'npm:standardwebhooks@1.1.1';
import type { WebhookHeaders, WebhookVerifier } from './sendSmsCore.ts';

/**
 * base64 secret 목록(`parseHookSecrets` 결과)으로 검증기를 만든다.
 * 회전 중에는 secret 이 여러 개일 수 있으므로 하나라도 맞으면 통과, 전부 실패하면 throw.
 * (타임스탬프 허용 오차 ±5분은 라이브러리 기본값)
 */
export function createWebhookVerifier(base64Secrets: string[]): WebhookVerifier {
  if (base64Secrets.length === 0) throw new Error('[send-sms] hook secret 이 없습니다 (SEND_SMS_HOOK_SECRETS)');
  const hooks = base64Secrets.map((secret) => new Webhook(secret));
  return (rawBody: string, headers: WebhookHeaders) => {
    let lastError: unknown = null;
    for (const hook of hooks) {
      try {
        // jsonParse: false — 서명만 확인한다. payload 파싱/검증은 sendSmsCore 가 담당.
        hook.verify(rawBody, headers, { jsonParse: false });
        return;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError ?? new Error('signature verification failed');
  };
}
