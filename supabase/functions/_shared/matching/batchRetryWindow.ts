/**
 * 배치(daily-recommendation-batch)의 후보 부족 재확인 창 (#22).
 *
 * 후보 없음(exhausted)으로 끝난 사용자는 이 창이 지난 뒤에야 다시 대상이 된다 (recommendation_batch_targets · recommendation_run_claim 에 같은 값).
 * 매시간 :00 cron 과 정확히 1시간 창을 함께 쓰면 09:00:05 에 끝난 사용자가 10:00:00 에는 "1시간 안" 이라 빠져 두 시간에 한 번이 되므로,
 * 배치는 cron 간격보다 짧은 50분을 쓴다. 앱(daily-recommendation)은 이 값을 쓰지 않고 DB 기본(1시간)을 유지한다.
 */

/** 배치 기본 창 — 매시간 cron 보다 짧게 (50분) */
export const BATCH_RETRY_AFTER_SECONDS = 50 * 60;
/** 수동 실행·운영 점검용 override 하한 (5분) — 너무 짧으면 같은 사용자를 헛되이 반복해서 훑는다 */
export const MIN_RETRY_AFTER_SECONDS = 5 * 60;
/** override 상한 (24시간) — 그보다 길면 하루 안의 재확인이 없어진다 */
export const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;

/** 요청 body 의 retry_after_seconds 를 검증한다. 숫자가 아니거나 범위 밖이면 기본값으로 되돌린다 (요청이 정책을 넓히지 못하게) */
export function resolveRetryAfterSeconds(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < MIN_RETRY_AFTER_SECONDS || n > MAX_RETRY_AFTER_SECONDS) return BATCH_RETRY_AFTER_SECONDS;
  return Math.floor(n);
}
