/**
 * send-sms 핵심 로직 selftest — Node 로 실행 (Deno 불필요, 실제 SOLAPI 호출 없음).
 *   node --experimental-strip-types selftest.ts
 *
 * Issue #4 핵심 보장:
 *   - +82 한국 번호 → 010 국내 형식 변환, 그 외 번호/잘못된 OTP 거부
 *   - SOLAPI HMAC-SHA256 Authorization 헤더 생성
 *   - 웹훅 서명 실패 / 설정 누락 / 잘못된 payload → SOLAPI(fetch) 호출 없음
 *   - SOLAPI 오류(HTTP 오류·failedMessageList·타임아웃) → 성공(200) 응답 없음
 *   - 응답·로그에 OTP / 전체 전화번호 / API secret 미노출
 *
 * 실제 Standard Webhooks 라이브러리와의 통합은 Deno 테스트(hook_test.ts)가 별도로 검증한다.
 */
import { createHmac } from 'node:crypto';
import {
  buildOtpMessage,
  buildSolapiAuthorization,
  handleSendSmsRequest,
  hmacSha256Hex,
  isValidOtp,
  loadSendSmsConfig,
  normalizeSenderNumberKR,
  parseHookSecrets,
  randomSalt,
  SOLAPI_SEND_URL,
  sendSolapiSms,
  toSolapiPhoneKR,
  type SendSmsConfigResult,
  type SendSmsLogger,
} from './sendSmsCore.ts';

let passed = 0;
let failed = 0;

function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ── 테스트용 가짜 값 (실제 secret 아님) ──────────────────────────────────
const FAKE_API_KEY = 'NCSTESTAPIKEY0000';
const FAKE_API_SECRET = 'test-api-secret-not-real-0000000000';
const FAKE_HOOK_SECRET_B64 = 'dGVzdC1ob29rLXNlY3JldC1ub3QtcmVhbC0wMDAwMDAw'; // base64("test-hook-secret-not-real-0000000")
const RECIPIENT_E164 = '+821012345678';
const RECIPIENT_LOCAL = '01012345678';
const OTP = '493817';

const fakeEnv = (overrides: Record<string, string | undefined> = {}) => {
  const base: Record<string, string | undefined> = {
    SOLAPI_API_KEY: FAKE_API_KEY,
    SOLAPI_API_SECRET: FAKE_API_SECRET,
    SOLAPI_SENDER_NUMBER: '010-9999-0000',
    SEND_SMS_HOOK_SECRETS: `v1,whsec_${FAKE_HOOK_SECRET_B64}`,
    ...overrides,
  };
  return (name: string) => base[name];
};

// ── 전화번호 변환 (+82 → 010) ─────────────────────────────────────────────
eq('phone e164 → local', toSolapiPhoneKR('+821012345678'), '01012345678');
eq('phone e164 with spaces', toSolapiPhoneKR('+82 10 1234 5678'), '01012345678');
eq('phone e164 with leading zero', toSolapiPhoneKR('+82010-1234-5678'), '01012345678');
eq('phone supabase stored (no plus)', toSolapiPhoneKR('821012345678'), '01012345678');
eq('phone local hyphen', toSolapiPhoneKR('010-1234-5678'), '01012345678');
eq('phone local plain', toSolapiPhoneKR('01012345678'), '01012345678');
eq('phone 10-digit old format', toSolapiPhoneKR('+82161234567'), '0161234567');
eq('phone output has no plus/hyphen/space', /^[0-9]+$/.test(toSolapiPhoneKR('+82 10-1234-5678') ?? ''), true);

// ── 잘못된 전화번호 거부 ──────────────────────────────────────────────────
eq('reject non-KR country', toSolapiPhoneKR('+15551234567'), null);
eq('reject JP even if 10 starts', toSolapiPhoneKR('+819012345678'), null);
eq('reject landline', toSolapiPhoneKR('+8221234567'), null);
eq('reject landline local', toSolapiPhoneKR('02-123-4567'), null);
eq('reject too short', toSolapiPhoneKR('+82101234'), null);
eq('reject too long', toSolapiPhoneKR('+82101234567890'), null);
eq('reject empty', toSolapiPhoneKR(''), null);
eq('reject null', toSolapiPhoneKR(null), null);
eq('reject letters', toSolapiPhoneKR('+82abc'), null);
eq('reject 012 prefix', toSolapiPhoneKR('+82121234567'), null);

