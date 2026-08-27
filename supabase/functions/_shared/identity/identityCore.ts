/**
 * identity 핵심 로직 — 순수 모듈 (Deno Edge Function / Node selftest 겸용).
 *
 * 설계 원칙
 *   phone number != permanent user identity
 *   identityKey(본인확인 DI 등) → account → current phone
 *
 * 보안 원칙
 *   - raw identityKey 는 이 모듈 밖으로 저장/로그되지 않는다. DB 에는 HMAC 해시만.
 *   - HMAC 은 서버에서만 수행한다 (secret 은 Edge Function 환경변수).
 */

/** production 에서는 반드시 IDENTITY_HASH_SECRET 환경변수로 교체해야 하는 개발용 기본값.
 *  시드(seed.sql)의 fixture 해시 계산과 반드시 일치해야 한다. */
export const DEV_IDENTITY_HASH_SECRET = 'dev-only-identity-secret-do-not-use-in-prod';

// ---------------------------------------------------------------------------
// 전화번호 정규화 (한국 우선)
// ---------------------------------------------------------------------------

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

/** E.164 → 국내 표기 */
export function e164ToLocalKR(e164: string): string {
  return e164.startsWith('+82') ? `0${e164.slice(3)}` : e164;
}

/** 로그/응답용 마스킹: 010-****-5678 */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const local = e164ToLocalKR(phone).replace(/[^\d]/g, '');
  if (local.length < 8) return null;
  return `${local.slice(0, 3)}-****-${local.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// HMAC (WebCrypto — Deno / Node 18+ 공통)
// ---------------------------------------------------------------------------

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
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

/** raw identityKey → 저장용 해시. 호출 후 raw 값은 즉시 폐기한다. */
export function hashIdentityKey(rawIdentityKey: string, secret: string): Promise<string> {
  return hmacSha256Hex(secret, `identity:${rawIdentityKey}`);
}

/** 기기 ID → 저장용 해시 (원본 미저장) */
export function hashDeviceId(rawDeviceId: string, secret: string): Promise<string> {
  return hmacSha256Hex(secret, `device:${rawDeviceId}`);
}

// ---------------------------------------------------------------------------
// Mock identityKey 매핑 (개발 fixture)
//
//  - 010-0000-0001…       → dev-user-001…            (번호별 고유 identity)
//  - 010-0000-0011 / 0012 → duplicate-test-user      (번호 변경 시나리오)
//  - 010-0000-0021 / 0022 → race-test-user           (동시 가입 race 시나리오)
//  - 010-0000-0098 / 0099 → banned-test-user         (차단 우회 방지 시나리오)
//  - 그 외                 → 이름+생년월일 기반 결정적 키 (같은 사람 = 같은 키)
// ---------------------------------------------------------------------------

const FIXTURES: Record<string, string> = {
  '01000000011': 'duplicate-test-user',
  '01000000012': 'duplicate-test-user',
  '01000000021': 'race-test-user',
  '01000000022': 'race-test-user',
  '01000000098': 'banned-test-user',
  '01000000099': 'banned-test-user',
};

export function mockIdentityKeyFor(input: {
  phoneE164: string | null;
  name: string;
  birthDate: string;
}): string {
  const local = input.phoneE164 ? e164ToLocalKR(input.phoneE164) : '';
  if (FIXTURES[local]) return FIXTURES[local];
  if (/^0100000\d{4}$/.test(local)) return `dev-user-${local.slice(-3)}`;
  // 일반 입력: 같은 사람(이름+생년월일)이면 항상 같은 identityKey 가 되도록 결정적 유도.
  // 실서비스에서는 본인확인 기관이 내려주는 DI 를 그대로 사용한다.
  return `mock-di:${input.name.trim()}:${input.birthDate}`;
}

// ---------------------------------------------------------------------------
// 가입/복구 분기 결정 — verify-identity Edge Function 의 핵심 판단
// ---------------------------------------------------------------------------

export type ExistingIdentity = {
  userId: string | null; // 계정 삭제 후 identity 만 남으면 null
  banned: boolean;
  userStatus: string | null; // 연결된 계정의 users.status (없으면 null)
} | null;

export type IdentityOutcome =
  | 'created' // 신규 identity — 계정에 연결
  | 'already_verified' // 이미 본인 계정에 연결됨 (재시도 idempotent)
  | 'relinked' // 삭제된 계정의 identity 를 새 계정에 재연결 (재가입)
  | 'existing_account' // 같은 사람의 다른 활성 계정 존재 → 복구 flow
  | 'blocked'; // banned identity → 가입 금지

export function decideIdentityOutcome(existing: ExistingIdentity, myUserId: string): IdentityOutcome {
  if (!existing) return 'created';
  if (existing.banned) return 'blocked';
  if (existing.userId === myUserId) return 'already_verified';
  if (existing.userId === null) return 'relinked';
  if (existing.userStatus === 'banned') return 'blocked'; // banned 동기화 누락 대비 이중 방어
  return 'existing_account';
}

/** 만 나이 계산 → 성인(만 19세 이상) 여부 */
export function isAdult(birthDate: string, now: Date = new Date()): boolean {
  const birth = new Date(birthDate);
  if (Number.isNaN(birth.getTime())) return false;
  let age = now.getFullYear() - birth.getFullYear();
  const beforeBirthday =
    now.getMonth() < birth.getMonth() ||
    (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate());
  if (beforeBirthday) age -= 1;
  return age >= 19;
}
