# 본심 — 사진 없이 대화로 먼저 알아가는 소개팅 (MVP)

> **"사진 없이 대화로 먼저 알아가는 소개팅"**
>
> 사용자끼리 사진을 공개하지 않습니다. 본인확인과 얼굴 라이브니스(실제 사람 확인)를 마친 사용자에게
> **하루 한 명**, 나이·지역·연애 목적·기본 조건·가치관을 기준으로 상대를 소개하고,
> 짧은 자기소개와 텍스트 대화로 서로를 알아가게 합니다.
>
> 이 MVP 의 목표는 하나의 가설 검증입니다 —
> **"사진 없이 알아간 상대에게 호감이 생기고, 실제 만남과 재만남 의향으로 이어지는가?"**
>
> 사진이 없다는 사실만으로 진정성이나 좋은 만남이 보장된다고 말하지 않습니다.
> 프로필·대화 소재·안전·만남 후 경험을 함께 확인합니다 (로드맵: GitHub #30).

## MVP 범위 (2026-09-14 기준 — #30/#39)

**지금 활성인 기능**

- 전화번호 SMS OTP 로그인 → 본인확인(1인 1계정) → **인증용** 얼굴 라이브니스(Didit) → 기본 정보 → 공개 소개(고르기) → 설문 → 가치관 → 선호 조건 → 홈
- 하루 한 명 추천 (텍스트 카드: 닉네임·나이·지역·키·직업·흡연·음주·취미·키워드·**고른 항목으로 만든 소개 문장(연애 목적·공개 질문 선택)**·인증 배지)
- 상호 수락 → 텍스트 채팅 → 만남 의사 → 만남 후 비공개 피드백 (흐름 보완은 #41)
- 신고·차단·정지·탈퇴, 관리자 웹

**MVP 에서 제공하지 않는 것 (앱·문서에서 약속하지 않음)**

- 외모 취향 테스트, 이상형 얼굴/인상 선택, 외모 중요도 설정, 외모 적합도·궁합 표시
- 얼굴 임베딩·외모 취향 기반 추천 (#8/#9/#10 — 베타에서 구체적 문제가 확인되고 별도 채택된 뒤 검토)
- 프로필 사진 공개, 영상통화, 무한 스와이프, AI 대화 분석(#28), Plus/인앱 결제(#29 — UI 진입점은 숨김)

**얼굴 인증과 외모 추천의 구분**

| | 인증용 얼굴 라이브니스 (활성) | 외모 추천 (MVP 이후 검토) |
|---|---|---|
| 목적 | 실제 사람 확인 · 중복 가입 의심 검토 (#7) | 이상형/외모 취향 매칭 (#8/#9/#10) |
| 데이터 | Didit 세션 상태·점수·사유 코드 + 서버 전용 reference image | 얼굴 임베딩·취향 벡터 — **생성하지 않음 (null)** |
| 노출 | 상대에게 공개되지 않음, 추천 계산에 쓰이지 않음 | — |
| 동의 | 인증 목적 생체정보 고지 (#11/#12) | 채택 시 별도 동의 필요 |

**개발 순서**: **#39**(이 저장소 상태 — 외모 단계 없는 온보딩·고르기형 공개 프로필·문구·Plus 숨김) → **#40**(매칭 엔진에서 외모 차원 제외·가중치 재정규화) → **#41**(대화 → 상호 만남 동의 → 만남 후 피드백).
#39 이후 남은 의존성: `MatchingEngine` 은 아직 `appearance` 차원을 계산에 포함한다 (데이터가 없으면 중립 0.5 × 기본 중요도 3 으로 총점을 희석) — 추천 생성은 막히지 않지만 순위 왜곡 제거는 #40 에서 처리한다.

## 구성

| 영역 | 위치 | 스택 |
|---|---|---|
| 모바일 앱 | `apps/mobile` | React Native · Expo SDK 57 · TypeScript · Expo Router · TanStack Query |
| 백엔드 | `supabase/` | Supabase (Auth · PostgreSQL · Realtime · Storage · Edge Functions) |
| 매칭 엔진 | `supabase/functions/_shared/matching/` | 순수 TypeScript 모듈 (Deno/Node 겸용) |
| 관리자 웹 | `apps/admin` | Next.js 15 (service role 서버 컴포넌트) |
| 이전 프로토타입 | `legacy/web` | 참고용 (Next.js + SQLite 단일 웹 MVP) |

## 설치 & 실행

### 1. Supabase 설정

```bash
# Supabase CLI 로 새 프로젝트 연결 (또는 로컬: supabase start)
supabase link --project-ref <your-project-ref>

# 마이그레이션 적용 (0001 → 0015 순서대로 — 0015 는 앱 배포 전에 적용)
supabase db push        # 또는: psql 로 supabase/migrations/*.sql 순서 실행

# 시드 (개발용 데모 사용자 12명 + 매치/대화 샘플 + banned identity fixture)
# ⚠️ local/staging 전용 — production DB 에는 절대 실행하지 않는다 (docs/environments.md)
psql "$DATABASE_URL" -f supabase/seed/seed.sql

# 서버 환경 설정 (Issue #3 — fail-closed: APP_ENV 누락 시 production 취급)
#   local:  cp supabase/functions/.env.example supabase/functions/.env
#   원격:   supabase secrets set APP_ENV=development ALLOW_DEV_LOGIN=1   # 개발용 프로젝트
supabase secrets set APP_ENV=development
supabase secrets set ALLOW_DEV_LOGIN=1    # dev-login opt-in (production 에선 1 이어도 403)

# Edge Functions 배포 (개발/스테이징)
supabase functions deploy verify-identity
supabase functions deploy delete-account
supabase functions deploy dev-login       # 개발/스테이징 전용 — production 에는 배포 금지!
supabase functions deploy complete-face-verification   # 개발 전용 Mock 승인 — FACE_VERIFICATION_PROVIDER=mock 일 때만 기동
supabase functions deploy start-face-liveness           # 실제 얼굴 라이브니스 (Didit API v3) — docs/face-liveness-didit.md
supabase functions deploy didit-webhook --no-verify-jwt # Didit V3 결과 웹훅 (서명 검증) — 반드시 --no-verify-jwt
supabase functions deploy admin-face-review             # 관리자 얼굴 인증 검토 (service role 전용 — 관리자 웹이 호출)
supabase functions deploy daily-recommendation
supabase functions deploy icebreaker

# SMS OTP 실발송 (Issue #4) — Supabase Auth "Send SMS" HTTP Hook → SOLAPI.
#   훅은 JWT 발급 전에 호출되므로 반드시 --no-verify-jwt 로 배포한다 (함수가 웹훅 서명을 검증).
#   4개 secret 이 하나라도 없으면 함수가 모든 요청을 거부한다 (fail-closed). 값은 절대 커밋 금지.
supabase secrets set SOLAPI_API_KEY=<key> SOLAPI_API_SECRET=<secret> SOLAPI_SENDER_NUMBER=<01012345678>
supabase functions deploy send-sms --no-verify-jwt --project-ref <project-ref>
supabase secrets set SEND_SMS_HOOK_SECRETS='v1,whsec_...'   # Dashboard → Auth → Hooks → Send SMS 의 secret

# 본인확인 identity_key_hash 용 HMAC secret
#   development: 생략 가능 (개발 fixture secret 사용)
#   staging/production: 32자+ 고유 값 필수 — 미설정/개발 기본값이면 verify-identity 기동 실패
supabase secrets set IDENTITY_HASH_SECRET=<random-32B-hex>

# ⚠️ production 배포는 allowlist 스크립트로만 (dev-login 제외 + secret 사전 확인):
#   bash supabase/scripts/deploy-production.sh <prod-project-ref>
# 환경 분리/변수 목록: docs/environments.md · 출시 전 점검: docs/release-checklist.md
```

Supabase 대시보드에서 추가 확인:
- **Auth → Hooks → Send SMS**: Enable → HTTP → URL `https://<project-ref>.supabase.co/functions/v1/send-sms`
  → Generate secret → 표시된 `v1,whsec_...` 를 `supabase secrets set SEND_SMS_HOOK_SECRETS=...` 로 등록.
  이 훅이 켜지면 Supabase 가 만든 OTP 를 `send-sms` Edge Function 이 SOLAPI 로 실제 발송합니다
  (앱의 `signInWithOtp` / `verifyOtp` 흐름은 그대로). 상세: `docs/environments.md`.
- **Auth → Phone**: Phone provider 활성화 (SMS 사업자 항목은 훅이 대체하므로 비워 둠).
  개발 중에는 **Test OTPs** 에 `+821000000001 ~ +821000000099 → 123456` 처럼
  테스트 번호를 등록하면 실제 SMS 없이 로그인할 수 있어요.
  ⚠️ Test OTP 는 local/staging 전용 — **production 프로젝트에는 Test OTP/테스트 번호를
  절대 등록하지 않습니다** (Dashboard 설정이라 코드로 차단할 수 없음 —
  `docs/release-checklist.md` 로 매 출시마다 수동 확인).
- **Auth → Rate Limits**: SMS 발송 rate limit 확인 (OTP abuse 방지 — 기본값 유지 권장).
  이 값은 **프로젝트 전체** 시간당 SMS 수만 제한합니다. 같은 번호의 연타는 `send-sms` 훅이
  DB RPC(`sms_otp_rate_limit_check`, 마이그레이션 `0012`)로 **번호별 60초 쿨다운 + 시간당 5건**을 강제해
  429 로 거부합니다 (마이그레이션 미적용이면 fail-closed → 발송 안 함). 앱은 같은 번호를 60초 동안
  버튼 잠금(번호 변경/재시작 후에도 유지)으로 한 번 더 막습니다.
- **Auth → Email**: 이메일 OTP 는 일반 사용자 앱에서 제거됨 —
  시드 데모 계정(개발)과 관리자 웹 로그인에만 사용.
- **Storage**: `faces` 버킷은 마이그레이션이 생성 (private — public 전환 금지)

### 2. 모바일 앱

```bash
cd apps/mobile
cp .env.example .env     # Supabase URL/anon key 입력
npm install
npx expo start           # iOS 시뮬레이터: i / Android: a
```

일반 로그인은 **전화번호 SMS OTP** 입니다 (이메일 UI 없음).
개발 빌드에서 `EXPO_PUBLIC_DEV_LOGIN=1` 이면(단일 가드 `DEV_TOOLS_ENABLED` —
`src/lib/devTools.ts`) 웰컴 화면에 시드 계정 바로 로그인 버튼이 표시됩니다
(시드 계정은 이메일+비밀번호 — 개발 전용으로 분리 유지).
release 빌드(`__DEV__=false`)에서는 이 플래그가 1 이어도 개발 UI 가 절대 표시되지 않으며,
번들에서 아예 제거됩니다.

- 테스트 남성: `demo-m1@bonsim.dev` (지훈)
- 테스트 여성: `demo-f1@bonsim.dev` (서연) — 지훈과 매치·대화가 시드되어 있음
- 비밀번호: `bonsim-dev-password`

**테스트 로그인 (SMS 설정 없이 통과)**: 개발 모드(`npx expo start` + `EXPO_PUBLIC_DEV_LOGIN=1`)
에서는 전화번호 입력 화면에 "테스트로 시작하기" 버튼이 표시됩니다. `dev-login` Edge Function 이
입력한 번호가 연결된 개발 계정을 만들어 로그인시켜 주므로, Phone provider / Test OTP 설정 없이도
본인확인·온보딩 플로우를 그대로 테스트할 수 있어요.

dev-login 은 **fail-closed allowlist** 방식입니다 (Issue #3):
서버에 `APP_ENV=development`(또는 `staging`) **그리고** `ALLOW_DEV_LOGIN=1` 이 모두
설정된 경우에만 동작하고, `APP_ENV` 가 production/누락/알 수 없는 값이면
`ALLOW_DEV_LOGIN=1` 이어도 무조건 403 입니다. 허용 환경에서도 기본은 010-0000-XXXX
대역만 (다른 번호는 `supabase secrets set DEV_LOGIN_ALLOW_ANY_PHONE=1`).
release 빌드에는 버튼이 없고, **production 에는 dev-login 을 배포하지 않습니다**
(`supabase/scripts/deploy-production.sh` allowlist 에서 제외 — 상세: `docs/environments.md`).

본인확인(Mock) fixture — 로그인한 번호에 따라 identityKey 가 결정됩니다
(Test OTP 로그인, 테스트 로그인 버튼 모두 동일):

| 로그인 번호 | identityKey | 용도 |
|---|---|---|
| 010-0000-0001, 0002 … | `dev-user-001` … | 번호별 고유 identity (일반 가입) |
| 010-0000-0011 / 0012 | `duplicate-test-user` | 번호 변경 → 기존 계정 복구 시나리오 |
| 010-0000-0021 / 0022 | `race-test-user` | 동시 가입 race 시나리오 |
| 010-0000-0098 / 0099 | `banned-test-user` | 차단 우회 방지 (0099 는 시드된 banned 계정) |
| 그 외 번호 | 이름+생년월일 기반 | 같은 사람(같은 입력) = 같은 identity |

### 3. 관리자 페이지

```bash
cd apps/admin
cp .env.example .env.local   # service role key + 관리자 비밀번호
npm install
npm run dev                  # http://localhost:3100
```

대시보드(핵심 퍼널 9단계 전환율) · 사용자 정지/해제 · 신고 처리.

## 검증 (로컬)

```bash
# DB 스키마 + 시드 + RLS 테스트 (Docker 없이 로컬 Postgres 로)
cd supabase/tests && bash run_local_check.sh

# MatchingEngine 단위 테스트 (19건)
cd supabase/functions/_shared/matching && node --experimental-strip-types selftest.ts

# identity 로직 단위 테스트 (33건 — 전화번호 정규화 · 1인1계정 분기 · HMAC)
cd supabase/functions/_shared/identity && node --experimental-strip-types selftest.ts

# 서버 환경 guardrail 테스트 (Issue #3 — fail-closed dev-login / identity secret)
cd supabase/functions/_shared/env && node --experimental-strip-types selftest.ts

# SMS OTP 발송 훅 테스트 (Issue #4 — +82→010 변환 · 번호/OTP 검증 · SOLAPI HMAC 헤더 · 서명 실패/SOLAPI 오류 시
# 성공 응답 없음 · 번호별 쿨다운/상한 거부 시 429 + SOLAPI 미호출. SOLAPI/RPC 는 fetch mock — 실제 호출 없음)
cd supabase/functions/send-sms && node --experimental-strip-types selftest.ts
# 번호별 쿨다운/상한 RPC(sms_otp_rate_limit_check) DB 테스트는 위 run_local_check.sh 가 함께 실행 (sms_rate_limit_tests.sql)
# 실제 standardwebhooks 서명 검증 통합 테스트 (Deno 필요)
deno test --allow-env supabase/functions/send-sms/hook_test.ts

# 클라이언트 개발 도구 가드 테스트 (release 빌드에서 dev UI 비활성 보장)
cd apps/mobile && node --experimental-strip-types scripts/devtools-selftest.mjs
# 클라이언트 OTP 재전송 60초 쿨다운 테스트 (번호별 · 화면 이동/재시작 후 유지 · 저장값 검증)
cd apps/mobile && node --experimental-strip-types scripts/otp-cooldown-selftest.mjs
# 온보딩 재진입 판정 테스트 (#39 — 외모 데이터 없는 완료 · 'appearance' 단계 사용자 복귀 · 인증 미완료 홈 차단)
cd apps/mobile && node --experimental-strip-types scripts/onboarding-resume-selftest.mjs
# DB: 인증 전 온보딩 완료 차단 트리거 · 공개 자기소개 제약 (onboarding_guard_tests.sql — 위 run_local_check.sh 에 포함)

# 타입체크 / 빌드
cd apps/mobile && npx tsc --noEmit && npx expo export --platform web

# release 번들 개발 기능 제거 확인 (web + iOS + Android — dist/ 에서 개발 문구/credential grep 0건)
cd apps/mobile && npx expo export --platform web --platform ios --platform android --no-bytecode \
  && ! grep -rqE "테스트로 시작하기|촬영 건너뛰기|bonsim-dev-password|dev-login|service_role|외모 취향|AI만 먼저|본심 Plus|결제는 준비" dist/
cd apps/admin && npm run build
```

## MatchingEngine 구조

`supabase/functions/_shared/matching/MatchingEngine.ts` — 알고리즘 교체가 가능한 단일 모듈.

```
UserSnapshot(프로필·공개 소개 선택·가치관·설문·중요도·선호 조건·Dealbreaker)
  ├─ checkDealbreakers()   조건 불일치 → 추천 자체에서 제외 (점수 아님)
  ├─ directionalScore()    A→B 예측 (차원: personality/values/lifestyle/relationship — appearance 제외는 #40)
  │                        └ 개인화 중요도(1~5)로 가중 평균
  └─ computeMatch()        A→B, B→A 를 각각 계산 → 조화 평균
                           (한쪽만 좋아하는 조합은 우선순위 하락)
```

- **외모 점수 없음** — MVP 는 외모 취향 응답·얼굴 벡터를 만들지 않는다. 엔진에 남아 있는 `appearance` 차원은
  입력이 없어 중립값으로만 계산되며, 차원 제거·가중치 재정규화는 #40 에서 처리한다.
- 카드에는 원시 점수 대신 `buildReasons()` 가 만든 문구만 노출 — **확인된 데이터가 있을 때만** (설문 유사도·공통 취미·같은 지역·같은 연애 목적).
  근거가 없으면 문구를 지어내지 않고 비운다. "잘 맞는다/궁합 보장" 표현은 쓰지 않는다.
- 카드 스냅샷(`recommendations.card`)은 `profiles` 의 공개 필드 allowlist 로만 만든다 —
  `private_profiles`(가치관·민감 응답), 설문 응답, 인증 원본은 어떤 형태로도 실리지 않는다.
- 카드의 소개 문장(`card.intro`)은 사용자가 쓴 글이 아니라, 고른 선택지(연애 목적·공개 질문)를
  `publicPrompts.composeIntro()` 가 규칙대로 이어 붙인 것이다. 자유 텍스트·AI 분석 없음.
- `recommendationStrategy`: `high_confidence` / `exploration` / `fallback` (§30 탐색 정책 확장용)
- `ConversationSignals` 타입이 입력 계약에 포함되어 있어 대화 행동 신호를 이후 버전에서 반영 가능
- 추천 생성은 `daily-recommendation` Edge Function(service role)에서만 수행 —
  클라이언트는 타인의 원본 데이터에 접근하지 않고 서버가 만든 카드 스냅샷만 받음
- Plus(하루 +1) 는 `PLUS_EXTRA_RECOMMENDATION_ENABLED=false` 로 비활성 — 모두 하루 1명 (#29)

## 온보딩 순서 (#39)

```text
전화번호 OTP → 본인확인(identity) → 얼굴 인증(face) → 기본 정보(profile) → 공개 소개 고르기(intro)
  → 설문(questionnaire) → 가치관(values) → 선호 조건(preferences) → 완료(done) → 홈
```

- 저장된 `users.onboarding_step` 은 참고값이다. 앱 진입 게이트(`apps/mobile/src/app/index.tsx`)는
  `lib/onboardingCore.resolveOnboardingStep` 로 **인증 상태 + 남은 필수 입력** 을 확인해 알맞은 단계로 보낸다.
  예전 앱이 저장한 `appearance` 단계, 앱 재시작, 뒤로 가기, `/onboarding/appearance` 직접 진입 모두 같은 규칙으로 처리된다.
- 홈은 `onboarding_completed && identity_verified && face_verified` 일 때만 열린다. 완료 플래그만으로는 들어갈 수 없다.
- DB 트리거(`users_guard_onboarding_completion`, 0015)가 클라이언트의 "인증 전 완료" 기록을 거부한다.
- 외모 취향 응답·얼굴 벡터는 완료 조건이 아니다. 가짜 벡터·기본 응답을 만들지 않는다.
- 공개 소개는 **글쓰기가 아니라 고르기** 다: 연애 목적(필수) + "쉬는 날" 질문(필수) + 나머지 질문(선택)을 선택지에서 고르면
  같은 규칙으로 소개 문장이 만들어져 카드에 실린다. (`profiles.intro` 자유 텍스트 컬럼은 MVP 온보딩에서 쓰지 않는다)
- 공개/비공개 경계: `profiles.relationship_goal / public_answers` 는 **상대에게 공개** (선택 화면에 명시).
  `private_profiles` 가치관·민감 응답, 설문, 인증 데이터는 카드·API 응답에 실리지 않는다.

## 인증 구조 — 전화번호 로그인 + 1인 1계정

```text
전화번호            = 로그인 수단 (변경/재사용될 수 있음 — 영구 식별자가 아님)
본인확인 identityKey = 실제 사람 식별 수단 (실서비스: DI)

1 identityKey = 1 active account
```

가입 플로우:

```text
전화번호 입력 → SMS OTP (Supabase Phone Auth) → 세션 생성
  → 본인확인 (verify-identity Edge Function, Provider 추상화 — 현재 Mock)
      identityKey → 서버 HMAC(IDENTITY_HASH_SECRET) → identity_key_hash 조회
        ├ 없음                  → user_identities 에 연결 (신규 가입 계속)
        ├ 내 계정에 이미 연결   → 통과 (멱등)
        ├ 삭제된 계정의 identity → 새 계정에 재연결 (재가입)
        ├ 다른 활성 계정        → "기존 계정을 찾았습니다" → 복구(새 번호 연결) flow
        └ banned identity       → 가입 차단 (번호를 바꿔도 우회 불가)
  → 얼굴 인증(라이브니스 — 인증 목적) → 기본 정보 → 공개 소개 고르기 → 설문 → 가치관 → 선호 조건 → 홈
```

- **1인 1계정 3중 방어**: ① 가입 전 hash 조회(UX 분기) ② insert 시 unique 위반
  catch(동시 가입 race) ③ **DB `UNIQUE(identity_key_hash)`** — 최종 방어선.
- **`user_identities` 는 서버 전용**: RLS 정책이 하나도 없어 클라이언트는 접근 불가.
  identity 해시는 어떤 API 응답에도 포함되지 않음. HMAC 은 Edge Function 에서만 수행
  (secret 은 서버 환경변수, 클라이언트 번들 미포함).
- **전화번호 변경**: 새 번호 OTP + 본인확인 후 사용자가 확인하면
  `action: 'recover'` 가 기존 계정에 새 번호를 연결 (자동 overwrite 없음).
- **계정 삭제** (`delete-account`): 콘텐츠 비활성화 / 세션 무효화 / identity 보존을
  별도 함수로 분리. identity 보존으로 재가입 시 복구로 이어짐. banned 는 계정 삭제
  후에도 identity 에 남아 재가입 차단.
- **얼굴 인증 = 보조 신호**: DI/identityKey 가 primary duplicate-account control,
  얼굴은 **Didit 능동형 라이브니스(3D Action & Flash)** 로 실제 사람 확인 + Face Search 1:N 중복 의심 시
  `in_review` (auto-ban 없음). 승인은 서명 검증된 웹훅 + 서버 재조회로만 — `docs/face-liveness-didit.md`.
  라이브니스는 실명·나이를 증명하지 않는다 (본인확인은 별도).
- **Device signal**: `device_events` 에 가입/인증 이벤트만 기록 (서버 전용).
  "1 device = 1 account" 정책은 두지 않음 (폰 교체/중고기기 정상 시나리오).

### Migration 노트 (0009_phone_identity.sql)

- `users`: `phone`(E.164, UNIQUE) · `phone_verified_at` 추가, `status` 에 `banned` 추가.
  기존 FK/`users.id` 는 그대로 — 매칭·채팅 등 다른 테이블 영향 없음.
- 신규 `user_identities`: `identity_key_hash` **UNIQUE**, `user_id` 는 계정 삭제 시
  `set null` 로 남아 identity 보존 정책 지원. `banned` 플래그 포함
  (users.status→banned 시 트리거로 동기화).
- 신규 `device_events`: 기기 신호 로그 (서버 전용).
- `handle_new_auth_user` 가 auth.users 의 phone 을 E.164 로 복사,
  phone 변경 트리거로 동기화.
- 기존 이메일 시드 계정은 그대로 동작 (identity 는 시드가 placeholder 로 backfill).
  기존 사용자 데이터 삭제 없음 — additive migration.

검증: `supabase/tests/identity_tests.sql` (구조/유니크/트리거/RLS) +
`supabase/functions/_shared/identity/selftest.ts` (분기 로직·fixture·HMAC 33건).

## 개인정보 보호 구조

1. **얼굴 이미지**: private bucket `faces`. 라이브니스가 검증된 reference image 는 서버만 저장/접근하는
   `<user_id>/liveness/reference.jpg` (클라이언트는 읽기조차 불가). public URL 없음. raw video·audit image·Provider 응답 전체 미저장.
   다른 사용자의 얼굴을 가져오는 코드 경로 자체가 없음. (예전 사용자 업로드 `<user_id>/<pose>.jpg` 는 검증 이미지가 아니므로 더 이상 사용하지 않음)
2. **profiles(공개용) / private_profiles(가치관·민감 응답) 분리** — private 은 본인만 조회 가능.
3. **RLS 전면 적용**: 메시지·신고·피드백·행동 이벤트·좋아요(받은 쪽 비공개)·
   만남 의사(상호 yes 전 비공개)까지 시뮬레이션 테스트로 검증 (`supabase/tests/rls_tests.sql`).
4. **인증 플래그(본인/얼굴/나이)와 계정 상태는 서버 전용** — DB 트리거가 클라이언트 변경 차단.
5. 민감 설문은 선택 응답 + 공개 여부 별도 저장, 대화 분석은 `conversation_analysis_consent` 동의 필드로 준비만.
6. 로그에 얼굴 경로/민감정보를 남기지 않음.

## 현재 Mock 인 부분 (실서비스 전 교체)

| 기능 | 현재 | 교체 대상 |
|---|---|---|
| SMS OTP 발송 | **SOLAPI 실발송 구현 완료** (`send-sms` Send SMS Hook — Dashboard 훅 활성화 + secret 설정 필요). 로컬은 Test OTP | 운영 프로젝트에 훅/secret 설정 (`docs/environments.md`) |
| 본인 인증 | `MockIdentityProvider` (모든 6자리 코드 통과, identityKey 는 번호/이름 기반 결정적) | PASS / NICE / KCB / PortOne — 기관이 내려주는 DI 를 identityKey 로 사용 |
| OTP rate limit | 서버: `send-sms` 훅이 번호별 60초 쿨다운 + 시간당 5건 강제(429) + 대시보드 프로젝트 한도(30건/h) · 앱: 번호별 60초 버튼 잠금 | 실사용량 보고 한도 조정 + captcha 연동 |
| IDENTITY_HASH_SECRET | 개발 기본값 (시드 fixture 와 공유) | `supabase secrets set` 으로 운영 secret 발급 (교체 시 기존 해시 재계산 불가 주의) |
| 얼굴 라이브니스 | **Didit 네이티브 SDK 능동형 라이브니스 구현 완료** (`start-face-liveness` + `didit-webhook`, Development Build 필요). 개발 Mock 은 `complete-face-verification` (production 미배포) | Didit 콘솔 설정·secret·실기기 검증 (`docs/face-liveness-didit.md`) |
| 얼굴 특징 벡터 | 미생성 (null) — 인증용 reference image 만 서버 전용 private 저장 | MVP 범위 밖 (#8 — 별도 채택·별도 동의 후 검토) |
| 외모 취향 테스트 | **제거됨** (#39 — 온보딩·수정 화면에 없음, 기존 `appearance_preference_events` 행만 보존) | MVP 범위 밖 (#9/#10) |
| Icebreaker | 규칙 기반 (공개 정보만 사용) | 공개 답변 기반 선택형 질문 (#41) |
| 결제 | 구조만 (subscriptions 테이블) — **앱 진입점 숨김, 서버 Plus 플래그 off** (#29) | MVP 검증 이후 feature flag 로 재도입 |
| 이메일 로그인 | 시드 데모 계정·관리자 웹 전용으로 분리 | 일반 사용자 앱은 전화번호 OTP 만 사용 (완료) |
| 시드 데모 사용자 | `is_demo=true` 12명 | 실배포 시 제거 |

## 제품 원칙 (구현에 반영됨)

- 무한 스와이프 없음 — 하루 1명 (MVP 는 유료 개수 차등 없음)
- 유료여도 매칭 품질·순서·노출 우위 없음 (재도입 시에도 유지)
- 외모 점수/외모 취향 추천/인기 순위/부스트/Super Like/SNS 피드 없음
- 얼굴 데이터는 인증(실제 사람 확인·중복 가입 방지)에만 사용
- 한쪽만 좋아요한 사실, 거절 사실, 개인 피드백은 상대에게 비공개
- 채팅은 텍스트 전용 (사진 없는 경험 유지)
- 추천 이유는 확인된 데이터에서만 — 궁합·적합도를 보장하는 표현 없음

## 다음 개발 우선순위 (#30)

1. **#40** 외모 데이터 없이 기본 조건·가치관으로 매칭 — `appearance` 차원 제외·가중치 재정규화·양방향 조건 테스트
2. **#41** 텍스트 대화 → 상호 만남 동의 → 실제 만남 확인 → 비공개 피드백 흐름 완성
3. #22 하루 한 명 스케줄러·멱등성 · #23 후보 부족 정책 · #24 퍼널 측정 (베타 시작 전)
4. 인증·계정 P0: #5 실제 본인인증 Provider, #6 E2E, #7 인증용 라이브니스 남은 검증(실기기), #11 얼굴 데이터 보관 정책
5. #25 공개 프로필·비외모 선호조건 수정 화면 (P1)
6. MVP 이후 별도 채택 시 검토: #8 얼굴 임베딩 · #9/#10 외모 취향 매칭 · #28 AI 대화 분석 · #29 Plus/결제 재도입
