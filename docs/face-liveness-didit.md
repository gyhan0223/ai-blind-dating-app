# 얼굴 라이브니스 — Didit 능동형 라이브니스(3D Action & Flash) 연동 (Sessions API v3)

이 문서는 얼굴 인증 단계를 **Didit 네이티브 SDK 의 실제 능동형 라이브니스** 로 처리하는 구조와, 운영자가 직접 해야 하는 설정을 설명한다.
PR #35 의 첫 구현을 **Didit Sessions API v3 계약**(`liveness_checks[]`, `matches[]`, V3 웹훅 `event_id`)에 맞게 고치고,
승인 경로를 DB 트랜잭션 하나로 묶어 "승인 행만 있고 사용자는 영원히 처리 중" 인 상태가 생기지 않게 보완했다.

> 한 줄 요약: 앱은 카메라 화면을 열고 결과만 받는다. **승인은 오직 서버가** 서명 검증된 Didit V3 웹훅과
> `GET /v3/session/{id}/decision/` 재조회 결과로만 내린다. reference image 를 확보하지 못하면 승인하지 않는다.
> production 에서는 Mock 도, 클라이언트 조작도 승인이 될 수 없다.
>
> ⚠️ **아직 실제 Didit 계정·실기기 E2E 는 수행하지 않았다.** 이 문서의 계약은 Didit 공식 문서(v3)를 기준으로 구현·자동 테스트한 것이며,
> 콘솔 설정 + secret + Development Build 실기기 검증은 11절의 미완료 조건이다.

## 1. 사용자 흐름

```text
[얼굴 확인 안내] ─ "얼굴 확인 시작" ─▶ start-face-liveness (JWT)
                                          │  Didit POST /v3/session/ (서버, API Key, vendor_data = user id)
                                          │  face_verifications pending 행 + provider_session_id
                                          ▼
                              1회용 session_token → 앱 (저장 안 함)
                                          ▼
                     Didit 네이티브 화면 (앱 안, WebView 아님)
                     · 전면 카메라 안내선에 얼굴 맞추기
                     · 무작위 동작(눈 깜빡임·끄덕임·움직임) + 화면 플래시
                     · 촬영 버튼 없음 — SDK 가 자동 촬영·분석
                                          ▼
                    "확인 결과를 처리하고 있어요" (앱은 DB 폴링 + sync 요청)
                                          ▼
   Didit ──V3 웹훅(X-Signature-V2, event_id)──▶ didit-webhook ──GET /v3/session/{id}/decision/──▶
        liveness_checks[0].status == Approved & matches[] 비어 있음 → reference image 저장 →
        RPC face_liveness_approve (한 트랜잭션: face_verifications approved + verified_at + users.face_verified = true)
                                          ▼
                     앱이 DB 의 face_verified=true 를 확인 → 다음 온보딩 단계(profile)
```

- 라이브니스 방식: Didit 워크플로에서 **Active — 3D Action & Flash**. 사진·재생 영상·화면 재촬영·딥페이크·마스크 공격 방어는
  이 방식과 Didit 워크플로 설정이 담당한다. 앱은 자체 라이브니스 판정 코드를 두지 않는다.
- 세션 안 재시도 횟수(최대 3회)는 Didit 워크플로 설정이 관리한다. 앱/서버는 **세션 생성 횟수** 를 따로 제한한다
  (시간당 5회, 하루 10회 — `face_liveness_begin_session`).
- 실패(취소·권한 거부·조명·가림·시도 초과·Provider 장애 등)하면 얼굴 확인만 다시 시도한다. 온보딩 전체를 되돌리지 않는다.
- Didit 이 `Resubmitted` / `Awaiting User` 를 알리면 앱은 무한 대기 대신 "얼굴 확인을 다시 진행해 주세요" 를 보여주고
  새 세션으로 다시 시작할 수 있다 (두 상태는 절대 승인으로 해석하지 않는다. DB 에서는 `pending` + 사유 코드).
- `liveness_checks[].matches[]` 에 항목이 하나라도 있으면(Face Search 1:N 중복 의심) **자동 승인하지 않고 `in_review`**.
  어떤 계정과 유사한지는 읽지도 저장하지도 않으며 사유 코드(`face_search_match`)만 남긴다. 관리자 검토 화면(7절)에서만 해소된다.
- 라이브니스는 **"실제 사람이 카메라 앞에 있다"** 만 확인한다. 실명·생년월일·성인 여부는 증명하지 않는다.

## 2. 구성 요소

