/**
 * (legacy) /onboarding/appearance — 외모 취향 단계는 MVP(#39) 에서 제거되었다.
 * 예전 버전이 저장한 단계 값이나 딥링크로 들어오면 인증 상태와 남은 필수 입력을 확인해
 * 알맞은 단계(또는 홈)로 보낸다. 외모 취향 데이터는 더 이상 수집하지 않는다.
 */
import { Redirect } from 'expo-router';
import React from 'react';
import { OnboardingResume } from '@/components/OnboardingResume';
import { useSession } from '@/lib/session';

export default function LegacyAppearanceRoute() {
  const { session, appUser, loading } = useSession();
  if (loading) return null;
  if (!session) return <Redirect href="/auth/welcome" />;
  if (!appUser) return <Redirect href="/onboarding/identity" />;
  return <OnboardingResume user={appUser} />;
}
