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
| `ALLOW_DEV_LOGIN` | `1` (dev-login 쓸 때) | 필요 시 `1` | **설정 금지** — 설정돼도 403 | 아니오 | dev-login opt-in |
| `DEV_LOGIN_PASSWORD` | 생략 가능 (seed 기본값) | 고유 값 권장 | 해당 없음 (dev-login 미배포) | 예 | dev-login 계정 비밀번호 |
| `DEV_LOGIN_ALLOW_ANY_PHONE` | 필요 시 `1` | 필요 시 `1` | 해당 없음 | 아니오 | 테스트 대역 외 번호 허용 |
| `DISABLE_DEV_LOGIN` | — | — | — | 아니오 | 긴급 kill switch (모든 환경에서 유효) |

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

## Test OTP 정책 (코드로 강제 불가 — Dashboard 설정)

Supabase Auth 의 Test OTP/테스트 전화번호는 **대시보드 설정이라 이 저장소의 코드만으로는
차단을 강제하거나 검증할 수 없다.** 따라서 정책으로 관리한다:

- **production**: Test OTP 항목 **없음**, 테스트 전화번호 **없음**, 실제 SMS provider 만 사용,
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
supabase secrets set APP_ENV=production IDENTITY_HASH_SECRET=<staging 과 다른 고유 32자+> --project-ref <prod-ref>
bash supabase/scripts/deploy-production.sh <prod-ref>            # dev-login 은 배포되지 않음
```

`supabase functions deploy` 를 **인자 없이 실행하면 dev-login 을 포함한 전체 함수가 배포되므로
production 에서는 금지**한다.
