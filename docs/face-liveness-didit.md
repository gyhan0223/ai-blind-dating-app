# 얼굴 라이브니스 — Didit 능동형 라이브니스(3D Action & Flash) 연동

이 문서는 얼굴 인증 단계를 **Mock(정면/좌/우 수동 촬영 + 파일 존재 확인)** 에서
**Didit 네이티브 SDK 의 실제 능동형 라이브니스** 로 교체한 구조와, 운영자가 직접 해야 하는 설정을 설명한다.

> 한 줄 요약: 앱은 카메라 화면을 열고 결과만 받는다. **승인은 오직 서버가** 서명 검증된 Didit 웹훅과
> Didit Decision API 재조회 결과로만 내린다. production 에서는 Mock 도, 클라이언트 조작도 승인이 될 수 없다.

## 1. 사용자 흐름

```text
[얼굴 확인 안내] ─ "얼굴 확인 시작" ─▶ start-face-liveness (JWT)
                                          │  Didit POST /v3/session/ (서버, API Key)
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
   Didit ──웹훅(X-Signature-V2)──▶ didit-webhook ──Decision 재조회──▶ face_verifications approved
                                                                        users.face_verified = true
                                          ▼
                     앱이 DB 의 face_verified=true 를 확인 → 다음 온보딩 단계(profile)
```

- 라이브니스 방식: Didit 워크플로에서 **Active — 3D Action & Flash** (콘솔 표기상 최고 보안 등급의 Active Liveness).
  사진·다른 휴대폰에서 재생한 영상·화면 재촬영·딥페이크·마스크 공격 방어는 이 방식과 Didit 워크플로 설정이 담당한다.
  앱은 자체 라이브니스 판정 코드를 두지 않는다.
- 세션 안 재시도 횟수(최대 3회)는 Didit 워크플로 설정(`face_liveness_max_attempts`)이 관리한다.
  앱/서버는 **세션 생성 횟수** 를 따로 제한한다 (시간당 5회, 하루 10회 — `face_liveness_begin_session`).
- 실패(취소·권한 거부·조명·가림·시도 초과·Provider 장애 등)하면 얼굴 확인만 다시 시도한다. 온보딩 전체를 되돌리지 않는다.
- Didit Face Search(1:N) 가 중복 얼굴을 의심하면 **자동 승인하지 않고 `in_review`** 로 둔다. 자동 차단/삭제 없음.
  어떤 계정과 유사한지는 저장·노출하지 않으며 사유 코드(`face_search_match`)만 남긴다 (일란성 쌍둥이·오탐 대비 관리자 검토용).
- 라이브니스는 **"실제 사람이 카메라 앞에 있다"** 만 확인한다. 실명·생년월일·성인 여부는 증명하지 않는다
  (본인확인은 `verify-identity` / 향후 KCP 본인인증이 담당).

## 2. 구성 요소

