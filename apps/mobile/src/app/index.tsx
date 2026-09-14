/**
 * 진입 게이트 — 세션/온보딩 상태에 따라 목적지로 보낸다.
 *
 * 홈은 "온보딩 완료 + 본인확인 + 얼굴 인증" 이 모두 참일 때만 열린다 (canEnterHome).
 * 그 외에는 저장된 단계 값을 믿지 않고 OnboardingResume 이 인증 상태와 남은 필수 입력을 확인해
 * 알맞은 단계로 보낸다 — 예전 앱이 저장한 'appearance' 단계, 앱 재시작, 새로 추가된 필수 입력 모두 같은 규칙.
 */
import { Redirect } from 'expo-router';
import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { OnboardingResume } from '@/components/OnboardingResume';
import { Text } from '@/components/ui';
import { canEnterHome } from '@/lib/onboardingCore';
import { useSession } from '@/lib/session';
import { colors } from '@/theme/tokens';

export default function Gate() {
  const { session, appUser, loading } = useSession();

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <Text variant="title" style={{ marginBottom: 16 }}>본심</Text>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (!session) return <Redirect href="/auth/welcome" />;
  if (!appUser) return <Redirect href="/onboarding/identity" />;
  if (appUser.status !== 'active') return <Redirect href="/auth/suspended" />;
  if (canEnterHome(appUser)) return <Redirect href="/(tabs)" />;
  return <OnboardingResume user={appUser} />;
}
