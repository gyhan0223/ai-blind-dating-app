/**
 * Crash/Error 모니터링 (#20) — Sentry (@sentry/react-native). 무료 티어 기준.
 *
 *  * EXPO_PUBLIC_SENTRY_DSN 이 없으면 아무것도 하지 않는다 (개발·로컬 기본). DSN 은 공개 값이라 번들에 포함돼도 된다.
 *  * beforeSend / beforeBreadcrumb 에서 redactDeep 으로 전화번호·이메일·OTP·토큰·해시·얼굴 경로·메시지 원문을 지운다.
 *  * environment = EXPO_PUBLIC_APP_ENV(없으면 __DEV__ 기준), release = 앱 버전, dist = 빌드 번호.
 *  * 사용자 식별은 opaque user id 만 (setUser({ id })). 이메일·전화번호·닉네임은 넣지 않는다.
 *  * 네이티브 crash 심볼리케이션(source map 업로드)은 app.json 의 @sentry/react-native/expo 플러그인 + SENTRY_AUTH_TOKEN 이 필요하다 — #18 EAS 설정에서.
 */
import Constants from 'expo-constants';
import * as Sentry from '@sentry/react-native';
import { redact, redactDeep } from './redactCore';

const DSN = process.env.EXPO_PUBLIC_SENTRY_DSN;
let initialized = false;

export function monitoringEnvironment(): string {
  const env = process.env.EXPO_PUBLIC_APP_ENV;
  if (env === 'development' || env === 'staging' || env === 'production') return env;
  return __DEV__ ? 'development' : 'production';
}

export function initMonitoring() {
  if (initialized || !DSN) return;
  initialized = true;
  const version = Constants.expoConfig?.version ?? '0.0.0';
  const build =
    Constants.expoConfig?.ios?.buildNumber ?? (Constants.expoConfig?.android?.versionCode != null ? String(Constants.expoConfig.android.versionCode) : undefined);
  Sentry.init({
    dsn: DSN,
    environment: monitoringEnvironment(),
    release: `bonsim@${version}`,
    dist: build,
    enableAutoSessionTracking: true,
    tracesSampleRate: 0, // 성능 추적은 무료 한도 절약을 위해 끈다
    sendDefaultPii: false,
    maxBreadcrumbs: 30,
    beforeSend(event) {
      return redactDeep(event);
    },
    beforeBreadcrumb(breadcrumb) {
      // 네트워크 breadcrumb 의 URL 에 토큰/이메일이 섞이지 않게, 콘솔 로그는 버린다
      if (breadcrumb.category === 'console') return null;
      return redactDeep(breadcrumb);
    },
  });
}

/** 로그인/로그아웃 시 — opaque id 만 */
export function setMonitoringUser(userId: string | null) {
  if (!initialized) return;
  Sentry.setUser(userId ? { id: userId } : null);
}

/** 화면에서 잡은 오류 보고 (컨텍스트는 키만 — 원문 금지) */
export function captureError(err: unknown, context: Record<string, string | number | boolean | null> = {}) {
  if (!initialized) return;
  const safeContext: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(context)) safeContext[k] = typeof v === 'string' ? redact(v, 300) : v;
  Sentry.withScope((scope) => {
    scope.setContext('app', safeContext);
    if (err instanceof Error) Sentry.captureException(err);
    else Sentry.captureMessage(redact(String(err), 500));
  });
}

/** 화면 이동 breadcrumb (경로만) */
export function addScreenBreadcrumb(route: string) {
  if (!initialized) return;
  Sentry.addBreadcrumb({ category: 'navigation', message: redact(route, 200), level: 'info' });
}
