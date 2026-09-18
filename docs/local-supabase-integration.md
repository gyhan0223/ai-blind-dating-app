# 실제 로컬 Supabase 검증 — migration 이력 · 앱 요청 통합 테스트 · 관리자 Auth 통합 테스트

`supabase/tests/run_local_check.sh`(psql + `local_supabase_mock.sql`) 는 빠르지만 **Supabase CLI 의 migration 이력**과 **실제 Auth(GoTrue)** · **Realtime** · **Edge Function** 을 검증하지 않는다.
이 문서는 Supabase CLI 로 띄운 실제 로컬 스택(Postgres · GoTrue · PostgREST · Realtime · Edge Runtime · Kong) 위에서 migration 적용 경로, 앱이 실제로 보내는 요청(로컬 테스트 계정), 관리자 인증을 검증하는 경로를 설명한다.

| 경로 | 명령 | 검증 범위 | 걸리는 시간 |
|---|---|---|---|
| mock (빠름) | `cd supabase/tests && bash run_local_check.sh` | migration 버전 중복 검사 → psql 로 SQL 순서 실행 → RLS · RPC · 동시성 SQL 테스트 · 앱 요청 SQL 재현(`app_flow_tests.sql`) (auth 스키마는 스텁, GoTrue 없음) | 1~2분 |
| 실제 스택 (느림) | `bash supabase/tests/run_supabase_integration.sh` | CLI 경로 migration 적용/이력 · **앱 요청 통합**(dev-login 테스트 계정 → 온보딩 → 추천 · 대화 · 메시지 실시간 전달 · 차단 · 탈퇴/복구 · 나가기 · 넘기기, 4절) · 실제 GoTrue TOTP · 어댑터 · 관리자 웹 HTTP/쿠키 (5절) | 6~12분 (첫 실행은 이미지 pull) |

CI(`.github/workflows/ci.yml`)는 둘 다 돌린다 (`db` job · `supabase-integration` job). 두 job 모두 필수이며 환경이 없으면 **실패**한다 (skip 아님).

## 1. 필요한 환경

| 도구 | 버전 | 비고 |
|---|---|---|
| Docker | 데몬 실행 중 | Supabase CLI 로컬 스택은 컨테이너다. Docker Desktop / Colima / Rancher Desktop |
| Supabase CLI | **2.117.0** (고정) | `npx supabase@2.117.0 …` 또는 PATH 의 `supabase`. 다른 버전이면 스크립트가 거부한다 (`SUPABASE_CLI_VERSION` 으로 바꿀 수 있지만 CI 와 맞춘다). 스택 이미지: `supabase/postgres 17.6.1.167` · `gotrue v2.196.0` · `postgrest v16.2` (CLI 가 고정) |
| Node | 22 | `apps/admin` 에서 `npm ci` 완료 |
| Postgres 클라이언트 | 불필요 | 이 경로는 psql 을 쓰지 않는다 (mock 경로만 필요) |

설정 파일: `supabase/config.toml` (project_id `bonsim`, API 54321 · DB 54322, studio/realtime/storage/edge runtime/analytics 끔, seed 끔, TOTP MFA 켬,
`[api] auto_expose_new_tables = true` — 이 저장소의 마이그레이션은 Supabase 의 기존 기본 grant 를 전제로 한다, 7절).
격리 스택(`bonsim-it`)에서는 스크립트가 복사본의 `[realtime]` · `[edge_runtime]` 만 `enabled = true` 로 바꾼다 (메시지 실시간 전달 · Edge Function 검사용). 개발용 config 는 바꾸지 않는다.

## 2. 실행

### macOS / Linux / Git Bash

