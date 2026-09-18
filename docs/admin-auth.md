# 관리자 인증 · 2단계 인증 · 최소 권한 (#27)

관리자 웹(`apps/admin`)의 로그인이 "공유 비밀번호 + 입력한 이름" 에서 "개인 계정 + 인증 앱(TOTP) + owner/viewer 역할" 로 바뀐다.
코드: `apps/admin/lib/adminAuthCore.ts`(흐름·판정, 순수) · `supabaseAdminAuth.ts`(GoTrue/DB 어댑터) · `adminAuth.ts`(Next 쿠키·redirect) · `adminMembers.ts`(관리자 관리) ·
`supabase/migrations/0033_admin_accounts.sql`(membership·세션·RPC) · `0035_admin_accounts_gotrue_metadata.sql`(GoTrue createUser 의 metadata 적용 순서 대응 — 관리자 계정에 앱 사용자 행 없음 보장) · `scripts/admin-bootstrap.mjs`(서버 전용 bootstrap/복구).

## 1. 구조

```
이메일+비밀번호 ──GoTrue signInWithPassword──▶ aal1 토큰
   → admin_members 조회 (없음/비활성 → 거부)            ← 권한의 유일한 근거. app_metadata/JWT/쿠키의 role 은 보지 않는다
   → pending 쿠키 (10분, 등록/검증 화면 전용)
TOTP 코드 ──GoTrue mfa.challenge/verify──▶ aal2 토큰 ──서버가 getAuthenticatorAssuranceLevel 로 재확인──▶ admin_session_issue (DB 행)
   → 세션 쿠키 = 서명된 {session id}. GoTrue 세션은 정리(signOut) — 이후 관리자 웹은 service role 로만 DB 를 읽는다
매 요청: 쿠키 서명 확인 → admin_session_check (취소·만료·멤버 비활성·sessions_revoked_at 이후 발급 여부) → role/이름을 DB 에서 받는다
```

| 구성 | 관리형 Auth(GoTrue) 가 하는 일 | 앱(관리자 웹 + DB)이 하는 일 |
|---|---|---|
| 비밀번호 | 해시 저장·검증, 자체 로그인 rate limit | IP 키 + 계정 키 5회/15분 잠금(`admin_login_guard`, DB 공유) — 잠금 중엔 GoTrue 를 부르지 않음 |
| MFA | TOTP secret 발급·QR·검증·aal 판정 (알고리즘을 직접 쓰지 않는다) | 사용자 키 5회/15분 잠금 · aal2 를 서버가 재확인한 뒤에만 세션 발급 · 미등록 계정은 등록 화면만 |
| 세션 | (사용하지 않음 — 발급 즉시 signOut) | `admin_sessions` 행 + 서명 쿠키. 비활성화/강등/취소가 즉시 반영. 12시간 |
| 권한 | 없음 | `admin_members.role` (owner/viewer), `requireAdmin()`/`requireOwner()` 를 페이지·서버 액션마다 |
| 복구 | `admin.mfa.deleteFactor` (service role) | owner 의 `/admins` MFA 초기화 · 모든 owner 잠김은 `admin-bootstrap.mjs reset-mfa` (공개 API 없음) |

역할:

| | owner | viewer |
|---|---|---|
| 대시보드·퍼널·추천 풀·서버 오류·감사 로그 | ○ | ○ |
| 사용자 목록 | 이메일 표시, 정지/해제·즉시 익명화 | 이메일 마스킹, 조치 없음 |
| 신고 | 확인 중·경고·정지·차단·기각 | 목록만 |
| 얼굴 검토 | 승인·거절·복구 | 목록만 |
| 삭제 요청 · 미완료 삭제 작업 | 완전 삭제·처리 불가·재시도·단계 건너뛰기 | 연락처 마스킹, 조치 없음 |
| 베타 | 게이트·cohort·초대코드·대기자 입장 | 통계만, 초대코드 마스킹 |
| 관리자 계정(`/admins`) | 추가·역할·활성/비활성·세션 취소·MFA 초기화 | 접근 불가 |
| 내 계정(`/account`) | 비밀번호 변경·MFA 재등록 (재인증) | 동일 |

