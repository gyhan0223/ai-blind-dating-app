# 대화 → 상호 만남 의향 → 실제 만남 확인 → 비공개 피드백 (#41)

MVP(#30)의 핵심 흐름: 사용자는 공개 프로필로 상대를 알아보고, 텍스트로 대화하고, 서로 원할 때만 만나고, 만남 후 경험을
비공개로 남긴다. 이 문서는 `supabase/migrations/0016_meetup_flow.sql` · `supabase/functions/icebreaker` ·
`apps/mobile/src/lib/{chat,chatCore,meetup}.ts` 가 실제로 구현한 상태 모델과 데이터 의미를 적는다.
메시지 수·의향·만남을 진정성이나 궁합 점수로 해석하지 않는다.

유지 원칙: 사진·영상통화·얼굴 매칭 없음 · 인증용 라이브니스만 유지 · 하루 한 명 · 질문 사용과 만남을 강요하지 않음 ·
일방의 의향·거절·개인 피드백 비공개 · AI 원문 분석·개인화 학습·결제는 범위 밖.

## 1. 상태 모델 (`matches.meetup_state`)

| 값 | 의미 | 누가 바꾸나 |
|---|---|---|
| `none` | 아직 서로의 의향이 확인되지 않음 (한쪽만 yes 여도 `none`) | — |
| `mutual_interest` | **지금** 둘 다 `yes`. 상대의 가능한 때·지역이 서로에게 보인다. 예약 확정이 아니다 | `handle_meetup_intent` 트리거 (매치 행 잠금) |
| `interest_withdrawn` | 상호 성립 후 한쪽이 의향을 바꿈. 상대 정보는 다시 비공개. `mutual_interest_at`(과거 사실)은 남는다 | 같은 트리거 |
| `met_confirmed` | **양측이 각자** "만났음" 이라고 응답 | `handle_meetup_outcome` 트리거 |
| `completed` | 0016 이전 앱에서 **한쪽이** "만남을 가졌어요" 버튼을 누른 값. 미검증 과거 값 — 양측 확인으로 승격하지 않는다 | (과거 앱) |
| `scheduled` | 과거 값 (앱이 쓴 적 없음). 철회 시 `interest_withdrawn` 으로 갈 수 있다 | (과거) |

보조 컬럼: `mutual_interest_at`(처음 상호 성립 시각, 철회돼도 유지) · `meetup_confirmed_at`(양측 확인 시각) ·
`meetup_completed_at`(과거 앱의 한쪽 완료 시각 — 새 앱 미사용).

클라이언트는 `matches` 를 **업데이트할 수 없다** (0008 의 `matches_update_participant` 정책 제거, 트리거 `guard_match_update` 가
최종 사용자 컨텍스트의 `meetup_*` 변경을 거부). `is_end_user_request()` = `auth.uid() is not null and current_user in ('anon','authenticated')`
— SECURITY DEFINER RPC/트리거 안에서는 false 라 서버 로직만 상태를 바꾼다.

### 사용자별 테이블 (본인 행만 조회, 쓰기는 RPC 만)

| 테이블 | 내용 | 상대에게 |
|---|---|---|
| `meetup_intentions` | `intent` yes / not_yet + 가능한 때·지역 | **둘 다 yes 인 지금**만 상대 행이 보임 (`meetup_intentions_select_mutual`). 철회되면 다시 비공개 |
| `meetup_outcomes` | `outcome` met / not_met + `not_met_reason` canceled / no_show / other | 절대 비공개. 공통 상태(`met_confirmed`) 로만 알 수 있다 |
| `meetup_feedback` | 전체 만족도 1~5 · 재만남 의향 · 다음 소개 이용 의향 (각 yes/no/not_sure/null) · 아쉬웠던 점(선택형 복수) | 제출 여부·내용 모두 비공개 |

`no_show` 는 **사용자 진술**이다. 객관적 판정·제재 근거로 쓰지 않으며 상대에게 보이지 않는다.
미응답(null)은 취소·실패·불만이 아니다. 다음 소개 이용 의향 `no` 는 실패가 아니다 (좋은 관계가 생겨 더 필요 없을 수 있다).
0016 이전 `meetup_feedback` 행(`met_again_intent` yes/no, 외모·대화·가치관 점수, `form_version=1`)은 보존한다. 새 앱은 외모 점수를
받지 않는다 — 외모 불일치는 `concerns` 의 선택 사유로만 수집하고 추천 점수로 바꾸지 않는다.

### 만남 확인 집계 (`meetup_pair_summary` 뷰 — service role 전용)

| `confirmation` | 조건 |
|---|---|
| `unconfirmed` | 양측 모두 미응답 |
| `one_side_met` | 한쪽만 met (다른 쪽 미응답) |
| `one_side_not_met` | 한쪽만 not_met |
| `both_met` | 양측 met → `meetup_state = met_confirmed` |
| `mismatch` | 양측 응답이 met / not_met 으로 다름 |
| `both_not_met` | 양측 not_met |

`no_show_claimed` · `confirmation_disputed`(양측 확인 뒤 한쪽이 응답을 바꿈) · `legacy_unverified_completed` 를 따로 낸다.
양측 확인 뒤 응답이 바뀌어도 `met_confirmed`(과거 사실)는 되돌리지 않고 `confirmation_disputed` 로 표시한다.

## 2. RPC 계약 (모두 `authenticated` 전용, anon 실행 불가)

| RPC | 검증 | 결과 |
|---|---|---|
| `send_message(conv, client_message_id, content)` — SECURITY INVOKER | RLS: `sender = auth.uid()`, `can_chat_in`(활성 매치·양쪽 계정 active·차단 아님) | 같은 (대화, 발신자, client_message_id) 는 한 행. 재시도는 저장된 행 반환. 같은 키+다른 본문 → `message_content_mismatch` |
| `meetup_set_intent(match, intent, dates?, region?)` | 참가자 · 매치 active · 본인/상대 active · 차단 아님 | upsert → 트리거가 상호 전이·이벤트·알림 1회 |
| `meetup_report_outcome(match, outcome, reason?)` | 참가자 · 본인 active · `mutual_interest_at` 있거나 `meetup_state <> none` (앱 내 예약 등록은 요구하지 않음). 매치가 종료/차단돼도 허용 | upsert → 트리거가 양측 met 일 때만 `met_confirmed` |
| `meetup_submit_feedback(match, satisfaction?, met_again?, next_intro?, concerns?)` | 참가자 · 본인 active · **본인** outcome = met (상대 확인 불필요) · 최소 1개 응답. 매치가 종료/차단돼도 허용 | upsert (`form_version=2`) |
| `conversation_access(conv)` | 참가자 | `{can_chat, reason: ok / ended / self_restricted / unavailable / forbidden}` |
| `conversation_leave(match, reason?)` (#24, 0026) | 참가자. 계정 상태 무관 | 매치 행 잠금 → `closed` + `closed_at/closed_by/close_kind='left'` **1회**. 이미 종료면 `already_closed=true` 로 상태 불변. 이유는 `conversation_exits`(본인만) |
| `recommendation_accept(rec)` (#24) | 본인 추천 · 본인 active | 추천 accepted + 좋아요 + (상호면) 매치를 한 트랜잭션으로. `result`: matched / liked / no_slot_self / no_slot_partner / already_matched — 자리 부족이면 아무것도 남지 않는다 |
| `recommendation_mark_viewed(rec)` (#24) | 본인 추천 | `viewed_at` 최초 시각 기록 (멱등) |

`forbidden` 은 존재하지 않는 매치와 타인 매치를 구분하지 않는다 (열거 방지). SECURITY DEFINER 헬퍼 `meetup_mutual_yes` · `is_blocked_pair` 는
참가자가 아닌 호출자에게 항상 false 를 돌려준다 (RLS 정책 안에서는 항상 참가자 컨텍스트).

## 3. 채팅 안정화

- **식별자**: 앱이 작성 시 `client_message_id`(uuid) 를 1회 발급하고 재시도에도 같은 값을 쓴다. 서버 unique 인덱스
  `(conversation_id, sender_id, client_message_id)` + `send_message` 가 원자적으로 처리한다. 메트릭·이벤트·알림은 실제 insert 에만 붙는다.
  같은 본문을 새 식별자로 다시 쓰면 별도 메시지다 (본문·시간으로 중복 제거하지 않는다).
- **화면 상태**: 전송 중(반투명) / 실패(사유별: 네트워크 → 다시 보내기, 차단·권한 → 보낼 수 없음, 본문 불일치) / 저장됨. 실패해도 본문은 남고
  "입력창으로" 로 되돌릴 수 있다.
- **조회**: 최신 50건부터, `(created_at desc, id desc)` cursor 로 과거 추가 조회 (인덱스 `messages_conversation_cursor_idx`). 500건 넘는 대화도 최신부터 본다.
- **병합**: 초기 조회·과거 페이지·Realtime INSERT·낙관적 행을 `mergeMessages` 가 id/client_message_id 로 합친다 (`chatCore.ts`, selftest 32건).
- **누락 복구**: 구독을 먼저 열고 `SUBSCRIBED`(최초·재연결) 마다, 그리고 앱 포그라운드 복귀 시 마지막 서버 행 60초 전부터 다시 읽어 병합한다.
- **캐시 분리**: 계정이 바뀌면 `SessionProvider` 가 React Query 캐시를 비운다 (`queryClient.clear()`). 채널은 화면 언마운트 시 해제된다.
- **차단·정지 반영**: `matches` 가 Realtime publication 에 추가돼 열린 화면이 상태 변경(차단·상호 관심·양측 확인)을 받는다 (RLS 참가자 한정).
  `can_chat_in` 이 양쪽 계정 `active` 를 요구하므로 정지·탈퇴 상대에게는 기존 매치로도 보낼 수 없다. 대화 이력은 삭제하지 않는다
  (차단 후에도 참가자는 이전 메시지를 볼 수 있고, 신고 증거는 서버에 그대로 남는다).
- **나가기·3개 제한 (#24, 0026)**: 진행 중 매치는 사용자당 3개. 한쪽이 나가면 양쪽 모두 종료되고 자리가 돌아온다 (`conversation_leave`). 종료된 대화에는
  `handle_new_message` 가 매치 행을 잠근 뒤 status 를 다시 확인해 저장을 거부한다 (종료·전송 경쟁 포함). 상대에게는 "상대방이 대화를 종료했어요" 만 보이고 이유는
  보이지 않는다. 종료·차단·탈퇴·제재는 `matches.close_kind` 로 구분한다. 정책: `docs/conversation-policy.md`.

## 4. 공개 답변 기반 시작 질문 (`_shared/matching/starterQuestions.ts`)

입력은 `profiles.hobbies` · `profiles.public_answers`(허용 코드만) 뿐이다 — `private_profiles`·설문·인증·메시지 원문은 타입에 없다. LLM 호출 없음.

| basis | 근거 | 예 |
|---|---|---|
| `shared` | 둘 다 고른 선택지 / 공통 취미 | "둘 다 카페 가는 걸 좋아하네요. 카페에 가면 주로 뭘 하세요?" |
| `partner` | 상대만 고른 선택지 (공통점 주장 없음) | "전시·공연을 좋아하신다고 했는데, 최근에 기억에 남는 전시나 공연이 있었나요?" |
| `general` | 근거 부족 | "요즘 쉬는 날에는 어떻게 보내세요?" |

항상 2~3개, 결정적. 사용자가 고르면 **입력창에 들어갈 뿐** 자동 발송하지 않고, 무시하고 바로 대화할 수 있다. 4번째 메시지부터는 카드를 접는다.

**캐시 호환**: `conversations.icebreaker` 는 `{ version: 2, generated_at, questions }` 로 저장한다. 과거 `{ lead, question }` 캐시는 앱(`parseStarterCache`)과
서버 모두 무효로 보고 서버가 v2 로 덮어쓴다 — 0015 이전 비공개 가치관 응답으로 만들어졌을 수 있는 문구는 다시 노출되지 않는다.
`partner` 질문은 요청자 관점이라 캐시된 방향과 다를 수 있는데, 캐시는 "카드가 있다" 는 사실과 첫 요청자 관점만 담고 각 요청자에게는 매번 계산한 결과를 돌려준다.

## 5. 분석 이벤트 (`analytics_events`) — 서버 사실 기준

클라이언트는 대화·만남·피드백 이벤트를 기록하지 않는다. 트리거/RPC 가 실제 저장·상태 전환 시점에만 기록하므로 재시도·화면 재방문·같은 값 재저장은 새 이벤트를 만들지 않는다.

| event_type | 단위 | 언제 | payload |
|---|---|---|---|
| `message_sent` | 사용자 | 메시지가 실제로 insert 될 때 (재시도 제외) | conversation_id, match_id |
| `first_message` | 대화방 | 그 대화방의 첫 메시지 | 〃 |
| `two_way_conversation` | 매치 쌍 (참가자당 1행) | 양쪽 모두 1건 이상 보낸 순간 | 〃 |
| `conversation_resumed` | 사용자 | 6시간 이상 침묵 후 재개 | 〃 |
| `meetup_intent_set` | 사용자 | 의향 최초 저장 또는 **실제 변경** (같은 값 재저장 제외) | match_id, intent |
| `meetup_mutual_interest` | 매치 쌍 (참가자당 1행) | 처음 둘 다 yes | match_id |
| `meetup_mutual_interest_withdrawn` / `_restored` | 쌍 / 쌍 | 상호 후 철회 / 다시 성립 (최초 성립은 다시 세지 않음) | match_id |
| `meetup_outcome_reported` | 사용자 | 만남 결과 최초 응답 또는 실제 변경 | match_id, outcome, not_met_reason |
| `meetup_confirmed_both` | 매치 쌍 (참가자당 1행) | 양측 met 처음 성립 | match_id |
| `meetup_feedback_submitted` / `_changed` | 사용자 | 최초 제출 / 실제 값 변경 (동일 재제출 제외) | match_id |
| `conversation_left` (#24) | 사용자 | 나가기로 매치를 종료한 순간 (1회 — 재시도·상대 호출은 없음). 이유는 payload 에 없다 | match_id |
| `recommendation_accepted` (#24, 서버) | 사용자 | `recommendation_accept` 가 실제로 accepted 로 바꿨을 때 (자리 부족은 기록 없음) | recommendation_id, strategy |

과거 클라이언트 이벤트(`chat_started`, `meetup_interest_yes/not_yet`, `meetup_completed`, `second_date_interest_*`)는 0016 이전 데이터에만 남고
새로 기록되지 않는다. 클라이언트가 보낸 `meetup_completed` 만으로 실제 만남 건수를 확정하지 않는다.

**대화 지속 지표 (#24)**: 예전 `sustained_7d`(7일 안 2일 이상)는 핵심 퍼널에서 제외됐다. 첫 연락·상대 첫 답장·응답 대기·24시간 중단/재개·종료 단계는
`conversation_pair_metrics()` 가 메시지 행에서 계산한다 (`docs/funnel-metrics.md` 3절). 메시지 수·응답 속도는 관찰값이지 진정성 점수가 아니다.

### 집계 쿼리 예 (service role)

```sql
-- 매치 쌍 기준: 상호 관심 → 한쪽 이상 met → 양측 확인 (기간은 matches.created_at 으로 자른다)
select
  count(*) filter (where mutual_interest_at is not null)              as mutual_pairs,
  count(*) filter (where confirmation in ('one_side_met','both_met','mismatch')) as any_met_reported,
  count(*) filter (where confirmation = 'both_met')                    as both_confirmed,
  count(*) filter (where confirmation = 'mismatch')                    as mismatched,
  count(*) filter (where no_show_claimed)                              as no_show_claims,
  count(*) filter (where legacy_unverified_completed)                  as legacy_one_side_completed
from public.meetup_pair_summary
where status in ('active','closed','blocked');

-- 사용자 기준: 추천 받은 사용자 중 양측 확인 만남까지 간 비율
with rec_users as (select distinct user_id from public.recommendations),
met_users as (
  select user_a as user_id from public.matches where meetup_state = 'met_confirmed'
  union select user_b from public.matches where meetup_state = 'met_confirmed')
select (select count(*) from met_users m join rec_users r using (user_id))::numeric
     / nullif((select count(*) from rec_users), 0) as reached_confirmed_meetup_rate;

-- 재만남 의향 / 다음 소개 의향 — 미응답(null)·모르겠음(not_sure)·부정(no) 을 분리
select met_again_intent, next_intro_intent, count(*) from public.meetup_feedback
where form_version = 2 group by 1, 2;

-- 피드백 응답률: 본인이 met 이라고 응답한 사용자 중 피드백 제출
select count(f.id)::numeric / nullif(count(o.id), 0)
from public.meetup_outcomes o
left join public.meetup_feedback f on f.match_id = o.match_id and f.user_id = o.user_id
where o.outcome = 'met';
```

실제 두 번째 만남은 이 범위에서 기록하지 않는다 — 재만남 **의향**(`met_again_intent`)과 혼동하지 않는다.

## 6. 알림 연결 계약 (`notification_events` outbox, #17)

Push 발송(토큰 등록·expo-notifications·deep link)은 **미구현**이다. 서버는 중복 없는 이벤트만 남긴다.

| kind | 생성 | dedupe_key | 수신자 |
|---|---|---|---|
| `new_message` | 메시지 insert 트리거 | `message:<message_id>` | 상대 |
| `mutual_meetup_interest` | 처음 상호 yes 성립 | `match:<match_id>:mutual:<recipient_id>` | 양쪽 각 1건 |

행에는 kind · match_id · conversation_id · recipient 만 있다 (메시지 원문·일방 의향·거절·피드백·비공개 답변 없음). 발송기는
`delivered_at is null` 행을 읽어 보내고 `delivered_at`/`delivery_error` 를 채운다. 수신자 `users.status <> 'active'`, 차단 쌍, 알림 끔 설정은 발송기가 걸러야 한다
(설정 테이블은 #17 범위). Push 본문에는 "새 메시지가 도착했어요" 처럼 원문 없는 문구만 넣는다.

## 7. 개인정보·권한 검증 (`supabase/tests/meetup_flow_tests.sql`, JWT 컨텍스트)

- 제3자: 메시지 조회/전송·의향·결과 RPC·`conversation_access` 모두 거부, `meetup_mutual_yes`/`is_blocked_pair` 직접 호출은 false
- 상대: 일방 yes/not_yet/미응답 비공개 (행 0건, 공통 상태 `none`), 상대의 만남 결과·피드백 행 0건, 철회 후 날짜·지역 다시 비공개
- 클라이언트 직접 쓰기: `meetup_intentions`/`meetup_outcomes`/`meetup_feedback` insert 거부, update 는 0행, `matches.meetup_state/meetup_completed_at/meetup_confirmed_at` 변경 불가
- 차단 직후: 전송·의향 거부, 차단 전 저장된 메시지의 재시도는 저장 행 반환(중복 없음), 본인의 결과·피드백·신고는 가능, 상대 프로필 비공개, 이력 보존
- 정지 상대: `conversation_access` = unavailable, 전송 거부
- 동시성(`meetup_concurrency_test.sh`): 양측 동시 yes → 전이·이벤트·알림 1회 / 같은 키 동시 재시도 → 1행·메트릭 1

## 8. 기존 데이터 호환

| 데이터 | 처리 |
|---|---|
| `messages` 기존 행 | `client_message_id` null 유지. 조회·정렬·병합 그대로 동작 |
| `conversations.icebreaker` 과거 lead/question | 무효 → 서버가 v2 로 덮어씀 |
| `matches.meetup_state = mutual_interest` (0016 이전) | 그대로. `mutual_interest_at` 은 null 이지만 상태값으로 만남 결과 기록 가능 |
| `matches.meetup_state = completed` | 보존 (한쪽 완료·미검증). 대시보드에서 "예전 한쪽 완료" 로 따로 표시. 양측이 각자 met 응답하면 `met_confirmed` 로 바뀐다 |
| `meetup_intentions` 기존 행 | 보존. 새 RPC 가 같은 행을 갱신 |
| `meetup_feedback` 기존 행 | 보존 (`form_version=1`, 외모 점수 컬럼 유지). 새 제출은 `form_version=2` 로 덮어씀 |
| `analytics_events` 과거 클라이언트 이벤트 | 보존, 새로 기록하지 않음 |

## 9. 새로 수집하는 데이터의 목적·삭제

| 데이터 | 목적 | 삭제 |
|---|---|---|
| `messages.client_message_id` | 재시도 중복 방지 | 메시지와 함께 |
| `meetup_outcomes` | 실제 만남 여부(본인 진술) 집계 (#24) | `users(id) on delete cascade` — 계정 hard delete 시 함께 삭제 (#13). 상대에게 비공개 |
| `meetup_feedback` 새 컬럼 | 만남 경험 확인, 개선 판단 (#24). 추천 점수·개인화 학습에 쓰지 않음 (#28 범위 밖) | 〃 |
| `notification_events` | 알림 outbox | 〃. 발송 후 보존 기간은 #17 에서 정한다 (권장: 30일 후 삭제) |
| `analytics_events` 새 이벤트 | 퍼널 측정 | 기존 정책 (user_id `set null`) |
| `conversation_exits` (#24) | 나가기 이유(선택) 집계 — 본인만 조회, 상대 비공개 | `users`/`matches` cascade. 제재·호감 판단에 쓰지 않는다 |
| `matches.closed_at/closed_by/close_kind` (#24) | 종료 사실·지표 | 매치와 함께 |

`delete-account` 는 현재 `status='deleted'` 소프트 삭제다. 그 즉시 `can_chat_in`/`meetup_set_intent` 가 거부하므로 기존 매치로도 연락되지 않는다.
hard delete·익명화 파이프라인(#13)이 구현되면 위 cascade 로 함께 삭제된다.

## 10. 배포 순서

1. **DB**: `0016_meetup_flow.sql` 적용 (additive). 이 시점부터 예전 앱의 `matches` 직접 update(`markMeetupCompleted`)와 `meetup_intentions`/`meetup_feedback` 직접 upsert 는 실패한다 —
   예전 앱은 메시지 전송(직접 insert, 정책 유지)과 조회는 계속 되지만 만남 화면 저장은 안 된다. 앱 배포와 같은 릴리스 창에서 적용한다.
2. **Edge Function**: `supabase functions deploy icebreaker` (v2 캐시 형식 · 공개 필드만 조회 · 과거 캐시 덮어쓰기).
3. **앱**: 새 빌드 배포 (RPC 전송·cursor 조회·재동기화·만남 확인·피드백 v2). 관리자 웹 재배포 (대시보드 지표 의미 변경).
4. 배포 후 확인: `select count(*) from messages where created_at > '<배포 시각>' and client_message_id is null` → 0 (새 앱만 사용 중이면),
   `select meetup_state, count(*) from matches group by 1`, `select * from meetup_pair_summary limit 5`.

## 11. 이 PR 로 끝나지 않는 것

- **#17 Push**: 토큰 등록·발송기·deep link·알림 설정. outbox 계약만 제공 (6절).
- **#15/#16**: 관리자 신고 처리 화면·스팸 방지는 기존 그대로. 이 PR 은 채팅·만남 화면의 신고/차단 진입과 차단 즉시 차단만 다룬다.
- **#24**: 대시보드 전체 개편·cohort 비교는 하지 않았다. 이벤트 정의·집계 뷰·쿼리(5절)를 제공한다.
- **#13**: hard delete 파이프라인. cascade 로 연결만 해 두었다.
- **실기기/원격 검증**: Supabase Realtime 재연결·포그라운드 복귀·PostgREST RPC 경로·두 실기기 E2E 는 로컬에서 실행하지 못했다 (README 검증 절 참고).
