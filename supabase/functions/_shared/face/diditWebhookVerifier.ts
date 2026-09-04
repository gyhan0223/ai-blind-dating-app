/**
 * Didit 웹훅 서명 검증 — 순수 모듈 (Web Crypto 만 사용. Deno / Node 18+ 공통).
 *
 * Didit 은 모든 웹훅에 세 가지 서명 헤더를 붙인다.
 *   X-Signature-V2 (권장)  : HMAC-SHA256(secret, canonical_json(body)) 의 hex
 *                            canonical_json = 키 정렬 + 공백 없는 구분자 + 유니코드 비이스케이프
 *                            (Python `json.dumps(body, sort_keys=True, separators=(',', ':'), ensure_ascii=False)`
 *                             와 동일. 정수값 float(예: 1.0) 은 정수로 축약된다)
 *   X-Signature            : HMAC-SHA256(secret, raw_body) — 미들웨어가 JSON 을 재직렬화하면 깨지는 구버전
 *   X-Signature-Simple     : HMAC-SHA256(secret, "{timestamp}:{session_id}:{status}:{webhook_type}")
 *   X-Timestamp            : unix seconds
 *
 * 이 모듈은 문서가 권장하는 X-Signature-V2 만 검증한다 (약한 방식으로의 fallback 없음).
 * 타임스탬프는 ±5분(WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) 밖이면 replay 로 간주해 거부한다.
 * 비교는 상수 시간으로 수행한다. secret 값은 어떤 로그/오류에도 포함하지 않는다.
 */
import { WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS } from './faceCore.ts';

// ---------------------------------------------------------------------------
// canonical JSON
// ---------------------------------------------------------------------------

/** Python shorten_floats 와 동일: 정수값 실수는 정수로 (JS 에서는 사실상 항등이지만 명시적으로 유지) */
export function shortenFloats(data: unknown): unknown {
  if (data === null || data === undefined) return data;
  if (Array.isArray(data)) return data.map(shortenFloats);
  if (typeof data === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) out[k] = shortenFloats(v);
    return out;
  }
  if (typeof data === 'number' && Number.isFinite(data) && data === Math.floor(data)) {
    return Math.floor(data);
  }
  return data;
}

/** 키 정렬 + compact 직렬화 (Python json.dumps(sort_keys=True, separators=(',', ':'), ensure_ascii=False)) */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalWebhookBody(body: unknown): string {
  return stableStringify(shortenFloats(body));
}

// ---------------------------------------------------------------------------
// HMAC
// ---------------------------------------------------------------------------

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** X-Signature-V2 기대값 계산 (테스트/시뮬레이터용으로도 사용) */
export function computeDiditSignatureV2(secret: string, body: unknown): Promise<string> {
  return hmacSha256Hex(secret, canonicalWebhookBody(body));
}

/** 상수 시간 hex 비교 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (x.length === 0 || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// 검증
// ---------------------------------------------------------------------------

export type WebhookHeaders = {
  /** X-Signature-V2 */
  signatureV2: string | null;
  /** X-Timestamp (unix seconds) — 없으면 body.created_at / body.timestamp 를 사용 */
  timestamp: string | null;
};

export type WebhookVerifyFailure =
  | 'missing_secret'
  | 'invalid_json'
  | 'missing_signature'
  | 'missing_timestamp'
  | 'stale_timestamp'
  | 'bad_signature';

export type WebhookVerifyResult =
  | { ok: true; body: Record<string, unknown>; timestamp: number }
  | { ok: false; reason: WebhookVerifyFailure };

export async function verifyDiditWebhook(input: {
  rawBody: string;
  headers: WebhookHeaders;
  secret: string | null | undefined;
  nowSeconds: number;
  toleranceSeconds?: number;
}): Promise<WebhookVerifyResult> {
  const secret = (input.secret ?? '').trim();
  if (!secret) return { ok: false, reason: 'missing_secret' };

  let body: unknown;
  try {
    body = JSON.parse(input.rawBody);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, reason: 'invalid_json' };
  }
  const record = body as Record<string, unknown>;

  const signature = (input.headers.signatureV2 ?? '').trim();
  if (!signature) return { ok: false, reason: 'missing_signature' };

  const headerTs = input.headers.timestamp ? Number(input.headers.timestamp) : NaN;
  const bodyTs =
    typeof record.created_at === 'number'
      ? record.created_at
      : typeof record.timestamp === 'number'
        ? record.timestamp
        : NaN;
  const timestamp = Number.isFinite(headerTs) ? headerTs : bodyTs;
  if (!Number.isFinite(timestamp)) return { ok: false, reason: 'missing_timestamp' };

  const tolerance = input.toleranceSeconds ?? WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS;
  if (Math.abs(input.nowSeconds - timestamp) > tolerance) return { ok: false, reason: 'stale_timestamp' };

  const expected = await computeDiditSignatureV2(secret, record);
  if (!timingSafeEqualHex(expected, signature)) return { ok: false, reason: 'bad_signature' };

  return { ok: true, body: record, timestamp };
}
