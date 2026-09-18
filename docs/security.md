# 보안 하드닝 (#27) — 권한 · RLS · 남용 방지 · 관리자 감사

공개 베타 전 "클라이언트가 API 를 직접 호출해도 남의 데이터·관리자 기능·service role 경로가 열리지 않는가" 를 코드와 테스트로 고정한다.
검증: `supabase/tests/security_tests.sql` (run_local_check.sh 포함) · `supabase/functions/_shared/security/selftest.ts` · `apps/admin/scripts/admin-session-selftest.mjs`.

## 1. 원칙

| 원칙 | 구현 |
|---|---|
| 모든 public 테이블에 RLS | `security_tests.sql` 1) 이 전수 검사 — 새 테이블에 RLS 를 빼먹으면 로컬 검증이 실패한다 |
| 서버 전용 테이블은 grant 자체를 회수 | `revoke all ... from anon, authenticated` (user_identities 는 정책 0개로 차단) |
| SECURITY DEFINER 함수는 allowlist | 클라이언트가 실행할 수 있는 DEFINER 함수 목록을 테스트가 고정한다. 새 RPC 는 목록에 의식적으로 추가해야 한다 |
| 가드 트리거는 SECURITY INVOKER | DEFINER 안에서는 `current_user` 가 소유자가 되어 `is_end_user_request()` 가 늘 false 다 (0016 원칙). 비공개 테이블 조회가 필요하면 별도 DEFINER 헬퍼(`identity_facts_self`)를 호출자 본인 범위로만 연다 |
| 서버 관리 컬럼은 트리거로 잠금 | users(인증 플래그·상태·베타 입장) · profiles(성별·출생연도) · matches(meetup_*) · recommendations(점수·카드·전략) |
| fail-closed | rate limit / 베타 판정 RPC 가 실패하면 허용이 아니라 거부(503) |
| 뷰는 service role 전용 | 운영 뷰(퍼널·moderation·beta·meetup_pair_summary)는 authenticated 에 select 권한 없음 |

## 2. 클라이언트(anon key + 사용자 JWT)로 할 수 있는 일

| 대상 | 읽기 | 쓰기 |
|---|---|---|
| users | 본인 행 | `onboarding_step`·`last_active_at`·`onboarding_completed`(인증 완료 + 베타 입장 뒤에만) — 상태·인증 플래그·cohort 는 서버 |
| profiles | 본인 + 활성 매치 상대 | 본인 행 insert(베타 입장 뒤)/update. 성별·출생연도는 본인확인 결과와 같아야 하고 온보딩 완료 뒤 잠김 |
| private_profiles / questionnaire_responses / preference_settings / dealbreakers | 본인 | 본인 (선호·Dealbreaker 는 `preferences_save` RPC 권장 — 원자적) |
| recommendations | 본인 | `status` pending→accepted/skipped 와 `skip_reason` 만 |
| likes | 보낸 것 | 오늘 추천받은 상대에게만 insert |
| matches / conversations / conversation_metrics | 참가자 | 없음 (서버 트리거) |
| messages | 참가자 | `send_message` RPC (client_message_id 멱등 · 20/60초 · 200/시간 · 반복 본문 제한) · 읽음 표시 |
| meetup_intentions / meetup_outcomes / meetup_feedback | 본인(+상호 성립 뒤 상대 의향) | RPC 만 (`meetup_set_intent` · `meetup_report_outcome` · `meetup_submit_feedback`) |
| blocks | 본인 | 본인 |
| reports | 본인이 한 신고 | insert (pending, 긴급은 허용 사유만) · **10건/일** |
| analytics_events | 없음 | 본인 명의 insert · **300건/시간** |
| push_tokens / notification_preferences | 본인 | 본인 (`push_token_register` RPC) |
| beta_waitlist | 본인 | RPC 만 (`beta_join_waitlist` · `beta_redeem_invite` — 시도 10회/시간) |
| questionnaire_questions | 로그인 사용자 전체 | 없음 |
| 그 외 모든 테이블·뷰 | 거부 또는 0행 | 없음 |

anon(미로그인) 은 어떤 테이블에서도 행을 읽지 못한다 (테스트 4).

## 3. Edge Function 인증 모드