```bash
# (한 번) 관리자 웹 의존성
cd apps/admin && npm ci && cd ../..

# 전체: 격리 스택(project_id bonsim-it · API 55321 · DB 55322, realtime 켬) 기동 → migration 이력 검증
#       → functions serve(개발 env) + 앱 요청 통합 테스트 → 관리자 웹 build/start(3101) → 관리자 Auth 통합 테스트 → 스택 종료
bash supabase/tests/run_supabase_integration.sh

# 앱 요청 스위트만 (관리자 웹 build 생략)
SUPABASE_IT_SUITES=app bash supabase/tests/run_supabase_integration.sh

# 개발용 스택을 이미 띄워 둔 경우(supabase start): 그 스택에 붙어서 실행 (개발 DB 를 초기화하지 않으므로 이력 검사는 비파괴 부분만)
# app 스위트를 붙여서 돌리려면 그 스택의 config.toml 에서 [realtime] enabled = true 여야 한다 (Edge 는 스크립트가 functions serve 로 띄운다 —
# 저장소의 supabase/functions/.env 가 있으면 그것을, 없으면 임시 개발 env 를 쓴다)
eval "$(supabase status -o env | sed 's/^/export /')"
SUPABASE_IT_MODE=attach SUPABASE_URL="$API_URL" SUPABASE_ANON_KEY="$ANON_KEY" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" SUPABASE_DB_URL="$DB_URL" \
  bash supabase/tests/run_supabase_integration.sh
```

옵션: `SUPABASE_IT_SUITES=app,admin`(기본 둘 다) · `SUPABASE_IT_KEEP_STACK=1`(끝나도 스택 유지) · `ADMIN_IT_SKIP_BUILD=1`(이미 `next build` 한 `.next` 재사용) · `ADMIN_IT_PORT`(기본 3101) · `SUPABASE_CLI_BIN`(CLI 경로 지정) ·
`APP_IT_KEEP=1`(앱 스위트의 테스트 계정 유지) · `APP_IT_REALTIME_TIMEOUT_MS`(실시간 수신 대기, 기본 15000).
스택만 직접 다루려면: `supabase --workdir .supabase-it status` · `supabase --workdir .supabase-it stop --no-backup`.

### Windows PowerShell

스크립트는 bash 다. **Git Bash**(Git for Windows) 또는 WSL 에서 위 명령을 그대로 실행하는 것을 권장한다. PowerShell 에서 Git Bash 를 부르려면:

```powershell
cd <저장소>
& "C:\Program Files\Git\bin\bash.exe" -lc "bash supabase/tests/run_supabase_integration.sh"
```

PowerShell 만으로 단계별로 실행하려면 (한 줄씩):

```powershell
cd apps\admin; npm ci; cd ..\..
node supabase\scripts\check-migration-versions.mjs                        # 1) 버전 중복 검사
npx supabase@2.117.0 start -x realtime,storage-api,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor   # 2) 개발용 스택 (project_id bonsim)
npx supabase@2.117.0 migration list --local                                # 각 버전이 local/remote 에 1회
npx supabase@2.117.0 db push --local --dry-run                             # "Remote database is up to date"
$env:SUPABASE_URL = "http://127.0.0.1:54321"                                # supabase status 의 API URL / anon key / service_role key
$env:SUPABASE_ANON_KEY = "<anon key>"
$env:SUPABASE_SERVICE_ROLE_KEY = "<service_role key>"
$env:ADMIN_SESSION_SECRET = "<32자 이상 임의 문자열>"
cd apps\admin; npm run build; Start-Process -NoNewWindow npx -ArgumentList "next start -p 3101 -H 127.0.0.1"   # 3) 관리자 웹 (별도 창 권장)
$env:ADMIN_BASE_URL = "http://127.0.0.1:3101"
npm run integration:auth                                                    # 4) 통합 테스트 (관리자가 없는 빈 DB 에서만 — 있으면 npx supabase db reset --local)
cd ..\..; npx supabase@2.117.0 stop --no-backup
Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY, Env:ADMIN_SESSION_SECRET
```

주의: PowerShell 단계별 실행은 개발용 스택(project_id `bonsim`)을 쓴다. 개발 DB 에 관리자가 있으면 통합 테스트가 시작을 거부한다 — 데이터를 지우려면 `db reset --local` 을 **직접** 결정해서 실행한다 (스크립트는 개발 DB 를 초기화하지 않는다).

## 3. 스크립트가 하는 일과 거부하는 것

`run_supabase_integration.sh`:

1. `check-migration-versions.mjs` — 파일명 버전 중복이면 중단.
2. Docker 데몬 · CLI 버전 확인 — 없으면 exit 2 (실패).
3. `start` 모드: `.supabase-it/supabase/` 에 `config.toml`(project_id `bonsim-it`, 포트 553xx) 과 `migrations/` 복사본을 만들고 `supabase start` (postgres · gotrue · postgrest · kong 만).
   개발용 스택(`bonsim`)과 컨테이너·포트가 다르므로 개발 DB 는 건드리지 않는다.
   격리 config 복사본은 `[realtime]` · `[edge_runtime]` 을 켠다. `supabase/functions` 도 복사하고 그 안의 `.env` 에 개발 env
   (`APP_ENV=development` · `ALLOW_DEV_LOGIN=1` · `IDENTITY_PROVIDER=mock` · `FACE_VERIFICATION_PROVIDER=mock` · 실행마다 난수 `DEV_LOGIN_PASSWORD`)를 쓴다 — 저장소의 `supabase/functions/.env` 는 건드리지 않는다.
4. migration 이력 (CLI 경로 — psql 이 아니다):
   - 빈 DB → 전체 (`supabase start` 가 적용) → `migration list` 에서 local == remote, 각 버전 **1회**
   - 최신 상태 재적용 → `db push --dry-run` = up to date · `migration up` 적용 0건
   - 직전 버전까지 적용된 DB → 최신: `db reset --version <직전>` 뒤 `migration up` 이 **최신 1개만** 적용
   - 다시 빈 DB → 전체 (`db reset`) → 통합 테스트 시작 상태
5. [app] `supabase_realtime` publication 에 `messages` · `matches` 가 있는지 확인(없으면 실패) → `supabase functions serve --env-file …` 을 백그라운드로 띄우고
   dev-login 이 400(`invalid_phone`)을 줄 때까지 대기(403 이면 env 미적용으로 실패) → `supabase/tests/app_flow_integration.mjs` (4절) → 함수 로그에 비밀번호·service key 가 없는지 grep.
6. [admin] 관리자 웹 `next build` + `next start`(production, `ADMIN_SESSION_SECRET` 은 실행마다 난수 32바이트).
7. `apps/admin/scripts/admin-auth-integration.mjs` (5절).
8. 관리자 웹 서버 로그에 `otpauth://` · 세션 쿠키 값 · service role key 가 없는지 grep. 스택 종료.

거부하는 것:
- `SUPABASE_URL` / `SUPABASE_DB_URL` / `ADMIN_BASE_URL` 호스트가 localhost·127.0.0.1·::1·host.docker.internal 이 아니거나 `*.supabase.co` · `*.supabase.com` · `*.pooler.supabase.com` 이면 exit 2 (스크립트와 Node 테스트 양쪽에서).
- `local_supabase_mock.sql` 은 이 경로에서 절대 적용하지 않는다 (실제 auth 스키마를 스텁으로 덮지 않는다).
- 통합 테스트는 `admin_members` 가 0행일 때만 시작한다. 이전 실행이 남긴 테스트 계정(`*@admin-it.example.com`)만 지우고, 그 밖의 데이터는 건드리지 않는다.
- 계정·비밀번호·TOTP secret·service role key 는 저장소·출력·로그에 남기지 않는다 (비밀번호는 난수, secret 은 메모리, 실패 메시지는 검사 이름만).

## 4. 앱 요청 통합 테스트가 검증하는 것 (`supabase/tests/app_flow_integration.mjs`)

모바일 앱과 같은 SDK(`@supabase/supabase-js` — `apps/mobile` 의 것이 설치돼 있으면 그것, 아니면 `apps/admin` 의 것)로, 앱의 `chat.ts` · `recommendations.ts` · 온보딩 화면 · `me.tsx`(탈퇴) · `suspended.tsx`(복구) · `devModules.ts`(테스트 로그인)가 보내는 요청을
**같은 경로(anon key + 사용자 JWT · Edge Function · RPC · Realtime 채널)** 로 보낸다. service role 은 이전 실행이 남긴 테스트 계정 정리에만 쓴다.
계정은 `dev-login` Edge Function 이 만드는 로컬 테스트 계정 6개(010-0000-0401 ~ 0406, `dev-010000004XX@bonsim.dev`)이고 끝나면 삭제한다 (`APP_IT_KEEP=1` 이면 유지). 이메일·비밀번호·토큰은 출력하지 않는다.