| 영역 | 파일 | 역할 |
|---|---|---|
| DB | `supabase/migrations/0013_face_liveness.sql` | `face_verifications` 확장, 클라이언트 쓰기 차단, 상태 전이 보호 트리거, 세션 rate-limit RPC, storage `liveness/` 클라이언트 차단 |
| | `supabase/migrations/0014_face_liveness_v3_hardening.sql` | **원자적 승인 RPC** `face_liveness_approve`, 관리자 검토 RPC `face_liveness_admin_review` + 감사 테이블 `face_verification_reviews`, V3 웹훅 `event_id` 멱등 테이블 `face_webhook_events`, 비정상 데이터 점검 `face_liveness_inconsistent_rows` (전부 service role 전용) |
| 서버 공용 | `_shared/face/faceCore.ts` | v3 Decision 파서(`liveness_checks[]`, session/workflow/vendor 대조, `matches[]`/`warnings[]` 중복), 상태 매핑(Resubmitted/Awaiting User 포함), 보수적 판정, 전이 규칙, V3 웹훅 파싱 |
| | `_shared/face/diditWebhookVerifier.ts` | `X-Signature-V2` HMAC-SHA256 검증 (canonical JSON), 타임스탬프 ±5분, 상수 시간 비교 |
| | `_shared/face/diditClient.ts` | Didit API v3 클라이언트 (세션 생성 / Decision / 삭제 / reference image 다운로드). v2 fallback 없음, https base 만 |
| | `_shared/face/FaceLivenessProvider.ts` | Provider 추상화 (`didit` 실제 / `mock` 개발 전용), secret 로더 (fail-closed) |
| | `_shared/face/faceOutcome.ts` | Decision → DB 반영 (승인 경로는 이 파일 하나: reference image 확보 → RPC), 비정상 approved 행 복구 |
| | `_shared/face/startFaceLivenessCore.ts`, `diditWebhookCore.ts`, `adminReviewCore.ts` | Edge Function 핵심 로직 (순수 모듈, Node selftest) |
| | `_shared/face/supabaseFaceDb.ts` | service role DB/storage 어댑터 (RPC 호출) |
| Edge Function | `start-face-liveness` | JWT 검증 → 세션 생성(`start`) / 서버 재조회(`sync`) |
| | `didit-webhook` | JWT 없음, 서명 검증 → Decision 재조회 → 상태 반영 (`--no-verify-jwt` 배포) |
| | `admin-face-review` | **service role 전용** 관리자 검토 (승인/거절/복구). 관리자 웹 서버 액션만 호출 |
| | `complete-face-verification` | **개발 전용 Mock** 즉시 승인. `FACE_VERIFICATION_PROVIDER=mock` 일 때만 기동, production 미배포 |
| 관리자 웹 | `apps/admin/app/face-reviews/page.tsx`, `apps/admin/lib/faceReview.ts` | `in_review` 목록 · 승인/거절 · 복구 필요 목록 · 감사 기록 (기존 비밀번호 쿠키 인증 재사용) |
| 모바일 | `apps/mobile/src/services/face/faceFlowCore.ts` | 화면 상태 기계·오류 코드·한국어 문구 (순수 모듈, Node selftest) |
| | `apps/mobile/src/services/face/diditSdk.ts` | SDK 브리지 (lazy require — Expo Go 에서 앱이 죽지 않게) |
| | `apps/mobile/src/services/face/index.ts` | 서버 호출 (`start-face-liveness`), 본인 행 조회, 개발용 Mock 호출 |
| | `apps/mobile/patches/@didit-protocol+sdk-react-native+4.7.5.patch` | SDK Android 브리지의 세션 토큰/워크플로/vendor_data 로그 제거 (patch-package, `postinstall`) |
| | `apps/mobile/app.json` | Didit config plugin (autodetection 변형, NFC 끔), iOS/Android 권한 문구 |

### Mock 과 실제 Didit 흐름의 분리

| | Mock (`FACE_VERIFICATION_PROVIDER=mock`) | Didit (`=didit`) |
|---|---|---|
| 허용 환경 | development / staging 만 (production 은 `_shared/env` 가 cold start 에서 거부) | 모든 환경 |
| 세션 생성 (`start-face-liveness`) | 409 `provider_is_mock` — 세션을 만들지 않는다 | Didit v3 세션 생성 |
| 웹훅 (`didit-webhook`) | 503 `provider_not_didit` | 서명 검증 + 재조회 |
| 승인 경로 | `complete-face-verification` (앱의 "개발 모드: 얼굴 인증 통과" 버튼, `__DEV__ && DEV_TOOLS_ENABLED` 에서만 존재) | 웹훅/sync/관리자 → `faceOutcome` → RPC `face_liveness_approve` |
| production 배포 | allowlist 제외 + 배포돼 있으면 `deploy-production.sh` 가 중단 + 기동 자체 거부 (3중) | `start-face-liveness`, `didit-webhook`, `admin-face-review` |