| 영역 | 파일 | 역할 |
|---|---|---|
| DB | `supabase/migrations/0013_face_liveness.sql` | `face_verifications` 확장(상태 5종, provider_session_id UNIQUE, 점수 범위, reference_path 범위), 클라이언트 쓰기 차단 트리거, 상태 전이 보호 트리거, 세션 생성 rate-limit RPC, storage `liveness/` 하위 클라이언트 접근 차단 |
| 서버 공용 | `supabase/functions/_shared/face/faceCore.ts` | Didit 상태/Decision → 내부 도메인 상태 변환, 보수적 판정(`resolveOutcome`), 전이 규칙 |
| | `_shared/face/diditWebhookVerifier.ts` | `X-Signature-V2` HMAC-SHA256 검증 (canonical JSON), 타임스탬프 ±5분, 상수 시간 비교 |
| | `_shared/face/diditClient.ts` | Didit API 클라이언트 (세션 생성 / Decision 조회 / 세션 삭제 / reference image 다운로드) |
| | `_shared/face/FaceLivenessProvider.ts` | Provider 추상화 (`didit` 실제 / `mock` 개발 전용), secret 로더 (fail-closed) |
| | `_shared/face/faceOutcome.ts` | Decision → DB 반영 (승인 경로는 이 함수 하나) |
| | `_shared/face/startFaceLivenessCore.ts`, `diditWebhookCore.ts` | Edge Function 핵심 로직 (순수 모듈, Node selftest) |
| | `_shared/face/supabaseFaceDb.ts` | service role DB/storage 어댑터 |
| Edge Function | `start-face-liveness` | JWT 검증 → 세션 생성(`start`) / 서버 재조회(`sync`) |
| | `didit-webhook` | JWT 없음, 서명 검증 → Decision 재조회 → 상태 반영 (`--no-verify-jwt` 배포) |
| | `complete-face-verification` | **개발 전용 Mock** 즉시 승인. `FACE_VERIFICATION_PROVIDER=mock` 일 때만 기동, production 미배포 |
| 모바일 | `apps/mobile/src/services/face/faceFlowCore.ts` | 화면 상태 기계·오류 코드·한국어 문구 (순수 모듈, Node selftest) |
| | `apps/mobile/src/services/face/diditSdk.ts` | SDK 브리지 (lazy require — Expo Go 에서 앱이 죽지 않게) |
| | `apps/mobile/src/services/face/index.ts` | 서버 호출 (`start-face-liveness`), 본인 행 조회, 개발용 Mock 호출 |
| | `apps/mobile/src/app/onboarding/face.tsx` | 화면 |
| | `apps/mobile/app.json` | Didit config plugin (autodetection 변형, NFC 끔), iOS/Android 권한 문구 |

### Mock 과 실제 Didit 흐름의 분리

| | Mock (`FACE_VERIFICATION_PROVIDER=mock`) | Didit (`=didit`) |
|---|---|---|
| 허용 환경 | development / staging 만 (production 은 `_shared/env` 가 cold start 에서 거부) | 모든 환경 |
| 세션 생성 (`start-face-liveness`) | 409 `provider_is_mock` — 세션을 만들지 않는다 | Didit 세션 생성 |
| 웹훅 (`didit-webhook`) | 503 `provider_not_didit` | 서명 검증 + 재조회 |
| 승인 경로 | `complete-face-verification` (앱의 "개발 모드: 얼굴 인증 통과" 버튼, `__DEV__ && DEV_TOOLS_ENABLED` 에서만 존재) | 웹훅/sync → `faceOutcome.applyDecisionToRow` |
| production 배포 | allowlist 제외 + 배포돼 있으면 `deploy-production.sh` 가 중단 + 기동 자체 거부 (3중) | `start-face-liveness`, `didit-webhook` |

알 수 없는 provider 이름(예: `acme`)은 세 함수 모두 cold start 에서 throw 한다 (fail-closed).

## 3. 서버가 최종 승인하는 과정

1. `didit-webhook` 이 요청을 받는다. `DIDIT_WEBHOOK_SECRET` 이 없으면 500 (fail-closed).
2. `X-Signature-V2` 를 검증한다: `HMAC-SHA256(secret, canonical_json(body))` hex.
   canonical JSON = 키 정렬 + 공백 없는 구분자 + 유니코드 비이스케이프 (Didit 공식 데모의 Python `json.dumps(sort_keys=True, separators=(',',':'))` 와 동일).
   `X-Timestamp`(없으면 body `created_at`) 가 ±300초 밖이면 replay 로 거부. 실패는 전부 401.
   약한 방식(`X-Signature`, `X-Signature-Simple`)으로 fallback 하지 않는다.
