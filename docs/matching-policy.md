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
  · 내가 좋아요한 상대 · 매치된 적 있는 상대(상태 무관) · 과거에 추천된 적 있는 상대(전체 기간).
- 운영 제재(`suspended`/`banned`)와 탈퇴(`deleted`)는 `status` 로 걸러진다. 신고 처리·제재 정책 자체는 #15.
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
  끝까지(최대 500명 평가) 훑은 뒤에야 "후보 없음" 으로 판단한다 — 앞의 N명만 보고 오판하지 않는다. 그 이상 규모의 풀 정책은 #23.
- 순위: `scored`(총점 내림차순) → `conditions_only`. 같은 총점·같은 basis 는 `FNV-1a(요청자 id | KST 날짜 | 후보 id)` 오름차순.
  입력 순서와 무관하며, 외모·인기 점수는 쓰지 않는다. 날짜가 바뀌면 순서가 바뀔 수 있어 특정 후보가 영구 고정 우선순위를 갖지 않는다.
- 하루 1명. Plus +1 은 `PLUS_EXTRA_RECOMMENDATION_ENABLED=false` 로 비활성 (#29).
- 후보가 없으면 필수 조건을 완화하지 않는다. 신규끼리 배정 금지·첫 만남 외모 우대(#38)는 없다.
- 재추천 제외는 "과거에 추천된 적 있는 상대 전체 기간" 이다. 재추천 주기·대기 정책은 #23.
- `strategy` 값(`high_confidence`/`exploration`/`fallback`)은 DB check 제약·analytics 호환용 라벨이다:
  scored 총점 ≥0.62 인 1순위 / ≥0.5 / 그 외(conditions_only 포함). 탐색 정책이나 정확도를 뜻하지 않는다.
- **알려진 한계 (#22)**: 같은 사용자의 동시 요청이 각각 "오늘 추천 없음" 을 보고 서로 다른 후보를 저장하면 하루 한 명이 깨질 수 있다.
  `unique(user_id, candidate_id)` 는 같은 후보 중복만 막는다. 스케줄러·멱등 키는 #22 에서 처리한다.

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

## 10. 검증

- `supabase/functions/_shared/matching/selftest.ts` — 엔진·코어 단위 (in-memory DataSource). 실패 시 exit 1.
- `supabase/tests/recommendation_db_test.mjs` — 실제 Postgres(마이그레이션+seed) 위에서 DB → 스냅샷 → 엔진 → 저장 → 카드 반환.
  seed 의 과거 외모 데이터를 지워도 같은 결과, 신규 무외모 사용자 추천, 인증·차단·신고·exhausted, reasons 불변.
  `run_local_check.sh` 가 함께 실행한다.
- 실제 Didit 인증·실기기·원격 Supabase(PostgREST) 경로는 로컬에서 실행하지 않는다 — 배포 후 확인 대상.
