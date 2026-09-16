import { computeDevToolsEnabled } from './devToolsCore';

/**
 * 개발 편의 기능(테스트 로그인 · 본인확인 통과 · 얼굴 촬영 건너뛰기 등) 노출 여부 — 단일 guard.
 *
 * release 빌드에서는 EXPO_PUBLIC_DEV_LOGIN=1 이 잘못 주입돼도 항상 false 다.
 *
 * 사용 규칙: JSX 에서 반드시 리터럴 `__DEV__ && DEV_TOOLS_ENABLED` 형태로 감싼다.
 * Metro 가 release 번들에서 `__DEV__` 를 false 리터럴로 치환하므로, 리터럴 가드가 있으면
 * 개발용 버튼/문구가 minify 단계에서 번들에서 물리적으로 제거된다(dead code elimination).
 * (DEV_TOOLS_ENABLED 자체에도 __DEV__ 가 포함되어 있어 논리적으로는 중복이지만,
 *  모듈 경계를 넘는 상수는 정적으로 제거되지 않기 때문에 리터럴 가드가 필요하다.)
 */
export const DEV_TOOLS_ENABLED = computeDevToolsEnabled(
  __DEV__,
  process.env.EXPO_PUBLIC_DEV_LOGIN,
);

export type DevModules = typeof import('@/dev/devModules');

/**
 * 개발 전용 모듈(dev-login · Mock 얼굴 승인 · 시드 계정 로그인)을 개발 빌드에서만 불러온다 (#3).
 *
 * 버튼을 숨기는 것과 코드가 release 산출물에서 제거되는 것은 다르다 — 이전에는 `devMockApproveFace` 같은 함수가 일반 모듈에
 * 정적으로 import 되어 있어 버튼이 사라져도 'complete-face-verification' 호출 코드가 번들에 남았다.
 * 여기서는 `if (__DEV__) require(...)` 만 쓴다: Metro 는 production 변환에서 __DEV__ 를 false 로 치환하고 도달 불가능한 분기를
 * 제거한 뒤 의존성을 수집하므로 `@/dev/*` 모듈 전체가 release 번들에서 빠진다.
 * 검증: `npm run release:check` (실제 expo export 산출물 grep) — 문자열을 바꿔 검사를 피하지 않는다.
 */
export function loadDevModules(): DevModules | null {
  if (__DEV__) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@/dev/devModules') as DevModules;
  }
  return null;
}
