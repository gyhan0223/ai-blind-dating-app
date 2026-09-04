/**
 * Didit 네이티브 SDK 브리지 — 앱에서 SDK 를 직접 참조하는 유일한 파일.
 *
 * - Expo Go / 네이티브 모듈이 없는 빌드에서는 앱이 시작 시 죽지 않도록 lazy require 한다.
 *   (Development Build 또는 스토어 빌드에서만 실제 카메라 화면이 열린다 — docs/face-liveness-didit.md)
 * - SDK 화면(얼굴 안내·동작 감지·자동 촬영·분석)은 전부 SDK 가 담당한다. 앱은 토큰을 넘기고 결과만 받는다.
 * - 결과는 faceFlowCore.mapSdkResult 로 내부 타입으로 바꾼 뒤 화면 상태에만 사용한다 (승인 근거 아님).
 */
import Constants from 'expo-constants';
import { isExpoGo, type SdkResultLike } from './faceFlowCore';

type DiditModule = typeof import('@didit-protocol/sdk-react-native');

function loadSdk(): DiditModule | null {
  if (isExpoGo(Constants.executionEnvironment)) return null;
  try {
    // 네이티브 TurboModule 이 없으면 require 시점에 throw 된다 (Expo Go, 웹, 플러그인 미적용 빌드).
    // 정적 import 로 바꾸면 그런 빌드에서 앱 시작 자체가 실패하므로 의도적으로 lazy require 한다.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@didit-protocol/sdk-react-native') as DiditModule;
  } catch {
    return null;
  }
}

/** 이 빌드에서 SDK 를 실행할 수 있는지 (권한/기기 지원과는 별개) */
export function isDiditSdkAvailable(): boolean {
  return loadSdk() !== null;
}

/**
 * Didit 라이브니스 화면을 연다. 사용자가 촬영 버튼을 누르지 않아도 SDK 가 얼굴 위치·동작을 인식해
 * 자동으로 촬영·분석하고, 끝나면 화면을 닫는다(closeOnComplete).
 */
export async function runDiditLiveness(sessionToken: string): Promise<SdkResultLike> {
  const sdk = loadSdk();
  if (!sdk) {
    return { type: 'failed', error: { type: 'notInitialized', message: 'sdk_unavailable' } };
  }
  try {
    const result = await sdk.startVerification(sessionToken, {
      languageCode: 'ko',
      showCloseButton: true,
      showExitConfirmation: true,
      closeOnComplete: true,
      defaultLivenessCamera: sdk.CameraLens.Front,
      showLivenessCameraSwitchButton: false,
      loggingEnabled: false,
    });
    return result as SdkResultLike;
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    return { type: 'failed', error: { type: 'unknown', message } };
  }
}
