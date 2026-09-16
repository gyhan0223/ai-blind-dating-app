# 얼굴(생체) 정보 처리 별도 동의 (#12)

이 문서는 "동의 기능" 이 코드로 어떻게 동작하는지를 적는다. **법률 검토 완료를 뜻하지 않는다.** 확인되지 않은 값(Didit 처리 국가 ·
확인 업체 보관 기간 · 사업자/문의처)은 코드에서 `null` 로 두었고, 지어내지 않았다.

## 1. 구성

| 위치 | 역할 |
|---|---|
| `supabase/functions/_shared/consent/faceConsentPolicy.ts` | **단일 기준** — 종류(`face_biometric`) · 문서 버전 · `status`(draft/final) · 고지 항목(목적 · 항목 · 처리업체 · 처리 국가 · 보관·삭제 · 확인 업체 보관 · 거부 시 제한 · 철회 경로 · 문의처) · production 준비 상태 규칙 |
| `apps/mobile/src/constants/faceConsent.ts` | 앱 표시용 사본. `_shared/consent/selftest.ts` 가 서버 정책과 일치하는지 검사한다 (버전이 다르면 서버가 409/403 으로 거부) |
| `supabase/migrations/0030_face_consents.sql` | `face_consents(user_id, kind, doc_version, granted_at, revoked_at)` — 서버 전용 쓰기(트리거·정책), 본인 조회, (user, kind, version) 유일, 익명화/hard delete 시 삭제 |
| `start-face-liveness` `action:'consent'` | 동의 기록. 사용자 = JWT, 버전 = 서버 정책과 대조, 시각 = DB `now()`. 같은 버전 재요청은 멱등 |
| `start-face-liveness` `action:'start'` | **신규 Provider 세션 생성 전에** 현재 버전 동의가 서버에 있는지 확인. 없음 → 403 `consent_required`(Provider 호출 없음), 조회 실패 → 503 `consent_unavailable`, 문서 미준비 → 503 `consent_policy_not_ready` |
| `apps/mobile/src/app/onboarding/face.tsx` | "얼굴 확인 시작" → 서버에 현재 버전 동의가 없으면 동의 화면. 기본 미선택 체크박스, 다른 약관과 분리, 전문 링크(`EXPO_PUBLIC_POLICY_BASE_URL`/policy/privacy) |

## 2. 흐름

```text
[얼굴 확인 시작] → 앱: face_consents 본인 행 조회(현재 버전) ─없음─▶ 동의 화면 (체크 → "동의하고 시작")
                                                                       │  POST start-face-liveness {action:'consent', version}
                                                                       │  서버: 버전 대조 → face_consents insert (서버 시각)
                                                                       ▼
                    POST start-face-liveness {action:'start'} → 서버: 이미 인증? → 문서 준비? → 동의 있음? → Provider 세션 생성
                                                                        (앱 체크박스는 믿지 않는다 — 403 이면 앱은 동의 화면으로)
```

- 이미 `users.face_verified=true` 인 사용자는 `start` 가 `already_verified` 로 끝나므로 동의를 요구하지 않는다 (기존 승인 유지).
- 진행 중 세션의 `sync` · Didit 웹훅 · 관리자 검토(`admin-face-review`)는 동의를 검사하지 않는다 — 서버 간 처리에 사용자 체크박스를 요구하면 진행 중 검증이 깨진다.
- 개발용 Mock 승인(`complete-face-verification`)은 Provider 세션을 만들지 않으므로 동의 검사가 없다 (development/staging 전용, production 미배포).

## 3. 위조·중복·구버전

| 시도 | 결과 |
|---|---|
| 클라이언트가 `face_consents` 에 직접 insert/update (본인·타인) | RLS 정책 없음 + 트리거 `face_consents_server_only` → 거부 (`face_consents_tests.sql`) |
| `consent` 요청 body 에 `userId`/`user_id`/`consentedAt` | 무시 — JWT 사용자, DB 시각만 (`face/selftest.ts` "타인 동의 위조") |
| 같은 버전 동의 두 번 | unique 로 1행, 200 (멱등) |
| 서버 버전과 다른 버전 | 409 `consent_version_mismatch` + `currentVersion` (앱 갱신·재동의) |
| 구버전 동의만 있는 사용자의 `start` | 403 `consent_required` → 새 버전으로 재동의 |
| 동의 기록 실패 / 조회 실패 | 503, Provider 호출 없음 (fail-closed) |

