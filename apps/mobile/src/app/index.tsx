/**
 * 진입 게이트 — 세션/온보딩 상태에 따라 목적지로 보낸다.
 */
import { Redirect } from 'expo-router';
import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Text } from '@/components/ui';
import { useSession } from '@/lib/session';
import { nextOnboardingRoute } from '@/constants/options';
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
  if (appUser && appUser.status !== 'active') return <Redirect href="/auth/suspended" />;
  if (!appUser?.onboarding_completed) {
    return <Redirect href={nextOnboardingRoute(appUser?.onboarding_step ?? 'welcome') as never} />;
  }
  return <Redirect href="/(tabs)" />;
}
