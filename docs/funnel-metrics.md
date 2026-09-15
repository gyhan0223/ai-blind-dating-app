# 퍼널 정의 (#24) — 사진 없는 대화 → 실제 만남 → 재만남 의향

핵심 가설: **사진 없이 알아간 상대에게 호감이 생기고, 실제 만남과 재만남 의향으로 이어지는가.**
모든 단계는 서버 사실(행 존재·상태 전환)로 센다. 클라이언트가 보낸 이벤트만으로 단계를 확정하지 않는다.
뷰 `funnel_user_cohorts` · `funnel_pair_cohorts` (0022, service role) 를 관리자 `/funnel` 과 raw query 가 같이 읽는다.

## 1. 단위와 분모

| 단위 | 분모 | cohort |
|---|---|---|
| 사용자 | 가입 사용자 (demo 제외) | 가입주 (KST 월요일 시작) |
| 매치 쌍 | 매치 수 | 매치 생성주 |

사용자 기준은 "한 번이라도 도달" 이다 (여러 매치 중 하나라도). 매치 쌍 기준은 매치 하나의 진행이다. 두 값을 섞어 전환율을 만들지 않는다.

## 2. 단계 정의

| 단계 | 사용자 기준 | 매치 쌍 기준 | 근거 데이터 |
|---|---|---|---|
| 가입 | `users` 행 | — | |
| 온보딩+인증 | `onboarding_completed and identity_verified and face_verified` | — | |
| 추천 받음 | `recommendations` 행 (status 무관) | — | 서버 생성 |
| 호감 | `likes` 행 | — | |
| 매치 | `matches` 참가 | `matches` 행 | 트리거 |
| 첫 메시지 | 본인이 보낸 `messages` 1건 | `conversation_metrics.first_message_at` | 트리거 (재시도 중복 없음) |
| 양방향 대화 | 참여한 쌍 중 하나라도 양방향 | `messages_a > 0 and messages_b > 0` | |
| 지속 | 〃 | 매치 후 7일 안에 양방향 + `active_days >= 2` | **관찰 기준**이지 진정성 점수가 아니다 |
| 상호 만남 의향 | 〃 | `mutual_interest_at` 또는 과거 상태값 | 한쪽 yes 는 세지 않는다 |
| 본인 만났음 | `meetup_outcomes.outcome='met'` | 한쪽 이상 met (`one_side_met`) | 진술 |
| 양측 확인 | `meetup_state='met_confirmed'` 매치 참여 | `met_confirmed` | legacy `completed` 는 별도 열 |
| 피드백 | `meetup_feedback` 행 | 1건 이상 / 건수 | |
| 재만남 의향 | `met_again_intent='yes'` | 한쪽 이상 yes / 양측 yes | `no`·`not_sure`·null 을 분리 |
| 다음 소개 의향 | `next_intro_intent='yes'` | 한쪽 이상 yes | `no` 는 실패가 아니다 |

## 3. 주 지표와 함께 볼 지표

- **주 지표**: 추천 받은 사용자 중 양측 확인 만남까지 간 비율 = `both_confirmed / got_recommendation` (사용자 cohort).
  관찰 기간: 가입 후 4주 (cohort 열은 시간이 지나며 늘어난다 — 보고 시 "가입 후 N주 시점" 을 적는다).
- 함께: `two_way / matched`, `sustained_7d / two_way`, `mutual_interest / two_way`, `both_confirmed / mutual_interest`, `met_again_any_yes / both_confirmed`, 피드백 응답률 `feedback_any / one_side_met`.
- 분리해서 보는 것: 한쪽 응답 vs 양측 확인, 취소/노쇼(`meetup_pair_summary.confirmation`, `no_show_claimed`), 미응답(피드백 없음 ≠ 부정).
- 실제 두 번째 만남은 기록하지 않는다 (재만남 **의향**만). 두 번째 만남 기록은 별도 기능이 생길 때 별도 지표로.

## 4. 어디서 끊기는지 판단

| 끊기는 곳 | 해석·다음 개발 |
|---|---|
| 추천 → 호감 / 매치 | 추천 품질·카드 소개 문장 (#23/#25) |
| 매치 → 첫 메시지 / 양방향 | 시작 질문·프로필 소재 (#41) |
| 양방향 → 상호 의향 | 대화 흐름·만남 제안 UX |
| 상호 의향 → 양측 확인 | 일정 조율·안전감 (공공장소 안내) |
| 양측 확인 → 재만남 yes | 피드백 `concerns` 분포 (외모 취향 차이 반복이면 #8/#9/#10 재검토 — 단, 작은 표본으로 단정하지 않는다) |

## 5. 중복·왜곡 방지

- 단계는 행 존재/상태 전환으로 세므로 화면 재방문·재시도·재저장이 수치를 늘리지 않는다 (#41: `first_message`·`meetup_mutual_interest` 등 서버 이벤트도 1회).
- `analytics_events` 는 보조다 (시간순 분석용). 퍼널 수치는 뷰만 쓴다.
- 최소 세그먼트(성별·지역·연령대)는 개인 식별 위험이 있어 cohort 가 30명 미만이면 세그먼트를 나누지 않는다.

## 6. 검증

`supabase/tests/funnel_tests.sql` — 양방향·상호 의향·양측 확인·피드백 yes/no 카운트, legacy completed 분리, 미응답 미집계, 클라이언트 읽기 불가.
대시보드 수치와 raw query 표본 대조는 실제 프로젝트 데이터로 베타 시작 후 수행한다 (#24 완료 조건 중 남는 항목).