// ── 발신번호 정규화 ───────────────────────────────────────────────────────
eq('sender hyphen removed', normalizeSenderNumberKR('010-9999-0000'), '01099990000');
eq('sender e164', normalizeSenderNumberKR('+82-2-1234-5678'), '0212345678');
eq('sender spaces removed', normalizeSenderNumberKR(' 02 123 4567 '), '021234567');
eq('sender 1588 representative', normalizeSenderNumberKR('1588-1234'), '15881234');
eq('sender reject non-KR', normalizeSenderNumberKR('+15551234567'), null);
eq('sender reject garbage', normalizeSenderNumberKR('abc'), null);
eq('sender reject empty', normalizeSenderNumberKR(''), null);

// ── OTP 검증 ──────────────────────────────────────────────────────────────
eq('otp 6 digits ok', isValidOtp('123456'), true);
eq('otp leading zeros ok', isValidOtp('000123'), true);
eq('otp reject 5 digits', isValidOtp('12345'), false);
eq('otp reject 7 digits', isValidOtp('1234567'), false);
eq('otp reject letters', isValidOtp('12a456'), false);
eq('otp reject spaces', isValidOtp('123 456'), false);
eq('otp reject number type', isValidOtp(123456), false);
eq('otp reject undefined', isValidOtp(undefined), false);
eq('message text', buildOtpMessage('123456'), '[본심] 인증번호는 123456입니다.');

// ── Hook secret 파싱 (v1,whsec_...) ───────────────────────────────────────
eq('secret v1,whsec_ prefix stripped', parseHookSecrets(`v1,whsec_${FAKE_HOOK_SECRET_B64}`), [FAKE_HOOK_SECRET_B64]);
eq('secret whsec_ only', parseHookSecrets(`whsec_${FAKE_HOOK_SECRET_B64}`), [FAKE_HOOK_SECRET_B64]);
eq('secret bare base64', parseHookSecrets(FAKE_HOOK_SECRET_B64), [FAKE_HOOK_SECRET_B64]);
eq(
  'secret rotation (pipe separated)',
  parseHookSecrets(`v1,whsec_${FAKE_HOOK_SECRET_B64} | v1,whsec_${FAKE_HOOK_SECRET_B64}`),
  [FAKE_HOOK_SECRET_B64, FAKE_HOOK_SECRET_B64],
);
eq('secret reject non-base64', parseHookSecrets('v1,whsec_not base64!!'), []);
eq('secret reject empty', parseHookSecrets(''), []);
eq('secret reject too short', parseHookSecrets('v1,whsec_YWJj'), []);

// ── 설정 로드 (fail-closed) ───────────────────────────────────────────────
const cfgOk = loadSendSmsConfig(fakeEnv());
eq('config ok', cfgOk.ok, true);
if (cfgOk.ok) {
  eq('config sender normalized', cfgOk.config.senderNumber, '01099990000');
  eq('config hook secrets parsed', cfgOk.config.hookSecrets, [FAKE_HOOK_SECRET_B64]);
}
const cfgMissing = loadSendSmsConfig(fakeEnv({ SOLAPI_API_SECRET: undefined, SEND_SMS_HOOK_SECRETS: '   ' }));
eq('config missing detected', cfgMissing.ok ? null : cfgMissing.missing, ['SOLAPI_API_SECRET', 'SEND_SMS_HOOK_SECRETS']);
eq('config missing has no values', JSON.stringify(cfgMissing).includes(FAKE_API_KEY), false);
const cfgInvalid = loadSendSmsConfig(fakeEnv({ SOLAPI_SENDER_NUMBER: '+1 555 000', SEND_SMS_HOOK_SECRETS: 'v1,whsec_!!' }));
eq('config invalid detected', cfgInvalid.ok ? null : cfgInvalid.invalid, ['SOLAPI_SENDER_NUMBER', 'SEND_SMS_HOOK_SECRETS']);
eq('config all missing', loadSendSmsConfig(() => undefined).ok, false);