| 단계 | 검사 (앱 요청) | 결과 |
|---|---|---|
| 테스트 계정 | `dev-login`(010-0000-04XX) → email/password → GoTrue 비밀번호 로그인 · 같은 번호 재호출은 같은 계정 · 온보딩 전 `daily-recommendation` → 403 `not_ready` | ○ |
| 온보딩 | `verify-identity` request→confirm(mock, `created`/`relinked` · 성인) → `complete-face-verification`(mock 승인) → `profiles` upsert(RLS) → 소개(`relationship_goal` · `public_answers`) → 설문 26문항 upsert → `private_profiles` upsert → `preferences_save` RPC(지역 필수 조건 포함) → `users.onboarding_completed=true`(인증 뒤라 트리거 허용) · 본인확인 출생연도와 다른 값은 거부 | ○ |
| 추천 | A·B 서로만 후보 → 각각 `daily-recommendation` 1건 · `daily_limit` 1 · 카드는 공개 필드만(비공개·점수·전화 없음, intro 문장) · 재요청 멱등 · `recommendation_mark_viewed` 멱등 · 타인 추천 행 RLS 비공개 · `recommendation_accept` A→`liked`(재시도 `retry`) · B→`matched` + `match_id` | ○ |
| 대화 | 목록(`matches` + `conversations` 임베드 + 상대 닉네임) · `conversation_access` ok / 비로그인 forbidden · `send_message` 저장 · 같은 `client_message_id` 재전송 = 같은 행 · 내용 불일치 `message_content_mismatch` · 빈 본문 `invalid_content` · 페이지 조회 · 읽음 처리(상대 메시지만) · `conversation_metrics` · 상세 조회 · `icebreaker` Edge · anon 메시지 0행 | ○ |
| **메시지 실시간 전달** | 앱과 같은 채널(`conversation:<id>`, `postgres_changes` messages INSERT · matches UPDATE) 구독 → SUBSCRIBED → 상대가 보낸 메시지가 15초 안에 본문·발신자와 함께 도착 · 재전송/거부된 전송은 오지 않음 · 두 번째 대화방 · 복구 뒤 메시지도 전달 | ○ |
| 차단 | `blocks` insert → 트리거로 `matches.status=blocked` · 상대가 매치 UPDATE 를 Realtime 으로 수신 · 양쪽 `conversation_access` ended · 양쪽 전송 거부 · 이전 메시지 열람 · 목록은 종료로 이동(닉네임 숨김) · 상대 프로필 RLS 비공개 · 차단당한 쪽은 차단 사실 조회 불가 · 차단 뒤 오늘 추천 응답에서 상대 제외 · 먼저 차단한 상대는 소개되지 않음(`exhausted`) | ○ |
| 탈퇴 / 복구 | `delete-account`(delete) → `deleted:true` · 기존 세션의 Edge 호출 401 · refresh 무효 · 상대 `conversation_access` unavailable · 전송 거부 → 같은 번호 dev-login 재로그인 → `users.status=deleted` · `daily-recommendation` 403 → `reactivate` → `reactivated` · `fresh_start:false` · 재호출 400 `not_deleted` · active · 대화 이어짐 | ○ |
| 나가기 | `conversation_leave` → `left`(한 번만) · 상대 Realtime UPDATE(이유 없음) · access ended · 상대도 나가기 → `already_closed` · 종료 이유는 본인만 조회 · 이전 메시지 열람 · 목록 종료(`close_kind=left`) | ○ |
| 넘기기 | `recommendations` update → `skipped`(사유) · 재요청에 새 소개 없음 · `skipped`→`accepted` 재결정 거부 | ○ |