## 4. production 준비 상태 (`faceConsentReadiness`)

production(`APP_ENV=production`) 에서 새 세션을 만들려면 셋 다 필요하다. 하나라도 빠지면 `start`/`consent` 가 503 `consent_policy_not_ready` 이고
함수 로그에 이유(`policy_status_not_final` · `unresolved_disclosures:…` · `FACE_CONSENT_VERSION_missing|mismatch`)가 남는다. 사용자 화면에는 이유를 노출하지 않는다.

1. `FACE_CONSENT_POLICY.status === 'final'` (법률 검토 뒤 코드에서 변경)
2. 미확정 고지 항목(`null`) 없음 — 현재 `processor_country` · `processor_retention` · `contact`
3. 서버 secret `FACE_CONSENT_VERSION` 이 코드의 `version` 과 같다 (배포된 문서 버전을 운영자가 명시적으로 승인). `deploy-production.sh` 가 존재를 확인한다.

development/staging 은 draft 를 허용한다 (`FACE_CONSENT_VERSION` 을 설정했다면 코드와 일치해야 한다).
준비되지 않아도 진행 중 세션의 sync/웹훅은 계속 동작한다 (기동을 막지 않는다).

## 5. 문서 버전 변경(재동의) 기준

- 고지 내용(목적 · 항목 · 처리업체 · 국가 · 보관 · 철회 경로)이 바뀌면 `version` 을 올린다 → 이전 버전 동의만 있는 사용자는 **새 얼굴 확인을 시작할 때** 다시 동의한다.
- 이미 승인된 사용자의 인증(`face_verified`)은 해제하지 않는다 — 전체 사용자 재인증 강제는 이 기능의 범위가 아니며, 필요하면 법률 판단 뒤 별도 결정한다.
- 오탈자 수정처럼 의미가 바뀌지 않는 편집은 버전을 올리지 않아도 된다 (판단은 운영/법무).
- 앱 사본을 같이 갱신하지 않으면 `consent selftest` 가 실패하고, 배포된 구 앱은 409 를 받아 "앱 업데이트" 안내를 본다.

## 6. 철회·삭제

- 철회 경로는 기존 삭제 경로다: 앱 내 정보 → 회원 탈퇴, 또는 앱 밖 계정 삭제 요청 페이지. 즉시 삭제를 약속하지 않는다 — 탈퇴 30일 유예 뒤
  `account-purge` 가 얼굴 자산·Provider 세션·동의 기록을 삭제한다 (`docs/data-retention.md`).
- 동의 행의 `revoked_at` 은 서버 전용 컬럼이며 현재 자동으로 채우는 경로는 없다 (익명화 시 행 자체를 삭제). 부분 철회 기능은 만들지 않았다.

## 7. 미확정 · 미검증

- 문구는 초안(`draft`)이고 법률 검토 전이다. Didit 처리 국가/리전 · Didit 보관 기간 · 사업자/문의처는 확인되지 않아 `null` 이며 앱은 "개인정보 처리방침 전문" 링크로 대신한다.
- 동의 증적의 보관 기간(계정 삭제 뒤 별도 보존이 필요한지)은 미확정 — 현재는 익명화/hard delete 시 삭제한다.
- 실기기에서 동의 화면 → 세션 시작 흐름은 미검증 (Didit 계정·Development Build 필요).

## 8. 테스트

```bash
cd supabase/functions/_shared/face && node --experimental-strip-types selftest.ts      # 미동의 차단 · 위조 · 멱등 · 구버전 · 기록 실패 · sync/웹훅 회귀 · production 미준비
cd supabase/functions/_shared/consent && node --experimental-strip-types selftest.ts   # 서버/앱 사본 일치 · 자리표시자 없음 · 준비 상태 규칙
cd apps/mobile && node --experimental-strip-types scripts/face-liveness-selftest.mjs   # 앱 오류 코드·동의 필요 판단
bash supabase/tests/run_local_check.sh                                                  # face_consents_tests.sql
```