알 수 없는 provider 이름(예: `acme`)은 모든 함수가 cold start 에서 throw 한다 (fail-closed). Mock 은 production fallback 이 아니다.

## 3. Didit API v3 계약과 파서

| 호출 | 경로 | 비고 |
|---|---|---|
| 세션 생성 | `POST /v3/session/` | body `{ workflow_id, vendor_data: <user id> }` → `session_id`, `session_token`, `expires_at`, `status` |
| Decision 조회 | `GET /v3/session/{id}/decision/` | 승인의 유일한 근거 |
| 세션 삭제 | `DELETE /v3/session/{id}/delete/` | 200 JSON 또는 204 — **2xx 전부 성공** 으로 처리 (회원 탈퇴 후속 작업용) |

- 인증 헤더 `X-API-Key`. `DIDIT_API_BASE_URL` 은 https 만 허용하며 잘못된 값은 기동 실패. **v2 로 조용히 fallback 하지 않는다.**
- Decision 응답이 JSON 객체가 아니거나 아래 검증에 걸리면 `invalid_decision` 으로 **승인하지 않는다** (fail-closed):
  - `session_id` == 요청한 세션, `workflow_id` == `DIDIT_WORKFLOW_ID`, `vendor_data` == DB 행의 `user_id`
  - `liveness_checks` 가 없거나 빈 배열이면 Approved/In Review 를 승인 근거로 쓰지 않는다 (`missing_liveness`)
  - Liveness-only 워크플로 전제 — 노드가 여러 개면 임의로 고르지 않고 거부 (`multiple_liveness`)
  - 과거의 단일 `liveness` 객체는 더 이상 읽지 않는다
- 노드 필드: `status`(Approved 일 때만 `liveness_passed`), `method`, `score`(0~100 범위 밖은 버림), `reference_image`(https 만),
  `matches[]`(항목이 있으면 중복 의심 — 내용은 읽지 않음), `warnings[]`(+ 루트 `warnings[]`) 의 `DUPLICATE|FACE_SEARCH|MULTIPLE_ACCOUNT…` risk 코드는 보조 신호.
- 세션 상태 매핑: `Approved→approved`, `Declined→rejected`, `In Review→in_review`, `Not Started/In Progress/Awaiting User/Resubmitted→pending`,
  `Abandoned/Expired/Kyc Expired→expired`, 그 외 → 알 수 없음(승인 안 함). `Awaiting User`/`Resubmitted` 는 사유 코드
  `awaiting_user`/`resubmission_requested` 로 남기고 sync 응답의 `userActionRequired=true` 로 앱에 재시작을 안내한다.
- 판정(`resolveOutcome`): `matches[]`/경고 중복 의심 → `in_review`(Provider 가 Declined 면 `rejected`). 전체 Approved 인데 라이브니스 미승인 → `in_review`(`decision_incomplete`).
  전체 Approved **and** 라이브니스 Approved **and** 중복 의심 없음일 때만 승인 후보.

## 4. 서버가 최종 승인하는 과정

1. `didit-webhook` 이 요청을 받는다. `DIDIT_WEBHOOK_SECRET` 이 없으면 500 (fail-closed).
2. `X-Signature-V2` 를 검증한다: `HMAC-SHA256(secret, canonical_json(body))` hex (키 정렬 + compact + 유니코드 비이스케이프).
   `X-Timestamp`(없으면 body `created_at`) 가 ±300초 밖이면 replay 로 거부. 실패는 전부 401. 약한 방식(`X-Signature`, `X-Signature-Simple`)으로 fallback 하지 않는다.
3. `webhook_type` 이 `status.updated` / `data.updated` 가 아니면(user.* / business.* / transaction.* / travel_rule.* / activity.*) 세션 이벤트로 오인하지 않고 200 `unsupported_event`.
4. **`event_id` 멱등**: 이미 처리한 `event_id` 면 Provider Decision 을 다시 조회하지 않고 200 `duplicate` (`face_webhook_events`).
   503 으로 끝난 이벤트는 기록하지 않아 Didit 재시도가 다시 처리된다.
5. `session_id` 로 행을 찾는다 (없으면 200 ignored). `vendor_data` 는 행의 `user_id` 와, `workflow_id` 는 서버 설정과 일치해야 한다 (원문은 로그에 남기지 않는다).
6. 같은 `created_at`+status 재전송은 duplicate. 저장된 이벤트보다 오래된 이벤트는 `stale_event`. 이미 approved 인 행은 어떤 이벤트로도 바뀌지 않는다
   (단, `users.face_verified` 가 아직 false 인 부분 실패 상태는 여기서 복구한다).
