/**
 * 전화번호 정규화/표시 유틸리티 — 한국(+82) 우선.
 *
 *  - UI 표시: 010-1234-5678
 *  - Auth/DB: E.164 (+821012345678)
 *
 * 전화번호는 로그인 수단일 뿐 계정의 영구 식별자가 아니다.
 * (영구 식별은 서버의 본인확인 identity_key_hash — 클라이언트는 관여하지 않는다)
 */

const KR_MOBILE_RE = /^01[016789]\d{7,8}$/;

/** "010-1234-5678" / "+82 10 1234 5678" → "+821012345678" (실패 시 null) */
export function normalizePhoneKR(input: string): string | null {
  if (!input) return null;
  const plus = input.trim().startsWith('+') ? '+' : '';
  const s = plus + input.replace(/[^\d]/g, '');
  if (s.startsWith('+82')) {
    const rest = s.slice(3).replace(/^0/, '');
    return KR_MOBILE_RE.test(`0${rest}`) ? `+82${rest}` : null;
  }
  if (s.startsWith('+')) return null; // 한국 외 미지원
  return KR_MOBILE_RE.test(s) ? `+82${s.slice(1)}` : null;
}

/** 표시용: +821012345678 → 010-1234-5678 */
export function formatPhoneKR(phone: string): string {
  const local = phone.startsWith('+82')
    ? `0${phone.slice(3).replace(/[^\d]/g, '')}`
    : phone.replace(/[^\d]/g, '');
  if (/^01\d{9}$/.test(local)) return `${local.slice(0, 3)}-${local.slice(3, 7)}-${local.slice(7)}`;
  if (/^01\d{8}$/.test(local)) return `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}`;
  return phone;
}

/** 입력 중 실시간 자동 하이픈 */
export function autoHyphen(input: string): string {
  const d = input.replace(/[^\d]/g, '').slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 7) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
}
