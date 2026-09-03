/**
 * SMS OTP 재전송 쿨다운(otpCooldownCore) selftest — Node 로 실행 (Expo/RN 불필요).
 *   node --experimental-strip-types scripts/otp-cooldown-selftest.mjs
 *
 * 보장:
 *   - 발송 후 60초 동안 남은 시간이 정확히 줄어들고, 지나면 0
 *   - 번호별로 독립 · 화면 이동/재시작 후에도 저장값으로 복원
 *   - 저장소의 깨진 값/이상한 키/만료 항목은 버린다
 *   - 기기 시계가 뒤로 가도 60초를 넘겨 잠그지 않는다
 */
import {
  cooldownRemainingSec,
  formatCooldown,
  markSent,
  OTP_RESEND_COOLDOWN_SEC,
  parseStoredCooldowns,
  pruneCooldowns,
  serializeCooldowns,
} from '../src/lib/otpCooldownCore.ts';

let passed = 0;
let failed = 0;

function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const T0 = 1_756_814_400_000; // 임의 기준 시각 (ms)
const A = '+821012345678';
const B = '+821087654321';

eq('cooldown is 60s (서버와 동일)', OTP_RESEND_COOLDOWN_SEC, 60);

// 남은 시간
eq('no record → 0', cooldownRemainingSec(undefined, T0), 0);
eq('just sent → 60', cooldownRemainingSec(T0, T0), 60);
eq('0.5s later → 60 (올림)', cooldownRemainingSec(T0, T0 + 500), 60);
eq('1s later → 59', cooldownRemainingSec(T0, T0 + 1000), 59);
eq('59.9s later → 1', cooldownRemainingSec(T0, T0 + 59_900), 1);
eq('60s later → 0', cooldownRemainingSec(T0, T0 + 60_000), 0);
eq('1h later → 0', cooldownRemainingSec(T0, T0 + 3_600_000), 0);
eq('clock went backwards → capped at 60', cooldownRemainingSec(T0 + 999_999_999, T0), 60);
eq('NaN record → 0', cooldownRemainingSec(Number.NaN, T0), 0);
eq('custom cooldown 10s', cooldownRemainingSec(T0, T0 + 4000, 10), 6);

// markSent / 번호별 독립 / 화면 이동 후 유지
{
  const m1 = markSent({}, A, T0);
  eq('markSent records phone', m1, { [A]: T0 });
  eq('A locked', cooldownRemainingSec(m1[A], T0 + 10_000), 50);
  eq('B not locked (다른 번호)', cooldownRemainingSec(m1[B], T0 + 10_000), 0);
  const m2 = markSent(m1, B, T0 + 10_000);
  eq('both recorded', m2, { [A]: T0, [B]: T0 + 10_000 });
  eq('A still locked after B sent (번호 변경 후 돌아와도 유지)', cooldownRemainingSec(m2[A], T0 + 20_000), 40);
  const m3 = markSent(m2, A, T0 + 61_000);
  eq('expired A pruned then re-marked', m3, { [B]: T0 + 10_000, [A]: T0 + 61_000 });
  eq('original map untouched', m1, { [A]: T0 });
}

// prune
eq('prune removes expired only', pruneCooldowns({ [A]: T0, [B]: T0 + 30_000 }, T0 + 60_000), { [B]: T0 + 30_000 });
eq('prune empty', pruneCooldowns({}, T0), {});

// 저장/복원
{
  const raw = serializeCooldowns({ [A]: T0 });
  eq('round trip (앱 재시작 후 복원)', parseStoredCooldowns(raw, T0 + 5000), { [A]: T0 });
  eq('round trip expired → dropped', parseStoredCooldowns(raw, T0 + 60_000), {});
  eq('null raw', parseStoredCooldowns(null, T0), {});
  eq('empty raw', parseStoredCooldowns('', T0), {});
  eq('broken json', parseStoredCooldowns('{oops', T0), {});
  eq('array json', parseStoredCooldowns('[1,2]', T0), {});
  eq('non-object json', parseStoredCooldowns('42', T0), {});
  eq('bad key dropped', parseStoredCooldowns(JSON.stringify({ '010-1234-5678': T0, [A]: T0 }), T0), { [A]: T0 });
  eq('bad value dropped', parseStoredCooldowns(JSON.stringify({ [A]: 'now', [B]: T0 }), T0), { [B]: T0 });
  eq('huge future value capped (60s 뒤엔 풀림)', cooldownRemainingSec(parseStoredCooldowns(JSON.stringify({ [A]: T0 + 1e12 }), T0)[A], T0 + 60_000), 60);
}

// 표시
eq('format 60', formatCooldown(60), '01:00');
eq('format 5', formatCooldown(5), '00:05');
eq('format 0', formatCooldown(0), '00:00');
eq('format negative → 00:00', formatCooldown(-3), '00:00');

console.log(`otp-cooldown selftest: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