3. `session_id` 로 `face_verifications` 행을 찾는다 (없으면 200 ignored). `vendor_data` 가 있으면 행의 `user_id` 와 일치해야 한다 — vendor_data 만으로 사용자를 정하지 않는다.
4. 같은 이벤트 재전송(같은 `created_at` + 같은 status)은 200 duplicate. 이미 approved 인 행은 어떤 이벤트로도 바뀌지 않는다. 저장된 이벤트보다 오래된 이벤트는 무시.
5. `Approved` / `Declined` / `In Review` 는 웹훅 본문을 믿지 않고 **서버가 `GET /v2/session/{id}/decision/` 을 직접 조회** 한다.
   조회 실패·불완전한 응답(liveness 객체 없음 등)이면 승인하지 않고 503 → Didit 이 재시도.
6. `faceCore.resolveOutcome`: 전체 `Approved` **and** `liveness.status == Approved` 일 때만 approved.
   Face Search 중복 의심 → `in_review`(Provider 가 Declined 면 rejected). 전체 Approved 인데 liveness 가 Approved 가 아니면 `in_review`(`decision_incomplete`).
7. approved 이면 `liveness.reference_image`(https 서명 URL)를 서버에서 즉시 다운로드 → MIME(`image/jpeg|png`)·크기(≤5MB) 확인 → private bucket `faces` 의 `<user_id>/liveness/reference.jpg` 에 저장 → DB 에는 경로만.
   영상·audit image·전체 응답은 저장하지 않는다. 이미지 확보에 실패해도 승인은 유지되고 `provider_reason=reference_image_unavailable` 로 남는다.
8. `face_verifications.status='approved'`, `liveness_passed=true`, `verified_at` → 그 다음에만 `users.face_verified=true`.
9. DB 트리거가 최종 방어: approved → 다른 상태 전이 거부, `provider_event_at` 이 과거인 갱신 거부, 클라이언트(JWT) 컨텍스트의 insert/update/delete 전부 거부.

앱의 `sync` 요청(`start-face-liveness` `action:'sync'`)도 같은 `applyDecisionToRow` 를 타며, 클라이언트가 보낸 값 중 쓰는 것은 본인 소유 확인용 `sessionId` 뿐이다.

## 4. Secret / 환경변수

모두 **Supabase Secrets(서버) 전용** 이다. `EXPO_PUBLIC_*`, 모바일 번들, 로그, DB 에 넣지 않는다.

| 이름 | 값 | 비고 |
|---|---|---|
| `FACE_VERIFICATION_PROVIDER` | `didit` | production 필수. `mock`/미설정/미구현 이름이면 함수 기동 거부 |
| `DIDIT_API_KEY` | Didit 콘솔 API Key | 세션 생성·Decision 조회·세션 삭제 |
| `DIDIT_WORKFLOW_ID` | Liveness-only 워크플로 ID | |
| `DIDIT_WEBHOOK_SECRET` | 콘솔 웹훅 secret | `X-Signature-V2` 검증 |
| `DIDIT_API_BASE_URL` (선택) | 기본 `https://verification.didit.me` | 보통 설정하지 않는다 |

```bash
supabase secrets set FACE_VERIFICATION_PROVIDER=didit DIDIT_API_KEY=<key> DIDIT_WORKFLOW_ID=<workflow-id> DIDIT_WEBHOOK_SECRET=<secret> --project-ref <PROJECT_REF>
```

PowerShell (한 줄):

```powershell
supabase secrets set FACE_VERIFICATION_PROVIDER=didit DIDIT_API_KEY=<key> DIDIT_WORKFLOW_ID=<workflow-id> DIDIT_WEBHOOK_SECRET=<secret> --project-ref <PROJECT_REF>
```

값을 모르는 상태에서도 코드는 빌드·테스트된다 (secret 은 런타임에만 읽는다). 실제 값을 저장소에 커밋하지 않는다.

## 5. Didit 콘솔 설정 (운영자가 직접)

1. **계정/앱 생성** — https://business.didit.me 에서 가입 후 Application 을 만든다.
2. **Liveness-only 워크플로 생성** — Workflows → New workflow. 단계는 **Liveness 만** 추가한다.
   신분증(ID Verification), AML, 주소 인증, NFC, Phone/Email 단계는 넣지 않는다.
