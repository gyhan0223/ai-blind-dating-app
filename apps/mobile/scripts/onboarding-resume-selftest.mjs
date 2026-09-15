/**
 * 온보딩 재진입 판정 selftest — Node 로 실행 (Expo/RN 불필요).
 *   node --experimental-strip-types scripts/onboarding-resume-selftest.mjs
 *
 * Issue #39 핵심 보장:
 *   - 외모 취향 응답·얼굴 벡터 없이도 온보딩이 완료된다 (완료 조건에 외모 데이터가 없다)
 *   - 예전 앱이 저장한 'appearance' 단계 사용자는 인증 상태·남은 필수 입력으로 적절한 단계에 복귀한다
 *   - 인증(본인확인·얼굴) 미완료 사용자는 완료 플래그가 있어도 홈에 들어갈 수 없다
 */
import { canEnterHome, resolveOnboardingStep, routeForResumeStep } from '../src/lib/onboardingCore.ts';

let passed = 0;
let failed = 0;

function eq(name, actual, expected) {
  if (actual === expected) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL ${name}: expected ${expected}, got ${actual}`);
  }
}

const complete = {
  betaAccess: 'open',
  identityVerified: true,
  faceVerified: true,
  hasProfile: true,
  hasIntro: true,
  questionnaireAnswered: 26,
  questionnaireTotal: 26,
  hasValues: true,
  hasPreferences: true,
};

// 신규 사용자 — 정상 인증 후 외모 응답/벡터 없이 완료 (progress 에 외모 필드 자체가 없다)
eq('모든 필수 입력 + 인증 → done', resolveOnboardingStep(complete), 'done');
eq('done → 홈 라우트', routeForResumeStep('done'), '/(tabs)');

// 예전 버전에서 'appearance' 단계에 멈춘 사용자: 저장된 단계와 무관하게 데이터로 판정
// (외모 단계 직전까지 끝냈지만 새 필수 입력(자기소개)이 없는 경우 → intro)
eq('legacy appearance + 자기소개 없음 → intro', resolveOnboardingStep({ ...complete, hasIntro: false }), 'intro');
eq('legacy appearance + 모두 있음 → done', resolveOnboardingStep(complete), 'done');
eq('legacy appearance + 얼굴 인증 없음 → face (홈으로 보내지 않음)', resolveOnboardingStep({ ...complete, faceVerified: false }), 'face');

// 폐쇄 베타 게이트 (#26) — 허가 전에는 본인확인으로 가지 않는다. 이미 인증한 사용자는 게이트가 뒤늦게 켜져도 막지 않는다
eq('초대 필요 → beta', resolveOnboardingStep({ ...complete, betaAccess: 'invite_required', identityVerified: false, faceVerified: false, hasProfile: false }), 'beta');
eq('대기 중 → beta', resolveOnboardingStep({ ...complete, betaAccess: 'waitlisted', identityVerified: false, faceVerified: false }), 'beta');
eq('입장 허가 → identity 부터', resolveOnboardingStep({ ...complete, betaAccess: 'admitted', identityVerified: false, faceVerified: false }), 'identity');
eq('게이트 꺼짐 → identity 부터', resolveOnboardingStep({ ...complete, betaAccess: 'open', identityVerified: false }), 'identity');
eq('본인확인 끝난 사용자는 게이트가 켜져도 계속 진행', resolveOnboardingStep({ ...complete, betaAccess: 'invite_required', faceVerified: false }), 'face');
eq('beta 라우트', routeForResumeStep('beta'), '/auth/beta');

// 인증은 절대 건너뛰지 않는다
eq('본인확인 없음 → identity', resolveOnboardingStep({ ...complete, identityVerified: false }), 'identity');
eq('본인확인 없음 + 얼굴 없음 → identity 먼저', resolveOnboardingStep({ ...complete, identityVerified: false, faceVerified: false }), 'identity');
eq('얼굴 인증 없음 → face', resolveOnboardingStep({ ...complete, faceVerified: false }), 'face');

// 남은 필수 입력 순서
eq('프로필 없음 → profile', resolveOnboardingStep({ ...complete, hasProfile: false, hasIntro: false }), 'profile');
eq('설문 일부만 → questionnaire', resolveOnboardingStep({ ...complete, questionnaireAnswered: 5 }), 'questionnaire');
eq('설문 0건 → questionnaire', resolveOnboardingStep({ ...complete, questionnaireAnswered: 0 }), 'questionnaire');
eq('가치관 없음 → values', resolveOnboardingStep({ ...complete, hasValues: false }), 'values');
eq('선호조건 없음 → preferences', resolveOnboardingStep({ ...complete, hasPreferences: false }), 'preferences');
eq('단계 라우트', routeForResumeStep('preferences'), '/onboarding/preferences');

// 홈 진입 가드 — 완료 플래그만으로는 부족
eq('완료 + 인증 둘 다 → 홈', canEnterHome({ onboarding_completed: true, identity_verified: true, face_verified: true }), true);
eq('완료 + 얼굴 미인증 → 홈 불가', canEnterHome({ onboarding_completed: true, identity_verified: true, face_verified: false }), false);
eq('완료 + 본인 미확인 → 홈 불가', canEnterHome({ onboarding_completed: true, identity_verified: false, face_verified: true }), false);
eq('미완료 → 홈 불가', canEnterHome({ onboarding_completed: false, identity_verified: true, face_verified: true }), false);

console.log(`onboarding resume selftest: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