| 함수 | 호출자 | 남용 방지 |
|---|---|---|
| verify-identity | 사용자 JWT | 베타 입장 확인 → request 5회/10분 · confirm/recover 10회/시간 (사용자당). 세션은 서버 소유(0032) — JWT 사용자 결속·10분 만료·1회 사용·5회 실패 종료 (`docs/identity-verification.md`) |
| start-face-liveness | 사용자 JWT | 베타 입장 확인 → 세션 생성 횟수는 DB RPC(`face_liveness_begin_session`) 가 시간/일 상한 |
| daily-recommendation | 사용자 JWT | 30회/시간 · `recommendation_run_claim` 잠금 |
| icebreaker | 사용자 JWT | 30회/시간 |
| delete-account | 사용자 JWT | 5회/시간 |
| send-sms | Auth Hook 서명 | 번호별 60초 쿨다운 · 시간당 상한 (0012) |
| didit-webhook | Didit 서명(V3) | event_id 중복 무시 |
| daily-recommendation-batch · send-push · account-purge(batch · 단일 · face_cleanup) · admin-face-review | **service role key 일치** (`requireServiceRole`) | 사용자 JWT 는 401 |
| dev-login · complete-face-verification | 개발 전용 | production 미배포 + APP_ENV 가드 |

rate limit 원시 기능: `rate_limit_hit(scope, key, limit, window)` (0023, 고정 창 카운터, service role 전용). Edge 는 `_shared/rateLimit.ts` 의 `enforceRateLimit` 로 호출하고, RPC 실패 시 503 `rate_limit_unavailable`.
사용자 JWT 컨텍스트의 DB 트리거(신고·분석 이벤트)는 `rate_limit_hit_self(scope, limit, window)` 를 쓴다 — 키가 항상 호출자 본인이라 남을 제한할 수 없다.

## 4. 관리자 웹 — 개인 계정 · MFA · 최소 권한 (0033, `docs/admin-auth.md`)

- **계정**: 관리자 = Supabase Auth 개인 계정(이메일+비밀번호, `app_metadata.bonsim_admin=true` → `public.users` 행을 만들지 않음) + `admin_members` membership.
  **권한의 근거는 membership 행뿐이다** — JWT·user metadata·쿠키·요청 입력의 role 을 믿지 않는다. membership 은 서버(service role)만 만든다:
  첫 owner 는 `apps/admin/scripts/admin-bootstrap.mjs create-owner`(활성 owner 가 없을 때만), 이후는 owner 가 `/admins` 에서. 앱 사용자(`public.users` 행)는 `admin_member_add` 가 거부한다.
- **역할**: `owner`(모든 조치) · `viewer`(열람). 페이지·서버 액션마다 `requireAdmin()`/`requireOwner()` 가 서버에서 검사한다 (메뉴 숨김은 UX). viewer 에게는 이메일·연락처·초대코드가 마스킹되고
  정지/해제·삭제·단계 건너뛰기·얼굴 승인·초대코드·베타 설정·권한 변경 폼이 렌더링되지 않으며 직접 호출해도 `requireOwner` 가 거부한다.
  마지막 활성 owner 강등·비활성화는 RPC 가 활성 owner 행을 잠근 뒤 거부한다 (동시 변경에도 유지 — `admin_accounts_concurrency_test.sh`).
- **MFA**: Supabase Auth 관리형 TOTP (`mfa.enroll/challenge/verify`, 직접 구현한 알고리즘 없음). 비밀번호 통과 → `bonsim_admin_pending`(10분, 등록/검증 화면 전용) → 코드 검증 →
  **서버가 GoTrue 에 aal2 를 확인**한 뒤에만 `admin_sessions` 행 + 쿠키를 발급한다. 미등록 계정은 등록 화면만 접근 가능. 비밀번호 변경·본인 MFA 재등록은 비밀번호+현재 코드 재인증,
  타인 MFA 초기화는 owner, 모든 owner 잠김은 서버 스크립트 `reset-mfa` (공개 API 없음). TOTP secret·QR·코드·토큰은 HTML 응답에만 실리고 URL·로그·감사에 없다.
- **세션**: 쿠키 = `{sid}` 서명 토큰(v2, HMAC-SHA256, 12시간). 역할·활성·취소 여부는 **매 요청 `admin_session_check`** 가 DB 에서 읽는다 → 비활성화·강등·세션 취소가 발급된 세션에 즉시 반영.
  v1 쿠키(공유 비밀번호 시절)와 pending 토큰은 세션이 아니다. 서명 키 `ADMIN_SESSION_SECRET` — production 32자+ 필수. `httpOnly` · `sameSite=lax` · production `secure`.
