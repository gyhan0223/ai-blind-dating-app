import type { OnboardingStep } from '@/constants/options';
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