7. `Approved` / `Declined` / `In Review` 는 웹훅 본문을 믿지 않고 **서버가 `GET /v3/session/{id}/decision/` 을 직접 조회** 한다. 조회 실패·검증 실패 → 503 (Didit 재시도).
   `Not Started/In Progress/Awaiting User/Resubmitted` 는 상태·사유만 갱신, `Abandoned/Expired` 는 expired.
8. 승인 후보이면 `liveness_checks[0].reference_image`(https 서명 URL)를 서버에서 즉시 다운로드 → MIME(`image/jpeg|png`)·크기(≤5MB) 확인 →
   private bucket `faces` 의 `<user_id>/liveness/reference.jpg` 에 upsert. **다운로드·MIME·크기·저장 중 하나라도 실패하면 승인하지 않고
   `in_review` + `provider_reason=reference_image_unavailable`** (`liveness_passed=true` 는 기록). 이후 앱 `sync` / 웹훅 재전송 / 관리자 복구가
   Decision 을 다시 조회해(새 서명 URL) 같은 경로에 저장을 재시도한다.
9. RPC `face_liveness_approve(row, user, session, reference_path, liveness_passed …)` 가 **한 트랜잭션** 으로
   행·user_id·provider_session_id·reference_path·liveness_passed 를 다시 검증하고 `status='approved'`, `verified_at`, `users.face_verified=true` 를 반영한다.
   행/사용자 행을 `for update` 로 잠가 웹훅과 앱 sync 가 동시에 들어와도 한 번만 바뀌고(멱등), RPC 실패 시 둘 다 롤백된다 → 503 으로 재시도.
   이미 approved 인 행이라도 조건이 맞고 `users.face_verified=false` 면 플래그를 복구한다. `rejected` 행은 되살리지 않는다.
10. DB 트리거가 최종 방어: approved → 다른 상태 전이 거부, `provider_event_at` 이 과거인 갱신 거부, 클라이언트(JWT) 컨텍스트의 insert/update/delete 전부 거부.

앱의 `sync` 요청(`start-face-liveness` `action:'sync'`)도 같은 경로를 타며, 클라이언트가 보낸 값 중 쓰는 것은 본인 소유 확인용 `sessionId` 뿐이다.
행이 approved 인데 플래그가 없거나 `reference_path` 가 없는 비정상 데이터는 sync/웹훅/관리자 "복구" 가 같은 RPC 로 해소한다
(`select * from face_liveness_inconsistent_rows()` 로 점검).

Didit v3 는 같은 `vendor_data` 의 미완료 세션이 있으면 새 세션 대신 그 세션을 다시 돌려줄 수 있다. 서버는 같은 `session_id` 를 가진 본인 행을 다시 `pending` 으로 열고
방금 만든 행을 `superseded` 로 마감한다 (UNIQUE 충돌 없음). 다른 사용자의 세션 id 가 돌아오면 붙이지 않고 503.

## 5. Secret / 환경변수

모두 **Supabase Secrets(서버) 전용** 이다. `EXPO_PUBLIC_*`, 모바일 번들, 로그, DB 에 넣지 않는다.

| 이름 | 값 | 비고 |
|---|---|---|
| `FACE_VERIFICATION_PROVIDER` | `didit` | production 필수. `mock`/미설정/미구현 이름이면 함수 기동 거부 |
| `DIDIT_API_KEY` | Didit 콘솔 API Key | 세션 생성·Decision 조회·세션 삭제 (v3, `X-API-Key`) |
| `DIDIT_WORKFLOW_ID` | Liveness-only 워크플로 ID | Decision/웹훅의 `workflow_id` 대조에도 사용 |
| `DIDIT_WEBHOOK_SECRET` | 콘솔 웹훅 secret (V3 destination) | `X-Signature-V2` 검증 |
| `DIDIT_API_BASE_URL` (선택) | 기본 `https://verification.didit.me` | https 만. 보통 설정하지 않는다 |
| `ADMIN_ACTOR_LABEL` (관리자 웹, 선택) | 기본 `admin-web` | 감사 기록 `actor` 값 |

```bash
supabase secrets set FACE_VERIFICATION_PROVIDER=didit DIDIT_API_KEY=<key> DIDIT_WORKFLOW_ID=<workflow-id> DIDIT_WEBHOOK_SECRET=<secret> --project-ref <PROJECT_REF>
```

값을 모르는 상태에서도 코드는 빌드·테스트된다 (secret 은 런타임에만 읽는다). 실제 값을 저장소에 커밋하지 않는다. 이 작업에서 실제 Secret 을 만들거나 저장하지 않았다.

## 6. Didit 콘솔 설정 (운영자가 직접 — 아직 수행되지 않음)

