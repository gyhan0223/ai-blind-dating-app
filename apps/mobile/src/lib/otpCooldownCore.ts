/**
 * SMS OTP 재전송 쿨다운 — 순수 함수 (Node selftest 겸용, React Native 전역에 의존하지 않음).
 *
 * 역할: 화면 UX. 같은 번호로 60초 안에 "인증번호 받기 / 재전송" 버튼을 다시 누르지 못하게 잠근다.
 *   - 번호 입력 화면 ↔ 인증번호 화면을 오가도(번호 변경) 쿨다운이 유지된다.
 *   - AsyncStorage 에 저장해 앱을 껐다 켜도 유지된다 (otpCooldown.ts).
 *
 * 진짜 차단은 서버가 한다 — send-sms Edge Function(Send SMS Hook)이 DB RPC(sms_otp_rate_limit_check)로
 * 번호별 60초 쿨다운 + 시간당 상한을 강제하고, 걸리면 429 를 돌려준다. 이 모듈은 그 429 를
 * 애초에 만들지 않기 위한 클라이언트 편의 장치일 뿐이며, 우회돼도 보안/비용에 영향이 없다.
 */

/** 서버(send-sms SMS_OTP_COOLDOWN_SEC)와 맞춘 값 */
export const OTP_RESEND_COOLDOWN_SEC = 60;

/** 전화번호(E.164) → 마지막 발송 시각 (ms epoch) */
export type CooldownMap = Record<string, number>;

/** 남은 쿨다운(초). 없거나 지났으면 0. 기기 시계가 뒤로 간 경우도 최대 cooldownSec 을 넘지 않는다 */
export function cooldownRemainingSec(
  lastSentAt: number | undefined,
  now: number,
  cooldownSec: number = OTP_RESEND_COOLDOWN_SEC,
): number {
  if (typeof lastSentAt !== 'number' || !Number.isFinite(lastSentAt)) return 0;
  const remainingMs = lastSentAt + cooldownSec * 1000 - now;
  if (remainingMs <= 0) return 0;
  return Math.min(cooldownSec, Math.ceil(remainingMs / 1000));
}

/** 쿨다운이 끝난 번호를 제거한 새 맵 */
export function pruneCooldowns(
  map: CooldownMap,
  now: number,
  cooldownSec: number = OTP_RESEND_COOLDOWN_SEC,
): CooldownMap {
  const out: CooldownMap = {};
  for (const [phone, at] of Object.entries(map)) {
    if (cooldownRemainingSec(at, now, cooldownSec) > 0) out[phone] = at;
  }
  return out;
}

/** 발송(또는 서버 429) 시각을 기록한 새 맵 — 원본은 바꾸지 않는다 */
export function markSent(
  map: CooldownMap,
  phone: string,
  now: number,
  cooldownSec: number = OTP_RESEND_COOLDOWN_SEC,
): CooldownMap {
  return { ...pruneCooldowns(map, now, cooldownSec), [phone]: now };
}

/**
 * 저장소에서 읽은 문자열 → CooldownMap. 깨진 값/이상한 형식/만료 항목은 버린다 (항상 안전한 맵을 돌려준다).
 * 전화번호 키는 E.164(+82…)만 받는다.
 */
export function parseStoredCooldowns(
  raw: string | null | undefined,
  now: number,
  cooldownSec: number = OTP_RESEND_COOLDOWN_SEC,
): CooldownMap {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: CooldownMap = {};
  for (const [phone, at] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^\+\d{8,15}$/.test(phone)) continue;
    if (typeof at !== 'number' || !Number.isFinite(at)) continue;
    if (cooldownRemainingSec(at, now, cooldownSec) > 0) out[phone] = at;
  }
  return out;
}

export function serializeCooldowns(map: CooldownMap): string {
  return JSON.stringify(map);
}

/** 60 → "01:00", 5 → "00:05" */
export function formatCooldown(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