## 5. 관리자 Auth 통합 테스트가 검증하는 것 (`admin-auth-integration.mjs`, 155 검사)

실제 `lib/supabaseAdminAuth.ts`(GoTrue/DB 어댑터) · `lib/adminAuthCore.ts` · `lib/adminMembers.ts` · `scripts/admin-bootstrap.mjs` 와 실제 Next 서버를 그대로 쓴다.
테스트가 직접 구현하는 것은 RFC 6238 TOTP **코드 생성**뿐이며 검증은 GoTrue 가 한다. 계정은 Auth Admin API 로 만든 합성 계정(`it-*@admin-it.example.com`)이고 끝나면 삭제한다.

| 시나리오 | 어디서 | 결과 |
|---|---|---|
| 첫 owner 생성 성공 · 활성 owner 가 있으면 재-bootstrap 거부(exit 1, Auth 계정도 안 만듦) · 관리자 계정에 `public.users` 행 없음 | 실제 bootstrap 스크립트 (service role) | ○ |
| 앱 사용자(전화번호 Auth 계정)·membership 없는 Auth 계정의 관리자 로그인 거부(`bad_credentials`, `admin_login_not_member` 감사) · 앱 사용자를 관리자로 추가 → `app_user_not_allowed` · membership 없는 계정은 세션 발급 자체 거부 | 어댑터 + DB RPC | ○ |
| 비밀번호만 통과한 pending 으로는 세션 없음(`resolveSession` null, `admin_sessions` 0행) · HTTP: pending 쿠키만으로 `/users`·`/` → `/login`, mutation 서버 액션 → `/login` | 코어 · HTTP | ○ |
| 실제 GoTrue: TOTP 등록(secret·otpauth URI·QR SVG) → challenge → verify → `getAuthenticatorAssuranceLevel` = aal2 확인 → `admin_session_issue` · 비밀번호 토큰은 aal1, 검증 토큰은 aal2, 위조 토큰은 null | 어댑터 직접 + 코어 | ○ |
| 틀린 TOTP(`bad_code`, 감사) · 형식 오류 · 서명 변조 · 다른 키 서명 · payload 교체 · exp 지남 · 없는 세션 id · DB `expires_at` 만료 · 만료 pending | 코어 + DB | ○ |
| viewer: 허용된 조회 가능(`/users` `/audit` 200, 관리자 목록 로드) · 역할 변경/비활성화/세션 취소/MFA 초기화/관리자 추가 → DB `forbidden` · HTTP: `/admins` → `/?denied=1`, mutation 서버 액션 직접 호출 → `/?denied=1` 이고 대상 불변 | 코어 · DB · HTTP | ○ |
| 강등 → 기존 세션의 다음 요청에서 viewer · 비활성화 → 거부 · 재활성화해도 이전 세션은 무효 · 세션 취소 → 거부 (어댑터와 HTTP 브라우저 각각) | 코어 · HTTP | ○ |
| 마지막 활성 owner 자기 강등/비활성화 → `last_owner` (RPC · HTTP `/admins?error=last_owner`) · owner 둘이면 강등 가능 | DB · HTTP | ○ |
| 로그아웃 → 세션 취소 · 같은 쿠키 값 재사용 시 `/login` · mutation 도 `/login` | 코어 · HTTP | ○ |
| 비밀번호 변경(재인증: 비밀번호+코드) → GoTrue updateUser · 모든 세션 취소 · 옛 비밀번호 실패 | 어댑터 | ○ |
| 잠금: 비밀번호 5회 실패 → locked (다른 IP·계정 키) · 잠금 중 올바른 비밀번호도 거부 · TOTP 5회 실패 → MFA locked · 잠금 중 올바른 코드도 거부 · 세션 발급 없음 | DB `admin_login_guard` | ○ |
| HTTP 등록 흐름: 첫 로그인 `/login/mfa` 가 QR·수동 키를 HTML 에만 실음 · 모르는 factor id 로 제출 → 거부 · 재진입 시 새 factor · 등록 코드 → 세션 | Next 서버 액션(폼 POST) | ○ |

