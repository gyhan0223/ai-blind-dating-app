# 폐쇄 베타 cohort · 초대코드 · 가입 인원 제어 (#26)

좁은 지역·연령 cohort 만 순차적으로 받아 MVP 가설(#24)을 검증한다. 만남 이력이나 외모 점수로 가입·배정을 제한하지 않는다 (#38 미적용).
마이그레이션 `0025_beta_cohorts.sql` · 테스트 `supabase/tests/beta_tests.sql` · 관리자 `/beta` · 앱 `auth/beta`.

## 1. 모델

| 개념 | 테이블/컬럼 | 설명 |
|---|---|---|
| 게이트 | `app_settings.beta_gate {"enabled": bool}` | 꺼짐 = 일반 공개(모두 open). 켜짐 = 입장 허가가 있어야 진행 |
| 입장 허가 | `users.beta_admitted_at`, `users.cohort_id` | 서버만 쓴다 (트리거 `users_guard_beta_columns`). 베타 종료 뒤에도 cohort_id 는 측정용으로 남는다 |
| cohort | `beta_cohorts` | slug · 이름 · 지역 코드 목록(비면 전국) · 연령대 · 정원(선택) · 모집 ON/OFF |
| 초대코드 | `beta_invite_codes` | cohort 에 묶임 · 사용 횟수 · 만료 · 활성. 코드는 헷갈리는 글자를 뺀 대문자·숫자 8자 |
| 대기 | `beta_waitlist` | 초대 없이 온 사용자의 **지역 · 출생연도 · 성별** 만. 프로필·본인확인·얼굴 데이터는 만들지 않는다 |

## 2. 사용자 흐름

```
OTP 로그인 → Gate → OnboardingResume → beta_access_state()
   open / admitted  → 본인확인(identity) 부터 온보딩
   invite_required  → auth/beta: 초대코드 입력 또는 대기 등록
   waitlisted       → auth/beta: 대기 안내 + 알림 켜기 + 코드 입력 가능
```

- 초대코드: `beta_redeem_invite(code)` — 실패는 예외가 아니라 `error` 필드 (`rate_limited` 10회/시간 · `invalid_code`(없음/만료/비활성 구분 없음) · `code_exhausted` · `cohort_closed` · `cohort_full`).
  예외로 롤백되면 시도 카운터도 사라져 무차별 대입 상한이 동작하지 않기 때문에 값으로 돌려준다.
- 대기 등록: `beta_join_waitlist(region, birthYear, gender)` — 다시 부르면 갱신. 대기 화면에서 알림 권한을 켜 두면 입장 시 push(`beta_admitted`, 고정 문구)가 온다.
- 운영자가 입장시키면(`beta_admit_waitlist` / `beta_admit_user`) `analytics_events.beta_admitted{via}` 와 outbox 1건(dedupe `beta:admitted:<uid>`) 이 쌓인다.

## 3. 강제 지점 (앱을 우회해도 막힌다)

| 지점 | 방법 |
|---|---|
| 본인확인 시작 | `verify-identity` 가 `beta_access_allowed(uid)` 로 거부 (403 `beta_admission_required`, RPC 실패 시 503) |
| 얼굴 인증 시작 | `start-face-liveness` 동일 |
| 프로필 생성 | `profiles` insert 정책에 `beta_access_allowed_self()` |
| 온보딩 완료 | `users_guard_onboarding_completion` 이 입장 허가 없으면 거부 |
| 입장 컬럼 | 사용자가 `cohort_id`/`beta_admitted_at` 을 바꾸면 거부 |

이미 본인확인을 마친 사용자는 게이트가 뒤늦게 켜져도 막지 않는다 (서버도 "온보딩 완료 전이" 만 막는다). 기존 사용자를 내보내려면 정지(#15)로 처리한다.

## 4. 운영 (관리자 `/beta`)

1. cohort 만들기 — slug(예 `seoul-1`), 이름, 지역 코드(`seoul,gyeonggi`), 연령대, 정원.
2. 게이트 켜기 → 이때부터 새 계정은 초대/대기 화면을 본다.
3. 초대코드 발급 — 개수 · 코드당 사용 횟수 · 만료일. 소진/만료/비활성 코드는 `invalid_code`/`code_exhausted`.
4. 대기자 입장 — cohort 조건(지역·연령대)에 맞는 대기자를 오래된 순으로 N 명 (성별 필터 가능, 정원 남은 자리까지). 성별·지역 공급 불균형은 "대기자 분포" 표를 보고 성별 필터로 조절한다.
5. 모집 닫기 — 코드가 남아 있어도 `cohort_closed`. 정원 변경 즉시 반영.
6. 베타 종료 — 게이트 끄기. cohort 통계는 계속 볼 수 있다.

모든 조치는 `admin_audit_log` 에 처리자 이름과 함께 남는다 (#27).

## 5. 측정 (#24 연결)

- `beta_cohort_stats` 뷰: cohort 별 입장(남/여) · 온보딩 · 추천 생성/실제 확인 · 호감 · 매치 · 양방향 · 상호 만남 의향 · 양측 확인 (funnel_user_facts 기준, demo 제외). 7일 지속 지표는 #24 결정으로 제외됐다 (0026).
- `beta_waitlist_summary` 뷰: 지역 · 성별 · 5세 연령대별 대기/입장 수와 가장 오래된 대기 시각.
- 이벤트: `beta_waitlisted`, `beta_admitted{via: invite|waitlist|admin, cohort}` — 개인정보 없음.

## 6. 데이터 보관

- `beta_waitlist` 는 users 삭제 시 cascade, 익명화(purge) 시 트리거로 삭제 (`users_purged_waitlist`).
- 초대코드 행은 발급자 이름·사용 횟수만 담는다 (누가 어떤 코드를 썼는지는 저장하지 않는다 — `analytics_events.beta_admitted.cohort` 만).

## 7. 남은 것

- 실기기에서 대기 → 운영자 입장 → push 수신 → 온보딩 진입 확인 (#21).
- cohort 별 모집·관찰 기간·판단 기준 확정은 운영 결정 (#24).
- 초대코드 배포 채널(문자·메신저)은 저장소 밖.
