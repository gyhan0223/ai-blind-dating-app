# Release Checklist

production 배포/앱 출시 전 매번 확인한다. 환경 모델·변수 목록은 `docs/environments.md` 참고.

## Mobile (release 빌드)

- [ ] release 빌드 로그인 화면에 "테스트로 시작하기" 버튼이 **없다**
- [ ] release 빌드 얼굴 인증 화면에 "개발 모드: 촬영 건너뛰기" 버튼이 **없다**
- [ ] release 빌드 본인확인 화면에 "테스트로 통과하기" 버튼이 **없다**
- [ ] production 빌드 환경(EAS 등)에 `EXPO_PUBLIC_DEV_LOGIN` 이 설정되어 있지 **않다**
      (설정돼 있어도 release 빌드에선 무효지만, 아예 제거한다)
- [ ] `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` 가 **production 프로젝트** 값이다
      (localhost/staging 값 아님)
- [ ] 클라이언트 번들에 서버 secret 이 없다 — export 결과에서 확인:
      `npx expo export --platform web` 후 `dist/` 에서 `service_role`, `SERVICE_ROLE_KEY`,
      `IDENTITY_HASH_SECRET`, `bonsim-dev-password`, `테스트로 시작하기`, `촬영 건너뛰기` grep → 0건

## Supabase (production 프로젝트)

- [ ] production 과 staging 이 **서로 다른 Supabase 프로젝트**다
- [ ] `dev-login` 함수가 production 에 **배포되어 있지 않다**
      (`supabase functions list --project-ref <prod-ref>` 로 확인)
- [ ] (2차 방어 확인) 실수로 배포돼 있더라도 dev-login 호출이 **403** 을 반환한다
- [ ] production secrets 에 `APP_ENV=production` 이 설정되어 있다
- [ ] production secrets 에 `ALLOW_DEV_LOGIN` 이 **없다** (있어도 무효지만 제거)
- [ ] `IDENTITY_HASH_SECRET` 이 설정되어 있다 — 32자 이상, 개발 기본값·staging 값과 다른 고유 값
- [ ] Auth → Phone 에 **Test OTP / 테스트 전화번호 항목이 없다** (Dashboard 수동 확인 — 코드로 검증 불가)
- [ ] 실제 SMS provider(Twilio 등)가 연결되어 있고 rate limit 을 확인했다
- [ ] production DB 에 seed/fixture 가 **적용되어 있지 않다**:
      `is_demo=true` 사용자 0명, `%@bonsim.dev` 계정 0개
- [ ] 배포는 `bash supabase/scripts/deploy-production.sh <prod-ref>` (allowlist)로만 수행했다

## Admin

- [ ] `SUPABASE_SERVICE_ROLE_KEY` 가 서버 환경변수로만 존재한다 (`NEXT_PUBLIC_*` 금지, 브라우저 노출 없음)
- [ ] `ADMIN_PASSWORD` 가 기본값(`change-me`)이 아니다

## Verification (실기기)

- [ ] 실기기 release 빌드로 전화번호 SMS OTP 로그인 전체 플로우가 동작한다
- [ ] 개발 fixture 번호(010-0000-XXXX)가 production 에서 **동작하지 않는다**
      (Test OTP 미등록 → 실제 SMS 발송 실패/미도달 확인)
- [ ] 얼굴 인증을 건너뛸 수 있는 경로가 UI 어디에도 없다
- [ ] 서버 selftest 통과:
      `cd supabase/functions/_shared/env && node --experimental-strip-types selftest.ts`
      `cd supabase/functions/_shared/identity && node --experimental-strip-types selftest.ts`