1. **계정/앱 생성** — https://business.didit.me 에서 가입 후 Application 을 만든다.
2. **Liveness-only 워크플로 생성** — Workflows → New workflow. 단계는 **Liveness 만** 추가한다 (라이브니스 노드 1개).
   신분증(ID Verification), AML, 주소 인증, NFC, Phone/Email 단계는 넣지 않는다 — 노드가 여러 개면 서버 파서가 fail-closed 한다.
3. **Liveness 방식** — Liveness 노드 설정에서 **Active → `3D Action & Flash`** 를 선택한다. Passive/Flash 단독은 선택하지 않는다.
4. **재시도 횟수** — `Max attempts` = **3**.
5. **Face Search (1:N)** — 워크플로에 Face Search / Duplicate detection 을 켠다. 임계값은 콘솔 **권장값을 그대로** 둔다.
   매칭 시 동작은 "In Review" 를 권장한다 — 서버는 어떤 경우든 `matches[]` 가 있으면 자동 승인하지 않는다.
6. **Workflow ID 확인** — 워크플로 상세 화면의 ID → `DIDIT_WORKFLOW_ID`.
7. **API Key 확인** — Application → API keys → `DIDIT_API_KEY`. 키는 절대 앱 코드/`.env.example`/문서에 적지 않는다.
8. **웹훅 destination 등록 (반드시 V3)** — Application → Webhooks → URL
   `https://<PROJECT_REF>.supabase.co/functions/v1/didit-webhook` (staging/production 프로젝트별로 각각).
   **Webhook version 은 `v3`** 로 선택하고 세션 이벤트(`status.updated`, `data.updated`)를 구독한다.
   V3 가 아니면 `event_id` 와 `liveness_checks[]` 구조가 오지 않아 서버가 결과를 승인 근거로 쓰지 않는다.
   (API 로 만들 때: `POST /v3/webhook/destinations/` with `webhook_version: "v3"`.)
9. **웹훅 Secret 저장** — 콘솔이 보여주는 webhook secret → `DIDIT_WEBHOOK_SECRET`.
10. (선택) 데이터 보존 기간을 정책에 맞게 최소로 설정한다 (9절 참고).

## 7. 관리자 검토 (`in_review` 해소)

관리자 웹(`apps/admin`, 기존 비밀번호 쿠키 인증 `requireAdmin`)의 **얼굴 검토** 메뉴:

- **검토 대기**: `status='in_review'` 행 목록 — 접수 시각, 닉네임, 사용자 id 앞 8자, 세션 id 앞 8자, 사유 코드(`face_search_match` /
  `reference_image_unavailable` / `decision_incomplete`), 시도 횟수, 라이브니스 통과 여부, 참조 이미지 유무.
  **중복으로 매칭된 상대 사용자 정보나 얼굴 이미지는 조회하지도 표시하지도 않는다.**
- **승인**: 서버 액션 → Edge Function `admin-face-review`(service role key 로만 호출) → 서버가 Decision 을 다시 조회해
  `liveness_checks[0].status == Approved` · 행의 `liveness_passed=true` · `reference_path` 존재(없으면 그 자리에서 다운로드·저장 시도)를
  모두 확인한 뒤에만 RPC `face_liveness_admin_review` → `face_liveness_approve`. 조건이 없으면 **관리자도 승인 불가** (409 사유 표시).
- **거절**: `status='rejected'`, `provider_reason='admin_rejected'`, `users.face_verified=false` 유지. 사용자는 새 세션으로 다시 시도할 수 있고
  다른 계정·중복 상세는 노출되지 않는다.
- **복구 필요**: `face_liveness_inconsistent_rows()` (approved 인데 플래그/참조 이미지 없음) — "복구" 버튼이 같은 승인 경로를 다시 실행.
- **감사 기록**: `face_verification_reviews` 에 처리자(`ADMIN_ACTOR_LABEL`)·시각·이전/이후 상태·비고가 승인/거절과 같은 트랜잭션으로 남는다.

`admin-face-review` 는 공개 API 가 아니다. `Authorization` 이 프로젝트의 service role key 와 상수 시간 비교로 일치할 때만 처리하며, 사용자 JWT/anon key 는 401.

## 8. 배포

```bash
# 1) 마이그레이션 (0013 + 0014)
supabase db push --project-ref <PROJECT_REF>

# 2) secret (5절)

# 3) 함수 — start-face-liveness / admin-face-review 는 JWT ON, didit-webhook 은 반드시 --no-verify-jwt
supabase functions deploy start-face-liveness --project-ref <PROJECT_REF>
supabase functions deploy admin-face-review --project-ref <PROJECT_REF>
supabase functions deploy didit-webhook --no-verify-jwt --project-ref <PROJECT_REF>

# production 은 allowlist 스크립트만 사용 (complete-face-verification 을 배포하지 않고, DIDIT_* secret 존재를 확인한다)
bash supabase/scripts/deploy-production.sh <PROJECT_REF>
```

