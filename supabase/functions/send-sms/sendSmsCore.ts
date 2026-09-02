/**
 * Supabase Auth "Send SMS" HTTP Hook → SOLAPI 발송 핵심 로직 — 순수 모듈
 * (Deno Edge Function / Node selftest 겸용. Deno 전역·npm 의존 없음 — Web Crypto + fetch 만 사용).
 *
 * 보안 원칙 (Issue #4)
 *   - 이 훅은 JWT 발급 전에 호출되므로 JWT 인증에 의존하지 않는다. 대신 Supabase 가 붙여 보내는
 *     Standard Webhooks 서명(webhook-id / webhook-timestamp / webhook-signature)을 반드시 검증한다.
 *     검증 구현(standardwebhooks 라이브러리)은 index.ts 가 주입하고, 실패하면 SOLAPI 를 호출하지 않는다.
 *   - fail-closed: 필수 환경변수가 하나라도 없거나 형식이 잘못되면 어떤 요청도 처리하지 않는다.
 *   - 전화번호(한국 휴대전화)와 OTP(6자리 숫자)는 서버에서 다시 검증한다. 유효하지 않으면 SOLAPI 로 보내지 않는다.
 *   - 로그 · 응답 본문 · 오류 메시지에 OTP, 전체 전화번호, API secret 을 절대 포함하지 않는다.
 *   - SOLAPI 가 실패했는데 Supabase 에 성공(200)으로 응답하지 않는다.
 */

// ---------------------------------------------------------------------------
// 환경변수 (서버 전용 — EXPO_PUBLIC_* / 클라이언트 번들에 절대 넣지 않는다)
// ---------------------------------------------------------------------------

export const REQUIRED_ENV_VARS = [
  'SOLAPI_API_KEY',
  'SOLAPI_API_SECRET',
  'SOLAPI_SENDER_NUMBER',
  'SEND_SMS_HOOK_SECRETS',
] as const;

export type SendSmsConfig = {
  apiKey: string;
  apiSecret: string;
  /** SOLAPI 전송용 발신번호 — 숫자만 (+, -, 공백 없음) */
  senderNumber: string;
  /** Standard Webhooks 검증용 base64 secret 목록 (`v1,whsec_` 접두어 제거됨). 회전을 위해 복수 허용 */
  hookSecrets: string[];
};

export type SendSmsConfigResult =
  | { ok: true; config: SendSmsConfig }
  | { ok: false; missing: string[]; invalid: string[] };

/**
 * 환경변수를 읽어 설정을 만든다 (fail-closed).
 * 누락(missing)·형식 오류(invalid) 변수 "이름" 만 돌려주며 값은 절대 포함하지 않는다.
 */
