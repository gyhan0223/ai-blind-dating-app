# 본인확인 · 계정 복구 · 중복가입 검증 (#6)

1인 1계정 정책의 서버 흐름(`verify-identity`)이 어떤 계층에서 어떻게 검증되는지, 무엇이 아직 외부 검증 대기인지 적는다.
코드: `supabase/functions/verify-identity/index.ts`(얇은 handler) → `supabase/functions/_shared/identity/verifyIdentityCore.ts`(흐름) ·
`supabaseIdentityDeps.ts`(DB/Auth 어댑터) · `identityCore.ts`(순수 판단) · `IdentityVerificationProvider.ts`(Provider 인터페이스 · Mock).

## 1. 흐름과 세션 (0032)

```
request  : Provider 세션 시작 → identity_verification_sessions 행 (pending, 10분, provider_session_id 는 서버에만) → 클라이언트에 requestId(우리 세션 id)
confirm  : 조건부 점유 (id · user_id = JWT 사용자 · 만료 전 · pending 또는 lease(120초) 지난 checking) → Provider 결과
           → Provider 생년월일로 성인 판정(만 19세, 주입된 시계) → HMAC 해시 → identity 조회·판단(identityCore.decideIdentityOutcome)
           → created(insert) / relinked(user_id is null 행만 갱신) / already_verified / existing_account / blocked
           → users 플래그 · private_profiles(Provider 생년월일) → 세션 completed(outcome 저장)
recover  : 세션이 (JWT 사용자 소유 · existing_account · 15분 안) 이고, 현재 계정이 identity 연결 전 빈 계정이며, OTP 로 확인된 번호가 있을 때만
           → 대상 계정 재판단 → 새 계정 삭제(Auth) → 기존 계정에 번호 연결(Auth) → users.phone · deleted→active
```

| 세션 상태 | 의미 | 다음 |
|---|---|---|
| `pending` | 인증번호 대기 (expires_at 10분) | confirm 점유 → `checking` |
| `checking` | 한 요청이 Provider 를 호출 중 (동시 confirm 은 409 `session_in_progress`) | 성공/실패에 따라 전이. 120초 지나면 죽은 요청으로 보고 재점유 |
| `completed` | 결과 확정 (`outcome` = created / already_verified / relinked / blocked / underage) | 같은 사용자의 재전송은 Provider 재호출 없이 같은 결과 재생 |
| `existing_account` | 같은 사람의 다른 계정 발견 (`owner_user_id`, 해시·생년월일·성별 저장, 15분) | recover |
| `recovered` | (예약) | — |
| `failed` | 취소 · 5회 실패 · 대상 계정 상태 변경 · Provider 결과 불완전 | 처음부터 다시 request |
| `expired` | Provider 만료 또는 TTL 경과 | 처음부터 다시 request |

- 세션 행에는 raw DI · 이름 · 전화번호 · 인증번호가 없다. `identity_verification_sessions_prune(keep)` 으로 정리 (기본 1일). 계정 삭제 시 cascade.
- 응답 오류 코드: `invalid_session`(타인/없는 세션 — 존재 여부를 구분하지 않음) · `session_expired` · `too_many_attempts` · `session_in_progress`(409) ·
  `identity_mismatch`(409 — 이미 다른 identity 가 연결된 계정) · `provider_unavailable`(503) · `provider_result_invalid`(502) · `phone_login_required` · `not_recoverable` · `recover_failed`(500).
  실패 사유는 `[a-z0-9_]` 코드만 실린다 (Provider 문장·전문 없음).

## 2. 시나리오별 검증 계층

