# 대화 운영 정책 — 동시 대화 3개 · 나가기 · 재매칭 방지 (#24)

구현: `supabase/migrations/0026_conversation_slots_exit_metrics.sql`, `supabase/functions/_shared/matching/recommend.ts`,
`apps/mobile/src/lib/{chat,chatCore,recommendations}.ts`, 화면 `apps/mobile/src/app/(tabs)/{index,chats}.tsx` · `chat/[conversationId].tsx`.
지표 정의는 `docs/funnel-metrics.md`. 이 문서는 코드가 실제로 하는 일을 적는다 — 실제 프로젝트 배포·실기기 검증은 6절 절차대로 따로 수행한다.

## 1. 동시 대화 최대 3개

- 진행 중 매치 = `matches.status = 'active'`. **매치 생성 시점부터** 한 자리를 쓴다 (메시지가 없어도). 한도는 `conversation_slot_limit()` = 3 (앱 상수 `CONVERSATION_SLOT_LIMIT` 도 3 — 서버가 최종 강제).
- **서버 강제 지점**
  - `handle_mutual_like` 트리거(매치 생성): 좋아요를 보내는 쪽의 `users` 행을 잠그고 자리를 확인하고(`no_slot_self`), 상호 좋아요면 양쪽 행을 **id 오름차순**으로 잠근 뒤 양쪽 자리를 다시 확인한다(`no_slot_partner`). 직접 `likes` insert(예전 앱)도 같은 트리거를 지난다.
  - `recommendation_accept(rec_id)` RPC(새 앱): 추천 status → accepted, 좋아요, 매치 생성을 **한 트랜잭션**으로. 자리 부족·재매칭 차단은 예외가 아니라 `result` 로 돌려주고 **아무것도 남기지 않는다** (추천은 pending 유지). `result`: `matched` · `liked`(상대 응답 대기) · `no_slot_self` · `no_slot_partner` · `already_matched`. 재시도는 같은 결과.
  - `guard_recommendation_decision`(예전 앱의 직접 status 변경): 가득 찼으면 accepted 전이를 거부.
  - 추천 생성(`recommend.ts`): 요청자가 가득 차면 `slotsFull` — 후보를 훑지 않고 실행 기록 `result='slots_full'`. **그날은 다시 훑지 않는다** (`recommendation_run_claim` 이 skip). 자리가 생기면 **다음 날 소개부터** 재개된다 — 나가기마다 추가 소개를 주지 않고, 중단 기간의 소개를 쌓아 두지 않는다. 가득 찬 후보는 제외한다. 배치 대상(`recommendation_batch_targets`)도 가득 찬 사용자를 뺀다.
- 오늘 이미 저장된 추천은 가득 차도 그대로 돌려준다 (수락 시 RPC 가 자리를 다시 본다). 상대가 가득 차 `no_slot_partner` 면 추천은 pending 으로 남아 오늘 다시 시도하거나 넘길 수 있다 — 상대의 거절로 집계하지 않는다.
- 동시 수락: 같은 사용자 행 잠금으로 직렬화된다. `conversation_concurrency_test.sh` 가 "빈자리 1개에 두 명 동시 수락 → 매치 1개 + `no_slot_partner`" 를 검증한다.
- 화면: 홈은 `slots_full` 이면 "진행 중인 대화가 3개예요 — 대화를 하나 종료하면 다음 소개부터 다시 시작돼요" 와 대화 목록 이동 버튼. 대화 목록은 **내** 개수만 `N/3` 으로 보여 준다. 상대의 대화 개수는 어디에도 노출하지 않는다.
- **기존 초과 계정**: 배포 전에 3개를 넘는 계정이 있는지 `select * from public.conversation_slot_overflow` 로 확인한다. 기존 대화를 임의로 종료하거나 삭제하지 않는다 — 초과 계정은 새 매치만 막히고(수락 시 `no_slot_self`, 소개 중단), 스스로 나가기로 3개 이하가 되면 재개된다. 운영자가 안내 메시지를 보낼지는 운영 결정.

## 2. 나가기 (종료)

