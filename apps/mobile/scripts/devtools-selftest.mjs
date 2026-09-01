/**
 * DEV_TOOLS_ENABLED guard selftest — Node 로 실행 (Expo/RN 불필요).
 *   node --experimental-strip-types scripts/devtools-selftest.mjs
 *
 * Issue #3 핵심 보장: release 빌드(__DEV__=false)에서는
 * EXPO_PUBLIC_DEV_LOGIN 값과 무관하게 개발 도구가 절대 켜지지 않는다.
 */
import { computeDevToolsEnabled } from '../src/lib/devToolsCore.ts';

let passed = 0;
let failed = 0;

function eq(name, actual, expected) {
  if (actual === expected) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL ${name}: expected ${expected}, got ${actual}`);
  }
}

// release 빌드 — public flag 가 어떤 값이든 무조건 false
eq('release + flag=1 → false', computeDevToolsEnabled(false, '1'), false);
eq('release + flag=0 → false', computeDevToolsEnabled(false, '0'), false);
eq('release + flag 없음 → false', computeDevToolsEnabled(false, undefined), false);
eq('release + 이상한 값 → false', computeDevToolsEnabled(false, 'true'), false);

// 개발 빌드 — explicit opt-in 필요
eq('dev + flag=1 → true', computeDevToolsEnabled(true, '1'), true);
eq('dev + flag 없음 → false (opt-in)', computeDevToolsEnabled(true, undefined), false);
eq('dev + flag=0 → false', computeDevToolsEnabled(true, '0'), false);
eq('dev + flag="true" → false (1 만 유효)', computeDevToolsEnabled(true, 'true'), false);

console.log(`devtools selftest: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
