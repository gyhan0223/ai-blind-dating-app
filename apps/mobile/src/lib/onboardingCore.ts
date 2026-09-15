/**
 * 온보딩 재진입 판정 — 순수 함수 (React Native / Supabase 에 의존하지 않음).
 * Node selftest(scripts/onboarding-resume-selftest.mjs)로 검증한다.
 *
 * 원칙 (#39)
 *   - 저장된 onboarding_step 은 참고값이다. 실제 진입 단계는 "인증 상태 + 남은 필수 입력" 으로 결정한다.
 *     (예전 버전이 저장한 'appearance' 단계, 새로 추가된 필수 입력(자기소개), 앱 재시작·뒤로 가기 모두 같은 규칙)
 *   - 인증(본인확인·얼굴 라이브니스)은 절대 건너뛰지 않는다 — 플래그는 서버만 바꾼다.
 *   - 외모 취향 응답·얼굴 벡터는 완료 조건이 아니다.
 *   - 모든 필수 입력이 있고 인증이 끝났으면 'done' — 그때만 onboarding_completed 를 올린다
 *     (DB 트리거가 인증 전 완료를 거부하므로 클라이언트가 임의로 통과할 수 없다).
 */

export type ResumeStep = 'beta' | 'identity' | 'face' | 'profile' | 'intro' | 'questionnaire' | 'values' | 'preferences' | 'done';

/** 폐쇄 베타 입장 상태 (#26) — 서버 RPC beta_access_state() 값. open = 게이트 꺼짐(일반 공개) */
export type BetaAccess = 'open' | 'admitted' | 'waitlisted' | 'invite_required';

export type OnboardingProgress = {
  /** 베타 입장 상태 — 허가 전에는 본인확인으로 나아가지 않는다 (서버가 최종 강제) */
  betaAccess: BetaAccess;
  identityVerified: boolean;
  faceVerified: boolean;
  /** profiles 행 존재 (기본 정보) */
  hasProfile: boolean;
  /** profiles.relationship_goal + 필수 공개 질문 선택 존재 (고르기형 소개) */
  hasIntro: boolean;
  /** questionnaire_responses 응답 수 / 전체 문항 수 */
  questionnaireAnswered: number;
  questionnaireTotal: number;
  /** private_profiles 가치관 축 응답 존재 */
  hasValues: boolean;
  /** preference_settings 행 존재 */
  hasPreferences: boolean;
};

/** 순서대로 첫 번째 미완료 단계를 돌려준다. 전부 완료면 'done'. */
export function resolveOnboardingStep(p: OnboardingProgress): ResumeStep {
  // 베타 게이트: 이미 인증까지 마친 사용자는 게이트가 나중에 켜져도 막지 않는다 (서버도 온보딩 완료 전이만 막는다)
  if ((p.betaAccess === 'invite_required' || p.betaAccess === 'waitlisted') && !p.identityVerified) return 'beta';
  if (!p.identityVerified) return 'identity';
  if (!p.faceVerified) return 'face';
  if (!p.hasProfile) return 'profile';
  if (!p.hasIntro) return 'intro';
  if (p.questionnaireTotal > 0 && p.questionnaireAnswered < p.questionnaireTotal) return 'questionnaire';
  if (!p.hasValues) return 'values';
  if (!p.hasPreferences) return 'preferences';
  return 'done';
}

/** 단계 → 라우트 ('done' 은 홈) */
export function routeForResumeStep(step: ResumeStep): string {
  if (step === 'done') return '/(tabs)';
  if (step === 'beta') return '/auth/beta';
  return `/onboarding/${step}`;
}

/**
 * 홈 진입 가드 — 저장된 완료 플래그만으로는 홈에 들어갈 수 없다.
 * 완료 플래그가 있어도 인증 플래그가 빠져 있으면 다시 온보딩(인증 단계)으로 보낸다.
 */
export function canEnterHome(user: {
  onboarding_completed: boolean;
  identity_verified: boolean;
  face_verified: boolean;
}): boolean {
  return user.onboarding_completed && user.identity_verified && user.face_verified;
}
