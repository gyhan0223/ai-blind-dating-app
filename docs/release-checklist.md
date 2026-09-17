# Release Checklist

production 배포/앱 출시 전 매번 확인한다. 환경 모델·변수 목록은 `docs/environments.md` 참고.

## Mobile (release 빌드)

- [ ] release 빌드 로그인 화면에 "테스트로 시작하기" 버튼이 **없다**
- [ ] release 빌드 얼굴 인증 화면에 "개발 모드: 얼굴 인증 통과 (Mock)" 버튼이 **없다**
- [ ] release 빌드가 **Development/스토어 빌드** 다 (Expo Go 아님) — 얼굴 확인 시작 시 Didit 네이티브 카메라 화면이 앱 안에서 열린다
- [ ] `app.json` 에 `ios.bundleIdentifier` / `android.package` 가 실제 스토어 값으로 들어 있다 (저장소 기본값에는 없음)
- [ ] iOS 권한 문구가 카메라·마이크 두 개뿐이고 한국어다. 사진첩/NFC 권한을 요청하지 않는다
- [ ] release 빌드 본인확인 화면에 "테스트로 통과하기" 버튼이 **없다**
- [ ] (#39) 온보딩에 **외모 취향 테스트·외모 중요도·이상형 얼굴 선택 화면이 없다** — 순서: 본인확인 → 얼굴 인증 → 기본 정보 → 공개 소개 고르기 → 설문 → 가치관 → 선호 조건 → 홈
- [ ] (#39) 얼굴 인증 화면 문구가 "실제 사람 확인" 목적만 설명하고 이상형 추천처럼 설명하지 않는다 ("서로의 얼굴은 AI만 먼저 봅니다" 없음)
- [ ] (#39/#29) 내 정보 화면에 **Plus/결제/플랜 표시가 없다**. 앱 어디에도 결제 라우트·"결제 준비 중" 문구가 없다
- [ ] (#39) 추천 카드에 고른 항목으로 만든 소개 문장(연애 목적·공개 질문 선택)만 보이고, 가치관 설문·민감 응답은 카드/API 응답에 없다
- [ ] (#40) `daily-recommendation`·`icebreaker` 가 이 저장소의 최신 코드로 재배포되어 있다 (외모 데이터 미조회·인증 플래그 후보 필터·안전 조회 실패 시 500)
- [ ] (#40) 배포 후 새로 생성된 `recommendations.dimensions` 에 `appearance` 키가 없고 `basis` 가 있다:
      `select count(*) from recommendations where created_at > '<배포 시각>' and dimensions ? 'appearance'` → 0
- [ ] (#40) 인증 미완료(`face_verified=false` 등) 사용자로 daily-recommendation 을 호출하면 403 `not_verified` 다
- [ ] (#39) 번들 grep: `외모 취향|이상형|AI만 먼저|본심 Plus|결제는 준비` → 0건 (아래 secret grep 과 함께 확인)
- [ ] production 빌드 환경(EAS 등)에 `EXPO_PUBLIC_DEV_LOGIN` 이 설정되어 있지 **않다**
      (설정돼 있어도 release 빌드에선 무효지만, 아예 제거한다)
- [ ] `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` 가 **production 프로젝트** 값이다
      (localhost/staging 값 아님)
- [ ] (#3) `cd apps/mobile && npm run release:check:selfcheck` 가 통과한다 (검사기가 가짜 secret/마커를 실제로 잡는지)
- [ ] (#3) `cd apps/mobile && npm run release:check` 가 **exit 0** 이다 — web + iOS + Android `expo export` 산출물에서 개발 마커
      (`dev-login` · `complete-face-verification` · `bonsim-dev-password` · `devMockApproveFace` · 개발용 버튼 문구 …) · 서버 secret 이름 · 환경의 secret 값 ·
      `service_role` JWT 가 0건이고, `src/dev/*` 정적 import 가 없다. export 실패·환경 누락은 통과가 아니다 (exit 2). CI(`.github/workflows/ci.yml`)도 같은 검사를 돌린다
- [ ] (#3) 실제 스토어 제출용 release 빌드(EAS build)의 JS 번들에도 같은 검사를 적용한다: `node scripts/check-release-bundle.mjs --scan <EAS 산출물 디렉터리>`
      (EAS 는 이 저장소 밖에서 수행 — 위 정적 검사는 **EAS 네이티브 release·실기기 검증을 대신하지 않는다**)

## Supabase (production 프로젝트)

- [ ] production 과 staging 이 **서로 다른 Supabase 프로젝트**다
- [ ] `dev-login` 함수가 production 에 **배포되어 있지 않다**
      (`supabase functions list --project-ref <prod-ref>` 로 확인)
- [ ] (2차 방어 확인) 실수로 배포돼 있더라도 dev-login 호출이 **403** 을 반환한다
- [ ] production secrets 에 `APP_ENV=production` 이 설정되어 있다
- [ ] production secrets 에 `ALLOW_DEV_LOGIN` 이 **없다** (있어도 무효지만 제거)
- [ ] `IDENTITY_HASH_SECRET` 이 설정되어 있다 — 32자 이상, 개발 기본값·staging 값과 다른 고유 값
- [ ] `IDENTITY_PROVIDER` 가 **실제 provider** 로 설정되어 있다 (`mock` 아님 — mock 이면
      verify-identity 가 기동 실패하는 것이 정상)
- [ ] `FACE_VERIFICATION_PROVIDER=didit` 이다 (`mock` 아님 — mock 이면 start-face-liveness/didit-webhook 이 기동 실패하는 것이 정상)
- [ ] production secrets 에 `DIDIT_API_KEY` / `DIDIT_WORKFLOW_ID` / `DIDIT_WEBHOOK_SECRET` 가 **모두** 있다 (staging 과 다른 앱/값)
- [ ] `complete-face-verification`(개발용 mock) 함수가 production 에 **배포되어 있지 않다** (`supabase functions list`)
- [ ] `didit-webhook` 이 **`--no-verify-jwt` 로 배포**되어 있고 Didit 콘솔 웹훅 URL 이
      `https://<prod-ref>.supabase.co/functions/v1/didit-webhook` 이다 (staging URL 아님)
- [ ] Didit 콘솔 웹훅 destination 의 **version 이 V3** 이고 `status.updated` · `data.updated` 를 구독한다
      (V2 destination 이면 `event_id`/`liveness_checks[]` 가 오지 않아 승인이 되지 않는 것이 정상)
- [ ] Didit 워크플로: Liveness 단계 **하나만** · Active `3D Action & Flash` · 최대 3회 · Face Search 1:N 켜짐 · 신분증/AML/주소/NFC 없음
      (라이브니스 노드가 여러 개면 서버가 fail-closed 로 승인하지 않는다)
- [ ] (#13/#11/#12/#27) 마이그레이션 `0028_account_purge_jobs.sql` · `0029_face_session_assets.sql` · `0030_face_consents.sql` · `0031_admin_login_guard.sql` 이 적용되어 있고
      `account-purge` · `start-face-liveness` 가 재배포되어 있다 (0029 이전 DB 에 새 `start-face-liveness` 를 배포하면 승인 RPC 의 superseded 규칙이 없다; 0030 이전이면 `start` 가 503 `consent_unavailable`)
- [ ] (#13) pg_cron 에 `account-purge` batch(일 1회) · `face-asset-cleanup`(`{"face_cleanup":true}`, 1시간) · prune 이 등록되어 있다 (`docs/data-retention.md` 4절)
- [ ] (#13) 탈퇴 테스트 계정으로 `account-purge` 를 호출해 `account_purge_jobs` 의 4단계가 모두 `done` 이고 Storage `faces/<uid>/` 가 비어 있으며 Didit 세션 삭제가 2xx 였다 —
      **실제 프로젝트에서 미수행**. 실패 시 관리자 `/deletion-requests` 하단에 실패 단계가 보이고 재시도로 이어진다
- [ ] (#12) production secret `FACE_CONSENT_VERSION` 이 `faceConsentPolicy.ts` 의 `version` 과 같고 문서 `status` 가 `final` 이며 미확정 고지 항목이 없다 —
      아니면 `start-face-liveness` 가 새 세션을 503 `consent_policy_not_ready` 로 거부한다 (의도된 출시 차단). `docs/face-consent.md` 4절
- [ ] 마이그레이션 `0013_face_liveness.sql` + `0014_face_liveness_v3_hardening.sql` 이 production DB 에 적용되어 있다
      (`face_liveness_begin_session` · `face_liveness_approve` · `face_liveness_admin_review` RPC, `face_webhook_events` · `face_verification_reviews` 테이블 존재)
- [ ] `admin-face-review` 가 배포되어 있고(JWT ON) anon key / 사용자 JWT 로 호출하면 401 이다
- [ ] 잘못된 서명으로 didit-webhook 을 호출하면 401 이고 DB 가 바뀌지 않는다
- [ ] `webhook_type: transaction.status.updated` 같은 비세션 이벤트를 서명해 보내면 200 `unsupported_event` 이고 DB 가 바뀌지 않는다
- [ ] 같은 `event_id` 를 두 번 보내면 두 번째는 200 `duplicate` 이고 함수 로그에 Decision 재조회가 없다
- [ ] `select * from face_liveness_inconsistent_rows()` 가 0행이다 (approved 인데 `face_verified=false` / `reference_path` 없음 없음)
- [ ] production 에서 verify-identity 를 직접 호출해도 아무 6자리 코드로 통과되지 않는다
- [ ] production 에서 complete-face-verification 을 직접 호출해도 `face_verified=true` 가 되지 않는다 (미배포 또는 기동 실패)
- [ ] 사용자 JWT 로 `face_verifications` 에 insert/update 하면 거부된다 (RLS + 트리거)
- [ ] Auth → Phone 에 **Test OTP / 테스트 전화번호 항목이 없다** (Dashboard 수동 확인 — 코드로 검증 불가)
- [ ] SMS OTP 실발송(SOLAPI) — `send-sms` 가 production 에 **`--no-verify-jwt` 로 배포**되어 있다
      (`deploy-production.sh` 가 수행. `supabase functions list` 에서 send-sms 확인)
- [ ] production secrets 에 `SOLAPI_API_KEY` / `SOLAPI_API_SECRET` / `SOLAPI_SENDER_NUMBER` /
      `SEND_SMS_HOOK_SECRETS` 가 **모두** 있다 (하나라도 없으면 send-sms 가 500 → OTP 미발송)
- [ ] `SOLAPI_SENDER_NUMBER` 가 SOLAPI 콘솔에서 **등록·승인된 발신번호**다 (숫자만)
- [ ] Dashboard → Authentication → Hooks → **Send SMS Hook 이 Enabled** 이고 URL 이
      `https://<prod-ref>.supabase.co/functions/v1/send-sms` 다 (staging URL 아님)
- [ ] `SEND_SMS_HOOK_SECRETS` 가 위 Hook 의 현재 secret(`v1,whsec_...`)과 일치한다 — staging 과 다른 값
      (Edge Function 로그에 `signature verification failed` 가 없다)
- [ ] Auth → Rate Limits 의 SMS 발송 한도를 확인했다 (프로젝트 전체 한도 — OTP 남용/비용 방지)
- [ ] 마이그레이션 `0012_sms_otp_rate_limit.sql` 이 production DB 에 적용되어 있다
      (`sms_otp_rate_limit_check` RPC 존재. 없으면 send-sms 가 503 `sms_rate_limit_unavailable` 로 **발송을 거부**한다)
- [ ] 같은 번호로 60초 안에 두 번 요청하면 두 번째는 429 이고 SMS 가 **오지 않는다**
      (Edge Function 로그에 `rate limited — not sent` · SOLAPI 미호출)
- [ ] production DB 에 seed/fixture 가 **적용되어 있지 않다**:
      `is_demo=true` 사용자 0명, `%@bonsim.dev` 계정 0개
- [ ] 배포는 `bash supabase/scripts/deploy-production.sh <prod-ref>` (allowlist)로만 수행했다

## Admin

- [ ] `SUPABASE_SERVICE_ROLE_KEY` 가 서버 환경변수로만 존재한다 (`NEXT_PUBLIC_*` 금지, 브라우저 노출 없음)
- [ ] `ADMIN_PASSWORD` 가 기본값(`change-me`)이 아니다 · `ADMIN_SESSION_SECRET` 이 **32자 이상** 설정되어 있다 (#27 — production 에서는 없으면 로그인 자체가 실패한다)
- [ ] (#27) 관리자 웹이 신뢰할 수 있는 리버스 프록시 뒤에 있으면 `ADMIN_TRUST_PROXY_HEADERS=1`, 아니면 설정하지 않는다 (`docs/security.md` 4절)
- [ ] (#27) 두 인스턴스(또는 재시작 전후)에서 잘못된 비밀번호를 3회 + 2회 입력하면 5회째에 잠기고, `admin_login_locks` 에 원문 IP 가 없다.
      DB 를 끊고 로그인하면 "로그인 제한을 확인할 수 없어 로그인하지 않았습니다" 가 뜬다 — **실제 배포에서 미수행**
- [ ] 관리자 웹 **얼굴 검토** 화면이 열리고, 조건(라이브니스 Approved · liveness_passed · 참조 이미지) 없는 행은 승인이 409 로 거부된다
- [ ] 얼굴 검토 화면에 중복 매칭된 상대 사용자 정보·얼굴 이미지가 표시되지 않는다 (세션 id 는 앞 8자만)

## Verification (실기기)

- [ ] 실기기 release 빌드로 전화번호 SMS OTP 로그인 전체 플로우가 동작한다
      (실제 한국 휴대전화에 `[본심] 인증번호는 ······입니다.` SMS 가 도착하고 verifyOtp 로 로그인된다)
- [ ] 잘못된/만료된 OTP 가 거부된다 · 재전송 60초 타이머가 "번호 변경" 후에도 유지된다 · 과다 요청 시 429 안내가 표시된다
- [ ] send-sms Edge Function 로그에 OTP·전체 전화번호·API secret 이 **없다** (고정 코드/statusCode 만)
- [ ] 개발 fixture 번호(010-0000-XXXX)가 production 에서 **동작하지 않는다**
      (Test OTP 미등록 → 실제 SMS 발송 실패/미도달 확인)
- [ ] 얼굴 인증을 건너뛸 수 있는 경로가 UI 어디에도 없다
- [ ] 실기기(iOS·Android)에서 `docs/face-liveness-didit.md` 12절 실기기 체크리스트를 통과했다 — **아직 미수행 (실제 Didit 계정·실기기 E2E 필요)**
      (실제 얼굴 통과 · 인쇄 사진/재생 영상/두 명/가림/저조도 실패 안내 · 중단 후 복귀 · 재시작 시 pending 복원 · Resubmit 시 재시작 안내 · 중복 가입 in_review → 관리자 처리)
- [ ] 승인 시 `face_verifications.status='approved'` / `verified_at` / `users.face_verified=true` 가 같은 시점에 바뀌었다 (RPC 한 트랜잭션)
- [ ] reference image 가 없으면 승인되지 않고 `in_review`(`reference_image_unavailable`) 로 남았다가 재확인으로 복구된다
- [ ] Storage `faces/<uid>/liveness/reference.jpg` 가 사용자 JWT 로 읽히지 않는다
- [ ] Android release 빌드에서 얼굴 확인 1회 후 `adb logcat | grep -iE 'token=|vendorData=|workflowId='` 가 0줄이다 (SDK patch 적용 — `npm run sdk:verify-no-token-log` 가 OK)
- [ ] 개인정보처리방침에 생체정보(민감정보) 처리·국외 이전이 **인증(라이브니스·중복 가입 방지) 목적으로** 반영되어 있다 (`docs/face-liveness-didit.md` 10절 TODO — 출시 차단).
      MVP 는 외모 매칭을 하지 않으므로 외모 매칭 목적 동의는 받지 않는다 — 향후 #8 채택 시 별도 동의 필요
- [ ] (#12) **실기기**: 얼굴 확인 시작 → 별도 동의 화면(기본 미선택) → 체크 없이 시작 불가 → 동의 뒤 카메라 화면. 동의 행 없이 API 를 직접 호출하면 403 `consent_required` — **아직 미수행**
- [ ] (#11) 같은 계정으로 얼굴 확인을 두 번 시작해 두 번째가 승인된 뒤 첫 세션의 웹훅이 늦게 와도 `face_verifications` 의 approved 행이 1개이고
      Storage 에 `faces/<uid>/liveness/<row id>/reference.jpg` 가 승인 행 것만 남는다 (정리 큐 24시간 뒤) — **아직 미수행**
- [ ] 서버 selftest 통과 (`bash scripts/server-selftests.sh` 가 아래를 한 번에 실행):
      `cd supabase/functions/_shared/env && node --experimental-strip-types selftest.ts`
      `cd supabase/functions/_shared/identity && node --experimental-strip-types selftest.ts`
      `cd supabase/functions/send-sms && node --experimental-strip-types selftest.ts`
      `cd supabase/functions/_shared/face && node --experimental-strip-types selftest.ts`
      `cd supabase/functions/_shared/purge && node --experimental-strip-types selftest.ts` (#13/#11 — 삭제 작업 실패·재시도·동시성·페이지 제한·범위 이탈)
      `cd supabase/functions/_shared/consent && node --experimental-strip-types selftest.ts` (#12 — 서버/앱 동의 문서 일치·준비 상태)
      `cd apps/mobile && node --experimental-strip-types scripts/face-liveness-selftest.mjs`
      `deno test --allow-env supabase/functions/send-sms/hook_test.ts`
      `bash supabase/tests/run_local_check.sh` (sms_rate_limit_tests.sql · face_liveness_tests.sql · face_liveness_concurrency_test.sh ·
      account_purge_jobs_tests.sql · account_purge_concurrency_test.sh · face_session_assets_tests.sql · face_consents_tests.sql · admin_login_guard_tests.sql · admin_login_guard_concurrency_test.sh 포함)
      `cd apps/mobile && npm run sdk:verify-no-token-log`
      `cd apps/admin && npx tsc --noEmit`
      `cd apps/mobile && node --experimental-strip-types scripts/otp-cooldown-selftest.mjs`
      `cd apps/mobile && node --experimental-strip-types scripts/onboarding-resume-selftest.mjs` (#39/#26 — 외모 데이터 없는 완료·인증 미완료 홈 차단·베타 입장 단계)
      `cd apps/mobile && node --experimental-strip-types scripts/preferences-core-selftest.mjs` (#25)
      `cd supabase/functions/_shared/security && node --experimental-strip-types selftest.ts` (#27/#26 — fail-closed 판정)
      `cd apps/admin && node --experimental-strip-types scripts/admin-session-selftest.mjs` (#27 — 세션 토큰·DB 공유 로그인 잠금 흐름·secret 규칙·프록시 신뢰 경계)
      `cd apps/mobile && npm run release:check:selfcheck && npm run release:check` (#3 — release 산출물 검사)
      `cd supabase/functions/_shared/matching && node --experimental-strip-types selftest.ts` (#39/#40/#24 — 외모 제외·재정규화·안전 필터·공개 이유·tie-break·자리 제한, 실패 시 exit 1)
      `cd apps/mobile && node --experimental-strip-types scripts/chat-core-selftest.mjs` (#41/#24 — 채팅 병합·종료 안내 문구·자리 안내)
      `bash supabase/tests/run_local_check.sh` 에 포함된 `recommendation_db_test.mjs` (#40 — 실제 DB 위에서 외모 데이터 없이 추천 생성)
- [ ] 마이그레이션 `0015_no_appearance_onboarding.sql` 이 production DB 에 적용되어 있다 (`profiles.relationship_goal/public_answers(/intro)` 컬럼, `users_guard_onboarding_completion` 트리거)
      — **앱 배포보다 먼저** 적용한다 (새 앱은 이 컬럼에 저장한다)
- [ ] (#41) 마이그레이션 `0016_meetup_flow.sql` 이 production DB 에 적용되어 있다 (`send_message`/`meetup_set_intent`/`meetup_report_outcome`/`meetup_submit_feedback`/`conversation_access` RPC,
      `meetup_outcomes`·`notification_events` 테이블, `messages.client_message_id`, `matches.mutual_interest_at/meetup_confirmed_at`) — 앱과 **같은 릴리스 창**에서 (예전 앱의 만남 화면 저장은 이 시점부터 실패한다)
- [ ] (#22/#23) 마이그레이션 `0017_recommendation_runs.sql` 이 적용되어 있고(`recommendation_runs`, `recommendation_run_claim/finish`, `recommendation_batch_targets`, recommendations unique 변경),
      `daily-recommendation` · `daily-recommendation-batch` 가 재배포되어 있으며 pg_cron 에 배치 스케줄이 등록되어 있다 (`select * from cron.job`)
- [ ] (#22) 같은 계정으로 `daily-recommendation` 을 동시에 두 번 호출해도 오늘 `recommendations` 행이 1건이다. `daily-recommendation-batch` 를 사용자 JWT 로 호출하면 401 이다
- [ ] (#22 매시간 폴링) 마이그레이션 `0032_recommendation_batch_hourly.sql` 적용(`recommendation_batch_targets` 4인자) → `daily-recommendation-batch` 재배포 → cron 을 `'0,15,30,45 0-12 * * *'`(KST 09:00~21:45) 로 재등록
      (`select jobname, schedule from cron.job where jobname = 'daily-recommendation-batch'`, 예전 `'*/15 0 * * *'` 는 unschedule). 응답에 `retry_after_seconds: 3000` 이 온다
- [ ] (#22/#23/#17) 후보 없는 테스트 계정: 앱을 닫은 채 `recommendation_runs.finished_at` 을 55분 전으로 바꾸고 후보를 만든 뒤 배치 1회 수동 호출 → 오늘 `recommendations` 1건 ·
      `notification_events.daily_recommendation` 1건 → (cron `send-push`) 실기기 푸시 수신 → 탭하면 홈의 오늘의 소개. 후보를 만들지 않고 호출하면 행·이벤트가 늘지 않는다 — **실제 프로젝트·실기기 미수행**
- [ ] (#23) 마이그레이션 `0027_recommendation_observability.sql` 적용 (`recommendation_runs.eligible_count/recommendation_id/strategy/basis/error_stage`, `recommendation_run_finish` 8인자,
      `recommendations_created_event` 트리거, `recommendation_pool_stats`/`recommendation_run_stats`). 적용 뒤 `select count(*) from analytics_events where event_type='recommendation_created'` = `select count(*) from recommendations`
- [ ] (#23) `daily-recommendation` · `daily-recommendation-batch` 재배포 뒤 오늘 실행 행에 `eligible_count` 가 채워진다: `select result, cap_reached, eligible_count from recommendation_runs where for_date = (now() at time zone 'Asia/Seoul')::date`
      (후보 없음은 `exhausted`+`eligible_count=0`, 상한 도달은 `cap_reached=true`, 오류는 `status='failed'`+`error_stage`). 같은 계정이 앱을 여러 번 열어도 행·이벤트 수가 늘지 않는다
- [ ] (#23) 관리자 `/recommendation-pool` 이 조회 오류 배너 없이 열리고 demo 경고가 0 이다 (production 에 demo 계정 없음). 사용자 JWT 로 `recommendation_pool_stats(7)` 를 호출하면 권한 오류다
- [ ] (#23) **실기기**: 후보가 없는 테스트 계정의 홈이 빈 카드·무한 로딩 없이 "오늘은 소개할 분이 없어요"(또는 상한 도달 문구)를 보여 주고, "선호 조건 보기" 가 수정 화면으로 간다. 서버를 끈 상태의 오류 카드가 후보 부족 문구와 다르다 — **아직 미수행**
- [ ] (#41) `icebreaker` Edge Function 이 최신 코드로 재배포되어 있다 (v2 캐시 · 공개 필드만 조회). 배포 후 `select count(*) from conversations where icebreaker ? 'lead'` 가 줄어든다 (과거 캐시 덮어쓰기)
- [ ] (#41) 사용자 JWT 로 `matches` 의 `meetup_state`/`meetup_completed_at` 을 update 하면 0행이고, `meetup_intentions`/`meetup_outcomes`/`meetup_feedback` 에 insert 하면 거부된다
- [ ] (#41) 두 테스트 계정으로 A 만 yes 일 때 B 의 `meetup_intentions` 조회가 0행이고 매치 `meetup_state` 가 `none` 이다. B 도 yes 면 `mutual_interest` 가 되고 `analytics_events.meetup_mutual_interest` 가 참가자당 1행이다
- [ ] (#41) 한쪽만 "만났어요" 를 기록해도 `meetup_state` 가 `met_confirmed` 가 아니고, 상대는 `meetup_outcomes`/`meetup_feedback` 에서 0행을 본다
- [ ] (#41) 같은 `client_message_id` 로 `send_message` 를 두 번 호출해도 `messages` 1행 · `conversation_metrics.total_messages` +1 · `analytics_events.message_sent` 1행이다
- [ ] (#41) `meetup_pair_summary` 뷰와 `notification_events` 를 사용자 JWT 로 select 하면 권한 오류다
- [ ] (#41) **실기기 두 대**로 상호 수락 → 첫 메시지 → 시작 질문 선택·수정·전송 → 상호 의향 → 만남 확인 → 피드백을 끝까지 확인했다 — **아직 미수행** (로컬 DB·순수 로직 검증만 완료)
- [ ] (#41) 실기기에서 네트워크 끊김 → 복귀 시 놓친 메시지가 복구되고, 전송 실패 메시지가 "다시 보내기" 로 중복 없이 전송된다 — **아직 미수행**
- [ ] (#12) 관리자 웹 `/policy/terms` · `/policy/privacy` · `/policy/community` 가 로그인 없이 열리고 `[ ]` 값(사업자·연락처·시행일·리전·본인확인 기관)이 채워져 있다. 법률 검토 완료. 앱 release 빌드에 `EXPO_PUBLIC_POLICY_BASE_URL` 이 설정되어 로그인·내 정보 화면 링크가 실제로 열린다
- [ ] (#24) 마이그레이션 `0022_funnel_views.sql` · `0026_conversation_slots_exit_metrics.sql` 적용 (0026 은 `conversation_leave`/`recommendation_accept`/`recommendation_mark_viewed` RPC, `conversation_exits`, `matches.closed_*`, `conversation_pair_metrics`, 퍼널 뷰 재작성 — `sustained_7d` 컬럼 없음).
      적용 직전 `select * from conversation_slot_overflow` 로 3개 초과 계정을 확인해 둔다 (기존 대화는 건드리지 않는다 — `docs/conversation-policy.md` 1절)
- [ ] (#24) `daily-recommendation` · `daily-recommendation-batch` 재배포 (`conversation_slot_usage` 조회 — 0026 이전 DB 에 배포하면 lookup_failed 500). 관리자 웹·앱 순서로 배포
- [ ] (#24) 사용자 JWT 로 `conversation_exits` 를 조회하면 본인 행만 보이고, `conversation_pair_facts`/`conversation_cohorts`/`conversation_slot_usage` 는 권한 오류다
- [ ] (#24) 두 테스트 계정으로 A 가 나가기 → B 화면에 "상대방이 대화를 종료했어요", B 의 전송이 거부되고 신고 화면은 열린다. A 가 다시 나가기를 눌러도 `analytics_events.conversation_left` 는 1행
- [ ] (#24) 진행 중 대화 3개인 계정으로 `daily-recommendation` 을 호출하면 200 `slots_full: true` 이고 새 `recommendations` 행이 없다. 4번째 수락(`recommendation_accept`)은 `no_slot_self` 로 아무것도 남기지 않는다
- [ ] (#24) 관리자 `/funnel` 이 열리고(조회 오류 배너 없음), `/beta` 표에 7일 지속 열이 없다. 베타 시작 후 `psql $env:DATABASE_URL -v as_of="now()" -f supabase/tests/conversation_metrics_raw_check.sql` 결과 `mismatches = 0` 과 원본 cohort 집계를 `/funnel` 수치와 대조해 #24 에 기록한다 — **실제 프로젝트에서 아직 미수행**
- [ ] (#24) **실기기 두 대**로 `docs/conversation-policy.md` 6절 시나리오(3개 채우기 → 4번째 수락 안내 → 나가기 → 상대 안내 → 재수락 → 재추천 없음)를 끝까지 확인했다 — **아직 미수행**
- [ ] (#20) 마이그레이션 `0021_server_errors.sql` 적용. release 빌드에 `EXPO_PUBLIC_SENTRY_DSN`·`EXPO_PUBLIC_APP_ENV=production` 이 설정되어 있고 Sentry 에 첫 이벤트가 보인다 — **실기기 미검증**
- [ ] (#20) Sentry 이벤트·`server_errors` 행에 전화번호·이메일·토큰·얼굴 경로·메시지 원문이 없다 (표본 확인). 관리자 `/errors` 가 열린다
- [ ] (#15/#16) 마이그레이션 `0020_moderation.sql` 적용 · cron(`moderation_lift_expired_suspensions` 1시간) 등록. 관리자 웹 신고 화면에서 경고/7일 정지/영구 차단/기각이 동작하고 `moderation_actions` 에 기록된다
- [ ] (#16) 같은 대화에 60초 안 21번째 메시지가 `rate_limited`, 같은 본문 4번째가 `repeated_content` 로 거부되고 앱이 안내 문구를 보여준다. 정상 대화("주말에 카페 갈래요?")는 `moderation_signals` 에 기록되지 않는다
- [ ] (#13/#11/#14) 마이그레이션 `0019_account_deletion.sql` 적용 · `account-purge` 배포 · cron(`account-purge` batch 일 1회) 등록.
      탈퇴 테스트 계정을 `deleted_at` 31일 전으로 바꾼 뒤 batch 호출 → `profiles`·`face_verifications` 행 0, storage `faces/<uid>/` 비어 있음, 상대 대화에 "(탈퇴한 사용자의 메시지입니다)" — **실제 프로젝트에서 미수행**
- [ ] (#14) 관리자 웹 `/delete-account` 가 로그인 없이 열리고 요청이 `/deletion-requests` 에 나타난다. 스토어 제출 정보의 계정 삭제 URL 이 이 주소다
- [ ] (#17) 마이그레이션 `0018_push_notifications.sql` 적용 · `send-push` 배포 · cron 등록 (`select * from cron.job where jobname = 'send-push'`)
- [ ] (#17) 사용자 JWT 로 `notification_events_dequeue` 를 호출하면 거부되고, `push_tokens` 는 본인 행만 보인다
- [ ] (#17) **실기기(Android 우선)** 에서 알림 권한 허용 → `push_tokens` 행 생성 → 상대가 메시지 전송 → 1분 안에 "새 메시지가 도착했어요" 수신 → 탭하면 해당 채팅방 — **아직 미수행**
- [ ] (#17) 알림 본문에 메시지 원문·상대 닉네임이 없다 (잠금화면 확인). 알림 설정 스위치를 끄면 오지 않는다 (`skipped_reason='pref_off'`)
- [ ] (#17) 로그아웃 후 이전 계정의 알림이 오지 않는다 (`push_tokens` 에 행 없음). iOS 는 Apple Developer·APNs 키 등록 후 검증
- [ ] (#27) 마이그레이션 `0023_security_hardening.sql` 적용 (`rate_limit_hit`·`admin_audit_log`·추천 변경 가드·신고 상한). `verify-identity`·`icebreaker`·`delete-account`·`daily-recommendation`·`start-face-liveness` 재배포 — **0023/0025 보다 먼저 배포하면 안 된다** (rate limit·베타 RPC 가 없으면 fail-closed 로 503)
- [ ] (#27) `bash supabase/tests/run_local_check.sh` 의 `security_tests.sql` 이 통과했다 (RLS 전수 · DEFINER allowlist · 뷰 비공개 · anon 0행). production DB 에서도 `select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity` → 0행
- [ ] (#27) 사용자 JWT 로 `recommendations` 의 `score_total`/`card` 를 update 하면 거부되고, 같은 사용자가 하루 11번째 신고를 넣으면 거부된다. `rate_limit_hit`·`admin_audit_record` 를 사용자 JWT 로 호출하면 거부된다
- [ ] (#27) 관리자 웹: `ADMIN_SESSION_SECRET` 이 설정되어 있다 (16자+). 잘못된 비밀번호 5회 → 잠금 안내가 뜨고 `admin_audit_log` 에 `admin_login_failed/locked` 가 남는다. 정지·신고 처리·얼굴 검토·삭제 요청·베타 조치가 `/audit` 에 처리자 이름과 함께 보인다
- [ ] (#27) 관리자 로그인 쿠키(`bonsim_admin`)가 `p.sig` 형식이고 12시간 뒤 만료된다. 예전 형식(sha256 고정값)으로는 로그인되지 않는다
- [ ] (#25) 마이그레이션 `0024_profile_edit.sql` 적용. 온보딩 완료 계정으로 프로필 `birth_year`/`gender` update 가 거부되고, `preferences_save` 에 `appearance_importance` 를 넣으면 거부된다. 내 정보 → 소개/기본 정보/선호 조건/가치관 수정 화면이 열리고 저장 뒤 `analytics_events.profile_updated/preferences_updated` 에 컬럼 이름만 남는다 (값 없음) — **실기기 미검증**
- [ ] (#26) 마이그레이션 `0025_beta_cohorts.sql` 적용. 관리자 `/beta` 에서 cohort 생성 → 게이트 켜기 → 새 계정으로 로그인하면 입장 화면(초대코드/대기)이 뜨고, 코드 없이 `verify-identity` 를 직접 호출하면 403 `beta_admission_required`, `profiles` insert 가 거부된다. 초대코드 입장 뒤 온보딩이 진행된다 — **실기기 미검증**
- [ ] (#26) 대기 등록 계정에 `profiles`/`face_verifications`/`user_identities` 행이 없다. 운영자 "대기자 입장" 뒤 `notification_events.beta_admitted` 1건이 쌓이고 (cron `send-push`) 알림이 온다. 게이트를 끄면 누구나 가입되고 cohort 통계는 유지된다
- [ ] (#26/#27) 잘못된 초대코드 11번째 시도가 `rate_limited` 로 거부된다. 로그인 후 `verify-identity` request 를 10분 안에 6번 호출하면 429 다