// ── HMAC-SHA256 Authorization 헤더 ────────────────────────────────────────
await (async () => {
  const date = '2026-09-02T12:00:00.000Z';
  const salt = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const expectedSig = createHmac('sha256', FAKE_API_SECRET).update(date + salt).digest('hex');
  eq('hmac matches node crypto', await hmacSha256Hex(FAKE_API_SECRET, date + salt), expectedSig);
  eq(
    'hmac known vector (RFC 4231 #2)',
    await hmacSha256Hex('key', 'The quick brown fox jumps over the lazy dog'),
    'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
  );
  const header = await buildSolapiAuthorization({ apiKey: FAKE_API_KEY, apiSecret: FAKE_API_SECRET, date, salt });
  eq(
    'authorization header format',
    header,
    `HMAC-SHA256 apiKey=${FAKE_API_KEY}, date=${date}, salt=${salt}, signature=${expectedSig}`,
  );
  eq('authorization does not contain secret', header.includes(FAKE_API_SECRET), false);
  const s1 = randomSalt();
  const s2 = randomSalt();
  eq('salt is 32 hex chars', /^[0-9a-f]{32}$/.test(s1), true);
  eq('salt differs per request', s1 !== s2, true);
})();

// ── fetch mock 헬퍼 (실제 SOLAPI 호출 없음) ───────────────────────────────
type Call = { url: string; init: RequestInit };
function mockFetch(
  responder: (call: Call) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}