공개 페이지(`/policy/*`, `/delete-account`)는 로그인을 요구하지 않는다 (변경 없음).

## 2. 첫 설정 (bootstrap) — 서버 전용

```bash
# 0) DB 에 0033 + 0035 적용 (supabase db push — 0035 없이는 GoTrue 로 만든 관리자에 앱 사용자 행이 생겨 /admins 추가가 app_user_not_allowed 로 거부된다)
# 1) 관리자 웹 환경변수: SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY · SUPABASE_ANON_KEY · ADMIN_SESSION_SECRET(32자+)
# 2) 첫 owner — 활성 owner 가 없을 때만 성공한다. 비밀번호는 프롬프트(표시 안 됨)로 입력
cd apps/admin
SUPABASE_URL=https://<project>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
  node scripts/admin-bootstrap.mjs create-owner --email owner@example.com --name "운영자"
# 3) 관리자 웹 로그인 → 인증 앱 QR 스캔 → 코드 입력 → 대시보드. /admins 에 MFA "완료" 가 보인다
# 4) 추가 관리자는 /admins 에서 (이메일 · 이름 · 역할 · 초기 비밀번호). 본인이 첫 로그인에서 MFA 등록 · /account 에서 비밀번호 변경
```

PowerShell (한 줄씩):

```powershell
cd apps\admin
$env:SUPABASE_URL = "https://<project>.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "<service-role-key>"
node scripts\admin-bootstrap.mjs create-owner --email owner@example.com --name "운영자"
node scripts\admin-bootstrap.mjs list
Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY
```

- 관리자 이메일은 앱 사용자와 **별도 계정**이다. 앱 사용자(`public.users` 행)를 관리자로 추가하려 하면 `app_user_not_allowed` 로 거부된다.
- 초기 비밀번호는 Auth 에만 전달되고 저장·로그·감사에 남지 않는다. 12자 이상. Dashboard 의 비밀번호 정책이 더 엄격하면 그것을 따른다.
- 저장소에는 어떤 계정·비밀번호·TOTP secret 도 없다.

## 3. MFA 등록 · 재등록 · 복구

| 상황 | 절차 |
|---|---|
| 첫 로그인 | 비밀번호 → `/login/mfa` 가 QR 을 보여준다 → 코드 입력 → 세션. 등록 전에는 어떤 관리자 페이지도 열리지 않는다 |
| 기기 교체 (본인) | `/account` → 현재 비밀번호 + 현재 코드 재인증 → 기존 factor 삭제 → 새 QR → 코드 → 새 세션 (다른 세션은 취소) |
| 인증 앱 분실 (다른 owner 가 있음) | owner 가 `/admins` → MFA 초기화 (factor 삭제 + 세션 취소, 감사 기록) → 본인이 다시 로그인해 등록 |
| 모든 owner 잠김 | 서버에서 `node scripts/admin-bootstrap.mjs reset-mfa --email owner@example.com` → 다시 로그인해 등록. 공개 API 경로가 없다 |
| 비밀번호 변경 | `/account` → 현재 비밀번호 + 현재 코드 → 새 비밀번호 → 모든 세션 종료 → 재로그인 |
| 비밀번호 분실 | (미구현) owner 가 `/admins` 에서 새 비밀번호를 줄 수 없다 — Supabase Dashboard 에서 Auth 사용자의 비밀번호를 재설정하거나 계정을 새로 만든다. 이메일 재설정 링크는 Dashboard SMTP 설정이 필요해 이번 범위 밖 |