export function loadSendSmsConfig(env: (name: string) => string | undefined): SendSmsConfigResult {
  const read = (name: string) => (env(name) ?? '').trim();
  const missing = REQUIRED_ENV_VARS.filter((name) => read(name) === '');
  const invalid: string[] = [];

  const senderNumber = normalizeSenderNumberKR(read('SOLAPI_SENDER_NUMBER'));
  if (read('SOLAPI_SENDER_NUMBER') !== '' && !senderNumber) invalid.push('SOLAPI_SENDER_NUMBER');

  const hookSecrets = parseHookSecrets(read('SEND_SMS_HOOK_SECRETS'));
  if (read('SEND_SMS_HOOK_SECRETS') !== '' && hookSecrets.length === 0) invalid.push('SEND_SMS_HOOK_SECRETS');

  if (missing.length > 0 || invalid.length > 0) return { ok: false, missing, invalid };
  return {
    ok: true,
    config: {
      apiKey: read('SOLAPI_API_KEY'),
      apiSecret: read('SOLAPI_API_SECRET'),
      senderNumber: senderNumber as string,
      hookSecrets,
    },
  };
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * SEND_SMS_HOOK_SECRETS 파싱.
 * Supabase Dashboard 가 보여주는 형식은 `v1,whsec_<base64>` 이며, secret 회전 시 여러 개를 `|` 로
 * 이어 붙일 수 있다. 각 항목에서 `v1,` 과 `whsec_` 접두어를 벗겨 base64 본문만 돌려준다.
 * base64 로 해석할 수 없는 항목은 버린다 (→ 전부 버려지면 설정 오류로 fail-closed).
 */
export function parseHookSecrets(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split('|')) {
    let s = part.trim();
    if (!s) continue;
    if (s.startsWith('v1,')) s = s.slice(3);
    if (s.startsWith('whsec_')) s = s.slice('whsec_'.length);
    if (s.length < 16 || !BASE64_RE.test(s) || s.length % 4 !== 0) continue;
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 전화번호 / OTP 검증 (서버에서 다시 검증 — 클라이언트/Auth 입력을 신뢰하지 않는다)
// ---------------------------------------------------------------------------

/** 한국 휴대전화 국내 형식: 010/011/016/017/018/019 + 7~8자리 */
const KR_MOBILE_LOCAL_RE = /^01[016789]\d{7,8}$/;
/** 발신번호: 국내 일반/휴대전화(0 으로 시작, 9~11자리) 또는 대표번호(15xx/16xx/18xx, 8자리) */
const KR_SENDER_RE = /^(0\d{8,10}|1[5-9]\d{6})$/;

/**
 * 한국 번호를 SOLAPI 전송용 국내 형식(숫자만)으로 바꾼다.
 *   "+821012345678" → "01012345678"   (E.164)
 *   "821012345678"  → "01012345678"   (Supabase auth.users.phone 은 + 없이 저장된다)
 *   "010-1234-5678" → "01012345678"
 * 한국(+82) 외 국가번호, 형식 불일치 → null.
 */
function toLocalDigitsKR(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  const digits = trimmed.replace(/[^\d]/g, '');
  if (!digits) return null;
  if (trimmed.startsWith('+')) {
    if (!digits.startsWith('82')) return null; // 한국 외 미지원
    return `0${digits.slice(2).replace(/^0/, '')}`;
  }
  if (digits.startsWith('0')) return digits;
  if (digits.startsWith('82')) return `0${digits.slice(2).replace(/^0/, '')}`;
  return digits;
}

/** 수신번호: 한국 휴대전화만 허용. 실패 시 null (→ SOLAPI 호출 금지) */
export function toSolapiPhoneKR(input: string | null | undefined): string | null {
  const local = toLocalDigitsKR(input);
  return local && KR_MOBILE_LOCAL_RE.test(local) ? local : null;
}

/** 발신번호(SOLAPI_SENDER_NUMBER): +, -, 공백 제거 후 국내 형식으로. 실패 시 null */
export function normalizeSenderNumberKR(input: string | null | undefined): string | null {
  const local = toLocalDigitsKR(input);
  return local && KR_SENDER_RE.test(local) ? local : null;
}

/** OTP 는 6자리 숫자 문자열만 허용 */
export function isValidOtp(otp: unknown): otp is string {
  return typeof otp === 'string' && /^\d{6}$/.test(otp);
}

/** 발송 문구 — SMS(90byte) 한도 내 */
export function buildOtpMessage(otp: string): string {
  return `[본심] 인증번호는 ${otp}입니다.`;
}

// ---------------------------------------------------------------------------
// SOLAPI HMAC-SHA256 인증 (Web Crypto — SDK 미사용)
// ---------------------------------------------------------------------------

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return toHex(new Uint8Array(sig));
}

/** 요청마다 새로 만드는 salt — 16바이트 랜덤 → 32자 hex (SOLAPI 요구: 12~64바이트) */
export function randomSalt(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

export type SolapiAuthInput = { apiKey: string; apiSecret: string; date: string; salt: string };

/**
 * Authorization 헤더 값:
 *   HMAC-SHA256 apiKey=..., date=<ISO 8601>, salt=<random>, signature=<hex(HMAC-SHA256(apiSecret, date + salt))>
 */
export async function buildSolapiAuthorization(input: SolapiAuthInput): Promise<string> {
  const signature = await hmacSha256Hex(input.apiSecret, input.date + input.salt);
  return `HMAC-SHA256 apiKey=${input.apiKey}, date=${input.date}, salt=${input.salt}, signature=${signature}`;
}

// ---------------------------------------------------------------------------
// SOLAPI 발송
// ---------------------------------------------------------------------------

export const SOLAPI_SEND_URL = 'https://api.solapi.com/messages/v4/send-many/detail';

/** Supabase HTTP Hook 전체 제한(5초) 안에서 응답을 돌려주기 위한 SOLAPI 요청 타임아웃 */
export const DEFAULT_SOLAPI_TIMEOUT_MS = 3000;

export type SolapiSendResult =
  | { ok: true; status: number }
  | {
      ok: false;
      reason: 'http_error' | 'timeout' | 'network_error' | 'invalid_response' | 'failed_messages';
      status?: number;
      /** SOLAPI 오류 코드 (예: InvalidApiKey) — 전화번호/OTP 를 포함하지 않는 값만 */
      errorCode?: string;
      /** 발송 실패 메시지의 SOLAPI statusCode 목록 (예: "1041") */
      statusCodes?: string[];
    };

export type SolapiDeps = {
  fetch: typeof fetch;
  now?: () => Date;
  salt?: () => string;
  timeoutMs?: number;
};

type SolapiMessage = { to: string; from: string; text: string; type: 'SMS' };

/**
 * SOLAPI send-many/detail 로 SMS 1건을 보낸다. HTTP 상태 + failedMessageList 를 모두 확인한다.
 * 결과 객체에는 전화번호/OTP/secret 이 들어가지 않는다 (로그에 그대로 써도 안전).
 */
export async function sendSolapiSms(
  message: SolapiMessage,
  auth: { apiKey: string; apiSecret: string },
  deps: SolapiDeps,
): Promise<SolapiSendResult> {
  const now = deps.now ?? (() => new Date());
  const salt = (deps.salt ?? randomSalt)();
  const date = now().toISOString();
  const authorization = await buildSolapiAuthorization({ ...auth, date, salt });

  const controller = new AbortController();
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SOLAPI_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await deps.fetch(SOLAPI_SEND_URL, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [message] }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = controller.signal.aborted || (err instanceof Error && err.name === 'AbortError');
    return { ok: false, reason: aborted ? 'timeout' : 'network_error' };
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  } finally {
    clearTimeout(timer);
  }

  const obj = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;

  if (!res.ok) {
    const errorCode = obj && typeof obj.errorCode === 'string' ? obj.errorCode : undefined;
    return { ok: false, reason: 'http_error', status: res.status, errorCode };
  }
  if (!obj) return { ok: false, reason: 'invalid_response', status: res.status };

  const failedList = Array.isArray(obj.failedMessageList) ? obj.failedMessageList : [];
  const groupInfo = obj.groupInfo && typeof obj.groupInfo === 'object' ? (obj.groupInfo as Record<string, unknown>) : null;
  const count = groupInfo?.count && typeof groupInfo.count === 'object' ? (groupInfo.count as Record<string, unknown>) : null;
  const registeredFailed = typeof count?.registeredFailed === 'number' ? count.registeredFailed : 0;

  if (failedList.length > 0 || registeredFailed > 0) {
    const statusCodes = failedList
      .map((m) => (m && typeof m === 'object' ? (m as Record<string, unknown>).statusCode : undefined))
      .filter((c): c is string => typeof c === 'string');
    return { ok: false, reason: 'failed_messages', status: res.status, statusCodes };
  }
  return { ok: true, status: res.status };
}

// ---------------------------------------------------------------------------
// Hook 요청 처리
// ---------------------------------------------------------------------------

export type WebhookHeaders = {
  'webhook-id': string;
  'webhook-timestamp': string;
  'webhook-signature': string;
};

/**
 * Standard Webhooks 서명 검증기 — 검증 실패 시 throw 한다 (반환값은 사용하지 않는다).
 * index.ts 가 standardwebhooks 라이브러리로 구현해 주입한다.
 */
export type WebhookVerifier = (rawBody: string, headers: WebhookHeaders) => void | Promise<void>;

export type SendSmsLogger = (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;

export type SendSmsHandlerDeps = {
  config: SendSmsConfigResult;
  verifyWebhook: WebhookVerifier;
  fetch: typeof fetch;
  now?: () => Date;
  salt?: () => string;
  timeoutMs?: number;
  log?: SendSmsLogger;
};

/** 성공/오류 모두 application/json 으로 응답한다 */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Supabase Auth Hook 오류 형식 — message 에는 고정 코드만 (OTP/전화번호/secret 없음) */
function hookError(httpCode: number, message: string): Response {
  return jsonResponse({ error: { http_code: httpCode, message } }, httpCode);
}

const defaultLogger: SendSmsLogger = (level, message, fields) => {
  const line = `[send-sms] ${message}${fields ? ' ' + JSON.stringify(fields) : ''}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

/**
 * Send SMS Hook 요청 → SOLAPI 발송.
 *   POST 만 허용 → 설정 검사(fail-closed) → 서명 검증 → payload 재검증 → SOLAPI → 200 `{}`
 * 어떤 단계에서든 실패하면 SOLAPI 호출 없이(또는 실패 그대로) 오류 응답을 돌려준다.
 */
export async function handleSendSmsRequest(req: Request, deps: SendSmsHandlerDeps): Promise<Response> {
  const log = deps.log ?? defaultLogger;

  if (req.method !== 'POST') return hookError(405, 'method_not_allowed');

  if (!deps.config.ok) {
    log('error', 'misconfigured — 요청 거부 (fail-closed)', {
      missing: deps.config.missing,
      invalid: deps.config.invalid,
    });
    return hookError(500, 'sms_hook_misconfigured');
  }
  const { config } = deps.config;

  const rawBody = await req.text();
  const headers: WebhookHeaders = {
    'webhook-id': req.headers.get('webhook-id') ?? '',
    'webhook-timestamp': req.headers.get('webhook-timestamp') ?? '',
    'webhook-signature': req.headers.get('webhook-signature') ?? '',
  };
  if (!headers['webhook-id'] || !headers['webhook-timestamp'] || !headers['webhook-signature']) {
    log('warn', 'signature headers missing');
    return hookError(401, 'invalid_signature');
  }
  try {
    await deps.verifyWebhook(rawBody, headers);
  } catch {
    log('warn', 'signature verification failed');
    return hookError(401, 'invalid_signature');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    log('warn', 'payload is not JSON');
    return hookError(400, 'invalid_payload');
  }
  const p = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  const user = p?.user && typeof p.user === 'object' ? (p.user as Record<string, unknown>) : null;
  const sms = p?.sms && typeof p.sms === 'object' ? (p.sms as Record<string, unknown>) : null;

  const to = toSolapiPhoneKR(typeof user?.phone === 'string' ? user.phone : null);
  if (!to) {
    log('warn', 'recipient is not a KR mobile number — not sent');
    return hookError(400, 'invalid_recipient');
  }
  const otp = sms?.otp;
  if (!isValidOtp(otp)) {
    log('warn', 'otp is not a 6-digit code — not sent');
    return hookError(400, 'invalid_otp');
  }

  const startedAt = Date.now();
  const result = await sendSolapiSms(
    { to, from: config.senderNumber, text: buildOtpMessage(otp), type: 'SMS' },
    { apiKey: config.apiKey, apiSecret: config.apiSecret },
    { fetch: deps.fetch, now: deps.now, salt: deps.salt, timeoutMs: deps.timeoutMs },
  );
  const latencyMs = Date.now() - startedAt;

  if (!result.ok) {
    log('error', 'solapi send failed', {
      reason: result.reason,
      status: result.status,
      errorCode: result.errorCode,
      statusCodes: result.statusCodes,
      latencyMs,
    });
    return hookError(502, 'sms_send_failed');
  }

  log('info', 'sms sent', { status: result.status, latencyMs });
  return jsonResponse({}, 200);
}
