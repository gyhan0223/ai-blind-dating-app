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