- 앱: 대화 메뉴 → "대화 나가기" → 확인창 **"대화를 종료하면 다시 메시지를 보낼 수 없어요"** → (선택) 이유 → 종료. 이유 없이 "응답하지 않고 종료하기" 가능.
- 서버 `conversation_leave(match_id, reason?)`: 참가자만. 매치 행 `for update` → `status='closed'`, `closed_at`, `closed_by`, `close_kind='left'`, `analytics_events.conversation_left` 1건. 이미 종료된 매치(재시도·양쪽 동시·차단 뒤)는 상태를 바꾸지 않고 `already_closed=true` 를 돌려준다 — 종료·이벤트는 **한 번만**. 계정 상태와 무관하게 허용.
- 이유는 `conversation_exits(match_id, user_id, reason)` 에 저장하고 **본인만 select** 할 수 있다. `matches` 행에는 이유 컬럼이 없으므로 Realtime `matches` UPDATE payload 에도 없다. 상대는 `closed_by`·`close_kind` 로 "상대방이 대화를 종료했어요" 만 본다. 차단·탈퇴·제재 종료는 `closed_by=null` (누가 차단했는지 드러내지 않는다).
  - 이유 값: `no_reply` 답장이 없어요 · `not_a_fit` 대화가 잘 맞지 않아요 · `moved_elsewhere` 이미 다른 연락수단으로 연락하고 있어요 · `after_meetup` 만남 이후 종료하고 싶어요 · `other` 기타 · null 응답하지 않기.
- 종료 뒤 전송: RLS(`can_chat_in`)가 막고, 경쟁 상황(종료 커밋 직전 전송)은 `handle_new_message` 트리거가 매치 행을 잠근 뒤 `status` 를 다시 확인해 `conversation_closed` 로 거부한다 (서버 직접 insert 도 동일). 검증: `conversation_concurrency_test.sh` 3번.
- 종료 뒤에도 남는 것: 이전 메시지 열람(참가자), 신고(`reports`), 기존 선택적 만남 결과·피드백(`meetup_report_outcome` / `meetup_submit_feedback` 은 종료 매치도 허용). 종료된 상대의 프로필은 기존 RLS 대로 보이지 않으므로 목록에는 "종료된 대화 상대" 로 표시된다.
- 24시간 무응답으로 자동 종료하지 않는다. 나가기는 신고·제재와 구분된다 (제재는 `close_kind='admin'`).
- 종료된 대화는 진행 중 목록·3개 제한에서 빠지고, 목록의 "종료된 대화" 섹션에 접혀 있다.

## 3. 재매칭 방지

