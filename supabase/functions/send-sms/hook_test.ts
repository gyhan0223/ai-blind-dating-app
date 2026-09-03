/**
 * send-sms 통합 테스트 — Deno 로 실행 (실제 standardwebhooks 라이브러리 사용, SOLAPI 는 fetch mock).
 *   deno test --allow-env supabase/functions/send-sms/hook_test.ts
 *
 * 검증:
 *   - Supabase 가 보내는 형식(webhook-id/-timestamp/-signature, `v1,whsec_` secret)으로 서명된 요청만 통과
 *   - 본문 변조 / 다른 secret / 오래된 타임스탬프 → http_code 401 (HTTP 200 본문 — Auth 훅 규약), SOLAPI 미호출
 *   - secret 회전(`|` 로 여러 개) 시 어느 하나로 서명해도 통과
 */
import { deepStrictEqual as assertEquals } from 'node:assert/strict';
import { Webhook } from 'npm:standardwebhooks@1.1.1';
import { handleSendSmsRequest, loadSendSmsConfig, parseHookSecrets, type SmsRateLimiter } from './sendSmsCore.ts';
import { createWebhookVerifier } from './webhookVerifier.ts';

// 테스트용 가짜 값 (실제 secret 아님)
const SECRET_A = btoa('test-hook-secret-A-not-real-0000000');
const SECRET_B = btoa('test-hook-secret-B-not-real-0000000');
const OTP = '493817';
const HOOK_URL = 'https://example.test/functions/v1/send-sms';

const env = (hookSecrets: string) => (name: string) =>
  ({
    SOLAPI_API_KEY: 'NCSTESTAPIKEY0000',
    SOLAPI_API_SECRET: 'test-api-secret-not-real-0000000000',
    SOLAPI_SENDER_NUMBER: '010-9999-0000',
    SEND_SMS_HOOK_SECRETS: hookSecrets,
  })[name];

/** 서명 검증 테스트이므로 레이트리밋은 항상 허용 */
const rateLimiter: SmsRateLimiter = async () => ({ ok: true, allowed: true });

const payload = JSON.stringify({ user: { id: 'u1', phone: '+821012345678' }, sms: { otp: OTP } });

function sign(secretB64: string, body: string, at = new Date()) {
  const id = 'msg_test_1';
  const signature = new Webhook(secretB64).sign(id, at, body);
  return { 'webhook-id': id, 'webhook-timestamp': String(Math.floor(at.getTime() / 1000)), 'webhook-signature': signature };
}

function mockSolapi() {
  const calls: RequestInit[] = [];
  const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) => {
    calls.push(init ?? {});
    return Promise.resolve(
      new Response(JSON.stringify({ groupInfo: { count: { registeredFailed: 0 } }, failedMessageList: [] }), { status: 200 }),
    );
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function request(body: string, headers: Record<string, string>) {
  return new Request(HOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
}

Deno.test('v1,whsec_ secret 으로 서명된 요청은 통과하고 SOLAPI 가 호출된다', async () => {
  const config = loadSendSmsConfig(env(`v1,whsec_${SECRET_A}`));
  assertEquals(config.ok, true);
  if (!config.ok) return;
  const verifyWebhook = createWebhookVerifier(config.config.hookSecrets);
  const { fetch, calls } = mockSolapi();
  const res = await handleSendSmsRequest(request(payload, sign(SECRET_A, payload)), { config, verifyWebhook, rateLimiter, fetch, log: () => {} });
  assertEquals(res.status, 200);
  assertEquals(res.headers.get('Content-Type'), 'application/json');
  assertEquals(await res.text(), '{}');
  assertEquals(calls.length, 1);
  const sent = JSON.parse(String(calls[0].body));
  assertEquals(sent.messages[0].to, '01012345678');
  assertEquals(sent.messages[0].from, '01099990000');
  assertEquals(sent.messages[0].type, 'SMS');
});

Deno.test('본문이 변조되면 401 이고 SOLAPI 는 호출되지 않는다', async () => {
  const config = loadSendSmsConfig(env(`v1,whsec_${SECRET_A}`));
  if (!config.ok) throw new Error('config');
  const verifyWebhook = createWebhookVerifier(config.config.hookSecrets);
  const { fetch, calls } = mockSolapi();
  const tampered = payload.replace(OTP, '000000');
  const res = await handleSendSmsRequest(request(tampered, sign(SECRET_A, payload)), { config, verifyWebhook, rateLimiter, fetch, log: () => {} });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { error: { http_code: 401, message: 'invalid_signature' } });
  assertEquals(calls.length, 0);
});

Deno.test('다른 secret 으로 서명하면 401 이고 SOLAPI 는 호출되지 않는다', async () => {
  const config = loadSendSmsConfig(env(`v1,whsec_${SECRET_A}`));
  if (!config.ok) throw new Error('config');
  const verifyWebhook = createWebhookVerifier(config.config.hookSecrets);
  const { fetch, calls } = mockSolapi();
  const res = await handleSendSmsRequest(request(payload, sign(SECRET_B, payload)), { config, verifyWebhook, rateLimiter, fetch, log: () => {} });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { error: { http_code: 401, message: 'invalid_signature' } });
  assertEquals(calls.length, 0);
});

Deno.test('타임스탬프가 오래된 서명은 401 (replay 방지)', async () => {
  const config = loadSendSmsConfig(env(`v1,whsec_${SECRET_A}`));
  if (!config.ok) throw new Error('config');
  const verifyWebhook = createWebhookVerifier(config.config.hookSecrets);
  const { fetch, calls } = mockSolapi();
  const old = new Date(Date.now() - 10 * 60 * 1000);
  const res = await handleSendSmsRequest(request(payload, sign(SECRET_A, payload, old)), { config, verifyWebhook, rateLimiter, fetch, log: () => {} });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { error: { http_code: 401, message: 'invalid_signature' } });
  assertEquals(calls.length, 0);
});

Deno.test('secret 회전: | 로 이어 붙인 secret 중 어느 하나로 서명해도 통과', async () => {
  const raw = `v1,whsec_${SECRET_A}|v1,whsec_${SECRET_B}`;
  assertEquals(parseHookSecrets(raw), [SECRET_A, SECRET_B]);
  const config = loadSendSmsConfig(env(raw));
  if (!config.ok) throw new Error('config');
  const verifyWebhook = createWebhookVerifier(config.config.hookSecrets);
  for (const secret of [SECRET_A, SECRET_B]) {
    const { fetch, calls } = mockSolapi();
    const res = await handleSendSmsRequest(request(payload, sign(secret, payload)), { config, verifyWebhook, rateLimiter, fetch, log: () => {} });
    assertEquals(res.status, 200);
    assertEquals(calls.length, 1);
  }
});
