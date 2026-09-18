# 실제 로컬 Supabase 검증 — migration 이력 · 관리자 Auth 통합 테스트

`supabase/tests/run_local_check.sh`(psql + `local_supabase_mock.sql`) 는 빠르지만 **Supabase CLI 의 migration 이력**과 **실제 Auth(GoTrue)** 를 검증하지 않는다.
이 문서는 Supabase CLI 로 띄운 실제 로컬 스택(Postgres · GoTrue · PostgREST · Kong) 위에서 migration 적용 경로와 관리자 인증을 검증하는 경로를 설명한다.

| 경로 | 명령 | 검증 범위 | 걸리는 시간 |
|---|---|---|---|
| mock (빠름) | `cd supabase/tests && bash run_local_check.sh` | migration 버전 중복 검사 → psql 로 SQL 순서 실행 → RLS · RPC · 동시성 SQL 테스트 (auth 스키마는 스텁, GoTrue 없음) | 1~2분 |
| 실제 스택 (느림) | `bash supabase/tests/run_supabase_integration.sh` | CLI 경로 migration 적용/이력 · 실제 GoTrue TOTP · 어댑터 · 관리자 웹 HTTP/쿠키 | 5~10분 (첫 실행은 이미지 pull) |

CI(`.github/workflows/ci.yml`)는 둘 다 돌린다 (`db` job · `supabase-integration` job). 두 job 모두 필수이며 환경이 없으면 **실패**한다 (skip 아님).

## 1. 필요한 환경

| 도구 | 버전 | 비고 |
|---|---|---|
| Docker | 데몬 실행 중 | Supabase CLI 로컬 스택은 컨테이너다. Docker Desktop / Colima / Rancher Desktop |
| Supabase CLI | **2.117.0** (고정) | `npx supabase@2.117.0 …` 또는 PATH 의 `supabase`. 다른 버전이면 스크립트가 거부한다 (`SUPABASE_CLI_VERSION` 으로 바꿀 수 있지만 CI 와 맞춘다). 스택 이미지: `supabase/postgres 17.6.1.167` · `gotrue v2.196.0` · `postgrest v16.2` (CLI 가 고정) |
| Node | 22 | `apps/admin` 에서 `npm ci` 완료 |
| Postgres 클라이언트 | 불필요 | 이 경로는 psql 을 쓰지 않는다 (mock 경로만 필요) |

설정 파일: `supabase/config.toml` (project_id `bonsim`, API 54321 · DB 54322, studio/realtime/storage/edge runtime/analytics 끔, seed 끔, TOTP MFA 켬,
`[api] auto_expose_new_tables = true` — 이 저장소의 마이그레이션은 Supabase 의 기존 기본 grant 를 전제로 한다, 6절).

## 2. 실행

### macOS / Linux / Git Bash

```bash
# (한 번) 관리자 웹 의존성
cd apps/admin && npm ci && cd ../..

# 전체: 격리 스택(project_id bonsim-it · API 55321 · DB 55322) 기동 → migration 이력 검증 → 관리자 웹 build/start(3101) → 통합 테스트 → 스택 종료
bash supabase/tests/run_supabase_integration.sh

# 개발용 스택을 이미 띄워 둔 경우(supabase start): 그 스택에 붙어서 실행 (개발 DB 를 초기화하지 않으므로 이력 검사는 비파괴 부분만)
eval "$(supabase status -o env | sed 's/^/export /')"
SUPABASE_IT_MODE=attach SUPABASE_URL="$API_URL" SUPABASE_ANON_KEY="$ANON_KEY" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" SUPABASE_DB_URL="$DB_URL" \
  bash supabase/tests/run_supabase_integration.sh
```

옵션: `SUPABASE_IT_KEEP_STACK=1`(끝나도 스택 유지) · `ADMIN_IT_SKIP_BUILD=1`(이미 `next build` 한 `.next` 재사용) · `ADMIN_IT_PORT`(기본 3101) · `SUPABASE_CLI_BIN`(CLI 경로 지정).
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
4. migration 이력 (CLI 경로 — psql 이 아니다):
   - 빈 DB → 전체 (`supabase start` 가 적용) → `migration list` 에서 local == remote, 각 버전 **1회**
   - 최신 상태 재적용 → `db push --dry-run` = up to date · `migration up` 적용 0건
   - 직전 버전까지 적용된 DB → 최신: `db reset --version <직전>` 뒤 `migration up` 이 **최신 1개만** 적용
   - 다시 빈 DB → 전체 (`db reset`) → 통합 테스트 시작 상태
