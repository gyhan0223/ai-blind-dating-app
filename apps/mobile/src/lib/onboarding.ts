import type { OnboardingStep } from '@/constants/options';
import { hasRequiredPublicAnswers, QUESTIONS, relationshipGoalLabel } from '@/constants/questions';
import { fetchBetaAccessState } from './beta';
import { type OnboardingProgress, type ResumeStep, resolveOnboardingStep } from './onboardingCore';
import type { AppUser } from './session';
import { supabase } from './supabase';

/** 현재 단계 완료 → 다음 단계 저장. done 이면 onboarding_completed 처리. */
export async function advanceOnboarding(next: OnboardingStep) {
  const { data } = await supabase.auth.getUser();
  const userId = data.user?.id;
  if (!userId) throw new Error('로그인이 필요합니다.');

  const { error } = await supabase
    .from('users')
    .update({
      onboarding_step: next,
      onboarding_completed: next === 'done',
      last_active_at: new Date().toISOString(),
    })
    .eq('id', userId);
  if (error) throw error;
}

/**
 * 내 온보딩 진행 상태를 DB 에서 읽는다 (RLS — 본인 행만).
 * 외모 취향 응답·얼굴 벡터는 조회하지 않는다 — 완료 조건이 아니다 (#39).
 */
export async function loadOnboardingProgress(user: AppUser): Promise<OnboardingProgress> {
  const [beta, profileRes, responsesRes, privateRes, prefsRes] = await Promise.all([
    fetchBetaAccessState(),
    supabase.from('profiles').select('user_id, relationship_goal, public_answers').eq('user_id', user.id).maybeSingle(),
    supabase
      .from('questionnaire_responses')
      .select('question_id', { count: 'exact', head: true })
      .eq('user_id', user.id),
    supabase.from('private_profiles').select('user_id, marriage_intent').eq('user_id', user.id).maybeSingle(),
    supabase.from('preference_settings').select('user_id').eq('user_id', user.id).maybeSingle(),
  ]);
  if (profileRes.error || responsesRes.error || privateRes.error || prefsRes.error) {
    throw new Error('온보딩 상태를 확인하지 못했습니다.');
  }
  const profile = profileRes.data as { relationship_goal: string | null; public_answers: unknown } | null;
  return {
    betaAccess: beta.state,
    identityVerified: user.identity_verified,
    faceVerified: user.face_verified,
    hasProfile: profile != null,
    // 소개 = 연애 목적 + 필수 질문(쉬는 날) 선택. 자유 텍스트는 조건이 아니다
    hasIntro: relationshipGoalLabel(profile?.relationship_goal) != null && hasRequiredPublicAnswers(profile?.public_answers),
    questionnaireAnswered: responsesRes.count ?? 0,
    questionnaireTotal: QUESTIONS.length,
    hasValues: (privateRes.data as { marriage_intent: number | null } | null)?.marriage_intent != null,
    hasPreferences: prefsRes.data != null,
  };
}

/**
 * 재진입 위치 결정 — 인증 상태 + 남은 필수 입력 기준.
 * 모든 단계가 끝났으면 서버에 완료를 기록한다 (인증 전 완료는 DB 트리거가 거부한다).
 */
export async function resolveResume(user: AppUser): Promise<ResumeStep> {
  const step = resolveOnboardingStep(await loadOnboardingProgress(user));
  if (step === 'done' && !user.onboarding_completed) {
    await advanceOnboarding('done');
  }
  return step;
}