3. **Liveness 방식** — Liveness 노드 설정에서 **Active → `3D Action & Flash`** 를 선택한다
   (콘솔 표기가 바뀌었다면 "Action + Flash" 를 포함하는 최고 보안 등급의 Active 방식). Passive/Flash 단독은 선택하지 않는다.
4. **재시도 횟수** — `Max attempts` = **3**.
5. **Face Search (1:N)** — 워크플로에 Face Search / Duplicate detection 을 켠다. 임계값은 콘솔 **권장값을 그대로** 둔다
   (서버는 로컬 임계값을 두지 않고 Provider 판정을 그대로 따른다). 매칭 시 동작은 "In Review" 를 권장한다 — 서버도 어떤 경우든 자동 승인하지 않는다.
6. **Workflow ID 확인** — 워크플로 상세 화면의 ID 를 복사 → `DIDIT_WORKFLOW_ID`.
7. **API Key 확인** — Application → API keys → `DIDIT_API_KEY`. 키는 절대 앱 코드/`.env.example`/문서에 적지 않는다.
8. **웹훅 URL 등록** — Application → Webhooks → URL:
   `https://<PROJECT_REF>.supabase.co/functions/v1/didit-webhook` (staging/production 프로젝트별로 각각).
   이벤트: 세션 status 변경(`status.updated`). Didit 은 V2/V1/Simple 서명 헤더를 모두 보낸다.
9. **웹훅 Secret 저장** — 콘솔이 보여주는 webhook secret → `DIDIT_WEBHOOK_SECRET`.
10. (선택) 데이터 보존 기간을 정책에 맞게 최소로 설정한다 (8절 참고).

## 6. 배포

```bash
# 1) 마이그레이션 (0013_face_liveness.sql)
supabase db push --project-ref <PROJECT_REF>

# 2) secret (4절)

# 3) 함수 — start-face-liveness 는 JWT ON, didit-webhook 은 반드시 --no-verify-jwt
supabase functions deploy start-face-liveness --project-ref <PROJECT_REF>
supabase functions deploy didit-webhook --no-verify-jwt --project-ref <PROJECT_REF>

# production 은 allowlist 스크립트만 사용 (complete-face-verification 을 배포하지 않고, DIDIT_* secret 존재를 확인한다)
bash supabase/scripts/deploy-production.sh <PROJECT_REF>
```

PowerShell 에서는 Bash 의 `\` 줄바꿈을 쓰지 않는다. 한 줄로 쓰거나 백틱(`` ` ``)으로 잇는다:

```powershell
supabase functions deploy didit-webhook --no-verify-jwt --project-ref <PROJECT_REF>

supabase functions deploy didit-webhook `
  --no-verify-jwt `
  --project-ref <PROJECT_REF>
```

`supabase functions deploy` 를 인자 없이 실행하면 `dev-login` 과 `complete-face-verification` 까지 배포되므로 production 에서는 금지한다.

### 웹훅 테스트 (실비용 없음)

```bash
# 1) selftest 가 서명/재조회/멱등/전이 시나리오를 전부 검증한다
cd supabase/functions/_shared/face && node --experimental-strip-types selftest.ts

# 2) 배포된 함수에 직접 서명한 요청을 보내 401/200 을 확인한다 (session_id 는 DB 에 없으므로 200 {ignored:"unknown_session"})
BODY='{"session_id":"test-session","status":"In Progress","webhook_type":"status.updated","created_at":'"$(date +%s)"',"timestamp":'"$(date +%s)"',"vendor_data":"test"}'
# canonical JSON(키 정렬·compact) 의 HMAC — 위 selftest 의 computeDiditSignatureV2 와 같은 규칙
SIG=$(node --experimental-strip-types -e "import('./supabase/functions/_shared/face/diditWebhookVerifier.ts').then(m=>m.computeDiditSignatureV2(process.env.SECRET, JSON.parse(process.env.BODY)).then(console.log))" )
curl -i -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/didit-webhook" -H "Content-Type: application/json" -H "X-Signature-V2: $SIG" -H "X-Timestamp: $(date +%s)" --data "$BODY"
# 서명을 바꿔 보내면 401 {"error":"bad_signature"} 이어야 한다
```

