# 퍼널 · 대화 행동 지표 정의 (#24, 2026-09-15 결정 반영)

**목표: 서로 모르던 두 사람이 소개와 대화를 통해 호감을 가질 기회를 만든다.** 실제 만남과 관계 지속은 사용자의 선택이며
필수 성공 조건이 아니다. 호감을 직접 묻는 새 질문·AI 대화 분석·성격 판정·호감 점수는 없다. 첫 연락·양방향 응답·응답 지연·
중단/재개·나가기를 **서버 사실**(매치·메시지·종료 시각)로 측정한다. 카카오톡 등 외부 연락수단으로 옮기면 앱 대화가 끝날 수
있으므로 무응답·중단·나가기를 곧바로 실패나 비호감으로 해석하지 않는다.

구현: `supabase/migrations/0026_conversation_slots_exit_metrics.sql` (`conversation_pair_metrics(p_as_of)` 함수, 뷰
`conversation_pair_facts` · `conversation_cohorts` · `funnel_user_cohorts` · `funnel_pair_cohorts`), 관리자 `/funnel`.
검증: `supabase/tests/conversation_tests.sql`(고정 시각 경계) · `conversation_metrics_raw_check.sql`(원본 테이블 절차적 재계산 대조).
정책(3개 제한·나가기·재매칭 방지·배포·실기기 절차): `docs/conversation-policy.md`.

## 1. 단위·분모·관찰 기간

| 단위 | 분모 | cohort | 관찰 표기 |
|---|---|---|---|
| 사용자 | 가입 사용자 (demo 제외) | 가입주 (KST 월요일 시작) | `cohort_age_days` = 오늘 − cohort 시작일 |
| 매치 쌍 | 매치 수 (**어느 한쪽이라도 demo 면 제외**) | 매치 생성주 | 〃 · 대화 지표에는 `observing`(1시간 미만) 열이 따로 있다 |

사용자 기준은 "한 번이라도 도달" 이고, 매치 쌍 기준은 매치 하나의 진행이다. 두 값을 섞어 전환율을 만들지 않는다.
관찰 기간이 다른 cohort 를 같은 성과로 단정하지 않는다 — 보고 시 "가입(매치) 후 N일 시점" 을 같이 적는다.
모든 뷰는 service role 전용이며 관리자 화면과 raw query 가 같은 뷰를 읽는다. 조회 실패는 화면에 오류로 표시하고 "데이터 없음" 으로 숨기지 않는다.

## 2. 사용자 퍼널 (`funnel_user_cohorts`)

| 단계 | 기준 |
|---|---|
| 가입 / 온보딩+인증 | `users` 행 / `onboarding_completed and identity_verified and face_verified` |
| **추천 생성** | `recommendations` 행 (서버 생성, status 무관) |
| **추천 확인** | `recommendations.viewed_at` — 앱이 카드를 실제로 그린 시점에 `recommendation_mark_viewed()` 로 멱등 기록. 서버 생성만으로 열람을 단정하지 않는다. 0026 이전 행은 클라이언트 `recommendation_viewed` 이벤트가 있을 때만 최초 시각으로 복원, 없으면 null(**측정 시작 전**) |
| **추천 수락** | `recommendations.status = 'accepted'` (`recommendation_accept()` RPC — 자리 부족이면 수락으로 남지 않는다) |
| 호감 / 매치 / 메시지 보냄 / 양방향 | `likes` / `matches` 참가 / 본인 발신 `messages` 1건 / 참여한 쌍 중 하나라도 양방향 |
| 상호 만남 의향 / 본인 만났음 / 양측 확인 / 피드백 / 재만남 yes / 다음 소개 yes | 기존 정의 유지 (선택적 참고 정보 — 성공 조건 아님) |
| 나가기 경험 | `matches.closed_by = 사용자 and close_kind = 'left'` 인 매치가 하나라도 있음 |

`sustained_7d`(7일 안 2일 이상 대화)는 **핵심 퍼널과 완료 기준에서 제외**됐다 (뷰·관리자·`beta_cohort_stats` 에서 컬럼 제거). 대화 지속은 아래 대화 지표로 본다.