HTTP 검사는 브라우저가 JS 없이 `<form action={서버 액션}>` 을 제출하는 것과 같은 요청(multipart/form-data + `$ACTION_ID_…` 숨은 필드)을 보내고 `Set-Cookie`·`Location` 을 본다. "버튼이 안 보인다" 는 표시 검사와 서버 거부 검사를 구분해서 기록한다.

### 이 테스트가 찾아낸 결함 (수정됨)

1. **관리자 계정에 `public.users` 행이 생김** — GoTrue 의 Admin API `createUser` 는 `raw_app_meta_data` 에 provider 만 넣어 insert 한 뒤 요청의 `app_metadata`(`bonsim_admin`) 를 **같은 트랜잭션의 별도 update** 로 적용한다. 0033 의 after-insert 트리거는 표식을 볼 수 없어 앱 사용자 행이 만들어졌고, 그 결과 `admin_member_add` 가 모든 관리자 추가를 `app_user_not_allowed` 로 거부했다(관리자 웹 `/admins` 추가 불가). mock SQL 테스트는 표식과 함께 직접 insert 해서 통과했다. → `0035_admin_accounts_gotrue_metadata.sql`: `raw_app_meta_data` 가 `bonsim_admin=true` 로 바뀌는 순간 같은 트랜잭션에서 방금 생긴 빈 앱 사용자 행만 거두는 after-update 트리거 + 기존 행 정리. 회귀: `admin_accounts_tests.sql` 7절(GoTrue 순서 재현), 통합 테스트 1·3·4절.
2. **첫 로그인 TOTP 등록 화면 500** — `/login/mfa` 페이지(서버 컴포넌트)가 렌더 중 `startMfaEnrollment()` 로 pending 쿠키를 다시 썼는데 Next 는 렌더 중 쿠키 변경을 금지한다 (`Cookies can only be modified in a Server Action or Route Handler`). 실제 웹에서는 첫 owner 를 포함해 누구도 MFA 를 등록할 수 없었다(본인 MFA 재등록도 같은 경로). → 등록 화면은 쿠키를 쓰지 않고 발급한 factor id 를 폼 숨은 필드로 넘기며, `runMfaVerify` 가 그 id 가 **이 사용자의 미검증 factor** 인지 GoTrue `listFactors` 로 확인한 뒤에만 challenge/verify 한다 (pending 에 fid 가 있으면 폼 값 무시). 회귀: `admin-auth-selftest.mjs` 2절(+5), 통합 테스트 7절.
3. `lib/supabaseAdminAuth.ts` · `audit.ts` · `adminMembers.ts` 의 상대 import 에 `.ts` 확장자를 붙였다 (Node `--experimental-strip-types` 로 실제 어댑터를 로드하기 위해. `adminAuthCore.ts` 와 같은 방식, `next build` 영향 없음).

## 6. migration 번호 변경 (0032 → 0034) 과 기존 적용 이력 확인

