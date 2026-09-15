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
| 소프트 삭제 | `delete-account` Edge (status=deleted, 트리거 `users_track_deleted_at` 가 deleted_at 기록), `can_chat_in`/`meetup_set_intent` 가 양쪽 active 요구 | `meetup_flow_tests.sql` (정지 상대), `account_deletion_tests.sql` |
| 유예·후보 | `account_purge_candidates(grace)` — deleted_at 이 유예를 지난 계정 | 〃 |
| 익명화 | `account_purge(user_id)` — 아래 표대로. `account-purge` Edge 가 얼굴 자산 삭제 후 호출 | 〃 |
| 완전 삭제 | `account-purge` `{hard:true}` → `auth.admin.deleteUser` → `auth.users` cascade 로 `users` 행·메시지·매치·신고 행까지 삭제 | 로컬에서는 auth admin API 가 없어 미검증 |
| 앱 밖 요청 | `apps/admin/app/delete-account` (공개, 로그인 없음) → `account_deletion_requests`(서버 전용) → `/deletion-requests` 에서 운영자 처리 | 테이블 RLS: 〃 |

## 2. 데이터별 처리 (익명화 시점)

| 데이터 | 목적 | 익명화(30일 뒤) | 완전 삭제(hard) |
|---|---|---|---|
| `profiles` · `private_profiles` · `questionnaire_responses` · `preference_settings` · `dealbreakers` | 소개·매칭 | **삭제** | 삭제 |
| `appearance_preference_events` (MVP 미사용 과거 데이터) | — | 삭제 | 삭제 |
| `recommendations` (내가 받은 것) | 추천 이력 | 삭제 | 삭제 |
| `recommendations` (상대가 받은 내 카드) | 상대의 추천 이력 | `card='{}'` 로 비움, pending 은 expired | 삭제(cascade) |
| `likes` | 매칭 | 삭제 (양방향) | 삭제 |
| `matches` · `conversations` · `conversation_metrics` | 상대의 대화 이력·집계 | 유지 (active 는 closed 로). 개인 식별 정보 없음 | 삭제(cascade) |
| `messages` (내가 보낸 것) | 상대의 대화 이력·신고 증거 | 본문 → "(탈퇴한 사용자의 메시지입니다)", client_message_id null. 행 유지 | 삭제(cascade) |
| `meetup_intentions` · `meetup_outcomes` · `meetup_feedback` (내 응답) | 만남 흐름·측정 | 삭제. 상대의 응답과 매치 집계 상태(`met_confirmed` 등)는 유지 | 삭제 |
| `push_tokens` · `notification_preferences` · `notification_events`(수신) | 알림 | 삭제 (탈퇴 즉시 토큰 삭제) | 삭제 |
| `face_verifications` · `face_verification_reviews` | 인증(실제 사람·중복 가입 확인) | 행 삭제. storage `faces/<uid>/*` 삭제. Didit 세션 `DELETE /v3/session/{id}/delete/` (best effort) | 동일 |
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
- Provider(Didit) 측: 세션 삭제 API 호출 (best effort — 실패해도 익명화는 진행하고 함수 로그에 남는다. 재시도는 운영자가 `account-purge` 를 다시 호출).
  Didit 자체 보관 기간·계약은 #12 문서에 고지한다.
- 웹훅 원문(`face_webhook_events`)은 `face_liveness_prune_webhook_events(interval '7 days')` 로 정리한다 (0014).

## 4. cron

```sql
select cron.schedule('account-purge', '0 19 * * *', $$  -- KST 04:00
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/account-purge',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
    body := '{"batch": true, "grace_days": 30}'::jsonb);
$$);
```

## 5. 스토어 제출 (#14/#19)

- 계정 삭제 URL: `https://<admin-host>/delete-account` (로그인 없음). App Store "계정 삭제" 요건과 Google Play 데이터 삭제 URL 에 그대로 쓴다.
- 앱 안 삭제 경로: 내 정보 → 회원 탈퇴.
- 안내 문구는 이 문서 2절과 같아야 한다 (관리자 웹 페이지 본문 참고).

## 6. 남은 것

- 완전 삭제(hard)의 `auth.admin.deleteUser` 경로는 실제 Supabase 프로젝트에서만 검증할 수 있다.
- `reports` 를 완전 삭제 전에 보관해야 하는지(법정 보존)는 #12 법률 검토에서 정한다.
- Didit 세션 삭제 실패 재시도 자동화는 없다 (운영자 재호출).