- **fail-closed**: 제한 저장소·membership·세션·aal 조회·Auth 어느 것이든 응답하지 않으면 거부(`unavailable`). 비관리자 Auth 계정의 로그인은 자격 증명 실패와 같은 응답으로 거부하고 실패로 집계한다.
- **로그인 제한 (DB 공유, 0031)**: 비밀번호는 IP 키 + 계정 키, MFA 코드는 사용자 키 — 각각 5회 실패 → 15분 잠금 (`admin_login_guard`, 행 잠금·인스턴스 공유). 키는 HMAC(원문 미저장).
  잠금 중에는 비밀번호·코드를 검사하지 않는다. 프록시 헤더는 `ADMIN_TRUST_PROXY_HEADERS=1` 일 때만 신뢰 (아니면 모든 클라이언트가 한 IP 키를 공유 — 계정 키는 별도).
  관리형 Auth 자체의 제한(GoTrue 의 로그인/MFA rate limit)은 그대로 추가로 작동하며, 앱 제한은 "우리가 세션을 발급하는 조건" 을 결정한다 — 둘 중 하나만 통과해서는 세션이 없다.
- **구 공유 비밀번호 로그인 (전환 기간)**: `ADMIN_LEGACY_PASSWORD_LOGIN=1` + `ADMIN_PASSWORD` 가 있고 **MFA 로 로그인을 완료한 관리자가 없을 때만** (`admin_legacy_login_allowed`, 매 요청 DB 확인).
  첫 owner 가 MFA 로 로그인하는 순간 닫히고 기존 legacy 쿠키도 무효가 된다. 상시 대체 경로가 아니다. 이 세션의 actor 는 `legacy:<이름>` 이며 관리자 계정 관리는 할 수 없다.
- **감사 로그** `admin_audit_log` (0023): actor = 인증된 관리자 계정 id(불변), 표시 이름은 `detail.actor_name`. 로그인·MFA 실패/잠금·비밀번호 변경·MFA 초기화·관리자 추가/역할/상태/세션 취소 + 기존 조치 전부.
  도메인 기록(`moderation_actions.actor` · `face_verification_reviews.actor` · `beta_invite_codes.created_by` · 삭제 작업 requested_by)에도 같은 id 가 들어간다. 이전 기록(입력한 이름)은 그대로 보존되고 `/audit` 이 이름 맵으로 표시한다.
- service role key · anon key 는 서버 환경변수 (`NEXT_PUBLIC_*` 금지). `next build` 산출물 검사: `apps/admin/scripts/check-admin-bundle.mjs` (CI).

## 5. 회귀 테스트가 잡는 것

`security_tests.sql` (서버 전용 테이블 목록에 `account_purge_jobs` · `account_purge_job_events` · `face_asset_cleanup` · `admin_login_locks` · `identity_verification_sessions` · `admin_members` · `admin_sessions` 포함)
1. RLS 꺼진 public 테이블 → 실패
2. allowlist 밖의 DEFINER 함수를 authenticated/anon 이 실행 가능 → 실패
3. 클라이언트가 읽을 수 있는 뷰 → 실패
4. anon 이 어떤 테이블에서든 행을 읽음 → 실패
5. 서버 전용 테이블을 사용자 JWT 가 읽음 → 실패
6. recommendations 점수·카드·상태(expired / 재결정) 조작 → 실패
7. 신고 11건째 허용 → 실패 (서버 insert 는 제한 없음)
8. `rate_limit_hit` / `admin_audit_record` 를 사용자 JWT 로 실행 → 실패

`profile_edit_tests.sql` (0024) · `beta_tests.sql` (0025) 는 각 도메인의 서버 관리 컬럼과 RPC 범위를 검증한다.
`admin_accounts_tests.sql`(7절: GoTrue createUser 의 metadata 적용 순서 재현 — 0035) · `admin_accounts_concurrency_test.sh` (0033) · `apps/admin/scripts/admin-auth-integration.mjs` (실제 로컬 GoTrue·PostgREST·Next — 155 검사, `docs/local-supabase-integration.md`) · `apps/admin/scripts/admin-auth-selftest.mjs` (82 검사 — 비관리자/미로그인 차단 · role 위조 · MFA 미완료 세션 · 만료/변조 · 강등/비활성화/취소 즉시 반영 · 실패 제한 · 장애 시 거부 · 재인증 · 구 로그인 게이트 · secret/코드 비노출).

## 6. 남은 것 (이 저장소 밖 · 후속)

- Supabase Auth 자체 rate limit(OTP 발송·토큰 갱신·MFA verify)은 Dashboard 설정 — release checklist. Dashboard 에서 이메일 공개 가입을 끄는 것을 권장한다 (관리자 계정은 스크립트/owner 가 만든다).
- 관리자 인증의 **실제 GoTrue 연동은 로컬에서 실행하지 않았다** (mock Provider 로만 검증). staging 에서 bootstrap → 로그인 → TOTP 등록 → viewer 차단 → 비활성화 즉시 반영을 확인해야 한다 (`docs/admin-auth.md` 5절).
- Storage 객체 정책은 `0007/0013` 그대로 (faces 버킷 본인 경로만, `liveness/` 는 서버 전용). 이번 변경 없음.