QR·secret 은 등록 화면 HTML 에만 실린다. 화면을 새로고침하면 이전 미검증 factor 는 지워지고 새 것이 발급된다. 코드 실패 5회 → 15분 잠금.
등록 화면은 서버 컴포넌트 렌더 중이라 쿠키를 쓰지 않는다 — 발급한 factor id 는 폼의 숨은 필드(`fid`)로 검증 액션에 전달되고, 서버가 그 id 가 이 계정의 **미검증** factor 인지 GoTrue 에 확인한 뒤에만 challenge/verify 한다 (pending 쿠키에 factor 가 있는 로그인 검증 경로에서는 폼 값을 무시한다).

## 4. 전환 순서 (구 공유 비밀번호 → 개인 계정) 와 되돌리기

1. `0033_admin_accounts.sql` 적용 (additive — 기존 `admin_audit_log`·`admin_login_locks` 등은 그대로).
2. 관리자 웹에 `SUPABASE_ANON_KEY` 추가, `ADMIN_SESSION_SECRET` 확인. 아직 운영 중이라면 `ADMIN_LEGACY_PASSWORD_LOGIN=1` + 기존 `ADMIN_PASSWORD` 를 둔다 → 새 버전을 배포해도 구 로그인이 계속 된다.
   (배포 직후 기존 v1 쿠키는 무효라 다시 로그인해야 한다.)
3. `create-owner` 로 첫 owner 생성 → 그 사람이 개인 계정으로 로그인해 MFA 등록 → `/admins` 에 "완료" 확인.
4. **그 순간 구 로그인은 자동으로 닫힌다** (`admin_legacy_login_allowed()` = false — DB 가 판정, 매 요청). 로그인 화면에서 구 폼이 사라지고 기존 legacy 쿠키도 무효.
5. 필요한 관리자를 `/admins` 에서 추가 (viewer 부터).
6. `ADMIN_LEGACY_PASSWORD_LOGIN` · `ADMIN_PASSWORD` · `ADMIN_ACTOR_LABEL` 을 환경에서 지운다.

되돌리기: 3 단계 전이면 환경변수만으로 구 로그인이 유지된다. 3 단계 뒤에 구 로그인을 다시 열려면 `admin_members.mfa_verified_at` 을 모두 null 로 되돌려야 하는데, 이는 의도적으로 UI 가 없다 (DB 에서 직접 — 감사 기록 남길 것).
기존 감사 기록(입력한 이름)은 보존되고 `/audit` 이 그대로 보여준다. 새 기록은 계정 id 로 남고 이름 맵으로 표시된다.

## 5. 검증

로컬에서 실행한 것:

```bash
cd apps/admin && npm run selftest          # admin-session (53) · admin-auth (82) — mock Provider/Directory
cd supabase/tests && bash run_local_check.sh   # admin_accounts_tests.sql · admin_accounts_concurrency_test.sh (두 연결) · security_tests (서버 전용 테이블)
cd apps/admin && npm run bundle:check:selfcheck && npm run build && npm run bundle:check
```

PowerShell (한 줄씩):

```powershell
cd apps\admin; npm run selftest
cd supabase\tests; bash run_local_check.sh
cd apps\admin; npm run bundle:check:selfcheck
cd apps\admin; npm run build
cd apps\admin; npm run bundle:check
```

