# 환경 분리 (local / staging / production)

Issue #3 기준 환경 모델. 핵심 원칙은 두 가지다.

1. **fail-closed** — 서버는 `APP_ENV` 가 없거나 알 수 없는 값이면 **production 으로 간주**한다.
   설정 실수/누락 상태에서 개발용 우회 기능이 켜지는 일이 없어야 한다.
2. **explicit opt-in** — 개발 기능(dev-login, face skip, fixture)은
   "명시적 development/staging + 명시적 허용 플래그" 조합에서만 켜진다.
   production 은 어떤 플래그 조합으로도 켜지지 않는다.

## Supabase 프로젝트 분리 원칙

| 환경 | Supabase | 용도 |
|---|---|---|
| local | `supabase start` (로컬 CLI) | 일상 개발. seed/fixture 자유롭게 사용 |
| staging | **별도 staging 프로젝트** | 배포 전 검증. Test OTP/fixture 허용 가능 |
| production | **별도 production 프로젝트** | 실서비스. 개발 기능·fixture 일절 금지 |

- **staging 과 production 은 절대 같은 Supabase 프로젝트를 공유하지 않는다.**
- staging/production 프로젝트 생성은 비용이 발생하는 외부 작업이므로 이 저장소에서
  자동으로 수행하지 않는다. 프로젝트를 만든 뒤 아래 환경변수 표대로 설정하면 된다.

## 환경 판별 방법

- **서버(Edge Functions)**: 서버 전용 환경변수 `APP_ENV` (`supabase secrets set APP_ENV=...`).
  판별 로직은 `supabase/functions/_shared/env/envCore.ts` — 누락/오타 → production 취급.
  **클라이언트 입력이나 `EXPO_PUBLIC_*` 값은 서버 보안 판단에 절대 사용하지 않는다.**
- **클라이언트(mobile)**: 빌드 타입 `__DEV__` 가 1차 기준.
  `DEV_TOOLS_ENABLED`(`apps/mobile/src/lib/devTools.ts`) =
  `__DEV__ && EXPO_PUBLIC_DEV_LOGIN === '1'` — release 빌드에서는 public flag 값과
  무관하게 항상 false. 클라이언트 가드는 UX 용이고, 최종 방어선은 서버 가드다.

## Mobile public 환경변수 (`apps/mobile/.env`)

> ⚠️ **`EXPO_PUBLIC_*` 값은 전부 클라이언트 번들에 포함된다. 어떤 secret 도 절대 넣지 말 것.**
> (service role key, `IDENTITY_HASH_SECRET`, 관리자 비밀번호 등 금지)

| 변수 | local | staging | production | secret? | 번들 포함? |
|---|---|---|---|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | 로컬 URL (`http://127.0.0.1:54321`) | staging 프로젝트 URL | production 프로젝트 URL | 아니오 | 예 |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | 로컬 anon key | staging anon key | production anon key | 아니오 (public key) | 예 |
| `EXPO_PUBLIC_DEV_LOGIN` | `1` (개발 기능 opt-in) | 설정 안 함 권장 | **설정 금지** (설정돼도 release 빌드에선 무효) | 아니오 | 예 |

- URL/anon key 가 없으면 앱은 모든 환경에서 즉시 실패한다(fail-fast, localhost fallback 없음).
- release 빌드는 localhost 계열 URL 을 거부한다 (`apps/mobile/src/lib/supabase.ts`).

## Edge Function 서버 환경변수 (`supabase secrets` / 로컬 `supabase/functions/.env`)

실제 값은 문서/저장소에 절대 적지 않는다. 예시 파일: `supabase/functions/.env.example`

