# 본심 — 사진 없는 AI 블라인드 소개팅 (MVP)

> **"서로의 얼굴은 AI만 먼저 봅니다."**
>
> 사용자끼리 사진을 직접 공개하지 않고, AI가 외모 취향·성격·가치관·행동 데이터를
> 기반으로 **하루 한 명**, 서로 잘 맞을 가능성이 높은 상대를 소개하는 소개팅 앱입니다.
>
> 이 MVP 의 목표는 하나의 가설 검증입니다 —
> **"사진을 직접 보지 않아도, AI 가 골라준 상대와 실제로 대화하고 만나러 나갈 것인가?"**

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

# 마이그레이션 적용 (0001 → 0009 순서대로)
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
supabase functions deploy complete-face-verification
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
  클라이언트는 재전송 60초 타이머를 추가로 강제합니다.
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
# 성공 응답 없음. SOLAPI 는 fetch mock — 실제 호출 없음)
cd supabase/functions/send-sms && node --experimental-strip-types selftest.ts
# 실제 standardwebhooks 서명 검증 통합 테스트 (Deno 필요)
deno test --allow-env supabase/functions/send-sms/hook_test.ts

# 클라이언트 개발 도구 가드 테스트 (release 빌드에서 dev UI 비활성 보장)
cd apps/mobile && node --experimental-strip-types scripts/devtools-selftest.mjs

# 타입체크 / 빌드
cd apps/mobile && npx tsc --noEmit && npx expo export --platform web

# release 번들 개발 기능 제거 확인 (web + iOS + Android — dist/ 에서 개발 문구/credential grep 0건)
cd apps/mobile && npx expo export --platform web --platform ios --platform android --no-bytecode \
  && ! grep -rqE "테스트로 시작하기|촬영 건너뛰기|bonsim-dev-password|dev-login|service_role" dist/
cd apps/admin && npm run build
```

## MatchingEngine 구조

`supabase/functions/_shared/matching/MatchingEngine.ts` — 알고리즘 교체가 가능한 단일 모듈.

```
UserSnapshot(프로필·가치관·설문·중요도·이상형·Dealbreaker·외모 벡터)
  ├─ checkDealbreakers()   조건 불일치 → 추천 자체에서 제외 (점수 아님)
  ├─ directionalScore()    A→B 예측 (차원: appearance/personality/values/lifestyle/relationship)
  │                        └ 개인화 중요도(1~5)로 가중 평균
  └─ computeMatch()        A→B, B→A 를 각각 계산 → 조화 평균
                           (한쪽만 좋아하는 조합은 우선순위 하락)
```

- **절대적 외모 점수 없음** — 외모 차원은 "내 취향 벡터 × 상대 스타일 벡터" 유사도만 사용
- 카드에는 원시 점수 대신 `buildReasons()` 가 만든 설명 문구만 노출
- `recommendationStrategy`: `high_confidence` / `exploration` / `fallback` (§30 탐색 정책 확장용)
- `ConversationSignals` 타입이 입력 계약에 포함되어 있어 대화 행동 신호를 이후 버전에서 반영 가능
- 추천 생성은 `daily-recommendation` Edge Function(service role)에서만 수행 —
  클라이언트는 타인의 원본 데이터에 접근하지 않고 서버가 만든 카드 스냅샷만 받음

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
  → 얼굴 인증 → 프로필 → 온보딩 (기존 flow 유지)
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
  얼굴은 실제 사람 확인 + 매칭용 (`face_verifications.feature_vector`).
  동일 얼굴 탐지는 향후 추가 인증 대상 선별에만 사용 (auto-ban 없음).
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

1. **얼굴 이미지**: private bucket `faces` (`<user_id>/<pose>.jpg`), storage RLS 로 본인 폴더만 접근.
   public URL 없음. 다른 사용자의 얼굴을 가져오는 코드 경로 자체가 없음.
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
| OTP rate limit | Supabase 기본 + 클라이언트 60초 재전송 타이머 | 대시보드 rate limit 조정 + captcha 연동 |
| IDENTITY_HASH_SECRET | 개발 기본값 (시드 fixture 와 공유) | `supabase secrets set` 으로 운영 secret 발급 (교체 시 기존 해시 재계산 불가 주의) |
| 얼굴 라이브니스 | 촬영 UX 만 (좌/우 안내) + 서버 파일 존재 확인 | 온디바이스 라이브니스 SDK |
| 얼굴 특징 벡터 | 사용자별 결정적 해시 벡터 | 얼굴 임베딩 모델 |
| 외모 취향 테스트 | 추상 인상 일러스트 카드 | 합법적 synthetic face dataset |
| Icebreaker | 규칙 기반 | LLM |
| 결제 | 구조만 (subscriptions 테이블, Plus=추천 개수만) | 인앱 결제 / PG |
| 이메일 로그인 | 시드 데모 계정·관리자 웹 전용으로 분리 | 일반 사용자 앱은 전화번호 OTP 만 사용 (완료) |
| 시드 데모 사용자 | `is_demo=true` 12명 | 실배포 시 제거 |

## 제품 원칙 (구현에 반영됨)

- 무한 스와이프 없음 — 하루 1명 (Plus 는 2명, **개수만** 다름)
- 유료여도 매칭 품질·순서·노출 우위 없음
- 외모 점수/인기 순위/부스트/Super Like/SNS 피드 없음
- 한쪽만 좋아요한 사실, 거절 사실은 상대에게 비공개
- 채팅은 텍스트 전용 (사진 없는 경험 유지)

## 다음 개발 우선순위

1. 실제 본인인증(PASS/PortOne) 연동 (SMS 발송은 SOLAPI 훅으로 구현 완료 — 운영 프로젝트 설정 + 남용 방지 rate limit 튜닝 남음)
2. 온디바이스 라이브니스 + 얼굴 임베딩 → 외모 취향 매칭 고도화
3. ConversationSignals 를 MatchingEngine 가중치에 반영 (만남 후 피드백 학습 포함)
4. 추천 탐색 정책(Exploit/Explore/Diversity) 본격 구현 + 추천 풀 공정성 모니터링
5. 푸시 알림 (매치/메시지) · 계정 삭제 셀프서비스 · 결제