const solapiOk = () =>
  new Response(JSON.stringify({ groupInfo: { count: { total: 1, registeredFailed: 0 } }, failedMessageList: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

// ── sendSolapiSms — 요청 형식 / 결과 판정 ─────────────────────────────────
await (async () => {
  const { fetch, calls } = mockFetch(solapiOk);
  const result = await sendSolapiSms(
    { to: RECIPIENT_LOCAL, from: '01099990000', text: buildOtpMessage(OTP), type: 'SMS' },
    { apiKey: FAKE_API_KEY, apiSecret: FAKE_API_SECRET },
    { fetch, now: () => new Date('2026-09-02T12:00:00.000Z'), salt: () => 'fixedsalt0123456789abcdef' },
  );
  eq('solapi ok result', result, { ok: true, status: 200 });
  eq('solapi url', calls[0]?.url, SOLAPI_SEND_URL);
  eq('solapi method', calls[0]?.init.method, 'POST');
  const headers = calls[0]?.init.headers as Record<string, string>;
  eq('solapi content-type', headers['Content-Type'], 'application/json');
  eq(
    'solapi authorization prefix',
    headers.Authorization?.startsWith(
      `HMAC-SHA256 apiKey=${FAKE_API_KEY}, date=2026-09-02T12:00:00.000Z, salt=fixedsalt0123456789abcdef, signature=`,
    ),
    true,
  );
  eq('solapi body', JSON.parse(String(calls[0]?.init.body)), {
    messages: [{ to: '01012345678', from: '01099990000', text: '[본심] 인증번호는 493817입니다.', type: 'SMS' }],
  });
  eq('solapi request has abort signal (timeout)', calls[0]?.init.signal instanceof AbortSignal, true);

  // HTTP 오류 (예: 인증 실패)
  const bad = mockFetch(
    () => new Response(JSON.stringify({ errorCode: 'InvalidApiKey', errorMessage: 'x' }), { status: 401 }),
  );
  const r2 = await sendSolapiSms(
    { to: RECIPIENT_LOCAL, from: '01099990000', text: 't', type: 'SMS' },
    { apiKey: FAKE_API_KEY, apiSecret: FAKE_API_SECRET },
    { fetch: bad.fetch },
  );
  eq('solapi http error', r2, { ok: false, reason: 'http_error', status: 401, errorCode: 'InvalidApiKey' });

  // 200 이지만 발송 실패 목록 존재
  const failedList = mockFetch(
    () =>
      new Response(
        JSON.stringify({
          groupInfo: { count: { total: 1, registeredFailed: 1 } },
          failedMessageList: [{ to: RECIPIENT_LOCAL, from: '01099990000', statusCode: '1041', statusMessage: 'invalid' }],
        }),
        { status: 200 },
      ),
  );
  const r3 = await sendSolapiSms(
    { to: RECIPIENT_LOCAL, from: '01099990000', text: 't', type: 'SMS' },
    { apiKey: FAKE_API_KEY, apiSecret: FAKE_API_SECRET },
    { fetch: failedList.fetch },
  );
  eq('solapi failed list → not ok', r3, { ok: false, reason: 'failed_messages', status: 200, statusCodes: ['1041'] });
  eq('solapi failed result has no phone', JSON.stringify(r3).includes(RECIPIENT_LOCAL), false);

  // 200 이지만 JSON 이 아님
  const notJson = mockFetch(() => new Response('<html>', { status: 200 }));
  const r4 = await sendSolapiSms(
    { to: RECIPIENT_LOCAL, from: '01099990000', text: 't', type: 'SMS' },
    { apiKey: FAKE_API_KEY, apiSecret: FAKE_API_SECRET },
    { fetch: notJson.fetch },
  );
  eq('solapi invalid response → not ok', r4, { ok: false, reason: 'invalid_response', status: 200 });

  // 네트워크 오류
  const netErr = mockFetch(() => {
    throw new TypeError('fetch failed');
  });
  const r5 = await sendSolapiSms(
    { to: RECIPIENT_LOCAL, from: '01099990000', text: 't', type: 'SMS' },
    { apiKey: FAKE_API_KEY, apiSecret: FAKE_API_SECRET },
    { fetch: netErr.fetch },
  );
  eq('solapi network error → not ok', r5, { ok: false, reason: 'network_error' });

  // 타임아웃 — abort 될 때까지 응답하지 않는 fetch
  const hang = mockFetch(
    (call) =>
      new Promise<Response>((_, reject) => {
        call.init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
  );
  const r6 = await sendSolapiSms(
    { to: RECIPIENT_LOCAL, from: '01099990000', text: 't', type: 'SMS' },
    { apiKey: FAKE_API_KEY, apiSecret: FAKE_API_SECRET },
    { fetch: hang.fetch, timeoutMs: 20 },
  );
  eq('solapi timeout → not ok', r6, { ok: false, reason: 'timeout' });
})();

// ── handleSendSmsRequest — 훅 요청 처리 (서명 검증기 주입) ────────────────
const HOOK_URL = 'https://example.test/functions/v1/send-sms';
const hookPayload = (overrides: { phone?: unknown; otp?: unknown } = {}) =>
  JSON.stringify({
    user: { id: 'user-1', phone: 'phone' in overrides ? overrides.phone : RECIPIENT_E164 },
    sms: { otp: 'otp' in overrides ? overrides.otp : OTP },
  });
const signedHeaders = { 'webhook-id': 'msg_1', 'webhook-timestamp': '1756814400', 'webhook-signature': 'v1,dummy' };
const hookRequest = (body: string, headers: Record<string, string> = signedHeaders, method = 'POST') =>
  new Request(HOOK_URL, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: method === 'POST' ? body : undefined });

function captureLog(): { log: SendSmsLogger; lines: string[] } {
  const lines: string[] = [];
  return { log: (level, message, fields) => lines.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`), lines };
}
const acceptAll = () => {};
const rejectAll = () => {
  throw new Error('No matching signature found');
};
const config = loadSendSmsConfig(fakeEnv());

await (async () => {
  // 정상: 서명 OK → SOLAPI 호출 → 200 {}
  {
    const { fetch, calls } = mockFetch(solapiOk);
    const { log, lines } = captureLog();
    const verifierCalls: { body: string; headers: Record<string, string> }[] = [];
    const res = await handleSendSmsRequest(hookRequest(hookPayload()), {
      config,
      fetch,
      log,
      verifyWebhook: (body, headers) => {
        verifierCalls.push({ body, headers });
      },
    });
    eq('success status', res.status, 200);
    eq('success content-type', res.headers.get('Content-Type'), 'application/json');
    eq('success body {}', await res.text(), '{}');
    eq('success solapi called once', calls.length, 1);
    eq('verifier got raw body', verifierCalls[0]?.body, hookPayload());
    eq('verifier got headers', verifierCalls[0]?.headers, signedHeaders);
    const sent = JSON.parse(String(calls[0]?.init.body));
    eq('sent to local format', sent.messages[0].to, RECIPIENT_LOCAL);
    eq('sent from sender', sent.messages[0].from, '01099990000');
    eq('sent text has otp', sent.messages[0].text, `[본심] 인증번호는 ${OTP}입니다.`);
    const joined = lines.join('\n');
    eq('logs have no otp', joined.includes(OTP), false);
    eq('logs have no full phone', joined.includes(RECIPIENT_LOCAL) || joined.includes(RECIPIENT_E164), false);
    eq('logs have no api secret', joined.includes(FAKE_API_SECRET), false);
  }

  // 서명 실패 → 401, SOLAPI 미호출
  {
    const { fetch, calls } = mockFetch(solapiOk);
    const { log, lines } = captureLog();
    const res = await handleSendSmsRequest(hookRequest(hookPayload()), { config, fetch, log, verifyWebhook: rejectAll });
    eq('bad signature status', res.status, 401);
    eq('bad signature content-type', res.headers.get('Content-Type'), 'application/json');
    eq('bad signature body', await res.json(), { error: { http_code: 401, message: 'invalid_signature' } });
    eq('bad signature → solapi NOT called', calls.length, 0);
    eq('bad signature logs have no otp', lines.join('\n').includes(OTP), false);
  }

  // 서명 헤더 누락 → 401, 검증기/SOLAPI 미호출
  {
    const { fetch, calls } = mockFetch(solapiOk);
    let verifierCalled = false;
    const res = await handleSendSmsRequest(
      hookRequest(hookPayload(), { 'webhook-id': 'msg_1' }),
      { config, fetch, log: () => {}, verifyWebhook: () => { verifierCalled = true; } },
    );
    eq('missing headers status', res.status, 401);
    eq('missing headers → verifier not called', verifierCalled, false);
    eq('missing headers → solapi NOT called', calls.length, 0);
  }

  // 설정 누락 → 500 (fail-closed), 검증/SOLAPI 미호출
  {
    const { fetch, calls } = mockFetch(solapiOk);
    const { log, lines } = captureLog();
    const broken: SendSmsConfigResult = loadSendSmsConfig(fakeEnv({ SOLAPI_API_KEY: undefined }));
    const res = await handleSendSmsRequest(hookRequest(hookPayload()), { config: broken, fetch, log, verifyWebhook: acceptAll });
    eq('misconfigured status', res.status, 500);
    eq('misconfigured body', await res.json(), { error: { http_code: 500, message: 'sms_hook_misconfigured' } });
    eq('misconfigured → solapi NOT called', calls.length, 0);
    eq('misconfigured log names missing var', lines.join('\n').includes('SOLAPI_API_KEY'), true);
    eq('misconfigured log has no secret', lines.join('\n').includes(FAKE_API_SECRET), false);
  }

  // 잘못된 전화번호 → 400, SOLAPI 미호출
  for (const phone of ['+15551234567', '+8221234567', '', null, 12345, undefined]) {
    const { fetch, calls } = mockFetch(solapiOk);
    const { log, lines } = captureLog();
    const res = await handleSendSmsRequest(hookRequest(hookPayload({ phone })), { config, fetch, log, verifyWebhook: acceptAll });
    eq(`invalid phone ${JSON.stringify(phone)} status`, res.status, 400);
    eq(`invalid phone ${JSON.stringify(phone)} body`, await res.json(), { error: { http_code: 400, message: 'invalid_recipient' } });
    eq(`invalid phone ${JSON.stringify(phone)} → solapi NOT called`, calls.length, 0);
    eq(`invalid phone ${JSON.stringify(phone)} log has no otp`, lines.join('\n').includes(OTP), false);
  }

  // 잘못된 OTP → 400, SOLAPI 미호출
  for (const otp of ['12345', '1234567', 'abcdef', 493817, '', undefined]) {
    const { fetch, calls } = mockFetch(solapiOk);
    const res = await handleSendSmsRequest(hookRequest(hookPayload({ otp })), { config, fetch, log: () => {}, verifyWebhook: acceptAll });
    eq(`invalid otp ${JSON.stringify(otp)} status`, res.status, 400);
    eq(`invalid otp ${JSON.stringify(otp)} body`, await res.json(), { error: { http_code: 400, message: 'invalid_otp' } });
    eq(`invalid otp ${JSON.stringify(otp)} → solapi NOT called`, calls.length, 0);
  }

  // Supabase 가 + 없이 저장한 번호(821012345678)도 정상 변환
  {
    const { fetch, calls } = mockFetch(solapiOk);
    const res = await handleSendSmsRequest(hookRequest(hookPayload({ phone: '821012345678' })), { config, fetch, log: () => {}, verifyWebhook: acceptAll });
    eq('stored phone without plus status', res.status, 200);
    eq('stored phone without plus → to', JSON.parse(String(calls[0]?.init.body)).messages[0].to, RECIPIENT_LOCAL);
  }

  // JSON 아님 / 구조 불일치 → 400
  {
    const { fetch, calls } = mockFetch(solapiOk);
    const res = await handleSendSmsRequest(hookRequest('not json'), { config, fetch, log: () => {}, verifyWebhook: acceptAll });
    eq('non-json status', res.status, 400);
    eq('non-json → solapi NOT called', calls.length, 0);
    const res2 = await handleSendSmsRequest(hookRequest('[]'), { config, fetch, log: () => {}, verifyWebhook: acceptAll });
    eq('array payload status', res2.status, 400);
    eq('array payload → solapi NOT called', calls.length, 0);
  }

  // POST 외 메서드 → 405
  {
    const { fetch, calls } = mockFetch(solapiOk);
    const res = await handleSendSmsRequest(hookRequest('', signedHeaders, 'GET'), { config, fetch, log: () => {}, verifyWebhook: acceptAll });
    eq('GET status', res.status, 405);
    eq('GET content-type', res.headers.get('Content-Type'), 'application/json');
    eq('GET → solapi NOT called', calls.length, 0);
  }

  // SOLAPI 오류 → 502 (성공 응답 금지), 응답/로그에 민감정보 없음
  {
    const { fetch, calls } = mockFetch(
      () => new Response(JSON.stringify({ errorCode: 'ValidationError', errorMessage: `to ${RECIPIENT_LOCAL} invalid` }), { status: 400 }),
    );
    const { log, lines } = captureLog();
    const res = await handleSendSmsRequest(hookRequest(hookPayload()), { config, fetch, log, verifyWebhook: acceptAll });
    eq('solapi http error status', res.status, 502);
    eq('solapi http error content-type', res.headers.get('Content-Type'), 'application/json');
    const text = await res.text();
    eq('solapi http error body', JSON.parse(text), { error: { http_code: 502, message: 'sms_send_failed' } });
    eq('solapi http error called once', calls.length, 1);
    eq('error body has no otp', text.includes(OTP), false);
    eq('error body has no phone', text.includes(RECIPIENT_LOCAL) || text.includes('1012345678'), false);
    const joined = lines.join('\n');
    eq('error log mentions reason', joined.includes('http_error') && joined.includes('ValidationError'), true);
    eq('error log has no otp', joined.includes(OTP), false);
    eq('error log has no phone', joined.includes('1012345678'), false);
    eq('error log has no secret', joined.includes(FAKE_API_SECRET), false);
  }
  {
    const { fetch } = mockFetch(
      () =>
        new Response(
          JSON.stringify({ groupInfo: { count: { registeredFailed: 1 } }, failedMessageList: [{ to: RECIPIENT_LOCAL, statusCode: '1041' }] }),
          { status: 200 },
        ),
    );
    const { log, lines } = captureLog();
    const res = await handleSendSmsRequest(hookRequest(hookPayload()), { config, fetch, log, verifyWebhook: acceptAll });
    eq('solapi failed list status', res.status, 502);
    eq('solapi failed list body', await res.json(), { error: { http_code: 502, message: 'sms_send_failed' } });
    eq('solapi failed list log has status code only', lines.join('\n').includes('1041') && !lines.join('\n').includes(RECIPIENT_LOCAL), true);
  }
  {
    const { fetch } = mockFetch(
      (call) =>
        new Promise<Response>((_, reject) => {
          call.init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const res = await handleSendSmsRequest(hookRequest(hookPayload()), { config, fetch, log: () => {}, verifyWebhook: acceptAll, timeoutMs: 20 });
    eq('solapi timeout status', res.status, 502);
  }
})();

console.log(`send-sms selftest: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