5. 관리자 웹 `next build` + `next start`(production, `ADMIN_SESSION_SECRET` 은 실행마다 난수 32바이트).
6. `apps/admin/scripts/admin-auth-integration.mjs` (4절).
7. 관리자 웹 서버 로그에 `otpauth://` · 세션 쿠키 값 · service role key 가 없는지 grep. 스택 종료.

거부하는 것:
- `SUPABASE_URL` / `SUPABASE_DB_URL` / `ADMIN_BASE_URL` 호스트가 localhost·127.0.0.1·::1·host.docker.internal 이 아니거나 `*.supabase.co` · `*.supabase.com` · `*.pooler.supabase.com` 이면 exit 2 (스크립트와 Node 테스트 양쪽에서).
- `local_supabase_mock.sql` 은 이 경로에서 절대 적용하지 않는다 (실제 auth 스키마를 스텁으로 덮지 않는다).
- 통합 테스트는 `admin_members` 가 0행일 때만 시작한다. 이전 실행이 남긴 테스트 계정(`*@admin-it.example.com`)만 지우고, 그 밖의 데이터는 건드리지 않는다.
- 계정·비밀번호·TOTP secret·service role key 는 저장소·출력·로그에 남기지 않는다 (비밀번호는 난수, secret 은 메모리, 실패 메시지는 검사 이름만).

## 4. 관리자 Auth 통합 테스트가 검증하는 것 (`admin-auth-integration.mjs`, 155 검사)

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

## 5. migration 번호 변경 (0032 → 0034) 과 기존 적용 이력 확인

`0032_identity_verification_sessions.sql`(#6) 과 `0032_recommendation_batch_sweep.sql`(#22/#17) 이 같은 번호를 썼다. CLI 는 버전을 `supabase_migrations.schema_migrations` 의 PK 로 기록하므로
실제 `supabase db push` 는 두 번째 파일에서 `duplicate key value violates unique constraint "schema_migrations_pkey" (version)=(0032)` 로 멈추고(이 저장소 트리에서 재현·확인), 이력에는 첫 파일(identity)만 남는다.
원격에 한쪽만 적용된 뒤에는 다른 쪽이 영원히 "적용됨" 으로 오인된다. psql 로 순서 실행하는 mock 경로는 통과하므로 드러나지 않았다.

- 이동: `0032_recommendation_batch_sweep.sql` → **`0034_recommendation_batch_sweep.sql`** (내용 동일, 헤더 주석만). 0033(관리자 계정)은 이 파일에 의존하지 않고, 이 파일도 0033 에 의존하지 않는다.
- 새 파일: `0035_admin_accounts_gotrue_metadata.sql` (4절 결함 1).
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

## 6. 남은 것 — 원격 · 실기기

- 원격 프로젝트의 migration 이력 확인과 `db push` (5절 표) — 미실행. 이 작업은 원격 DB 를 바꾸지 않았다.
- 원격 프로젝트의 `[api] auto_expose_new_tables`(Data API 기본 grant) 설정이 로컬 `config.toml` 과 같은지 확인 — 다르면 새 테이블에 anon/authenticated/service_role grant 가 없어 앱·관리자 웹이 실패한다.
- 이 통합 테스트는 **관리자 Auth** 만 검증한다. 본인확인(verify-identity)·계정 복구·SMS OTP·Didit 얼굴 인증 실 E2E 는 여기서 검증되지 않았다 (`docs/identity-verification.md` · `docs/release-checklist.md`).
- 실기기·실제 배포에서의 관리자 웹 확인(`docs/release-checklist.md` Admin 절)은 여전히 필요하다 — 로컬 통합 통과가 이를 대신하지 않는다.
- CI 의 `supabase-integration` job 은 이 브랜치의 첫 push 에서 처음 실행된다. Docker 없는 환경에서 만든 이 변경은 CLI 의 `--db-url` 경로(push · reset --version · migration up · list)와 실제 GoTrue/PostgREST 바이너리로 검증했고, `supabase start` 로 띄운 컨테이너 스택 자체는 CI 에서 확인한다.