Didit 콘솔의 "Send test webhook" 을 쓰면 실제 서명으로 같은 검증을 할 수 있다. Edge Function 로그에는
`[didit-webhook] rejected: bad_signature` 또는 `[face] session xxxxxxxx… → approved (liveness_approved)` 같은 고정 코드만 남는다.

## 7. 모바일 — Development Build 필수

Didit SDK 는 네이티브 모듈(TurboModule, 카메라)이므로 **Expo Go 에서는 동작하지 않는다.**
Expo Go 에서 실행하면 앱은 죽지 않고 "이 빌드에서는 얼굴 확인을 실행할 수 없어요 … 개발 빌드로 실행해 주세요" 를 보여준다
(`diditSdk.ts` 가 lazy require + `executionEnvironment === 'storeClient'` 감지).

요구사항 (SDK 4.7.5 기준): React Native 0.76+ New Architecture, iOS 13+ (autodetection 변형 — NFC 를 끄면 iOS 15 요구 없음),
Android API 24+, Kotlin 1.9+, Java 17+. 이 앱은 Expo SDK 57 / RN 0.86 (New Architecture 기본) 이라 충족한다.

`app.json` 플러그인 설정:

```json
[
  "@didit-protocol/sdk-react-native",
  { "iosVariant": "autodetection", "androidVariant": "autodetection", "iosNfcEnabled": false, "androidNfcEnabled": false }
]
```

- `autodetection` = 자동 촬영 ON, NFC OFF. `core` 로 바꾸면 NFC 는 꺼지지만 **얼굴 촬영이 수동 셔터 버튼으로 바뀌므로** 쓰지 않는다.
  (legacy 키 `androidNfcEnabled:false` 만 주면 Android 가 `core` 가 되어 자동 촬영이 사라진다 — 그래서 variant 키를 명시한다.)
- 권한: iOS `NSCameraUsageDescription`, `NSMicrophoneUsageDescription` 만 한국어로 설정. 사진첩/NFC 문구·capability 는 넣지 않는다.
  Android 는 `CAMERA` 만 요청하고 `NFC`, `READ_MEDIA_IMAGES`, `READ_EXTERNAL_STORAGE` 는 `blockedPermissions` 로 제거한다.
  런타임 카메라 권한 요청은 SDK 가 직접 한다.
- **Bundle ID / Android package 는 저장소에 없다.** 스토어 식별자가 확정되면 `app.json` 의 `ios.bundleIdentifier`, `android.package` 를
  직접 추가한다 (임의 값을 커밋하지 않는다). 없으면 `expo prebuild` / EAS build 가 값을 물어본다.

빌드:

```bash
cd apps/mobile
npm install
# EAS (권장)
npx eas build --profile development --platform ios      # Apple 개발자 계정 · 기기 UDID 등록 필요
npx eas build --profile development --platform android
# 또는 로컬 native build (macOS + Xcode / Android Studio)
npx expo prebuild --platform ios && npx expo run:ios --device
npx expo prebuild --platform android && npx expo run:android --device
```

이 저장소에는 `eas.json` 이 없다. `npx eas build:configure` 로 생성한 뒤 `development` 프로필에 `developmentClient: true` 를 둔다.
iOS 는 CocoaPods 가 `DiditSDK.podspec` 을 GitHub(raw.githubusercontent.com) 에서, Android 는 Gradle 이 Didit Maven 저장소를
GitHub 에서 받는다 — 빌드 머신의 네트워크에서 두 호스트가 열려 있어야 한다.