| 항목 | 어디서 | 종류 |
|---|---|---|
| 일반 앱 사용자·미로그인 관리자 접근 차단 | admin-auth §3 · admin_accounts_tests (앱 사용자 membership 거부) · security_tests (테이블·RPC 서버 전용) | mock + DB |
| 관리자 metadata·role 위조 차단 | admin-auth §3 (다른 키 서명·role 끼워넣기·없는 세션 id) · 0033 은 metadata 를 읽지 않음 | mock + DB |
| 비밀번호만 통과한 세션의 접근 차단 | admin-auth §1 (pending 은 resolveSession null) · §2 (등록 전 세션 없음) | mock |
| 만료·변조 세션 차단 | admin-session (v1/변조/만료) · admin-auth §1 · admin_accounts_tests (만료·취소·not_found) | mock + DB |
| viewer 의 모든 관리 mutation 직접 호출 차단 | `requireOwner()` 가 모든 mutation 서버 액션 상단 (코드) · admin-auth (hasRole) · admin_accounts_tests (viewer 의 RPC 거부) | 코드 + DB |
| 권한 강등·비활성화 이후 기존 세션 차단 | admin-auth §1 · admin_accounts_tests (같은 세션이 강등/비활성화/재활성화 뒤 어떻게 보이나) | mock + DB |
| 마지막 owner 보호 및 동시 변경 | admin_accounts_tests · admin_accounts_concurrency_test.sh (두 연결 동시 강등 → 1명 유지) | DB |
| 로그인·MFA 실패 횟수 제한 | admin-auth §5 (IP·계정·MFA 키, 잠금 중 미검사, 동시 요청) · admin_login_guard 테스트(0031) | mock + DB |
| DB/Auth 장애 시 권한 허용으로 넘어가지 않음 | admin-auth §1/§4/§5/§7 (directory/provider down → 거부) | mock |
| 감사 로그 actor 위조 방지 | actor 는 세션(`admin_session_check` 결과)에서만 · RPC p_actor 는 서버가 넣음 · admin_accounts_tests (actor uuid) | 코드 + DB |
| 세션·OTP·MFA secret·서버 key 로그/번들 비노출 | admin-auth §9 (콘솔 캡처·응답) · check-admin-bundle (.next/static) | mock + 빌드 |
| 공개 정책·삭제 안내 페이지 접근 유지 | `/policy/[slug]` · `/delete-account` 는 `requireAdmin` 을 부르지 않음 (코드) · next build 가 policy 를 정적 생성 | 코드 |
| 기존 신고·삭제·얼굴 검토·베타 운영의 owner 정상 경로 | 서버 액션은 `requireOwner` 만 추가, 도메인 RPC 호출 동일. 도메인 SQL 테스트(moderation/deletion/face/beta) 그대로 통과 | DB |

위 표는 **mock**(가짜 Provider/Directory · auth 스텁) 기준이다. 실제 GoTrue·PostgREST·실제 Next 서버를 쓰는 통합 검증은 별도 경로다:

```bash
bash supabase/tests/run_supabase_integration.sh      # Docker + Supabase CLI 2.117.0 — docs/local-supabase-integration.md
```

| | mock 경로 (`npm run selftest` · `run_local_check.sh`) | 실제 스택 경로 (`run_supabase_integration.sh` · `npm run integration:auth`) |
|---|---|---|
| GoTrue | 가짜 Provider (코드 `123456`) | 실제 GoTrue v2.196.0: TOTP enroll/challenge/verify · `getAuthenticatorAssuranceLevel` · admin createUser/deleteFactor |
| DB | auth 스텁 + 실제 RPC(psql) | 실제 auth 스키마 + PostgREST(service role) 로 RPC/테이블 |
| 관리자 웹 | 없음 (코어 함수만) | 실제 `next start`: 로그인/MFA 폼 POST · 쿠키 · 보호 페이지 · mutation 서버 액션 · 로그아웃 |
| bootstrap | RPC 만 | 실제 `admin-bootstrap.mjs` 실행 (재-bootstrap 거부 포함) |
| 잡아낸 것 | 판정 규칙 회귀 | **GoTrue 가 app_metadata 를 insert 뒤 update 로 넣어 관리자 계정에 앱 사용자 행이 생기던 결함(0035)** · **등록 화면의 렌더 중 쿠키 쓰기 500** (`docs/local-supabase-integration.md` 4절) |

통합 테스트가 다루지 않는 것: 실제 배포 환경(리버스 프록시 · `ADMIN_TRUST_PROXY_HEADERS`) · 실제 브라우저 UI · 본인확인/SMS/Didit. release checklist 의 "실제 배포에서 미수행" 항목은 그대로 남는다.
GoTrue MFA 계약(`enroll` → unverified factor + `qr_code/secret/uri`, `verify` → aal2 세션, `getAuthenticatorAssuranceLevel(jwt)`)은 실제 GoTrue 로 확인했다.
