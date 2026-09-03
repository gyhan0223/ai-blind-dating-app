/**
 * SMS OTP 재전송 쿨다운 저장 (AsyncStorage). 판정 로직은 otpCooldownCore.ts (순수 함수).
 * 저장 실패는 조용히 무시한다 — 서버가 진짜 차단을 하므로 클라이언트 저장은 편의 기능이다.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { type CooldownMap, parseStoredCooldowns, serializeCooldowns } from './otpCooldownCore';

const STORAGE_KEY = 'otp_resend_cooldown_v1';

export async function loadOtpCooldowns(now: number = Date.now()): Promise<CooldownMap> {
  try {
    return parseStoredCooldowns(await AsyncStorage.getItem(STORAGE_KEY), now);
  } catch {
    return {};
  }
}

export async function saveOtpCooldowns(map: CooldownMap): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, serializeCooldowns(map));
  } catch {
    // 저장 실패는 무시 (서버가 차단을 보장)
  }
}