이 저장소에서 확인한 것: `expo prebuild --no-install` 결과 Podfile 에 `$DiditSdkIosVariant = 'autodetection'` 블록,
`gradle.properties` 에 `diditSdkAndroidVariant=autodetection`, Maven 저장소·BouncyCastle 제외 규칙, Info.plist 의 카메라/마이크 한국어 문구가
생성된다. 실제 `pod install`/Gradle 빌드와 기기 실행은 Apple 자격증명·실기기가 필요해 이 환경에서는 수행하지 못했다.

## 8. 개인정보 보호

코드로 강제되는 것:

- 얼굴 이미지·생체 특징은 상대 사용자에게 절대 공개되지 않는다 (private bucket, public URL 없음, `liveness/` 하위는 클라이언트 접근 자체 불가).
- raw video / audit image / 전체 Provider 응답·웹훅 payload 를 저장하지 않는다 (DB 에는 상태·점수·방식·사유 코드·경로만).
- 로그에 API Key·session token·얼굴 URL·전화번호를 남기지 않는다 (세션 id 축약 + 고정 코드).
- `feature_vector` 는 만들지 않는다 (null). 사용자가 예전에 올린 `front/left/right.jpg` 는 라이브니스 검증 이미지가 아니므로 새 흐름에서 신뢰하지 않고 임베딩 입력으로도 쓰지 않는다 (파괴적 삭제는 하지 않았다).

목적 분리:

- **라이브니스·중복계정 방지 목적** (이번 작업): 실제 사람 확인 + Face Search 1:N.
- **외모 매칭 목적** (향후): reference image 를 얼굴 임베딩 입력으로 쓰기 전에 **별도 동의** 가 필요하다. 동의 없이 매칭에 사용하지 않는다.

회원 탈퇴 시 삭제 경로 (후속 작업 TODO — `delete-account` 에 아직 연결되지 않음):

1. Supabase storage `faces/<user_id>/liveness/*` 삭제 (service role).
2. `face_verifications` 행의 `reference_path` 제거 / 행 익명화 (정책 확정 후).
3. Didit 측 세션·생체 데이터 삭제: `DiditFaceLivenessProvider.deleteSession(session_id)` (`DELETE /v2/session/{id}/delete/`) 를
   해당 사용자의 모든 `provider_session_id` 에 대해 호출. Didit 콘솔의 데이터 보존 기간도 함께 확인.
4. Face Search 인덱스에서 제거되는지 Didit 정책 확인 (탈퇴 후 재가입 중복 탐지 정책과 함께 결정).

Production 전 체크리스트 (개인정보처리방침):

- [ ] 민감정보(생체정보) 처리 항목·목적·보유기간 고지 및 **별도 동의** 문구
- [ ] 국외 이전 고지 (Didit 서버 위치·이전받는 자·이전 항목·목적·보유기간)
- [ ] 라이브니스 목적과 외모 매칭 목적을 분리해 고지, 매칭 목적은 추가 동의
- [ ] 탈퇴 시 Provider 데이터 삭제 절차·기간 고지
- [ ] Didit 과의 처리위탁 계약(DPA) 및 보존 기간 설정 확인

## 9. Provider 장애 시 운영 대응

- `start-face-liveness` 가 503 `provider_unavailable` 을 돌려주면 앱은 "지금은 얼굴 확인을 할 수 없어요" 를 보여주고 재시도만 허용한다.
  세션 행은 `expired/provider_create_failed` 로 마감되며, 연타는 시간당 5회 상한이 막는다.
- 웹훅은 Decision 재조회 실패 시 503 을 돌려주므로 Didit 이 재시도한다. 재시도가 끝나 놓친 세션은 앱의 `sync` 나
  운영자가 `POST start-face-liveness {action:'sync', sessionId}` (해당 사용자 JWT) 로 다시 맞출 수 있다.
- 장애 중에는 절대 Mock 으로 전환하지 않는다 (production 에서 `FACE_VERIFICATION_PROVIDER=mock` 은 기동 거부).
  얼굴 인증 없이 온보딩을 통과시키는 우회 경로는 없다.