| 시나리오 | 이전에 검증돼 있던 것 | 이번에 추가 (#6) |
|---|---|---|
| 신규 가입 | `identity_tests.sql` (auth→users 동기화·identity insert) · `selftest.ts` (판단 created) | `verifyIdentitySelftest.ts` §1: request→confirm 전체 전이, 저장 값이 Provider 결과인지(클라이언트 생년월일·이름 무시), 플래그·프로필·세션·이벤트 |
| 동일 사용자 재인증 | `selftest.ts` (already_verified 판단) | §2: 재인증 identity 1행 유지 · §10 같은 세션 재전송은 Provider 재호출 없이 같은 결과 |
| 전화번호 변경 후 기존 계정 복구 | `identity_tests.sql` (auth phone 변경 → users.phone 동기화) — handler 경로 미검증 | §3: existing_account → recover 순서(새 계정 삭제 → 번호 이동) · 마스킹 번호 · 세션 cascade · Provider 재호출 없음 |
| 같은 identity 의 동시 가입 | `identity_tests.sql` (순차 UNIQUE 위반) | §4 created 경쟁(끼어들기) · **`identity_concurrency_test.sh` 두 연결**(insert 대기 후 UNIQUE · relink 0행 · 세션 claim 1행) |
| 탈퇴 계정 복구·재가입 | `identity_tests.sql` (삭제 뒤 user_id null 보존·relink) · `account_deletion_tests.sql` (익명화 시 identity 보존) | §5: 유예 중(existing_account→recover→active) · 익명화 뒤(재연결→스켈레톤 active) · hard delete 뒤(relinked) 를 handler 로 구분 |
| 영구정지 identity 의 번호 변경 우회 | `identity_tests.sql` (ban 동기화·삭제 뒤 유지) · `selftest.ts` (blocked 판단) | §6: 새 번호 confirm → blocked · recover 불가 · hard delete 뒤에도 blocked · users.status 만 banned 인 경우 |
| 미성년자 차단 | `selftest.ts` (isAdult 경계) | §7: 클라이언트는 성인 생년월일을 보내도 Provider 결과가 미성년이면 underage · 고정 시계로 생일 하루 전/당일 경계 · 저장·플래그 없음 |
| 인증 취소·실패·만료 | 없음 (Mock 은 아무 6자리 코드 통과) | §8: invalid_code 4회 pending 유지 → 5회 failed · cancelled · Provider expired · TTL 만료(시계) · 네트워크 오류 503 뒤 재시도 · 비정형 사유 정리 · 불완전 결과 502 |
| 다른 사용자의 인증 세션 사용 | 없음 (requestId 가 서버에 기록되지 않았음) | 0032 + `identity_sessions_tests.sql`(소유자 조건부 점유) + §9 (confirm/recover 모두 invalid_session, Provider 미호출, 사유 코드 이벤트) |
| 결과 재전송·복구 중복 실행 | 없음 | §10 재전송 재생 · §10b 동시 confirm 409 · lease 재점유 · recover 는 existing_account 세션에서 한 번(점유) |
| 중간 실패와 재시도 | 없음 | §11: 새 계정 삭제 실패(불변·재시도) · 번호 이동 실패(새 계정 없음·기존 그대로 → 재로그인·재인증·복구) · 플래그/프로필/identity 저장 실패 후 재시도 · 세션 생성 실패 |
| 개인정보 비노출 | `server_errors` 마스킹 (#20) | §14: 모든 응답·이벤트·콘솔에 raw identityKey · 인증번호 · 전화번호 전체 · 이름 · Provider 세션 id 없음 |

`verifyIdentitySelftest.ts` 의 Provider(`TestIdentityProvider`)는 그 파일에만 있고 `getIdentityProvider('test')` 는 실패한다 (§15). production 은 env 단계에서 `mock` 도 거부된다 (`docs/environments.md`).

## 3. 이번에 고친 결함

1. **relink 경쟁에서 두 계정이 인증 완료 표시될 수 있었다.** 삭제된 계정의 identity(user_id null)를 두 계정이 동시에 재연결하면 두 번째 갱신은 0행인데
   오류가 아니어서 그대로 `users.identity_verified=true` 가 됐다 (identity 는 한쪽에만). 지금은 0행을 실패로 보고 재조회해 `existing_account` 로 안내한다 (§4b · 동시성 스크립트).
2. **인증 세션이 JWT 사용자와 결속되지 않았다.** requestId 를 서버가 기록하지 않아 타인 세션·만료·재사용을 막을 근거가 없었다 → 0032 세션 테이블.
3. **recover 가 세션 없이 Provider 를 다시 부르고 클라이언트 입력을 다시 받았다.** 지금은 confirm 이 남긴 서버 검증 결과만 쓴다. 번호 소유(phone_confirmed_at)가 없거나
   현재 계정에 이미 identity/인증 플래그가 있으면 복구하지 않는다 (잘못된 계정을 지우지 않는다).
4. **Provider 예외가 미처리 500 이었다** → 503 `provider_unavailable`, 세션은 pending 으로 복귀.
5. **실패 사유가 그대로 응답에 실렸다** → 코드 형태만.

## 4. 로컬 실행

```bash
# 흐름 selftest (Provider/DB/Auth/시계 주입 — 114 검사)
cd supabase/functions/_shared/identity && node --experimental-strip-types verifyIdentitySelftest.ts
# 순수 판단 selftest
cd supabase/functions/_shared/identity && node --experimental-strip-types selftest.ts
# DB: 세션 테이블 · 조건부 점유 · relink 0행 · cascade · prune + 두 연결 동시성 (run_local_check.sh 에 포함)
cd supabase/tests && bash run_local_check.sh
```

PowerShell (한 줄씩):

```powershell
cd supabase\functions\_shared\identity; node --experimental-strip-types verifyIdentitySelftest.ts
cd supabase\functions\_shared\identity; node --experimental-strip-types selftest.ts
cd supabase\tests; bash run_local_check.sh
```

## 5. staging 재현 절차 (실제 Provider 선정 뒤 — **미실행**)

실제 본인확인 업체는 아직 선정되지 않았다. `IdentityVerificationProvider` 인터페이스만 있고 실서비스 adapter 는 없다. 업체 연동 뒤 staging 에서 아래를 수행하고 결과를 이 문서에 적는다.

1. 신규 번호 A 로 OTP 로그인 → 본인확인 → `created`. `user_identities` 1행, `private_profiles.birth_date` 가 기관 값인지.
2. 같은 기기에서 다시 본인확인 → `already_verified`.
3. 번호 B 로 로그인 → 같은 사람으로 본인확인 → `existing_account`(마스킹 A) → 복구 → 재로그인(B) 하면 기존 프로필. Auth 에 A 계정의 phone 이 B 로 바뀌고 B 임시 계정이 없는지.
4. 두 기기에서 같은 사람으로 동시에 confirm → 한쪽 `created`, 다른 쪽 `existing_account`. `user_identities` 1행.
5. 탈퇴(유예) → 새 번호로 본인확인 → 복구 → `status=active`. 익명화 뒤 → 복구 → 온보딩 처음부터. (hard delete 는 관리자 삭제 요청 처리 뒤) 재가입 → `relinked`.
6. 관리자에서 영구 차단 → 새 번호로 본인확인 → `blocked`. 계정 완전 삭제 뒤에도 `blocked`.
7. 미성년 테스트 계정(업체 제공) → `underage`, 플래그 없음.
8. 기관 인증창에서 취소 / 틀린 코드 5회 / 10분 방치 / 기내 모드 → 각각 `cancelled` · `too_many_attempts` · `session_expired` · 503 뒤 재시도.
9. 기기 1 의 requestId 를 기기 2 에서 사용 → `invalid_session`.
10. Edge 로그 · `device_events.meta` · `server_errors` 에 DI/전화번호/인증번호가 없는지.

## 6. 미구현 · 미검증

- 실서비스 Provider adapter (PASS/NICE/KCB/PortOne 등) — 업체 미선정. `getIdentityProvider` switch 에 등록하고 `startVerification`/`getVerificationResult` 계약(취소·만료·네트워크 오류를 `verified:false` 또는 예외로)을 지켜야 한다.
- 위 5절 staging E2E — 로컬 selftest·DB 테스트는 실제 Provider·Auth 연동 검증이 아니다.
- Supabase Auth 실제 동작(`auth.admin.deleteUser` → `updateUserById(phone)` 의 부분 실패 재현)은 로컬 Auth 통합 테스트로 수행하지 않았다 (어댑터는 인메모리 Auth 로만 검증).
