# 온보딩 후 프로필 · 선호 조건 · Dealbreaker · 가치관 수정 (#25)

마이그레이션 `0024_profile_edit.sql` · 테스트 `supabase/tests/profile_edit_tests.sql` · 순수 로직 `apps/mobile/src/lib/preferencesCore.ts` (selftest `npm run preferences:selftest`).

## 1. 화면 (내 정보 → )

| 화면 | 라우트 | 저장 | 공개 여부 |
|---|---|---|---|
| 소개 수정 (연애 목적 · 공개 질문 선택) | `settings/intro` | `profiles` update | 상대에게 공개 |
| 기본 정보 수정 (닉네임 · 만나고 싶은 상대 · 지역 · 키 · 직업 · 흡연 · 음주 · 선택 항목) | `settings/profile` | `profiles` update | 카드 항목만 공개 |
| 선호 조건 · Dealbreaker · 중요도 | `settings/preferences` | RPC `preferences_save` | 비공개 (소개 기준) |
| 가치관 다시 답하기 (+ 지난 연애 선택 응답·공개 여부) | `settings/values` | `private_profiles` upsert | 비공개 |

온보딩 화면(`onboarding/profile · intro · values · preferences`)과 수정 화면은 같은 폼 컴포넌트(`components/forms/*`)를 쓴다 — 항목·검증 규칙이 한 곳에 있다.
설문(성격 1~5 문항 26개)은 다시 받지 않는다 — 민감 재응답은 가치관 화면의 선택 항목으로 한정.

## 2. 사용자가 바꿀 수 없는 것 (서버 검증)

| 항목 | 규칙 | 구현 |
|---|---|---|
| 성별 · 출생연도 | 본인확인 결과(`user_identities.birth_date/gender`)와 같아야 한다. 온보딩 완료 뒤에는 변경 불가 | 트리거 `profiles_guard_protected` (INVOKER) + 헬퍼 `identity_facts_self()` (본인 값만) |
| 프로필 소유자 | `user_id` 변경 불가 | 같은 트리거 |
| 인증 플래그 · 상태 · 베타 입장 | 서버만 | 0001 · 0025 트리거 |
| 외모 중요도 | 입력받지 않음 (#39) | `preferences_save` 허용 키에 없음 → 거부 |

앱은 본인확인 결과를 `identity_facts_self()` 로 읽어 온보딩 기본 정보 화면에서 출생연도·성별을 채우고 잠근다 (Mock provider 로 값이 없으면 입력받는다). 정정이 필요하면 운영자가 서버에서 고친다.

## 3. 원자성 — `preferences_save(p_settings, p_dealbreakers)`

- SECURITY INVOKER (RLS 로 본인 행만). 한 트랜잭션: 설정 upsert(넘긴 키만 덮어씀) → Dealbreaker 전체 동기화(넘긴 종류 upsert, 나머지 삭제).
- 허용 키 밖·잘못된 Dealbreaker 종류·제약 위반(나이 역전 등) 이면 **아무것도 저장되지 않는다** (테스트: 부분 저장 없음).
- 이전에는 앱이 설정 upsert → Dealbreaker upsert → 삭제를 세 번 호출해 중간 실패 시 반쯤 바뀔 수 있었다.
- 수정 화면은 바뀐 게 없으면 서버를 부르지 않는다 (`preferencesEqual`).

## 4. 반영 시점

추천 엔진(#40 DataSource)은 **생성 시점** 에 `profiles / preference_settings / dealbreakers / private_profiles` 를 읽는다. 따라서 수정값은 다음 추천 생성부터 반영되고, 오늘 이미 만들어진 추천은 다시 계산하지 않는다. 모든 수정 화면이 이 문구를 보여준다.
(`recommendation_db_test.mjs` 가 실제 DB 행에서 스냅샷을 만드는 경로를 검증한다.)

## 5. 변경 이벤트 (analytics_events, 서버 기록)

| 이벤트 | 언제 | payload |
|---|---|---|
| `profile_updated` | 온보딩 완료 사용자가 `profiles` 를 고쳤을 때 | `{fields: [바뀐 컬럼 이름]}` — 값 없음 |
| `values_updated` | `private_profiles` 를 고쳤을 때 | 동일 (민감 응답 값 없음) |
| `preferences_updated` | `preferences_save` 성공 시 | `{settings: [넘긴 키], dealbreakers: [종류]}` |

온보딩 중 저장은 이벤트를 남기지 않는다 (`onboarding_completed` 로 충분). 클라이언트는 이 이벤트를 기록하지 않는다.

## 6. 남은 것

- 실기기에서 수정 → 다음 날 추천에 반영 확인 (#21).
- 지역·나이 조건 완화 제안(후보 부족 시)은 #23 — 사용자 동의 없이 자동 완화하지 않는다.
