/**
 * 민감정보 마스킹 (#20) — 순수 모듈. 서버 `supabase/functions/_shared/observability/redact.ts` 와 규칙을 동기 유지한다.
 * 오류 보고(Sentry)·로그에 전화번호·이메일·OTP·토큰·해시·얼굴 경로가 남지 않게 한다. uuid 는 opaque id 라 유지한다.
 */

const RULES: { re: RegExp; mask: string }[] = [
  { re: /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, mask: '[jwt]' },
  { re: /(bearer\s+)[A-Za-z0-9._\-]{8,}/gi, mask: '$1[token]' },
  { re: /((?:api[_-]?key|secret|token|password|passwd|pwd)["']?\s*[:=]\s*["']?)[^\s"',}]{4,}/gi, mask: '$1[redacted]' },
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, mask: '[email]' },
  { re: /\+\d{9,15}\b/g, mask: '[phone]' },
  { re: /\b01[016789][\s.-]?\d{3,4}[\s.-]?\d{4}\b/g, mask: '[phone]' },
  { re: /\bfaces\/[^\s"']+/g, mask: 'faces/[path]' },
  { re: /\b[0-9a-f]{32,}\b/gi, mask: '[hash]' },
  { re: /((?:인증번호|인증 번호|otp|verification code|code)\s*(?:는|은|:|=|is)?\s*)\d{4,8}\b/gi, mask: '$1[otp]' },
];

export function redact(text: string | null | undefined, maxLength = 2000): string {
  if (text == null) return '';
  let out = String(text);
  for (const r of RULES) out = out.replace(r.re, r.mask);
  if (out.length > maxLength) out = out.slice(0, maxLength) + '…';
  return out;
}

const DENY_KEY = /content|message|body|phone|email|token|secret|password|otp|identity|reference_path|card|detail|note|nickname/i;

/** 객체의 문자열 값을 재귀적으로 마스킹하고, 원문·연락처 류 키는 통째로 제거한다 (Sentry beforeSend 용) */
export function redactDeep<T>(value: T, depth = 0): T {
  if (depth > 6) return value;
  if (typeof value === 'string') return redact(value, 1000) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (DENY_KEY.test(k) && k !== 'message' && k !== 'exception') continue; // Sentry 이벤트의 message/exception 은 값만 마스킹
      if (DENY_KEY.test(k) && (k === 'message' || k === 'exception') && depth === 0) {
        out[k] = redactDeep(v, depth + 1);
        continue;
      }
      if (DENY_KEY.test(k)) continue;
      out[k] = redactDeep(v, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}
