/**
 * 개발 도구 노출 판단 — 순수 함수 (Node selftest 겸용, React Native 전역에 의존하지 않음).
 *
 * 보안 원칙 (Issue #3):
 *   release 빌드(__DEV__ === false)에서는 EXPO_PUBLIC_DEV_LOGIN 값과 무관하게 항상 false.
 *   EXPO_PUBLIC_* 는 클라이언트 번들에 포함되는 public 값이므로,
 *   그 값 하나만으로 production 에서 개발 기능이 켜져서는 안 된다.
 *   개발 빌드에서도 명시적으로 EXPO_PUBLIC_DEV_LOGIN=1 을 설정해야 켜진다 (explicit opt-in).
 */
export function computeDevToolsEnabled(
  isDevBuild: boolean,
  devLoginFlag: string | undefined,
): boolean {
  return isDevBuild === true && devLoginFlag === '1';
}