`0032_identity_verification_sessions.sql`(#6) 과 `0032_recommendation_batch_sweep.sql`(#22/#17) 이 같은 번호를 썼다. CLI 는 버전을 `supabase_migrations.schema_migrations` 의 PK 로 기록하므로
실제 `supabase db push` 는 두 번째 파일에서 `duplicate key value violates unique constraint "schema_migrations_pkey" (version)=(0032)` 로 멈추고(이 저장소 트리에서 재현·확인), 이력에는 첫 파일(identity)만 남는다.
원격에 한쪽만 적용된 뒤에는 다른 쪽이 영원히 "적용됨" 으로 오인된다. psql 로 순서 실행하는 mock 경로는 통과하므로 드러나지 않았다.

- 이동: `0032_recommendation_batch_sweep.sql` → **`0034_recommendation_batch_sweep.sql`** (내용 동일, 헤더 주석만). 0033(관리자 계정)은 이 파일에 의존하지 않고, 이 파일도 0033 에 의존하지 않는다.
- 새 파일: `0035_admin_accounts_gotrue_metadata.sql` (5절 결함 1).
- 재발 방지: `node supabase/scripts/check-migration-versions.mjs` — 중복 버전이면 파일명을 출력하고 exit 1 (`--selfcheck` 로 검사기 자체 검증). `run_local_check.sh` 앞단과 CI 두 job 이 실행한다.

**원격(staging/production) 적용 상태는 이 저장소의 배포 기록으로 확인되지 않는다 — "미확인"이다.** 원격을 바꾸기 전에 반드시 아래를 사람이 확인한다 (repair·이력 변경은 이 작업에서 실행하지 않았다):

```bash
supabase link --project-ref <ref>
supabase migration list --linked                      # local 열에 0034·0035, remote 열에 0032 가 어떻게 있는지
# 또는 SQL Editor: select version, name from supabase_migrations.schema_migrations where version >= '0031' order by version;
# 배치 sweep 이 실제로 적용됐는지: select to_regclass('public.recommendation_batch_cursor');  -- null 이면 미적용
```

| 원격 상태 | 뜻 | 할 일 |
|---|---|---|
| `0032` 없음 | 두 파일 모두 미적용 | `supabase db push` — 0032(identity) → 0033 → 0034 → 0035 순으로 적용된다 |
| `0032` = `identity_verification_sessions`, `recommendation_batch_cursor` 없음 | 예전 트리로 push 하다 두 번째 0032 에서 실패한 상태 (이번 로컬 재현과 같음) | `supabase db push` — 0033 · 0034 · 0035 만 적용된다 (로컬에서 확인한 경로) |
| `0032` = `identity…` 인데 `recommendation_batch_cursor` 가 **있음** | 배치 sweep SQL 을 psql 등으로 별도 적용한 상태 | 0034 는 멱등(`if not exists` · `drop function if exists` → 재생성)이라 `db push` 로 0034 를 그대로 적용해 이력을 맞춘다. 다만 적용 전 `recommendation_batch_targets` 시그니처 등 차이가 없는지 `--dry-run` 과 diff 로 확인 |
| `0032` = `recommendation_batch_sweep` | 파일 순서가 달랐던 환경 | identity 세션 테이블이 없다면 `0032_identity…` 가 "적용됨" 으로 오인된다 — `migration repair --status reverted 0032` 뒤 push 하는 절차가 필요하나 **이 작업 범위 밖**. 실행 전 DB 백업·사람 확인 |

## 7. 남은 것 — 원격 · 실기기

- 원격 프로젝트의 migration 이력 확인과 `db push` (6절 표) — 미실행. 이 작업은 원격 DB 를 바꾸지 않았다.
- 원격 프로젝트의 `[api] auto_expose_new_tables`(Data API 기본 grant) 설정이 로컬 `config.toml` 과 같은지 확인 — 다르면 새 테이블에 anon/authenticated/service_role grant 가 없어 앱·관리자 웹이 실패한다.
- 앱 요청 통합 테스트(4절)는 **mock provider**(본인확인 mock · 얼굴 인증 mock 즉시 승인)로 온보딩을 통과한다. 실제 본인확인 기관·SMS OTP 실발송·Didit 얼굴 라이브니스·Push 실발송은 여기서 검증되지 않았다 (`docs/identity-verification.md` · `docs/face-liveness-didit.md` · `docs/release-checklist.md`). Realtime 은 로컬 스택의 Realtime 컨테이너로 검증하며, 원격 프로젝트의 `supabase_realtime` publication 에 `messages` · `matches` 가 들어 있는지는 별도로 확인한다 (0004 · 0016 은 publication 이 있을 때만 추가한다).
- 실기기·실제 배포에서의 관리자 웹 확인(`docs/release-checklist.md` Admin 절)은 여전히 필요하다 — 로컬 통합 통과가 이를 대신하지 않는다.
- CI 의 `supabase-integration` job 이 이 경로를 실행한다. 앱 요청 통합 테스트(4절)는 Docker 없는 환경에서 작성되어 실제 스택 위의 실행 결과는 CI(`supabase-integration` job) 로그가 근거다 — 로컬에서 재현하려면 2절 명령을 쓴다.
