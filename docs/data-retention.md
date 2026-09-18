# 개인정보 보관·삭제 정책 (#13 · #11 · #14)

이 문서는 코드가 실제로 하는 일을 적는다. 법률 문서(개인정보처리방침, #12)는 이 표를 근거로 작성한다.
법률 검토 전이므로 "정책 확정" 이 아니라 "구현된 기본값" 이다 — 보관 기간은 상수·cron 인자로 바꿀 수 있다.

## 1. 탈퇴 흐름

```text
앱 회원 탈퇴 (delete-account)  ──▶  status=deleted, deleted_at=now()  ──30일 유예──▶  account-purge (batch, cron 일 1회)
   · 추천·매칭·대화 즉시 중단            · 같은 번호로 로그인 → "계정 복구" 가능          · 얼굴 storage/Didit 세션 삭제
   · 세션 전체 무효화                    · 유예 중에는 데이터 유지                          · account_purge RPC (한 트랜잭션)
                                                                                           · 계정 스켈레톤만 남김 (복구하면 처음부터)
앱 밖 삭제 요청 (/delete-account)  ──▶  account_deletion_requests  ──운영자 본인 확인──▶  account-purge (hard) = 위 + auth 계정 삭제
```

| 단계 | 구현 | 검증 |
|---|---|---|
| 소프트 삭제 | `delete-account` Edge (status=deleted, 트리거 `users_track_deleted_at` 가 deleted_at 기록), `can_chat_in`/`meetup_set_intent` 가 양쪽 active 요구. status 기록이 실패하면 500(`delete_failed`)으로 응답하고 세션을 끊지 않는다 — 앱은 로그아웃하지 않고 안내만 한다 (계정이 남아 있는데 탈퇴됐다고 오해하지 않게) | `meetup_flow_tests.sql` (정지 상대), `account_deletion_tests.sql`, `app_flow_tests.sql` (탈퇴자 self_restricted · 상대 unavailable · 복구) |
| 유예·후보 | `account_purge_candidates(grace)` — deleted_at 이 유예를 지난 계정 | 〃 |
| 삭제 작업 상태 (#13) | `account_purge_jobs` (0028) — 사용자당 1행, 단계 storage · provider · db · auth 의 done/failed/skipped, lease, 시도 횟수, Provider 세션 스냅샷. 7절 | `account_purge_jobs_tests.sql` · `account_purge_concurrency_test.sh` · `_shared/purge/selftest.ts` |
| 익명화 | `account_purge(user_id)` — 아래 표대로. `account-purge` Edge 의 db 단계가 호출 (storage/provider 결과와 무관하게 진행) | 〃 |
| 완전 삭제 | `account-purge` `{hard:true}` → db 단계가 done 인 뒤 auth 단계 `auth.admin.deleteUser` → `auth.users` cascade 로 `users` 행·메시지·매치·신고 행까지 삭제. "user not found" 만 이미 삭제됨으로 인정 | 로컬에서는 auth admin API 가 없어 미검증 (adapter mock 으로 실패/멱등 시나리오만) |
| 앱 밖 요청 | `apps/admin/app/delete-account` (공개, 로그인 없음) → `account_deletion_requests`(서버 전용) → `/deletion-requests` 에서 운영자 처리 | 테이블 RLS: 〃 |

## 2. 데이터별 처리 (익명화 시점)

| 데이터 | 목적 | 익명화(30일 뒤) | 완전 삭제(hard) |
|---|---|---|---|
| `profiles` · `private_profiles` · `questionnaire_responses` · `preference_settings` · `dealbreakers` | 소개·매칭 | **삭제** | 삭제 |
| `appearance_preference_events` (MVP 미사용 과거 데이터) | — | 삭제 | 삭제 |
| `recommendations` (내가 받은 것) | 추천 이력 | 삭제 | 삭제 |
| `recommendations` (상대가 받은 내 카드) | 상대의 추천 이력 | `card='{}'` 로 비움, pending 은 expired | 삭제(cascade) |
| `likes` | 매칭 | 삭제 (양방향) | 삭제 |
| `matches` · `conversations` · `conversation_metrics` | 상대의 대화 이력·집계·재매칭 방지 | 유지 (active 는 closed 로, `close_kind='account'`). 개인 식별 정보 없음 | 삭제(cascade) — 이후 새 계정으로 재가입하면 과거 상대와 다시 매칭될 수 있다 (`docs/conversation-policy.md` 3절) |
| `conversation_exits` (#24, 나가기 이유 — 본인만 조회) | 종료 이유 집계 | 유지 (user_id 는 계정 스켈레톤을 가리킴, 개인 식별 정보 없음) | 삭제(cascade) |
| `messages` (내가 보낸 것) | 상대의 대화 이력·신고 증거 | 본문 → "(탈퇴한 사용자의 메시지입니다)", client_message_id null. 행 유지 | 삭제(cascade) |
| `meetup_intentions` · `meetup_outcomes` · `meetup_feedback` (내 응답) | 만남 흐름·측정 | 삭제. 상대의 응답과 매치 집계 상태(`met_confirmed` 등)는 유지 | 삭제 |
| `push_tokens` · `notification_preferences` · `notification_events`(수신) | 알림 | 삭제 (탈퇴 즉시 토큰 삭제) | 삭제 |
| `face_verifications` · `face_verification_reviews` · `face_asset_cleanup` | 인증(실제 사람·중복 가입 확인) | 행 삭제(db 단계). storage `faces/<uid>/**` 전체(하위 폴더·페이지 포함) 삭제 후 재조회 0건 확인(storage 단계). Didit 세션 `DELETE /v3/session/{id}/delete/` 를 스냅샷된 모든 세션에 대해 2xx 확인(provider 단계). 실패는 작업에 남고 재시도한다 — **best effort 아님** | 동일 |
| `face_consents` (#12) | 생체정보 동의 증적 | 삭제 (트리거 `users_purged_face_consents`) | 삭제(cascade) |
| `user_identities` | 1인 1계정·차단 우회 방지 | `identity_key_hash`·`banned`·`user_id` 만 남기고 생년월일·성별·검증 시각 null | 행은 `user_id` null 로 남음 (해시·banned 유지) |
| `users` | 계정 스켈레톤 | email null, 인증·온보딩 플래그 초기화, `purged_at`. **phone 은 로그인 수단(auth.users)과 함께 유지** — 재로그인 시 같은 계정으로 이어져 처음부터 시작 | auth.users 와 함께 삭제 (전화번호 삭제) |
| `reports` | 신고 처리·증거 | 유지 (신고자/피신고자 id 는 계정 스켈레톤을 가리킴) | 삭제(cascade) — 운영 기록이 필요하면 완전 삭제 전에 별도 보관 |
| `blocks` | 차단 유지 | 유지 | 삭제(cascade) |
| `analytics_events` · `device_events` | 측정·남용 탐지 | `user_id` null (연결 해제) | 〃 |
| `recommendation_runs` | 배치 기록 | 삭제 | 삭제 |
| `beta_waitlist` (#26) | 폐쇄 베타 대기 (지역·출생연도·성별) | 삭제 (트리거 `users_purged_waitlist`) | 삭제(cascade) |
| `users.cohort_id` (#26) | cohort 측정 | 유지 (개인 식별 정보 아님) | 삭제 |
| `rate_limit_counters` (#27) | 남용 방지 카운터 (사용자 id 키) | 2일 뒤 `rate_limit_prune` — 사용자별 삭제 없음 | 〃 |

## 3. 얼굴 데이터 (#11) — 인증 목적, 최소 수집

- 저장하는 것: `face_verifications` 행(상태·점수·사유 코드·Didit 세션 id) + 서버 전용 reference image (`faces/<uid>/liveness/reference.jpg`, private bucket, 클라이언트 접근 불가).
  raw 영상·audit 이미지·Provider 응답 원문·임베딩은 저장하지 않는다 (`feature_vector` null).
- 쓰임: 라이브니스 결과 확인, Face Search 1:N 중복 의심 시 관리자 검토(`in_review`). 추천·카드·상대 화면 어디에도 쓰이지 않는다 (#40 로더가 읽지 않음).
- 보관: 계정이 활성인 동안 (중복 가입 검토 근거). 탈퇴 후 유예(30일) 뒤 익명화 시 삭제. 관리자 검토 감사 기록(`face_verification_reviews`)도 함께 삭제.
- Provider(Didit) 측: 세션 삭제 API 호출. 실패(설정 누락·네트워크·401/403·429·5xx·404)는 `account_purge_jobs.provider_error` 에 코드로 남고 배치·운영자 재시도가 이어서 처리한다.
  익명화(db 단계)는 Provider 결과와 무관하게 진행되므로 로컬 개인정보 삭제가 외부 실패에 막히지 않는다 (7절).
  Didit 자체 보관 기간·계약은 #12 문서에 고지한다 (미확인).
- **재인증·실패 후 정리 (#11)**: reference image 는 세션(행)별 경로 `faces/<uid>/liveness/<face_verification_id>/reference.jpg` 에 저장된다
  (예전 고정 경로 `faces/<uid>/liveness/reference.jpg` 의 기존 행은 그대로 유효). 세션이 `expired`/`rejected`/`superseded` 로 끝나면
  트리거가 `face_asset_cleanup` 큐에 이미지 경로·Provider 세션을 등록하고, 24시간 뒤부터 `account-purge {face_cleanup:true}` 가
  #13 과 같은 실행기로 지운다. `in_review`(관리자 검토 중)·`pending`·`approved` 는 등록하지 않는다. 처리 직전에 행이 아직 종료 상태인지,
  승인 행이 같은 경로를 참조하지 않는지(구 고정 경로 보호), 삭제 작업 중인 사용자가 아닌지 다시 확인한다.
  같은 사용자에게 다른 approved 행이 있으면 `face_liveness_approve` 는 새 승인을 거부하고 그 행을 `superseded` 로 마감한다
  (늦은 웹훅·sync 가 최신 승인/이미지를 덮어쓰지 못한다). `docs/face-liveness-didit.md` 4절.
- 웹훅 원문(`face_webhook_events`)은 `face_liveness_prune_webhook_events(interval '7 days')` 로 정리한다 (0014).

## 4. cron (등록은 운영자가 — 이 저장소에서 수행하지 않았다)

```sql
-- 탈퇴 유예 지난 계정 익명화 + 실패한 삭제 작업 재시도 (일 1회)
select cron.schedule('account-purge', '0 19 * * *', $$  -- KST 04:00
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/account-purge',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
    body := '{"batch": true, "grace_days": 30, "limit": 100}'::jsonb);
$$);
-- 종료된 얼굴 세션 자산 정리 (#11, 1시간마다)
select cron.schedule('face-asset-cleanup', '30 * * * *', $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/account-purge',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
    body := '{"face_cleanup": true, "limit": 50}'::jsonb);
$$);
-- 기록 정리 (보관 기간은 미확정 기본값 — 7절)
select cron.schedule('purge-records-prune', '15 19 * * 0', $$
  select public.account_purge_jobs_prune(interval '365 days'), public.face_asset_cleanup_prune(interval '30 days'), public.admin_login_locks_prune(interval '1 day');
$$);
```

## 5. 스토어 제출 (#14/#19)

- 계정 삭제 URL: `https://<admin-host>/delete-account` (로그인 없음). App Store "계정 삭제" 요건과 Google Play 데이터 삭제 URL 에 그대로 쓴다.
- 앱 안 삭제 경로: 내 정보 → 회원 탈퇴.
- 안내 문구는 이 문서 2절과 같아야 한다 (관리자 웹 페이지 본문 참고).

## 6. 남은 것 (실제 프로젝트에서만 확인 가능)

- 완전 삭제(hard)의 `auth.admin.deleteUser` 경로, Storage 실제 삭제, Didit `DELETE /v3/session/{id}/delete/` 실제 응답은 실 Supabase/Didit 프로젝트에서만 검증할 수 있다.
  이 저장소의 테스트는 adapter mock 으로 실패·재시도·멱등 시나리오를 재현한 것이다.
- `reports` 를 완전 삭제 전에 보관해야 하는지(법정 보존)는 #12 법률 검토에서 정한다.
- Didit 세션 삭제의 **404 가 "이미 삭제됨" 인지** 는 공식 문서로 확인하지 못했다 (문서 사이트 접근 불가). 기존 계약 테스트대로 404 는 실패로 남기며,
  운영자가 콘솔에서 확인한 뒤 "건너뛰기"(사유 필수, 감사 기록) 로 마감한다. 문서 확인 뒤 명확하면 `providerFailureCode` 에서 멱등 성공으로 바꾼다.
- 보관 기간(미확정 기본값): 완료된 삭제 작업 기록 365일 · 정리 큐 완료 항목 30일 · 정리 큐 대기 24시간. 법률 검토 뒤 확정한다.
- pg_cron 등록(4절)은 운영자가 한다.

## 7. 삭제 작업 (#13) — 단계 · 의존성 · 재시도 · 감사

`account-purge` 는 한 사용자를 다음 4단계로 처리하고 결과를 `account_purge_jobs` 에 남긴다 (Edge 응답 `stages.<단계>.status/error`).

| 단계 | 하는 일 | done 조건 | 실패 코드 (예) | 의존 |
|---|---|---|---|---|
| storage | `faces/<uid>/` 아래 모든 객체 나열(하위 폴더·100개 페이지 반복) → 사용자 범위 검증 → 삭제 → 재조회 | 재조회 0건 | `storage_forbidden` · `storage_bucket_not_found` · `storage_network` · `storage_incomplete` · `path_out_of_scope` | 없음 |
| provider | 작업 생성 시 스냅샷한 Didit 세션 id 전부 DELETE (2xx 만 성공) | 남은 세션 0 | `provider_not_configured` · `provider_forbidden` · `provider_rate_limited` · `provider_server_error` · `provider_network` · `provider_not_found_unconfirmed` | 없음 (db 단계 뒤에도 스냅샷으로 재시도) |
| db | `account_purge` RPC (한 트랜잭션) | RPC 성공 | `db_error` · `user_not_found` | 없음 — 외부 실패에 막히지 않는다 |
| auth (hard) | `auth.admin.deleteUser` | 성공 또는 명확한 user_not_found | `auth_forbidden` · `auth_server_error` · `auth_network` | **db done 이후** |

- 전체 `done` = 필요한 모든 단계가 done/skipped. 하나라도 failed 면 `failed` + `retryable:true` 로 보고하고 "완료" 로 기록하지 않는다 (관리자 삭제 요청도 pending 유지).
- 재실행(배치 `account_purge_batch_targets` 의 retry · 관리자 "재시도")은 완료한 단계를 건너뛰고 실패한 단계부터 이어간다.
- 동시 worker·중복 클릭은 lease(기본 300초) 로 직렬화되어 `busy` 로 끝난다. 죽은 worker 의 lease 는 만료 뒤 다른 worker 가 이어받고, 늦은 기록은 `lease_lost` 로 거부된다.
- 스냅샷 `provider_sessions` 는 provider 단계가 done/skipped 되면 비운다 (세션 id 무기한 보존 금지). 이벤트(`account_purge_job_events`)에는 코드·수치만 있고 경로·세션 id·오류 원문이 없다.
- `account_purge_jobs` 는 `users` 와 FK 가 없어 hard delete 뒤에도 남는다 (무엇이 언제 어떻게 끝났는지). 완료 기록은 `account_purge_jobs_prune` 으로 정리한다.
- 운영자 "건너뛰기"(`account_purge_job_skip_stage`) 는 실패한 storage/provider/auth 단계에만, 사유와 함께 감사 기록으로 남는다. db 단계는 건너뛸 수 없다.
- 관리자 웹: 사용자 목록의 상태 배지(삭제 미완료 + 실패 단계) · `/deletion-requests` 하단 "미완료 삭제 작업" (재시도 · 건너뛰기).
