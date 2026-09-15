# Crash/오류 모니터링과 민감정보 없는 로그 (#20)

무료 티어·자체 로그 범위로 구현했다. 유료 플랜은 실제 베타 트래픽이 무료 한도를 넘을 때 판단한다.

## 구조

| 영역 | 도구 | 켜는 조건 | 위치 |
|---|---|---|---|
| 앱 crash·오류 | Sentry (`@sentry/react-native` 7.11, SDK 57 번들 버전) | `EXPO_PUBLIC_SENTRY_DSN` 설정 시. 없으면 아무것도 하지 않는다 | `apps/mobile/src/lib/monitoring.ts` |
| Edge Function 오류 | `server_errors` 테이블 (항상) + Sentry Store API (`SENTRY_DSN` 설정 시, SDK 없이 HTTP) | 항상 (RPC `record_server_error`, service role) | `supabase/functions/_shared/observability/report.ts` |
| 마스킹 규칙 | 순수 모듈 2벌 (앱·서버 동기) | — | `apps/mobile/src/lib/redactCore.ts` · `_shared/observability/redact.ts` |
| 관리자 조회 | `/errors` (최근 24시간 수·같은 유형 묶음) | — | `apps/admin/app/errors/page.tsx` |

태그: `environment`(앱: `EXPO_PUBLIC_APP_ENV` 또는 `__DEV__` 기준, 서버: `APP_ENV`), `release`(앱: `bonsim@<app.json version>`, `dist` = 빌드 번호 / 서버: `RELEASE` secret).

## PII redaction 규칙 (앱·서버 동일, selftest 로 검증)

| 지우는 것 | 예 → 결과 |
|---|---|
| JWT / Bearer / api key·secret·password 값 | `Bearer eyJ…` → `Bearer [jwt]`, `DIDIT_API_KEY=…` → `[redacted]` |
| 이메일 | `a@b.co` → `[email]` |
| 전화번호 (E.164, 010-…) | `+821012345678` → `[phone]` |
| 얼굴 이미지 경로 | `faces/<uid>/liveness/reference.jpg` → `faces/[path]` |
| 32자 이상 16진수 (identity 해시, HMAC) | → `[hash]` |
| 인증번호 (인증번호/otp/code 뒤 4~8자리) | `인증번호 123456` → `인증번호 [otp]` |
| 컨텍스트 키 | `content`·`message`·`phone`·`email`·`token`·`card`·`reference_path`·`nickname`·`note`·`detail` 키는 통째로 제거. 허용 키는 allowlist (`user_id`·`match_id`·`conversation_id`·`stage`… — opaque id 만) |

uuid 는 opaque id 라 유지한다. 콘솔 breadcrumb 은 버린다 (앱 콘솔에 원문이 찍힐 수 있으므로).

## 알림 기준 (운영 기본값)

- fatal: 앱 crash-free 세션 비율이 하루 기준 99% 아래 → Sentry 알림 규칙 (무료 티어에서 설정 가능).
- 핵심 API: `server_errors` 에서 같은 fingerprint 가 1시간 안 10건 이상 → 확인. 대상 함수: `daily-recommendation`, `send-push`, `account-purge`, `didit-webhook`, `send-sms`.
  (didit-webhook / send-sms / verify-identity 는 기존 로그 규약을 유지하며 `reportServerError` 연결은 후속 — 이번 범위는 새로 만든 함수 4개.)

## 설정

1. Sentry 프로젝트 2개(React Native / 서버) 또는 1개. DSN 은 공개 값이다.
2. 앱: `EXPO_PUBLIC_SENTRY_DSN`, `EXPO_PUBLIC_APP_ENV` (EAS 빌드 프로필별). 네이티브 심볼리케이션은 `app.json` 에 `@sentry/react-native/expo` 플러그인(`organization`, `project`) + 빌드 환경 `SENTRY_AUTH_TOKEN` — **#18 EAS 설정에서 함께** (지금은 플러그인 미추가: 값이 없으면 빌드 경고를 내므로).
3. 서버: `0021_server_errors.sql` 적용, 선택으로 `supabase secrets set SENTRY_DSN=… RELEASE=<sha>`. cron: `select public.server_errors_prune(interval '30 days')` 일 1회.

## 검증

- `cd supabase/functions/_shared/observability && node --experimental-strip-types selftest.ts` (17건)
- `cd apps/mobile && node --experimental-strip-types scripts/redact-selftest.mjs` (9건 — Sentry 이벤트 형태에서 user.email/phone·extra.content·Authorization 제거)
- `supabase/tests/server_errors_tests.sql` (service role 전용·fingerprint·prune)
- **미실행**: 실기기 release 빌드 crash 수집·Sentry 대시보드 표시, Store API 실제 전송. DSN 을 넣은 빌드에서 확인해야 한다.