PowerShell 에서는 Bash 의 `\` 줄바꿈을 쓰지 않는다. 한 줄로 쓰거나 백틱(`` ` ``)으로 잇는다.
`supabase functions deploy` 를 인자 없이 실행하면 `dev-login` 과 `complete-face-verification` 까지 배포되므로 production 에서는 금지한다.

### 웹훅 테스트 (실비용 없음)

```bash
# 1) selftest 가 v3 파서/서명/재조회/멱등/전이/복구 시나리오를 전부 검증한다 (외부 호출 없음)
cd supabase/functions/_shared/face && node --experimental-strip-types selftest.ts

# 2) 배포된 함수에 직접 서명한 V3 형태 요청을 보내 401/200 을 확인한다 (session_id 가 DB 에 없으므로 200 {ignored:"unknown_session"})
BODY='{"event_id":"evt-manual-1","webhook_type":"status.updated","session_id":"test-session","status":"In Progress","created_at":'"$(date +%s)"',"timestamp":'"$(date +%s)"',"vendor_data":"test"}'
SIG=$(node --experimental-strip-types -e "import('./supabase/functions/_shared/face/diditWebhookVerifier.ts').then(m=>m.computeDiditSignatureV2(process.env.SECRET, JSON.parse(process.env.BODY)).then(console.log))" )
curl -i -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/didit-webhook" -H "Content-Type: application/json" -H "X-Signature-V2: $SIG" -H "X-Timestamp: $(date +%s)" --data "$BODY"
# 서명을 바꿔 보내면 401 {"error":"bad_signature"}, webhook_type 을 transaction.status.updated 로 바꾸면 200 {"ignored":"unsupported_event"}
```

Didit 콘솔의 "Send test webhook" 을 쓰면 실제 서명으로 같은 검증을 할 수 있다. Edge Function 로그에는
`[didit-webhook] rejected: bad_signature` 또는 `[face] session xxxxxxxx… → approved (liveness_approved)` 같은 고정 코드만 남는다.

## 9. 모바일 — Development Build 필수, SDK 로그

Didit SDK 는 네이티브 모듈(TurboModule, 카메라)이므로 **Expo Go 에서는 동작하지 않는다.**
Expo Go 에서 실행하면 앱은 죽지 않고 "이 빌드에서는 얼굴 확인을 실행할 수 없어요 … 개발 빌드로 실행해 주세요" 를 보여준다
(`diditSdk.ts` 가 lazy require + `executionEnvironment === 'storeClient'` 감지).

`app.json` 플러그인 설정 (`autodetection` = 자동 촬영 ON, NFC OFF — `core` 로 바꾸면 수동 셔터가 되므로 쓰지 않는다):

```json
["@didit-protocol/sdk-react-native", { "iosVariant": "autodetection", "androidVariant": "autodetection", "iosNfcEnabled": false, "androidNfcEnabled": false }]
```

앱은 `startVerification(token, { defaultLivenessCamera: Front, showLivenessCameraSwitchButton: false, closeOnComplete: true, loggingEnabled: false })` 로 호출한다.

### SDK 세션 토큰 로그 제거 (patch-package)

`@didit-protocol/sdk-react-native` 4.7.5 의 Android 브리지(`SdkReactNativeModule.kt`)는 앱의 `loggingEnabled:false` 와 무관하게
`Log.d(TAG, "startVerification: token=${token.take(8)}...")` 로 세션 토큰 앞 8자를, `startVerificationWithWorkflow` 에서 workflow id / vendor_data /
metadata / contact & expected details 를 logcat 에 남긴다. 확인 시점(2026-09-07)의 최신 4.7.6 에도 같은 코드가 있어(네이티브 SDK 버전만 올림)
업그레이드로는 해결되지 않는다. 그래서:

- SDK 를 `4.7.5` 로 **정확히 고정** 하고 `apps/mobile/patches/@didit-protocol+sdk-react-native+4.7.5.patch` 로 해당 로그의 값을 제거한다.
- `package.json` 의 `"postinstall": "patch-package"` 가 `npm install`/`npm ci` (EAS Build 포함) 마다 patch 를 적용한다. `patch-package` 는 `dependencies` 에 있다.
- `node_modules` 를 직접 고친 상태로 두지 않는다. SDK 버전을 올리면 patch 파일 이름/내용을 다시 만든다 (`npx patch-package @didit-protocol/sdk-react-native`).
- iOS 브리지(`DiditSdkBridge.swift`)와 JS 래퍼에는 토큰/식별자 로그가 없다 (확인 스크립트가 함께 검사).