| 변수 | local | staging | production | secret? | 비고 |
|---|---|---|---|---|---|
| `APP_ENV` | `development` | `staging` | `production` | 아니오 | 누락 시 production 취급 (fail-closed) |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | (CLI 자동 주입) | (자동 주입) | (자동 주입) | **service role 은 secret** | 클라이언트에 절대 노출 금지 |
| `IDENTITY_HASH_SECRET` | 생략 가능 (dev fixture secret 사용) | **필수** — 32자+ 고유 값 | **필수** — 32자+ 고유 값 (staging 과 다른 값) | **예** | 미설정/개발 기본값/짧은 값 → verify-identity 기동 실패 |
| `IDENTITY_PROVIDER` | 생략 가능 (`mock` 기본값) | 생략 가능 (`mock`) 또는 실제 provider | **필수** — 실제 provider 이름 (`mock` 금지) | 아니오 | 미설정/`mock`/미구현 이름 → verify-identity 기동 실패 |
| `FACE_VERIFICATION_PROVIDER` | 생략 가능 (`mock` 기본값) | `didit` 권장 (실기기 테스트) 또는 생략(`mock`) | **필수** — `didit` (`mock` 금지) | 아니오 | 미설정/`mock`/미구현 이름 → start-face-liveness·didit-webhook 기동 실패. `mock` 은 complete-face-verification(개발용)만 기동 |
| `DIDIT_API_KEY` | didit 사용 시 필수 | **필수** (didit 시) | **필수** | **예** | Didit 세션 생성·Decision 조회. 로그/응답 미노출 |
| `DIDIT_WORKFLOW_ID` | didit 사용 시 필수 | **필수** (didit 시) | **필수** | 아니오 (비공개 취급) | Liveness-only 워크플로 ID (3D Action & Flash, 최대 3회, Face Search) |
| `DIDIT_WEBHOOK_SECRET` | didit 사용 시 필수 | **필수** (didit 시) — staging 앱의 secret | **필수** — production 앱의 secret | **예** | didit-webhook 의 `X-Signature-V2` 검증. 없으면 모든 웹훅 500 |
| `DIDIT_API_BASE_URL` | — | — | — | 아니오 | 선택. 기본 `https://verification.didit.me` |
| `ALLOW_DEV_LOGIN` | `1` (dev-login 쓸 때) | 필요 시 `1` | **설정 금지** — 설정돼도 403 | 아니오 | dev-login opt-in |
| `DEV_LOGIN_PASSWORD` | 생략 가능 (seed 기본값) | 고유 값 권장 | 해당 없음 (dev-login 미배포) | 예 | dev-login 계정 비밀번호 |
| `DEV_LOGIN_ALLOW_ANY_PHONE` | 필요 시 `1` | 필요 시 `1` | 해당 없음 | 아니오 | 테스트 대역 외 번호 허용 |
| `DISABLE_DEV_LOGIN` | — | — | — | 아니오 | 긴급 kill switch (모든 환경에서 유효) |
| `SOLAPI_API_KEY` | 생략 (Test OTP 사용) | **필수** (실발송 시) | **필수** | **예** | send-sms 전용. 누락 시 send-sms 가 모든 요청 거부 (fail-closed) |
| `SOLAPI_API_SECRET` | 생략 | **필수** (실발송 시) | **필수** | **예** | send-sms 전용. 로그/응답에 절대 미노출 |
| `SOLAPI_SENDER_NUMBER` | 생략 | **필수** (실발송 시) | **필수** | 아니오 | SOLAPI 에 등록·승인된 발신번호 (숫자만, 예: `01012345678`) |
| `SEND_SMS_HOOK_SECRETS` | 생략 | **필수** (실발송 시) | **필수** — staging 과 다른 값 | **예** | Dashboard → Auth → Hooks → Send SMS 의 secret (`v1,whsec_...`). 회전 시 `\|` 로 복수 |

## Admin (Next.js) 서버 환경변수 (`apps/admin/.env.local`)

| 변수 | secret? | 비고 |
|---|---|---|
| `SUPABASE_URL` | 아니오 | 환경별 프로젝트 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | **예** | 서버 컴포넌트에서만 사용. `NEXT_PUBLIC_*` 로 절대 노출 금지 |
| `ADMIN_PASSWORD` | **예** | 관리자 로그인 |