## 3. 대화 행동 지표 (`conversation_pair_metrics(p_as_of)` → `conversation_pair_facts` / `conversation_cohorts`)

계산 입력은 **서버에 저장된 사용자 메시지(`messages`)**, 매치 생성 시각, 종료 시각뿐이다. 시스템 안내·시작 질문 카드는 메시지가 아니라
저장되지 않는다. `p_as_of`(기준 시각)를 고정하면 결과가 결정적이며, 같은 시각의 메시지는 `id` 로 정렬한다. `as_of` 이후의 메시지·종료는 보이지 않는다.

| 지표 | 열 | 정의 |
|---|---|---|
| 관찰 종료 | `observed_until` | `least(closed_at, as_of)`. 0026 이전에 닫혀 종료 시각이 없는 매치는 null (지속시간 지표도 null — 지어내지 않는다) |
| 첫 연락 | `first_message_at`, `first_sender_id`, `first_sender_gender`, `first_contact_seconds` | 매치 생성부터 최초 사용자 메시지까지, 첫 발신자 성별 |
| 첫 연락 분류 | `first_contact_class` | `within_1h`(≤ 1시간, **정확히 1시간 포함**) · `after_1h` · `observing`(메시지 없음 + 매치 후 1시간 미만 — 실패로 세지 않는다) · `not_started`(메시지 없음 + 1시간 이상) · `closed_early`(메시지 없이 **1시간 전** 종료) |
| 상대 첫 답장 | `first_reply_at`, `first_reply_wait_seconds`, `first_reply_status` | 최초 발신자에 대한 상대의 첫 메시지. `replied` / `waiting`(활성, 대기 = as_of − 첫 메시지) / `no_reply_closed`(답장 없이 종료, 대기 = 종료 시각 − 첫 메시지 — **종료를 답장으로 세지 않는다**) |
| 양방향 | `two_way` | 양쪽 모두 메시지를 보냈다 |
| 응답 대기 | `max_completed_wait_seconds`, `_a`, `_b`, `_male`, `_female` | 발신자가 바뀌는 첫 메시지(run 시작)부터 상대의 다음 메시지까지. **같은 사람의 연속 발신은 시작 시각을 바꾸지 않는다** (A 13시 → A 15시 → B 18시 = 5시간). 쌍 전체·user_a/user_b·대기한 사람의 성별별 최댓값 |
| 진행 중 대기 | `open_wait_seconds`, `open_wait_by`, `open_wait_status` | 마지막 run(아직 답장 없음). `ongoing`(활성) / `ended_by_close`(종료 시점에서 멈춤) / `none`(메시지 없음). 완료된 대기와 구분한다 |
| 24시간 중단 | `last_message_at`, `silence_seconds`, `stall_24h_reached`, `stall_24h_at`, `stall_started_hours_after_match`, `stalled_now` | 마지막 메시지 이후 **양쪽 모두** 새 메시지가 없는 시간. **정확히 24시간부터** 24시간 이상. `stall_24h_at` = 마지막 메시지 + 24h. `stalled_now` 는 활성 매치만. 첫 메시지가 없는 매치는 중단이 아니라 미시작이다. 상대 응답 대기와 다른 지표다 |
| 중단 후 재개 | `resumed_after_24h_count`, `last_resumed_at` | 24시간 이상 간격 뒤에 온 메시지 수와 마지막 시각. 원본 시각을 보존해 재개·종료 순서를 잃지 않는다 |
| 명시적 종료 | `closed`, `closed_at`, `close_time_known`, `closed_by`, `close_kind`, `exit_reason`, `close_stage`, `close_hours_after_match` | `close_kind`: `left`(나가기) · `blocked` · `account`(탈퇴/익명화) · `admin`(제재) · `unknown`(0026 이전). `close_stage`: `before_first_message` / `before_first_reply` / `after_two_way`. `exit_reason` 은 나간 사람의 선택 응답(null = 응답 안 함) — 집계에만 쓰고 개인별로 보지 않는다 |
| 참고 | `meetup_state` | 기존 만남 상태 (선택 정보) |