- 오래 남은 pending 은 `select public.face_liveness_expire_stale(interval '1 day')` 로 정리한다 (pg_cron 권장).
- 운영자가 승인을 취소해야 할 때만 트랜잭션 안에서 `set_config('app.face_verification_override','on',true)` 후 갱신한다.

## 10. 테스트

자동 (외부 API 호출 없음, 실제 얼굴/실사용자 데이터 없음):

```bash
cd supabase/functions/_shared/face && node --experimental-strip-types selftest.ts      # 서버 로직 127건
bash supabase/tests/run_local_check.sh                                                  # 마이그레이션 + RLS + face_liveness_tests.sql
npx deno@2 check supabase/functions/start-face-liveness/index.ts supabase/functions/didit-webhook/index.ts supabase/functions/complete-face-verification/index.ts
cd apps/mobile && node --experimental-strip-types scripts/face-liveness-selftest.mjs    # 화면 흐름 84건
cd apps/mobile && npx tsc --noEmit && npx expo lint
```

실기기 수동 체크리스트 (iOS 실제 기기 / Android 실제 기기 각각, Development Build):

- [ ] 실제 얼굴: 안내 동작을 따라 하면 촬영 버튼 없이 자동 완료 → "확인 결과를 처리하고 있어요" → 프로필 단계로 이동
- [ ] SDK 화면이 앱 안의 네이티브 화면이다 (WebView/외부 브라우저 아님)
- [ ] 인쇄된 얼굴 사진 → 실패 안내
- [ ] 다른 휴대폰에서 재생한 얼굴 영상 → 실패 안내
- [ ] 화면에 두 명의 얼굴 → 실패/재시도 안내
- [ ] 얼굴이 없을 때 → 안내
- [ ] 마스크·손으로 얼굴을 가렸을 때 → 안내
- [ ] 저조도/역광 → 재시도 안내
- [ ] 중간에 닫기(X) → "얼굴 확인을 중단했어요" → 다시 시도 가능, 온보딩 처음으로 돌아가지 않음
- [ ] 카메라 권한 거부 → 설정 안내 버튼 → 설정에서 허용 후 재시도 성공
- [ ] 비행기 모드 → 네트워크 오류 안내
- [ ] 결과 대기 중 앱 종료 후 재실행 → "확인 결과를 처리하고 있어요" 로 복원되고 승인되면 다음 단계
- [ ] 같은 사람이 다른 전화번호로 재가입 → Face Search 로 `in_review` (자동 승인 없음, 상대 계정 정보 미노출)
- [ ] 시간당 6번째 세션 시도 → "시도 횟수를 초과했어요"
- [ ] Supabase DB: `face_verifications` 에 `provider_session_id`, `liveness_score`, `reference_path=<uid>/liveness/reference.jpg` 가 있고 `users.face_verified=true`
- [ ] Storage: `faces/<uid>/liveness/reference.jpg` 가 있고 앱(사용자 JWT)으로는 읽히지 않는다
- [ ] Edge Function 로그에 토큰·URL·전체 payload 가 없다
- [ ] release 빌드에 "개발 모드: 얼굴 인증 통과" 버튼이 없다

## 11. 다음 작업(얼굴 임베딩) 전 남은 조건

- Didit 콘솔 설정 + secret 4개 + 웹훅 URL 등록 (5절)
- Bundle ID / package 확정 후 Development Build 로 실기기 체크리스트 통과 (7·10절)
- `liveness.reference_image` 필드명·Decision 응답 형태를 실제 워크플로 응답으로 1회 확인 (파서는 `reference_image` / `reference_image_url`, `decision` 중첩을 모두 허용)
- 개인정보처리방침 개정 + 외모 매칭 목적 별도 동의 (8절)
- `delete-account` 에 Didit 세션 삭제·storage 삭제 연결 (8절 TODO)
- 임베딩 입력은 `face_verifications.status='approved' and reference_path is not null` 행만 사용한다 (사용자 업로드 `front/left/right.jpg` 는 사용 금지)