## dev-login 정책 (fail-closed allowlist)

`supabase/functions/dev-login/index.ts` 는 다음 조건을 **모두** 만족할 때만 동작한다.

```text
APP_ENV ∈ { development, staging }   AND   ALLOW_DEV_LOGIN=1
```

- production, `APP_ENV` 누락, 알 수 없는 값 → `ALLOW_DEV_LOGIN=1` 이어도 **무조건 403**
- 1차 원칙: production 에는 dev-login 을 **배포 자체를 하지 않는다**
  (`supabase/scripts/deploy-production.sh` allowlist 에서 제외).
- 허용 환경에서도 기본은 010-0000-XXXX 테스트 대역만.

## Mock provider 정책 (fail-closed)

본인확인(`verify-identity`)은 현재 Mock provider 로 동작한다. Mock 은 **verificationId 를 검증하지 않고
아무 6자리 코드나 통과시키므로** production 에서 절대 실행되면 안 된다.

얼굴 인증은 실제 provider **Didit** 이 연동되어 있다 (`docs/face-liveness-didit.md`):

- `FACE_VERIFICATION_PROVIDER=didit` → `start-face-liveness`(세션 생성/서버 재조회) + `didit-webhook`(서명 검증 + Decision 재조회)
  만 승인을 만들 수 있다. `DIDIT_API_KEY` / `DIDIT_WORKFLOW_ID` / `DIDIT_WEBHOOK_SECRET` 이 하나라도 없으면 두 함수가 기동을 거부한다.
- `FACE_VERIFICATION_PROVIDER=mock` (development/staging 만) → `start-face-liveness` 는 409 `provider_is_mock` 으로 세션을 만들지 않고,
  개발용 `complete-face-verification`(앱의 "개발 모드: 얼굴 인증 통과" 버튼, `__DEV__ && DEV_TOOLS_ENABLED`)만 승인을 만든다.
  이 함수는 production allowlist 에 없고, 배포돼 있어도 `didit` 이면 기동을 거부한다.

공통 원칙:

- **production**: `IDENTITY_PROVIDER` / `FACE_VERIFICATION_PROVIDER` 에 실제 provider 이름이
  **필수**다. 미설정·`mock`·아직 구현되지 않은 이름이면 해당 함수가 **cold start 에서 기동을
  거부**한다 (fail-closed). 직접 API 를 호출해도 `identity_verified` / `face_verified` 를 true 로 만들 수 없다.
- **development / staging**: 미설정 시 `mock` 기본값 (개발 편의 유지).
- 실제 provider 연동 시 `IdentityVerificationProvider.ts` 의 `getIdentityProvider` switch /
  `_shared/face/FaceLivenessProvider.ts` 의 `getFaceLivenessProvider` switch 에 구현을 등록한다 — 미구현 이름이 mock 으로
  조용히 대체되는 경로는 없다.

## SMS OTP 실발송 — Send SMS Hook + SOLAPI (Issue #4)

Supabase Phone Auth 의 `signInWithOtp` / `verifyOtp` 흐름은 그대로 두고, Supabase 가 OTP 를 만든 뒤
**Auth "Send SMS" HTTP Hook** 으로 `send-sms` Edge Function 을 호출하면 함수가 SOLAPI 로 실제 SMS 를 보낸다.

```text
앱 signInWithOtp(+8210…)
  → Supabase Auth 가 OTP 생성 + 저장
  → HTTP Hook POST https://<ref>.supabase.co/functions/v1/send-sms
      헤더: webhook-id / webhook-timestamp / webhook-signature (Standard Webhooks 서명)
      본문: { user: { phone }, sms: { otp } }
  → send-sms: 서명 검증 → 번호/OTP 재검증 → 번호별 쿨다운/상한 판정 (DB RPC sms_otp_rate_limit_check)
      → SOLAPI send-many/detail (HMAC-SHA256 인증)
  → 200 {} 이면 Supabase 가 클라이언트에 성공 응답
  → 오류는 200 + {error:{http_code,message}} 로 돌려주고 Supabase 가 그 http_code 로 signInWithOtp 를 실패시킴
      (429 sms_rate_limited → 앱은 "요청이 너무 잦아요")
앱 verifyOtp(+8210…, 123456) → Supabase 가 저장한 OTP 와 비교 (함수 무관)
```