검증:

```bash
cd apps/mobile
npm ci                                   # postinstall 이 patch 적용
npm run sdk:verify-no-token-log          # OK: … 로그가 없습니다  (patch 미적용/버전 불일치면 종료 코드 1)
# Release 빌드 실기기 (Android):
adb logcat -c && adb logcat -s SdkReactNative:* DiditSdk:* | grep -iE 'token=|vendorData=|workflowId=|metadata='   # 얼굴 확인 1회 수행 → 출력 0줄이어야 한다
# iOS: Console.app 에서 프로세스 필터 후 같은 문자열 검색 → 0건
```

요구사항 (SDK 4.7.5 기준): React Native 0.76+ New Architecture, iOS 13+, Android API 24+. 이 앱은 Expo SDK 57 / RN 0.86 이라 충족한다.
**Bundle ID / Android package 는 저장소에 없다.** 스토어 식별자가 확정되면 `app.json` 에 직접 추가한다 (임의 값을 커밋하지 않는다).
빌드/EAS 절차는 이전과 같다 (`npx eas build --profile development --platform ios|android`). 이 저장소에는 `eas.json` 이 없다.

이 환경에서 확인한 것: `expo prebuild --no-install --platform android` 가 `gradle.properties` 에 `diditSdkAndroidVariant=autodetection` 을 생성한다.
실제 Gradle/Xcode 빌드와 기기 실행은 자격증명·실기기가 필요해 수행하지 못했다.

## 10. 개인정보 보호

코드로 강제되는 것:

- 얼굴 이미지·생체 특징은 상대 사용자에게 절대 공개되지 않는다 (private bucket, public URL 없음, `liveness/` 하위는 클라이언트 접근 자체 불가).
- raw video / audit image / 전체 Provider 응답·웹훅 payload / `matches[]` 내용을 저장하지 않는다 (DB 에는 상태·점수·방식·사유 코드·경로만).
- 로그에 API Key·session token·얼굴 URL·workflow id·application/environment 원문·전화번호를 남기지 않는다 (세션 id 축약 + 고정 코드). SDK Android 로그도 patch 로 제거.
- `feature_vector` 는 만들지 않는다 (null). 얼굴 임베딩은 이번 작업 범위가 아니다.

목적 분리: **라이브니스·중복계정 방지 목적** (현재) 과 **외모 매칭 목적** (향후 — reference image 를 임베딩 입력으로 쓰기 전 **별도 동의** 필수).

회원 탈퇴 시 삭제 경로 (후속 작업 TODO — `delete-account` 에 아직 연결되지 않음):
1. storage `faces/<user_id>/liveness/*` 삭제 (service role). 2. `face_verifications` 행의 `reference_path` 제거/익명화.
3. Didit 측 삭제: `DiditFaceLivenessProvider.deleteSession(session_id)` (`DELETE /v3/session/{id}/delete/`, 2xx 성공) 를 해당 사용자의 모든 `provider_session_id` 에 대해 호출.
4. Face Search 인덱스 제거 여부를 Didit 정책으로 확인.

**출시 차단 조건 — 개인정보처리방침 (이 작업에서 문구를 완성하지 않았다. 법무 검토 필요):**

- [ ] TODO: 민감정보(생체정보) 처리 항목·목적·보유기간 고지 및 **별도 동의** 문구
- [ ] TODO: Didit(Provider) 에 대한 처리위탁·**국외 이전** 고지 (서버 위치·이전받는 자·항목·목적·보유기간)
- [ ] TODO: 라이브니스 목적과 **외모 매칭 목적을 분리** 해 고지, 매칭 목적은 추가 동의
- [ ] TODO: 탈퇴 시 Provider 데이터 삭제 절차·기간 고지
- [ ] TODO: Didit 과의 DPA 및 보존 기간 설정 확인

## 11. Provider 장애 / 운영 대응

- `start-face-liveness` 가 503 `provider_unavailable` 을 돌려주면 앱은 재시도만 허용한다. 행은 `expired/provider_create_failed`, 연타는 시간당 5회 상한이 막는다.
- 웹훅은 Decision 재조회/RPC 실패 시 503 (event_id 미기록) → Didit 이 재시도한다. 놓친 세션은 앱의 `sync`, 관리자 화면의 "복구",
  또는 `select * from face_liveness_inconsistent_rows()` 로 찾아 처리한다.
- 장애 중에는 절대 Mock 으로 전환하지 않는다. 얼굴 인증 없이 온보딩을 통과시키는 우회 경로는 없다.
- 오래 남은 pending 은 `face_liveness_expire_stale(interval '1 day')`, 오래된 웹훅 이벤트 기록은 `face_liveness_prune_webhook_events(interval '7 days')` 로 정리한다 (pg_cron 권장).
- 운영자가 승인을 취소해야 할 때만 트랜잭션 안에서 `set_config('app.face_verification_override','on',true)` 후 갱신한다.