- `matches` 의 `unique(user_a, user_b)` 와 종료 행 보존이 기본이다. 종료 기록을 지우지 않는다.
- `handle_mutual_like`: 종료된(closed/blocked) 매치가 있는 쌍의 좋아요는 `already_matched` 로 거부한다 (익명화로 `likes` 가 지워진 뒤 재가입해도 매치 행이 남아 있으면 막힌다). 활성 매치가 있는 쌍의 중복 좋아요는 무시된다.
- `guard_match_lifecycle`(BEFORE UPDATE, 모든 역할): `closed/blocked → active` 전이는 `match_reopen_forbidden` 으로 거부. 최종 사용자는 `matches` 를 update 할 수 없다 (정책 없음 + `guard_match_update`).
- 추천 엔진은 `matchedUserIds`(상태 무관)를 영구 제외한다 (#40).
- **탈퇴/삭제와의 관계·한계**: 익명화(`account_purge`)는 매치 행을 남기고(closed) 메시지 본문만 자리표시로 바꾸므로, 같은 `users.id` 로 복구·재온보딩하면 재매칭이 계속 막힌다. **완전 삭제(hard, auth 계정 삭제)** 는 cascade 로 매치 행까지 지우므로 새 계정으로 재가입하면 과거 상대와 다시 매칭될 수 있다 — 본인확인 해시(`user_identities`)로 동일인을 알 수는 있지만 매칭 이력은 남지 않는다. 이를 막으려면 익명 쌍 해시 테이블을 무기한 보관해야 하는데, 새 개인정보를 무기한 저장하지 않는다는 기존 정책과 충돌하므로 **이번 범위에서는 하지 않는다** (별도 결정 필요). 유예 기간(30일) 안의 복구는 같은 계정이라 막힌다.

## 4. 데이터·권한

| 새 데이터 | 목적 | 접근 | 삭제 |
|---|---|---|---|
| `matches.closed_at / closed_by / close_kind` | 종료 사실·지표 | 참가자 select (기존 정책) | 매치와 함께 |
| `conversation_exits` | 나가기 이유(선택) 집계 | 본인 select 만. 쓰기는 RPC | `users`/`matches` cascade, hard delete 시 삭제 |
| `recommendations.viewed_at` | 추천 생성/확인 구분 | 본인 select. 쓰기는 `recommendation_mark_viewed` | 추천과 함께 |
| 뷰 `conversation_slot_usage` / `conversation_slot_overflow` / `conversation_pair_facts` / `conversation_cohorts` | 서버·운영 | service role 전용 | — |

`security_tests.sql` 의 SECURITY DEFINER allowlist 에 `conversation_leave` · `recommendation_accept` · `recommendation_mark_viewed` 가 추가됐다. 뷰는 모두 클라이언트 비공개 (`conversation_tests.sql` 4절).

## 5. 배포 순서와 구버전 호환

1. **DB**: `0026_conversation_slots_exit_metrics.sql` 적용 (0025 까지 적용된 뒤). 배포 직전 `select * from public.conversation_slot_overflow` 로 초과 계정을 확인해 둔다 (1절).
2. **Edge Functions 재배포**: `daily-recommendation`, `daily-recommendation-batch` (요청자·후보 자리 확인, `slots_full` 응답/집계). 다른 함수는 변경 없음.
3. **관리자 웹** 재배포 (`/funnel` 대화 지표·`/beta` 열 변경 — `sustained_7d` 컬럼이 사라져 예전 관리자 빌드는 그 열이 비어 보인다, 오류는 아님).
4. **앱** 새 빌드 (수락 RPC, 자리 안내, 나가기, 종료 목록, 열람 기록).

구버전 앱 호환 위험 (0026 적용 후, 새 앱 배포 전):
- 예전 앱은 추천 수락을 "status update → likes insert" 두 요청으로 한다. 본인 자리가 없으면 첫 요청(status)이 `no_slot_self` 로 실패해 아무것도 바뀌지 않는다. **상대** 자리가 없으면 status 는 accepted 로 바뀐 뒤 likes insert 가 `no_slot_partner` 로 실패해 "수락됐지만 좋아요 없음" 행이 남을 수 있다. 확인: `select id from recommendations r where status='accepted' and not exists (select 1 from likes l where l.from_user_id=r.user_id and l.to_user_id=r.candidate_id)`. 새 앱에서는 발생하지 않는다 (RPC 원자성).
- 예전 앱에는 나가기·종료 안내가 없어 상대가 나간 대화가 "보낼 수 없어요(ended)" 로만 보인다. 3개 제한은 서버가 강제하므로 예전 앱도 초과할 수 없고, 가득 찬 사용자는 홈에서 "오늘의 소개를 확인했어요/없어요" 류 문구를 본다 (`slots_full` 을 모름).
- `recommendation_mark_viewed` 를 호출하지 않으므로 예전 앱 사용자의 "추천 확인" 은 기록되지 않는다 (측정 시작 전과 같은 상태).

## 6. 검증 절차 (Windows PowerShell)

로컬(도커 없는 Postgres 16 가정). 각 줄을 따로 실행한다.

```powershell
cd supabase\tests
$env:DB_NAME = "blind_dating_check"
bash run_local_check.sh          # WSL/Git Bash. conversation_tests.sql · conversation_concurrency_test.sh · conversation_metrics_raw_check.sql 포함
cd ..\functions\_shared\matching
node --experimental-strip-types selftest.ts
cd ..\..\..\..\apps\mobile
node --experimental-strip-types scripts/chat-core-selftest.mjs
npx tsc --noEmit
cd ..\admin
npx tsc --noEmit
```

실제 프로젝트 배포 뒤 (service role · SQL Editor 또는 psql):

```powershell
$env:DATABASE_URL = "<production or staging connection string>"
psql $env:DATABASE_URL -c "select * from public.conversation_slot_overflow"
psql $env:DATABASE_URL -v as_of="now()" -f supabase\tests\conversation_metrics_raw_check.sql
psql $env:DATABASE_URL -c "select * from public.conversation_cohorts order by cohort_week desc limit 5"
```

`conversation_metrics_raw_check.sql` 은 뷰(`conversation_pair_metrics`)와 원본 테이블 절차적 재계산을 매치별로 대조하고 마지막에 `compared / mismatches` 를 낸다.
`mismatches` 가 0 이고, 그 아래 원본 기반 cohort 집계(`first_within_1h_raw`, `two_way_raw`, `closed_left_raw`)가 관리자 `/funnel` 의 같은 열과 같으면 통과다.
결과 표를 그대로 이슈 #24 에 남긴다. **실행하지 않은 검증은 통과로 적지 않는다.**

### 실기기 확인 (두 대, staging)

테스트 계정: production 인증 우회를 켜지 않는다. staging 에서 `docs/environments.md` 의 개발 로그인(Test OTP 또는 dev-login, 010-0000-00XX)으로 남 1 · 여 4 계정을 만들고 온보딩을 끝낸다.
서로 추천되게 하려면 staging DB 에 service role 로 `recommendations` 행을 넣거나 `daily-recommendation` 을 호출한다.

1. 남 A 가 여 B·C·D 와 순서대로 상호 수락 → 대화 목록에 `진행 중 3/3` 과 안내 문구. 홈 → "진행 중인 대화가 3개예요".
2. A 에게 여 E 추천(pending)이 있는 상태에서 수락 → 카드가 남고 "진행 중인 대화가 3개예요…" 안내 (no_slot_self). `recommendations` 는 pending, `likes` 없음.
3. A 가 B 와의 대화에서 나가기: 확인창 문구 → 이유 선택/미선택 → 종료. B 기기: 열려 있던 채팅 화면 하단이 "상대방이 대화를 종료했어요. 이전 대화는…" 로 바뀌고 목록의 "종료된 대화" 로 이동. B 의 `conversation_exits` 조회는 0행 (Supabase 대시보드 → RLS 확인은 SQL Editor `set role authenticated; select set_config('request.jwt.claim.sub','<B uuid>',false); select * from conversation_exits;`).
4. B 가 종료된 대화에서 전송 시도 → "보낼 수 없어요". 신고 화면은 열린다.
5. A 가 E 를 다시 수락 → 매치. 같은 날 A 의 홈은 새 소개를 만들지 않는다 (`recommendation_runs.result='slots_full'` 였다면 내일부터).
6. B 와 A 가 서로 다시 추천되지 않는다 (`daily-recommendation` 을 여러 번 호출해도). service role 로 `insert into likes (B→A)` 를 넣으면 `already_matched`.
7. 관리자 `/funnel`: 사용자 표에 추천 생성/확인/수락 열, 대화 행동 표에 위 시나리오가 반영되는지 (관찰 중 → 1시간 내 첫 연락 등), `/beta` 표에 7일 지속 열이 없는지.

**아직 미수행**: 실기기 두 대·Realtime 경로·원격 PostgREST RPC 호출은 로컬에서 실행하지 못했다. 위 절차를 수행한 뒤 결과를 #24 에 기록한다.

## 7. 운영 결정 사항 (이 구현이 정하지 않은 것)

- 모집 지역·연령·인원·모집 기간, 집단 비교 관찰 기간과 보고 시점, 표본 부족·관찰 중일 때의 판단 보류 기준 (#24 6절).
- 기존 3개 초과 계정에 대한 안내 여부.
- 자리가 생긴 날 같은 날 소개를 재개할지 (현재: 다음 날부터 — 나가기마다 추가 소개를 주지 않기 위한 보수적 선택).