보안 설계 (`supabase/functions/send-sms/`):

- **오류 응답 규약** — Supabase Auth 는 훅이 **HTTP 200** 으로 `{ "error": { "http_code": N, "message": "…" } }` 를
  돌려줄 때만 본문을 읽어 그 http_code/message 를 앱에 전달한다. 훅이 4xx/5xx 상태 코드를 직접 돌려주면
  본문을 무시하고 "Unexpected status code returned from hook: 502" 같은 고정 문구를 내보내며, 429/503 은
  재시도까지 한다. 그래서 아래의 401/400/429/500/502/503 은 모두 **본문의 http_code** 다 (HTTP 상태는 200).
- **JWT 인증 없음, 서명 검증 필수** — 훅은 JWT 발급 전에 호출되므로 `--no-verify-jwt` 로 배포한다.
  대신 `SEND_SMS_HOOK_SECRETS` 로 Standard Webhooks 서명(`standardwebhooks` 라이브러리)을 검증하고,
  실패하면 SOLAPI 를 호출하지 않고 401 을 돌려준다. 타임스탬프 ±5분 밖은 거부(replay 방지).
- **fail-closed** — `SOLAPI_API_KEY` / `SOLAPI_API_SECRET` / `SOLAPI_SENDER_NUMBER` / `SEND_SMS_HOOK_SECRETS`
  중 하나라도 없거나 형식이 틀리면 모든 요청에 500. 로그에는 변수 이름만 남긴다.
- **번호별 재전송 쿨다운 + 시간당 상한 (서버 강제)** — Dashboard Rate Limits 는 프로젝트 전체 시간당 SMS 수만
  제한하고 같은 번호의 60초 내 재요청을 막지 않는다. 그래서 `send-sms` 가 발송 직전에 DB RPC
  `sms_otp_rate_limit_check` (마이그레이션 `0012_sms_otp_rate_limit.sql`) 로 **같은 번호 60초 쿨다운 + 1시간 5건**을
  판정하고, 걸리면 SOLAPI 를 호출하지 않고 429 `sms_rate_limited` 를 돌려준다. 행 잠금으로 동시 연타에도 1건만 허용.
  RPC 는 Edge Runtime 이 자동 주입하는 `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` 로 호출한다 (추가 secret 없음).
  판정 자체가 실패(마이그레이션 미적용·DB 오류·1.5초 타임아웃)하면 503 `sms_rate_limit_unavailable` 로 발송하지 않는다
  (fail-closed). 테이블 `sms_otp_send_log` 에는 전화번호 원문 대신 HMAC(hook secret) 해시만 저장하며,
  RLS 정책 없음 + anon/authenticated 권한 회수로 클라이언트는 접근할 수 없다. 앱의 60초 버튼 잠금은 UX 용이다.
- **서버 재검증** — `user.phone` 은 `+821012345678` / `821012345678` 어느 형식이든 `01012345678` 로 바꾸고
  한국 휴대전화(`01[016789]` + 7~8자리)만 허용, OTP 는 6자리 숫자만 허용. 아니면 400 (SOLAPI 미호출).
- **실패를 성공으로 숨기지 않음** — SOLAPI HTTP 오류·`failedMessageList`·타임아웃(3초, Supabase 훅 5초 제한 고려)은
  전부 502. 응답/로그/오류 메시지에는 OTP·전체 전화번호·API secret 이 들어가지 않는다 (고정 코드 + SOLAPI statusCode 만).
- **SOLAPI SDK 미사용** — Deno Web Crypto 로 `HMAC-SHA256 apiKey=…, date=…, salt=…, signature=…` 헤더를 직접 만든다.
  발신/수신번호에는 `+`, `-`, 공백을 넣지 않는다.