**24시간 이상 표시**: 관리자 화면은 완료된 최장 대기를 `1시간 미만 / 1~24시간 / 24시간 이상` 구간으로만 보여 주고, 진행 중 대기·중단도 "24시간 이상" 으로 통일한다. 원본 초 값은 뷰에 그대로 남는다.

### cohort 집계 열 (`conversation_cohorts`, 매치주, demo 쌍 제외)

`matched · observing · first_within_1h · first_after_1h · not_started · closed_early · first_sender_male/female · replied · reply_waiting · reply_no_reply_closed · two_way ·
completed_wait_max_under_1h / _1h_to_24h / _24h_plus · male_waited_24h_plus · female_waited_24h_plus · open_wait_24h_plus · stalled_now · resumed_after_24h ·
closed · closed_left/blocked/account/admin/unknown · close_before_first_message / close_before_first_reply / close_after_two_way ·
exit_no_reply / exit_not_a_fit / exit_moved_elsewhere / exit_after_meetup / exit_other / exit_unanswered · met_confirmed`

분모는 열마다 다르다: 첫 연락·종료 열은 매치, 답장 열은 첫 메시지가 있는 매치, 대기 구간은 양방향 매치, 종료 단계는 종료, 나가기 이유는 나가기. 관리자 화면이 같은 규칙으로 %를 낸다.

## 4. 해석 규칙

- 나가기·차단·탈퇴·제재와 24시간 무응답은 **별도 상태**다. 24시간 무응답은 통계 기준일 뿐 자동 종료 조건이 아니다.
- 무응답을 회피형·비호감으로, 지속 대화를 상호 호감으로 확정하지 않는다. 메시지 내용 분석·진정성 점수는 없다.
- 외부 연락수단 이동은 나가기 이유 `moved_elsewhere`(선택 응답)로만 참고한다. 대화 원문에서 연락처를 추출하거나 미응답만으로 추정하지 않는다.
- 관찰 시간이 부족한 사례(`observing`, `cohort_age_days` 작음)를 실패로 세지 않는다. 표본이 적을 때 판단을 보류하는 기준은 운영 결정 사항이다 (#24 6절).
- 실제 만남·재만남 의향·만족도는 기존 선택적 참고 정보다. 두 번째 만남 수집은 하지 않는다.

## 5. 중복·왜곡 방지

- 단계·지표는 행 존재/상태 전환/메시지 행으로 세므로 화면 재방문·요청 재시도·같은 값 재저장이 수치를 늘리지 않는다
  (`send_message` 멱등, `conversation_leave` 는 매치 행 잠금으로 1회, `recommendation_mark_viewed` 는 최초 시각 유지, `recommendation_accept` 재시도는 같은 결과).
- `analytics_events` 는 보조다 (`conversation_left`, `recommendation_accepted` 는 서버가 기록). 퍼널 수치는 뷰만 쓴다.
- 최소 세그먼트(성별·지역·연령대)는 cohort 30명 미만이면 나누지 않는다. 대화 지표의 성별 열은 "첫 발신 성별·대기한 쪽 성별" 집계뿐이며 개인을 식별하지 않는다.

## 6. 검증

| 무엇 | 어떻게 |
|---|---|
| 경계·규칙 (1시간/24시간, 연속 발신, 첫 답장 없음, 진행 중 대기, 조기 종료, 중단 후 재개, 시각 미상 종료, demo 제외) | `supabase/tests/conversation_tests.sql` — 고정 `p_as_of` 로 결정적 |
| 뷰 vs 독립 계산 | `supabase/tests/conversation_metrics_raw_check.sql` — 원본 테이블을 plpgsql 루프로 재계산해 매치별 대조 + 원본 기반 cohort 집계. 로컬 `run_local_check.sh` 가 고정 시각과 `now()` 두 번 실행 |
| 실제 프로젝트 표본 대조 | 베타 시작 후 `conversation-policy.md` 5절 절차대로 raw check 를 실행하고 관리자 `/funnel` 숫자와 대조해 이슈에 기록한다 — **아직 미수행** |
