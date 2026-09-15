/**
 * 민감정보 마스킹 (#20) — 순수 모듈 (Deno/Node 겸용). 앱(`apps/mobile/src/lib/redactCore.ts`)과 규칙을 동기 유지한다.
 *
 * 로그·오류 보고에 절대 남기면 안 되는 것: 전화번호 · 이메일 · 인증번호(OTP) · JWT/토큰/API key · 본인확인 해시 ·
 * 얼굴 이미지 경로 · 메시지 원문. 사용자 식별은 opaque uuid 만 허용한다 (uuid 는 마스킹하지 않는다).
 */

const RULES: { name: string; re: RegExp; mask: string }[] = [
  // JWT (header.payload.signature) — 가장 먼저 (숫자 규칙에 걸리기 전에)
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, mask: '[jwt]' },
  // Bearer / api key 류
  { name: 'bearer', re: /(bearer\s+)[A-Za-z0-9._\-]{8,}/gi, mask: '$1[token]' },
  { name: 'apikey', re: /((?:api[_-]?key|secret|token|password|passwd|pwd)["']?\s*[:=]\s*["']?)[^\s"',}]{4,}/gi, mask: '$1[redacted]' },
  // 이메일
  { name: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, mask: '[email]' },
  // 전화번호 — E.164(+82…) / 010-0000-0000 / 01000000000
  { name: 'phone_e164', re: /\+\d{9,15}\b/g, mask: '[phone]' },
  { name: 'phone_kr', re: /\b01[016789][\s.-]?\d{3,4}[\s.-]?\d{4}\b/g, mask: '[phone]' },
  // 얼굴 이미지 경로
  { name: 'face_path', re: /\bfaces\/[^\s"']+/g, mask: 'faces/[path]' },
  // 긴 16진수 (identity_key_hash, HMAC 등 32자 이상). uuid(8-4-4-4-12) 는 하이픈 때문에 걸리지 않는다
  { name: 'hex', re: /\b[0-9a-f]{32,}\b/gi, mask: '[hash]' },
  // OTP — "인증번호/code/otp" 근처의 4~8자리 숫자
  { name: 'otp', re: /((?:인증번호|인증 번호|otp|verification code|code)\s*(?:는|은|:|=|is)?\s*)\d{4,8}\b/gi, mask: '$1[otp]' },
];

/** 문자열 안의 민감정보를 마스킹한다. 길이도 제한한다 (기본 2000자) */
export function redact(text: string | null | undefined, maxLength = 2000): string {
  if (text == null) return '';
  let out = String(text);
  for (const r of RULES) out = out.replace(r.re, r.mask);
  if (out.length > maxLength) out = out.slice(0, maxLength) + '…';
  return out;
}

/** 로그에 실어도 되는 컨텍스트 키 allowlist — 메시지 본문·연락처·인증 데이터 키는 애초에 넣지 않는다 */
const CONTEXT_KEY_ALLOW = new Set([
  'function', 'stage', 'action', 'kind', 'status', 'http_status', 'user_id', 'match_id', 'conversation_id',
  'recommendation_id', 'report_id', 'event_id', 'attempt', 'count', 'reason', 'platform', 'release', 'environment',
  'screen', 'route', 'code',
]);

const CONTEXT_KEY_DENY = /content|message_text|body|phone|email|token|secret|password|otp|code_value|identity|reference_path|front_path|left_path|right_path|card|detail|note/i;

/** 컨텍스트 객체를 allowlist 로 거르고 값도 마스킹한다. 중첩 객체는 버린다 */
export function sanitizeContext(ctx: Record<string, unknown> | null | undefined): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!ctx) return out;
  for (const [k, v] of Object.entries(ctx)) {
    if (!CONTEXT_KEY_ALLOW.has(k) || CONTEXT_KEY_DENY.test(k)) continue;
    if (v == null) out[k] = null;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = redact(v, 300);
    // 객체/배열은 버린다 (원문·카드 등이 섞여 들어오는 것을 막는다)
  }
  return out;
}

/** Error → 안전한 메시지 (스택은 파일 경로만 남긴다) */
export function safeErrorMessage(err: unknown): { message: string; name: string; stack: string | null } {
  if (err instanceof Error) {
    return { message: redact(err.message, 500), name: err.name, stack: err.stack ? redact(err.stack, 2000) : null };
  }
  if (typeof err === 'string') return { message: redact(err, 500), name: 'Error', stack: null };
  return { message: 'unknown_error', name: 'Error', stack: null };
}
