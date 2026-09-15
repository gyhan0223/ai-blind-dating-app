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
| verify-identity | 사용자 JWT | 베타 입장 확인 → request 5회/10분 · confirm/recover 10회/시간 (사용자당) |
| start-face-liveness | 사용자 JWT | 베타 입장 확인 → 세션 생성 횟수는 DB RPC(`face_liveness_begin_session`) 가 시간/일 상한 |
| daily-recommendation | 사용자 JWT | 30회/시간 · `recommendation_run_claim` 잠금 |
| icebreaker | 사용자 JWT | 30회/시간 |
| delete-account | 사용자 JWT | 5회/시간 |
| send-sms | Auth Hook 서명 | 번호별 60초 쿨다운 · 시간당 상한 (0012) |
| didit-webhook | Didit 서명(V3) | event_id 중복 무시 |
| daily-recommendation-batch · send-push · account-purge · admin-face-review | **service role key 일치** (`requireServiceRole`) | 사용자 JWT 는 401 |
| dev-login · complete-face-verification | 개발 전용 | production 미배포 + APP_ENV 가드 |

rate limit 원시 기능: `rate_limit_hit(scope, key, limit, window)` (0023, 고정 창 카운터, service role 전용). Edge 는 `_shared/rateLimit.ts` 의 `enforceRateLimit` 로 호출하고, RPC 실패 시 503 `rate_limit_unavailable`.
사용자 JWT 컨텍스트의 DB 트리거(신고·분석 이벤트)는 `rate_limit_hit_self(scope, limit, window)` 를 쓴다 — 키가 항상 호출자 본인이라 남을 제한할 수 없다.

## 4. 관리자 웹

- **세션**: 쿠키 = 서명된 토큰(HMAC-SHA256, 만료 12시간, nonce). 서명 키는 `ADMIN_SESSION_SECRET`(권장) 또는 비밀번호에서 파생 → 비밀번호 변경 = 전 세션 무효. `httpOnly` · `sameSite=lax` · production `secure`.
  (이전: 쿠키가 `sha256(비밀번호)` 고정값이라 한 번 새면 영구 유효했다)
- **로그인 제한**: IP(해시) 당 5회 실패 → 15분 잠금 (인스턴스 메모리). 성공·실패·잠금이 `admin_audit_log` 에 남는다.
- **처리자 이름**: 로그인 때 입력 → 세션에 서명되어 실려 모든 조치의 `actor` 가 된다. 비우면 `ADMIN_ACTOR_LABEL`.
- **감사 로그** `admin_audit_log` (0023): 정지/해제·신고 처리·얼굴 검토·삭제 요청 처리·즉시 익명화·베타 게이트/cohort/초대코드/입장·로그인. `/audit` 화면. detail 에는 id·결과만 (연락처·원문 없음).
  도메인별 기록(`moderation_actions`, `face_verification_reviews`, `account_deletion_requests`)은 그대로 두고 그 위에 "누가 무엇을 눌렀나" 를 모은다.
- service role key 는 서버 환경변수로만 존재한다 (`NEXT_PUBLIC_*` 금지). 클라이언트 번들 grep 은 release checklist.

## 5. 회귀 테스트가 잡는 것

`security_tests.sql`
1. RLS 꺼진 public 테이블 → 실패
2. allowlist 밖의 DEFINER 함수를 authenticated/anon 이 실행 가능 → 실패
3. 클라이언트가 읽을 수 있는 뷰 → 실패
4. anon 이 어떤 테이블에서든 행을 읽음 → 실패
5. 서버 전용 테이블을 사용자 JWT 가 읽음 → 실패
6. recommendations 점수·카드·상태(expired / 재결정) 조작 → 실패
7. 신고 11건째 허용 → 실패 (서버 insert 는 제한 없음)
8. `rate_limit_hit` / `admin_audit_record` 를 사용자 JWT 로 실행 → 실패

`profile_edit_tests.sql` (0024) · `beta_tests.sql` (0025) 는 각 도메인의 서버 관리 컬럼과 RPC 범위를 검증한다.

## 6. 남은 것 (이 저장소 밖 · 후속)

- Supabase Auth 자체 rate limit(OTP 발송·토큰 갱신)은 Dashboard 설정 — release checklist.
- 로그인 잠금은 인스턴스 메모리라 다중 인스턴스에서는 인스턴스별로 적용된다. 필요하면 `rate_limit_hit` 로 옮긴다.
- Storage 객체 정책은 `0007/0013` 그대로 (faces 버킷 본인 경로만, `liveness/` 는 서버 전용). 이번 변경 없음.
- 관리자 2단계 인증·역할 분리(읽기 전용 운영자)는 미구현 — 운영자가 한 명 이상이 되면 다룬다.
