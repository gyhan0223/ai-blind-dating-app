# Release Checklist

production 배포/앱 출시 전 매번 확인한다. 환경 모델·변수 목록은 `docs/environments.md` 참고.

## Mobile (release 빌드)

- [ ] release 빌드 로그인 화면에 "테스트로 시작하기" 버튼이 **없다**
- [ ] release 빌드 얼굴 인증 화면에 "개발 모드: 얼굴 인증 통과 (Mock)" 버튼이 **없다**
- [ ] release 빌드가 **Development/스토어 빌드** 다 (Expo Go 아님) — 얼굴 확인 시작 시 Didit 네이티브 카메라 화면이 앱 안에서 열린다
- [ ] `app.json` 에 `ios.bundleIdentifier` / `android.package` 가 실제 스토어 값으로 들어 있다 (저장소 기본값에는 없음)
- [ ] iOS 권한 문구가 카메라·마이크 두 개뿐이고 한국어다. 사진첩/NFC 권한을 요청하지 않는다
- [ ] release 빌드 본인확인 화면에 "테스트로 통과하기" 버튼이 **없다**
- [ ] production 빌드 환경(EAS 등)에 `EXPO_PUBLIC_DEV_LOGIN` 이 설정되어 있지 **않다**
      (설정돼 있어도 release 빌드에선 무효지만, 아예 제거한다)
- [ ] `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` 가 **production 프로젝트** 값이다
      (localhost/staging 값 아님)
- [ ] 클라이언트 번들에 서버 secret 이 없다 — **web + iOS + Android** export 결과에서 확인:
      `npx expo export --platform web --platform ios --platform android --no-bytecode` 후
      `dist/` 에서 `service_role`, `SERVICE_ROLE_KEY`, `IDENTITY_HASH_SECRET`,
      `bonsim-dev-password`, `dev-login`, `테스트로 시작하기`, `얼굴 인증 통과`, `DIDIT_API_KEY`, `complete-face-verification` grep → 0건
- [ ] 실제 스토어 제출용 release 빌드(EAS build)에서도 위 확인을 반복한다
      (EAS 는 이 저장소 밖에서 수행 — 산출물의 JS 번들에 같은 grep 적용)

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
- [ ] Didit 워크플로: Liveness 단계만 · Active `3D Action & Flash` · 최대 3회 · Face Search 1:N 켜짐 · 신분증/AML/주소/NFC 없음
- [ ] 마이그레이션 `0013_face_liveness.sql` 이 production DB 에 적용되어 있다 (`face_liveness_begin_session` RPC 존재)
- [ ] 잘못된 서명으로 didit-webhook 을 호출하면 401 이고 DB 가 바뀌지 않는다
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
- [ ] `ADMIN_PASSWORD` 가 기본값(`change-me`)이 아니다

## Verification (실기기)

- [ ] 실기기 release 빌드로 전화번호 SMS OTP 로그인 전체 플로우가 동작한다
      (실제 한국 휴대전화에 `[본심] 인증번호는 ······입니다.` SMS 가 도착하고 verifyOtp 로 로그인된다)
- [ ] 잘못된/만료된 OTP 가 거부된다 · 재전송 60초 타이머가 "번호 변경" 후에도 유지된다 · 과다 요청 시 429 안내가 표시된다
- [ ] send-sms Edge Function 로그에 OTP·전체 전화번호·API secret 이 **없다** (고정 코드/statusCode 만)
- [ ] 개발 fixture 번호(010-0000-XXXX)가 production 에서 **동작하지 않는다**
      (Test OTP 미등록 → 실제 SMS 발송 실패/미도달 확인)
- [ ] 얼굴 인증을 건너뛸 수 있는 경로가 UI 어디에도 없다
- [ ] 실기기(iOS·Android)에서 `docs/face-liveness-didit.md` 10절 실기기 체크리스트를 통과했다
      (실제 얼굴 통과 · 인쇄 사진/재생 영상/두 명/가림/저조도 실패 안내 · 중단 후 복귀 · 재시작 시 pending 복원 · 중복 가입 in_review)
- [ ] Storage `faces/<uid>/liveness/reference.jpg` 가 사용자 JWT 로 읽히지 않는다
- [ ] 개인정보처리방침에 생체정보(민감정보) 처리·국외 이전·외모 매칭 목적 별도 동의가 반영되어 있다 (`docs/face-liveness-didit.md` 8절)
- [ ] 서버 selftest 통과:
      `cd supabase/functions/_shared/env && node --experimental-strip-types selftest.ts`
      `cd supabase/functions/_shared/identity && node --experimental-strip-types selftest.ts`
      `cd supabase/functions/send-sms && node --experimental-strip-types selftest.ts`
      `cd supabase/functions/_shared/face && node --experimental-strip-types selftest.ts`
      `cd apps/mobile && node --experimental-strip-types scripts/face-liveness-selftest.mjs`
      `deno test --allow-env supabase/functions/send-sms/hook_test.ts`
      `bash supabase/tests/run_local_check.sh` (sms_rate_limit_tests.sql · face_liveness_tests.sql 포함)
      `cd apps/mobile && node --experimental-strip-types scripts/otp-cooldown-selftest.mjs`