## 12. 테스트

자동 (외부 API 호출 없음 — fetch mock, 실제 얼굴/실사용자/실제 Didit 응답 없음):

```bash
cd supabase/functions/_shared/face && node --experimental-strip-types selftest.ts        # 서버 로직 284건 (v3 fixture 17종 · 웹훅 · 복구 · 관리자)
bash supabase/tests/run_local_check.sh                                                    # 마이그레이션 0001~0014 + RLS + face_liveness_tests.sql + 승인 RPC 동시성(2 세션)
npx deno@2 check supabase/functions/start-face-liveness/index.ts supabase/functions/didit-webhook/index.ts supabase/functions/complete-face-verification/index.ts supabase/functions/admin-face-review/index.ts
cd apps/mobile && node --experimental-strip-types scripts/face-liveness-selftest.mjs      # 화면 흐름 103건 (v3 상태 · 승인 복구 포함)
cd apps/mobile && npx tsc --noEmit && npx expo lint && npm run sdk:verify-no-token-log
cd apps/admin && npx tsc --noEmit
```

실기기 수동 체크리스트 (iOS / Android 실제 기기 각각, Development Build) — **미수행**:

- [ ] 실제 얼굴: 안내 동작을 따라 하면 촬영 버튼 없이 자동 완료 → "확인 결과를 처리하고 있어요" → 프로필 단계로 이동
- [ ] SDK 화면이 앱 안의 네이티브 화면이다 (WebView/외부 브라우저 아님)
- [ ] 인쇄된 얼굴 사진 / 다른 휴대폰에서 재생한 얼굴 영상 / 두 명 / 얼굴 없음 / 마스크·손 가림 / 저조도·역광 → 각각 실패·재시도 안내
- [ ] 중간에 닫기(X) → "얼굴 확인을 중단했어요" → 다시 시도 가능, 온보딩 처음으로 돌아가지 않음
- [ ] 카메라 권한 거부 → 설정 안내 → 허용 후 재시도 성공 · 비행기 모드 → 네트워크 오류 안내
- [ ] 결과 대기 중 앱 종료 후 재실행 → "확인 결과를 처리하고 있어요" 로 복원되고 승인되면 다음 단계
- [ ] Didit 콘솔에서 세션을 Resubmit 하면 앱이 "얼굴 확인을 다시 진행해 주세요" 를 보여주고 새 세션으로 재시작된다 (승인 아님)
- [ ] 같은 사람이 다른 전화번호로 재가입 → `matches[]` 로 `in_review` (자동 승인 없음, 상대 계정 정보 미노출) → 관리자 화면에서 승인/거절 → 앱 "결과 다시 확인" 이 반영
- [ ] 시간당 6번째 세션 시도 → "시도 횟수를 초과했어요"
- [ ] Supabase DB: `face_verifications` 에 `provider_session_id`, `liveness_score`, `reference_path=<uid>/liveness/reference.jpg`, `verified_at` 가 있고 `users.face_verified=true` 가 **같은 시점** 에 바뀐다
- [ ] `face_webhook_events` 에 event_id 가 쌓이고, 콘솔에서 웹훅을 재전송하면 함수 로그에 Decision 재조회 없이 `duplicate` 로 끝난다
- [ ] Storage: `faces/<uid>/liveness/reference.jpg` 가 있고 앱(사용자 JWT)으로는 읽히지 않는다
- [ ] Edge Function 로그에 토큰·URL·전체 payload·workflow id 가 없다 · Android logcat 에 `token=` 이 없다 (9절)
- [ ] release 빌드에 "개발 모드: 얼굴 인증 통과" 버튼이 없다

## 13. 남은 조건 (미완료)

- Didit 콘솔 설정(Liveness-only 워크플로 · 3D Action & Flash · Face Search · **V3 웹훅 destination**) + secret 4개 등록 — 운영자
- Supabase staging: `0014` 마이그레이션 적용, `admin-face-review` 배포, 관리자 웹 `ADMIN_ACTOR_LABEL`(선택) — 운영자
- Bundle ID / package 확정 후 Development Build 로 실기기 체크리스트(12절) 통과 — 실제 Didit 응답 형태 1회 확인 포함
- 개인정보처리방침 개정 + 외모 매칭 목적 별도 동의 (10절 TODO) — 출시 차단
- `delete-account` 에 Didit 세션 삭제·storage 삭제 연결 (10절 TODO)
- 얼굴 임베딩(다음 작업)은 `status='approved' and reference_path is not null` 행만 입력으로 사용한다