- 클라이언트(`apps/mobile`)는 `signInWithOtp` / `verifyOtp` 그대로. 429 를 받으면 "요청이 너무 잦아요" 를 표시하고
  같은 번호를 60초 잠근다(`lib/otpCooldown` — 번호 변경/앱 재시작 후에도 유지). SOLAPI 키/secret 은 `EXPO_PUBLIC_*` 에
  절대 넣지 않는다.

환경별 정책:

| 환경 | SMS 발송 | 비고 |
|---|---|---|
| local | Dashboard/`config.toml` Test OTP (실발송 없음) | send-sms 미배포·secret 미설정이 기본. 로컬에서 실발송을 시험하려면 `supabase/functions/.env` 에 4개 변수 + `config.toml` `[auth.hook.send_sms]` 설정 |
| staging | Test OTP **또는** SOLAPI 실발송 | 실발송 시 staging 전용 SOLAPI 키·hook secret 사용 |
| production | **SOLAPI 실발송만** — Test OTP 없음 | Dashboard Send SMS Hook 활성 + 4개 secret 필수. `deploy-production.sh` 가 secret 존재를 확인하고 `--no-verify-jwt` 로 배포 |

배포 / Dashboard 설정 순서 (staging·production 공통):

```bash
# 1) 서버 secret (값은 저장소에 절대 커밋하지 않는다)
supabase secrets set SOLAPI_API_KEY=<key> SOLAPI_API_SECRET=<secret> SOLAPI_SENDER_NUMBER=<01012345678> --project-ref <ref>
# 2) 마이그레이션 적용 (0012_sms_otp_rate_limit.sql — 번호별 쿨다운/상한 RPC. 없으면 send-sms 가 발송을 거부한다)
supabase db push --project-ref <ref>
#    함수 배포 — 반드시 --no-verify-jwt (훅은 JWT 없이 호출된다). production 은 deploy-production.sh 가 대신 수행
supabase functions deploy send-sms --no-verify-jwt --project-ref <ref>
# 3) Dashboard → Authentication → Hooks → "Send SMS" → Enable, HTTP 타입,
#    URL: https://<ref>.supabase.co/functions/v1/send-sms → Generate secret → 표시된 v1,whsec_... 복사
supabase secrets set SEND_SMS_HOOK_SECRETS='v1,whsec_...' --project-ref <ref>
# 4) Dashboard → Authentication → Providers → Phone: Enable, SMS provider 항목은 사용하지 않음(훅이 대체)
#    Rate Limits 에서 SMS 발송 한도 확인 (프로젝트 전체 한도 — 번호별 제한은 위 RPC 가 담당)
```

secret 회전: Dashboard 에서 새 secret 을 만든 뒤 `SEND_SMS_HOOK_SECRETS='v1,whsec_new|v1,whsec_old'` 로 잠시
둘 다 허용하고, 훅이 새 secret 으로 서명하는 것을 확인한 뒤 old 를 제거한다.

검증: `cd supabase/functions/send-sms && node --experimental-strip-types selftest.ts` (SOLAPI/RPC 는 fetch mock,
실제 호출 없음) · `deno test --allow-env supabase/functions/send-sms/hook_test.ts` (실제 standardwebhooks 서명 검증) ·
`bash supabase/tests/run_local_check.sh` (마이그레이션 + `sms_rate_limit_tests.sql` — RPC 쿨다운/상한/권한 검증).
실기기: 같은 번호로 "인증번호 받기 → 번호 변경 → 인증번호 받기" 를 60초 안에 하면 버튼이 잠겨 있고, 앱을 우회해
직접 호출해도 429 가 돌아오며 Edge Function 로그에 `rate limited — not sent` 가 남는다.

## Test OTP 정책 (코드로 강제 불가 — Dashboard 설정)

Supabase Auth 의 Test OTP/테스트 전화번호는 **대시보드 설정이라 이 저장소의 코드만으로는
차단을 강제하거나 검증할 수 없다.** 따라서 정책으로 관리한다:

- **production**: Test OTP 항목 **없음**, 테스트 전화번호 **없음**, Send SMS Hook(send-sms → SOLAPI)만 사용,
  SMS rate limit 확인. (release 마다 `docs/release-checklist.md` 로 수동 확인)
- **staging/local**: 필요하면 Test OTP 사용 가능 (예: `+821000000001~0099 → 123456`).

## Seed / fixture 정책

`supabase/seed/seed.sql` 은 데모 사용자 12명 + 테스트 계정/identity fixture 를 만든다.

- **production DB 에는 seed.sql 을 절대 실행하지 않는다.** production 배포 절차에는
  seed 명령이 포함되지 않는다 (README 의 seed 명령은 local/staging 전용).
- fixture identity(`dev-user-*`, `duplicate-test-user` 등)와 데모 계정(`demo-*@bonsim.dev`,
  `dev-*@bonsim.dev`)은 local/staging 에만 존재해야 한다.
- release 전 production DB 에 `is_demo=true` 사용자·`@bonsim.dev` 계정이 없는지 확인한다
  (release-checklist 항목).
- `DEV_IDENTITY_HASH_SECRET`(개발 fixture 용 상수)은 저장소에 존재하는 것 자체는 의도된
  것이지만, staging/production 런타임에서는 자동 선택될 수 없다
  (`resolveIdentitySecret` 이 거부 — `_shared/env/envCore.ts`).

## 배포 규칙 요약

```bash
# local
supabase start
cp supabase/functions/.env.example supabase/functions/.env   # APP_ENV=development 등
psql "$DATABASE_URL" -f supabase/seed/seed.sql               # local/staging 만!

# staging (별도 프로젝트)
supabase secrets set APP_ENV=staging IDENTITY_HASH_SECRET=<고유 32자+> --project-ref <staging-ref>
supabase functions deploy <함수들> --project-ref <staging-ref>   # 필요 시 dev-login 포함 + ALLOW_DEV_LOGIN=1

# production (별도 프로젝트) — 반드시 allowlist 스크립트 사용
supabase secrets set IDENTITY_HASH_SECRET=<staging 과 다른 고유 32자+> --project-ref <prod-ref>
supabase secrets set IDENTITY_PROVIDER=<실제 provider> FACE_VERIFICATION_PROVIDER=didit --project-ref <prod-ref>
supabase secrets set DIDIT_API_KEY=<key> DIDIT_WORKFLOW_ID=<workflow-id> DIDIT_WEBHOOK_SECRET=<secret> --project-ref <prod-ref>  # docs/face-liveness-didit.md
supabase secrets set SOLAPI_API_KEY=<key> SOLAPI_API_SECRET=<secret> SOLAPI_SENDER_NUMBER=<발신번호> \
  SEND_SMS_HOOK_SECRETS='v1,whsec_...' --project-ref <prod-ref>     # Dashboard Send SMS Hook 의 secret
bash supabase/scripts/deploy-production.sh <prod-ref>
# 스크립트가 수행하는 것:
#   1) dev-login / complete-face-verification(개발용 mock) 이 이미 배포되어 있으면 배포 중단
#   2) 필수 secret(IDENTITY_HASH_SECRET, *_PROVIDER, DIDIT_*, SOLAPI_*, SEND_SMS_HOOK_SECRETS) 존재 확인 — 없으면 실패
#      개발용 secret(ALLOW_DEV_LOGIN, DEV_LOGIN_*) 존재 시 실패
#   3) APP_ENV=production 직접 설정 (CLI 로 값 검증이 불가하므로 설정으로 확정)
#   4) allowlist 함수만 배포 (dev-login·complete-face-verification 제외, send-sms·didit-webhook 은 --no-verify-jwt)
```

`supabase functions deploy` 를 **인자 없이 실행하면 dev-login 을 포함한 전체 함수가 배포되므로
production 에서는 금지**한다.
