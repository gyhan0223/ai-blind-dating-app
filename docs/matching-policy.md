# 매칭 정책 — 외모 데이터 없는 기본 조건·가치관 추천 (#40)

MVP(#30)는 **사진 없이 대화로 먼저 알아가는 소개팅**이다. 인증된 사용자에게 하루 한 명을
기본 조건과 설명 가능한 비외모 규칙으로 소개한다. 이 문서는 `supabase/functions/_shared/matching/`
(`MatchingEngine.ts`, `recommend.ts`, `snapshot.ts`)이 실제로 구현한 정책을 적는다.
매칭 정확도나 궁합 확률을 사용자에게 보장하지 않는다.

## 1. 외모 데이터는 계산·조회·설명 어디에도 없다

| 항목 | 상태 |
|---|---|
| `appearance` 차원 · 외모 중요도 | 입력 타입(`types.ts`)과 계산(`MatchingEngine.ts`)에서 제거. 중립값 대입 없음 |
| `appearance_preference_events` | 매칭 로더(`snapshot.ts`)가 읽지 않음. 테이블·기존 행 보존 |
| `face_verifications.feature_vector` | 읽지 않음. 인증 플래그는 `users.face_verified`(서버만 갱신)로만 판단 — 벡터 유무와 무관 |
| `preference_settings.appearance_importance` | 읽지 않음 (컬럼 보존). 값이 1이든 5든 결과 동일 (selftest·DB 테스트로 검증) |
| 새 `recommendations.dimensions` | `{ basis, personality, values, lifestyle, relationship }` — appearance 키 없음 |

얼굴 라이브니스는 인증(실제 사람 확인·중복 가입 방지) 목적이다. 얼굴 임베딩·외모 취향 매칭은 MVP 이후 별도 채택(#8/#9/#10) 전까지 구현하지 않는다.

## 2. 활성 차원과 누락 응답 처리

활성 차원: `personality` / `values` / `lifestyle` / `relationship`.

- 각 차원은 이 **쌍에서 비교 가능한 정보가 있을 때만** 0~1 점수를 갖는다. 없으면 `null`(unavailable).
  - personality: 설문(personality 축) 유사도 · 상대의 자기 키워드가 내 선호 키워드와 겹치는 비율
  - values: 비공개 가치관 축(결혼·자녀 ×2, 소비·종교·이성친구 ×1, 장거리 ×0.5) 유사도
  - lifestyle: 설문(lifestyle 축) 유사도 · 공통 취미 비율 · 같은 광역 지역 코드(1 / 0.4) · 비흡연 선호 충족
  - relationship: 설문(relationship 축) 유사도 · 연락/데이트 빈도·개인 시간 유사도
- 누락 차원은 중립점으로 채우지 않고 평균에서 뺀다. 방향별 기본 점수:

  `base = Σ(유효 차원 점수 × 해당 사용자 중요도) / Σ(유효 차원 중요도)`

- 중요도(1~5)는 `preference_settings` 의 비외모 4개만 쓰고, 미설정·비정상 값은 3 (가중치 기본값이지 응답을 만드는 것이 아니다).
- 실제 0점(예: 가치관이 정반대)은 누락이 아니라 0으로 분모에 포함된다.
- 설문 값·가중치가 NaN/Infinity/범위 밖이면 무시한다. 점수는 항상 유한한 0~1 이다.
- **soft preference 보정**: 나이 범위·연상연하·키 범위·선호 지역은 제외가 아니라 `base` 에 더하는 가감점(±0.02~0.05)이다.
  `score = clamp01(base + adjustment)`. base 가 없으면 보정도 적용하지 않는다.
- 양방향: `total = 조화평균(score_A→B, score_B→A)`. 한쪽만 높은 조합은 내려간다.
- **conditions_only**: 어느 한 방향이라도 유효 차원이 없으면 `total = null`, `basis = 'conditions_only'`.
  필수 조건을 통과했으므로 탈락시키지 않으며, scored 후보 뒤에 tie-break 순서로 소개한다.
  이 후보의 저장 행은 `score_total = null` 이다 — 관측 점수가 아니라 "조건만 통과" 를 뜻한다.

`total` 은 내부 정렬용 숫자다. 앱은 원시 점수·차원을 받지 않으며 어떤 화면에도 표시하지 않는다.

## 3. 필수 조건(Dealbreaker) vs 선호

- 필수 조건(`dealbreakers` 테이블: 나이 범위·키 범위·흡연·음주·지역·결혼 의향·자녀 계획·종교)은 **양방향** 필터다.
  A 의 조건에 B 가 안 맞거나, B 의 조건에 A 가 안 맞으면 추천하지 않는다.
- 선호(`preference_settings`: “비흡연이면 좋겠어요”, 나이·키·지역 선호, 연상연하)는 가감점만 받는다. 선호를 필수로 승격하지 않는다.
- 필수 조건 평가에 필요한 값이 없으면 통과시키지 않는다:
  `marriage_intent` 규칙에 후보의 결혼 의향 응답이 없으면 실패, `children_intent` 규칙에 양쪽 자녀 계획 중 하나라도 없으면 실패.
- 성별 지향 상호 일치는 후보 조회와 엔진 양쪽에서 확인한다.

## 4. 연애 목적 (`profiles.relationship_goal`, 공개)

`serious / marriage_minded / take_it_slow / undecided`. 비공개 `marriage_intent` 와 다른 값이다.
현재 UI 에 "허용 목적 목록" 이 없으므로 목적이 달라도 제외하지 않는다. 같으면 공개 근거(추천 이유·icebreaker)로만 쓴다.
궁합표는 두지 않는다. 목적별 필수 조건이 필요해지면 별도 이슈로 다룬다.

## 5. 인증·계정·안전 필터

요청자와 후보 모두 다음을 만족해야 한다 (`recommend.ts` `accountEligible`, 후보 조회 SQL 에도 동일 조건):

`users.status = 'active'` · `onboarding_completed` · `identity_verified` · `face_verified` · `age_verified`

- `onboarding_completed` 만 믿지 않는다. 플래그는 서버(verify-identity / face_liveness_approve)만 갱신하고 DB 트리거가 클라이언트 변경을 막는다.
- 성인 확인은 `age_verified`(본인확인 결과)다. 출생연도 근사 나이로 대체하지 않는다.
- 얼굴 벡터가 null 이어도 `face_verified=true` 면 통과한다. 벡터가 있다고 인증으로 보지 않는다.
- 제외: 본인 · 양방향 차단 쌍(`blocks`) · **신고 당사자 쌍**(`reports`, 어느 쪽이 신고했든 그 둘 사이만 — 신고만으로 다른 사용자에게까지 전역 제외하지 않는다)
  · 내가 좋아요한 상대 · 매치된 적 있는 상태 무관 상대 · 과거 추천 상대 중 `pending`/`accepted`(영구) 와 최근 30일 안의 `skipped`/`expired`
  (7절 재추천 주기 — 30일이 지난 skipped/expired 상대는 다시 후보가 된다. 예전 문서의 "전체 기간 제외" 는 0017 이전 정책이다).
- 운영 제재(`suspended`/`banned`)와 탈퇴(`deleted`)는 `status` 로 걸러진다. 신고 처리·제재 정책 자체는 #15.
- **동시 대화 3개 제한 (#24, 0026)**: 요청자의 진행 중(active) 매치가 3개면 후보를 훑지 않고 `slots_full`(HTTP 200 `slots_full: true`, 실행 기록 `result='slots_full'`) 로 끝낸다 —
  후보 부족(`exhausted`)과 다른 결과다. 그날은 다시 훑지 않고(`recommendation_run_claim` skip) 자리가 생기면 **다음 날** 소개부터 재개된다. 진행 중 매치가 3개인 후보도 제외한다
  (`DataSource.activeMatchCounts`, 뷰 `conversation_slot_usage`). 수락 시에는 서버 RPC `recommendation_accept` 가 양쪽 자리를 잠금과 함께 다시 확인한다 (`docs/conversation-policy.md`).
- **재매칭 방지**: 매치된 적 있는 상대(상태 무관)는 영구 제외이며, DB 트리거가 종료된 쌍의 좋아요(`already_matched`)와 `closed → active` 재전이를 거부한다.
- **조회 실패 ≠ 데이터 없음**: users/blocks/reports/likes/matches/recommendations/후보 조회가 실패하면 `lookup_failed`(HTTP 500)로 끝내고 추천을 만들지 않는다. 후보 부족은 `exhausted`(HTTP 200) 로 구분한다.

## 6. 오늘 저장된 추천의 재검증

같은 날 다시 요청하면 저장된 추천을 그대로 돌려주기 전에 상대의 현재 상태를 다시 본다.

| 상대 상태 | pending 추천 | accepted/skipped 추천 |
|---|---|---|
| 비활성·미인증·차단 쌍 | `expired` 로 마감, 응답 제외, 오늘 한도에서 제외 → 새 추천 생성 | 응답 제외, 행 보존, 오늘 한도에 포함 |
| 신고 당사자 쌍 | 유지 (신고 ≠ 차단. 다음 추천부터 제외) | 유지 |

기존 매치·채팅·좋아요는 삭제하지 않는다.

## 7. 후보 순회·동점·하루 한 명

- 후보는 `profiles.user_id` 오름차순으로 100명씩 페이지를 돌며, 제외 목록을 뺀 뒤 계정 조건을 한 번 더 확인하고 양방향 계산한다.
  끝까지(최대 500명 평가) 훑은 뒤에야 "후보 없음" 으로 판단한다 — 앞의 N명만 보고 오판하지 않는다.
  상한에 걸리면 `capReached=true` 로 응답·`recommendation_runs.cap_reached` 에 기록된다 (#23 — 풀이 500명을 넘는 규모의 정렬·샤딩은 이 값이 실제로 나타날 때 정한다).
- 순위: `scored`(총점 내림차순) → `conditions_only`. 같은 총점·같은 basis 는 `FNV-1a(요청자 id | KST 날짜 | 후보 id)` 오름차순.
  입력 순서와 무관하며, 외모·인기 점수는 쓰지 않는다. 날짜가 바뀌면 순서가 바뀔 수 있어 특정 후보가 영구 고정 우선순위를 갖지 않는다.
- 하루 1명. Plus +1 은 `PLUS_EXTRA_RECOMMENDATION_ENABLED=false` 로 비활성 (#29).
- 후보가 없으면 필수 조건을 완화하지 않는다. 신규끼리 배정 금지·첫 만남 외모 우대(#38)는 없다.
- 재추천 주기 (#23, `RECOMMENDATION_COOLDOWN_DAYS = 30`): 과거 추천 상대 중 `pending`/`accepted` 는 영구 제외(좋아요·매치 이력도 영구 제외),
  `skipped`/`expired` 는 30일이 지나면 다시 후보가 된다 — 좁은 cohort 에서 풀이 마르지 않게 한다. 0017 이 `unique(user_id, candidate_id)` 를
  `(user_id, candidate_id, for_date)` + "같은 쌍의 pending 은 하나" 로 바꿨다.
- 배치 대상(`recommendation_batch_targets`)은 진행 중 매치가 3개인 사용자와 오늘 `slots_full` 로 끝난 사용자를 뺀다 (#24).
- `strategy` 값(`high_confidence`/`exploration`/`fallback`)은 DB check 제약·analytics 호환용 라벨이다:
  scored 총점 ≥0.62 인 1순위 / ≥0.5 / 그 외(conditions_only 포함). 탐색 정책이나 정확도를 뜻하지 않는다.
- **멱등성 (#22)**: `recommendation_run_claim(user_id, KST 날짜)` 가 (사용자, 날짜) 당 한 실행만 코어를 돌린다 (`recommendation_runs` 행 잠금 + lease 90초).
  동시 요청은 `busy` 를 받고 잠시 기다렸다가 저장된 오늘 추천을 읽는다. 실행이 죽으면 lease 만료 후 다른 요청이 다시 맡는다.
  코어의 insert 가 충돌해도 빈 응답 대신 오늘 저장된 행을 다시 읽어 돌려준다. 검증: `recommendation_runs_tests.sql` · `recommendation_claim_concurrency_test.sh` · selftest.
- **후보 부족 재시도 주기 (#23)**: `exhausted` 로 끝난 뒤 1시간 안의 재요청은 후보를 다시 훑지 않고 같은 답을 돌려준다(`skip`, 실행 기록의 `cap_reached` 를 함께 돌려준다).
  앱은 전체 탐색을 끝낸 경우 "오늘은 소개할 분이 없어요 — 필수 조건을 동의 없이 넓히지 않는다" 를, 탐색 상한에 걸린 경우(`cap_reached: true`) "아직 다 살펴보지 못했어요" 를 보여 준다
  (12절). 앱의 "다시 확인" 은 같은 요청을 다시 보낼 뿐이라 이 주기를 우회하지 않는다. 배치도 같은 규칙으로 건너뛴다.

## 8. 추천 이유는 공개된 사실만

`buildReasons()` 는 카드에 이미 공개되는 정보만 근거로 쓴다 (최대 3개):

| 근거 | 문구 |
|---|---|
| 공통 취미 | 공통 관심사가 있어요 |
| 같은 광역 지역 코드 | 같은 지역을 선택했어요 (거리를 단정하지 않는다) |
| 같은 공개 연애 목적 | 연애 목적이 같아요 |
| 공개 질문의 공통 선택지 (허용 코드만) | 쉬는 날 보내는 방식이 겹쳐요 / 함께 해보고 싶은 일이 겹쳐요 / 연애에서 중요하게 생각하는 것이 같아요 |
| 겹치는 자기 키워드 | 스스로 고른 키워드가 겹쳐요 |

- 비공개 응답(설문·가치관)과 차원 점수로는 문구를 만들지 않는다. 공개 프로필이 같으면 비공개 응답이 달라도 이유가 같다.
- 근거가 없으면 `reasons = []`. "잘 맞아요·궁합·성공 확률" 표현은 없다.
- 예전(배포 전) 카드에 남은 문구(`성격의 결이 잘 맞아요`, `…질문에 비슷하게 답했어요`, `가까운 지역에 살고 있어요`, `서로 다른 매력이…`)는
  앱이 표시 단계에서 걸러낸다(`apps/mobile/src/lib/recommendations.ts`). 저장 행은 바꾸지 않는다.

## 9. 배포 전 생성된 추천의 전환

- 배포 전 행의 `score_*`/`dimensions`(appearance 포함)는 과거 계산이며 외모 차원의 영향을 받았을 수 있다. 재계산하지 않는다.
- pending 추천: 보존하되 반환 시 6절 재검증을 거친다. accepted/skipped/매치·채팅·좋아요: 보존.
- 새 계산은 배포 시점 이후 생성되는 추천부터 적용된다. 과거 결과까지 외모와 무관했다고 주장하지 않는다.

## 10. 스케줄러 (#22) — `daily-recommendation-batch`

- service role 로만 호출되는 Edge Function. `recommendation_batch_targets(오늘)` 로 "자격 있고 오늘 추천이 없고 진행 중/최근 exhausted 가 아닌" 사용자를
  id 순으로 최대 `max_users`(기본 100) 명 읽어 사용자별 claim → 코어 → finish 를 돈다. `next_after` 를 돌려주고 다음 호출이 이어간다.
  같은 날 몇 번을 호출해도 새 행이 생기지 않는다. 앱의 `daily-recommendation` 과 같은 잠금을 쓰므로 둘이 겹쳐도 하루 한 명이다.
- 스케줄 등록 예 (Supabase pg_cron + pg_net, service role key 는 Vault 에 두고 SQL 에 직접 쓰지 않는다):

  ```sql
  -- 매일 KST 09:00~09:45 15분 간격 = UTC 00:00~00:45 (한 번에 100명씩, 4회면 400명. 더 크면 간격/횟수 조정)
  select cron.schedule('daily-recommendation-batch', '*/15 0 * * *', $$
    select net.http_post(
      url := 'https://<project-ref>.supabase.co/functions/v1/daily-recommendation-batch',
      headers := jsonb_build_object('Content-Type', 'application/json',
                                    'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
      body := '{"max_users": 100}'::jsonb);
  $$);
  select cron.schedule('recommendation-runs-prune', '0 18 * * *', $$ select public.recommendation_runs_prune(interval '30 days') $$);
  ```
- 배치가 아직 안 돌았어도 앱을 열면 `daily-recommendation` 이 바로 생성한다. 배치는 "아침에 미리 준비" 용이다 (Push 는 #17).
- 배포: `0017_recommendation_runs.sql` → `supabase functions deploy daily-recommendation daily-recommendation-batch` → cron 등록.
  0017 은 `recommendations` 의 unique 제약을 바꾸므로 seed 의 `on conflict (user_id, candidate_id, for_date)` 와 같이 배포한다.
  관측 컬럼·통계 함수(#23)는 `0027_recommendation_observability.sql` — 배포 순서는 12절.

## 11. 선호·프로필 수정의 반영 시점 (#25)

DataSource 는 추천 **생성 시점** 에 `profiles / preference_settings / dealbreakers / private_profiles` 를 읽는다. 사용자가 내 정보에서 조건을 바꾸면 다음 추천 생성부터 반영되고, 이미 만들어진 오늘의 추천은 다시 계산하지 않는다 (앱이 안내 — 홈의 후보 없음 카드에서도 "선호 조건 보기" 로 같은 화면에 간다). 자세한 내용은 `docs/profile-edit.md`.

## 12. 후보 부족 처리와 운영 관측 (#23, 0027)

초기 풀이 작아 추천이 안 만들어져도 필수 조건을 완화하지 않는다. 대신 **왜 안 만들어졌는지** 와 **후보가 몇 명이었는지** 를 실행 기록으로 남기고 운영자가 본다.
외모 점수·얼굴 벡터·LLM 은 관측에도 쓰지 않는다. 엔진의 필터를 통계 쪽에서 복제하지 않는다 — 엔진이 실행 중 본 값을 그대로 기록한다.

### 12.1 실행 결과 (`recommendation_runs`, 사용자·KST 날짜당 1행 = 최종 결과)

| 결과 | 조건 | 기록 |
|---|---|---|
| 새 추천 생성 | `result='ok'` + `recommendation_id` | `eligible_count`(적격 후보 수), `strategy`/`basis`(저장된 추천 행에서 복사) |
| 탐색을 끝냈지만 적격 후보 없음 | `result='exhausted'`, `cap_reached=false` | `eligible_count=0`, `scanned`(평가한 후보 수) |
| 탐색 상한 도달 | `result='exhausted'`, `cap_reached=true` | `eligible_count` 는 훑은 범위 안의 **하한** — 전체 규모가 아니다 |
| 요청자 대화 3개로 중단 | `result='slots_full'` | `eligible_count=null`(훑지 않음) |
| 데이터 조회·처리 오류 | `status='failed'`, `result in ('lookup_failed','error')` | `error_stage`(실패 단계). 0명으로 세지 않는다 |
| 이미 생성된 결과 반환 / 재시도 대기 / 생성 중 | claim `skip` / `busy` — **행을 만들지도 바꾸지도 않는다** | 재방문·재시도·앱과 배치 중첩은 집계에 들어가지 않는다 |

- **적격 후보** = 양방향 필수 조건 · 인증/계정 상태 · 차단/신고 쌍 · 추천(30일 쿨다운)/좋아요/매치 이력 · 상대의 대화 자리(3개)를 모두 통과한 후보 (선택된 상대 포함). `scanned`(제외 목록을 뺀 뒤 평가한 수)와 다르다.
- `strategy`(`high_confidence`/`exploration`/`fallback`)는 DB check·analytics **호환용 내부 라벨**이다 (scored 총점 ≥0.62 인 1순위 / ≥0.5 / 그 외). 매칭 정확도·궁합 확률을 뜻하지 않으며 사용자에게 그런 표현으로 노출하지 않는다.
  `fallback` 도 필수 조건을 통과한 후보(ranked)에서만 나온다. `basis`(`scored`/`conditions_only`)를 함께 기록해 "점수를 계산한 추천" 과 "조건만 통과한 추천" 을 구분한다.
- 0027 이전 실행 기록과 훑지 않은 실행의 `eligible_count` 는 `null` = **미측정**이다. 추정해 채우지 않는다.

### 12.2 전략 분석 이벤트 (`analytics_events.recommendation_created`)

- `recommendations` insert 트리거가 **같은 트랜잭션**에서 1건 기록한다 — 추천 행은 있는데 이벤트만 없는 상태가 생기지 않는다.
- `payload->>'recommendation_id'` 부분 unique 인덱스로 같은 추천에 두 번 기록될 수 없다 (앱 재방문·재시도·앱과 배치 중첩은 애초에 추천 행을 두 번 만들지 못한다: `recommendation_run_claim` + `(user_id, candidate_id, for_date)` unique).
- payload: `recommendation_id · candidate_id · strategy · basis · for_date · source`. 카드·점수·비공개 응답·얼굴 데이터·연락처·채팅 원문은 없다.
- 과거 행은 저장된 `strategy` 를 그대로 복원했다 (`source='backfill_0027'`, `created_at` = 추천 생성 시각). `dimensions.basis` 가 없는 0015 이전 행은 `basis=null`(미측정).
- 수락·넘김은 기존 `recommendation_accepted`(서버 RPC) / `recommendation_skipped`(앱) 이벤트가 `strategy` 를 갖고 있다. 퍼널 수치는 계속 뷰(행 존재) 기준이며 이벤트는 보조다.

### 12.3 운영자용 후보 규모 통계 (관리자 `/recommendation-pool`)

DB 함수 `recommendation_pool_stats(p_window_days)` · `recommendation_run_stats(p_window_days)` (service role 전용, 일반 사용자 호출 불가). 세그먼트 = **요청자**의 성별 · 지역 코드 · 연령대(5세 구간, `beta_waitlist_summary` 와 같은 계산) + 전체 행. demo 계정은 요청자에서 제외한다.
전체 사용자 쌍을 계산하지 않는다 (O(N²) 없음) — 최근 실행이 남긴 관측치를 집계한다.

**사용자별 최근 실행 기준** (`recommendation_pool_stats`, 단위: 사용자 수, 기간 = 최근 N일(오늘 포함) 안 마지막으로 끝난 실행):

| 열 | 뜻 |
|---|---|
| `eligible_users` | 추천 대상 사용자 — active · 온보딩 · 본인/얼굴/성인 인증 (단순 가입자 수가 아니다) |
| `slots_full_now_users` | 그중 **지금** 진행 중 대화가 3개 이상인 사용자 (현재 상태) |
| `with_candidates_users` / `zero_candidates_users` | 최근 실행이 전체 탐색을 끝냈고 적격 후보 ≥1 / =0 |
| `cap_reached_users` | 최근 실행이 탐색 상한에 걸림 — 전체 규모를 알 수 없다 (0명으로도 N명으로도 세지 않는다) |
| `latest_slots_full_users` | 최근 실행이 대화 3개로 중단 |
| `latest_failed_users` | 최근 실행이 조회·처리 오류 — 0명으로 세지 않는다 |
| `unmeasured_users` | 기간 안 끝난 실행 없음 · 0027 이전 기록 · 훑지 않은 실행(저장된 추천 반환) |
| `eligible_median/min/max` | with/zero 사용자의 **사용자별** 관측치. 후보는 사용자마다 겹치므로 합계는 "서로 다른 전체 후보 인원" 이 아니다 — 합계 열을 두지 않는다 |
| `demo_eligible_accounts` | 추천 자격을 갖춘 demo 계정 수 — 엔진은 demo 를 후보에서 걸러내지 않으므로(seed 의 demo 는 production 에 두지 않는 것이 기존 정책) 0 이 아니면 실제 사용자의 후보 수에 섞일 수 있다 |
| `window_days` · `measured_at` | 집계 기간 · 측정 시각 |

각 사용자는 with / zero / cap / slots_full / failed / unmeasured 중 정확히 하나로 센다 (합이 `eligible_users`).

**기간 내 전체 실행 기준** (`recommendation_run_stats`, 단위: 실행 행 = 사용자·날짜당 최종 결과 / 추천 행): `runs · runs_ok · runs_exhausted_complete · runs_exhausted_cap · runs_slots_full · runs_failed · runs_other`,
`recommendations_created · strategy_high_confidence/exploration/fallback · basis_scored/conditions_only/unmeasured`, `window_from · window_to`. 생성·전략 건수는 저장된 추천 행에서 센다 — HTTP 요청 수가 아니다.

**측정 한계**: 하루에 exhausted → (1시간 뒤) ok 처럼 결과가 바뀌면 같은 행이 덮어써져 최종 결과만 남는다(`attempts` 로 재시도 횟수는 남는다). 최근 실행이 없는 사용자는 후보 규모를 모른다(미측정). 상한 도달 사용자의 후보 수는 하한이다.
익명화된 요청자는 프로필이 없어 세그먼트 집계에서 빠진다. 30명 미만 세그먼트로 결론을 내지 않는다.

### 12.4 홈 대기 화면 (`apps/mobile/src/app/(tabs)/index.tsx`)

| 서버 응답 | 화면 |
|---|---|
| HTTP 5xx / 네트워크 오류 | "추천을 불러오지 못했어요 — 소개할 분이 없다는 뜻은 아니에요" + 다시 시도 (후보 부족 문구로 바꾸지 않는다) |
| `in_progress` | "오늘 소개할 분을 준비하고 있어요" + 다시 확인 |
| `slots_full` | "진행 중인 대화가 3개예요" + 대화 목록 |
| `exhausted` (완전 탐색) | "오늘은 소개할 분이 없어요 — 필수 조건을 동의 없이 넓히지 않는다, 다시 찾는 건 1시간에 한 번" + 다시 확인 + 선호 조건 보기(다음 소개부터 반영) |
| `exhausted` + `cap_reached` | "아직 다 살펴보지 못했어요 — 조건에 맞는 분이 없다고 단정하지 않는다" + 같은 버튼 |
| 오늘 추천을 이미 수락/넘김 | "오늘의 소개를 확인했어요" |

"소개가 준비되면 알려드릴게요" 는 기기 알림 권한이 허용돼 있고 `notification_preferences.daily_recommendation` 이 켜진 경우에만 붙는다. 소개 생성 push 는 기존 outbox 트리거(`recommendations_notify`, dedupe `recommendation:<user>:<date>`)가 하루 1건만 만들며 이번 변경은 추천 insert 경로를 바꾸지 않았다 (push 신규 구축·APNs/EAS 는 #17).

### 12.5 배포 순서 (Windows PowerShell — 한 줄씩, 프로젝트 ref·secret 은 환경변수로)

```powershell
# 0) 로컬 검증 (WSL/Git Bash 의 bash 사용)
cd supabase\tests
bash run_local_check.sh
cd ..\functions\_shared\matching
node --experimental-strip-types selftest.ts
cd ..\..\..\..\apps\admin
npx tsc --noEmit
cd ..\mobile
npx tsc --noEmit
cd ..\..

# 1) DB — 0027 (additive: 컬럼·트리거·통계 함수·finish 시그니처 확장. 기존 추천·매치·채팅 행 보존)
$env:SUPABASE_PROJECT_REF = "<project-ref>"
supabase link --project-ref $env:SUPABASE_PROJECT_REF
supabase db push

# 2) Edge Functions — finish 8인자·cap_reached 응답 (0027 이전 DB 에 배포해도 기본값으로 동작하지만 관측값은 기록되지 않는다)
supabase functions deploy daily-recommendation
supabase functions deploy daily-recommendation-batch

# 3) 관리자 웹 (/recommendation-pool) → 4) 앱 (cap_reached 카드·선호 조건 링크). 새 cron 등록은 없다 (배치 스케줄은 10절 그대로)
```

배포 뒤 확인: `select result, count(*) from recommendation_runs where for_date = (now() at time zone 'Asia/Seoul')::date group by 1` 과 관리자 `/recommendation-pool` 의 전체 행이 같은 그림이면 된다.
`select count(*) from analytics_events where event_type = 'recommendation_created'` 는 `select count(*) from recommendations` 와 같아야 한다.

## 13. 검증

- `supabase/functions/_shared/matching/selftest.ts` — 엔진·코어 단위 (in-memory DataSource). 실패 시 exit 1. #24: 요청자 가득 참 → slotsFull(재훑기·저장 없음), 가득 찬 후보 제외, claim skip(slots_full).
  #23: 후보 0명 / 한쪽 필수 조건 불일치 / 필수 조건 응답 누락 / 적격 1명 / fallback 도 필수 조건 통과 후보만 / 요청자·상대 자리 / 차단·신고·과거 매치 제외 / 30일 경계 /
  조회 실패 ≠ 0명 / 상한 도달 ≠ 완전 탐색 / claim skip·busy 는 finish 없음 / finish 에 적격 수·저장 id·실패 단계.
- `supabase/tests/recommendation_db_test.mjs` — 실제 Postgres(마이그레이션+seed) 위에서 DB → 스냅샷 → 엔진 → 저장 → 카드 반환.
  seed 의 과거 외모 데이터를 지워도 같은 결과, 신규 무외모 사용자 추천, 인증·차단·신고·exhausted, reasons 불변, `recommendation_created` 이벤트 저장 행 기준 1건.
  `run_local_check.sh` 가 함께 실행한다.
- `supabase/tests/recommendation_observability_tests.sql` — 이벤트 1회·DB unique, finish 관측값·5인자 호환, claim skip 의 cap_reached, 풀 통계 분류(demo 제외·미측정·중앙값·전체 행), 실행 통계, 일반 사용자 호출 불가.
- 실제 Didit 인증·실기기·원격 Supabase(PostgREST) 경로는 로컬에서 실행하지 않는다 — 배포 후 확인 대상.
