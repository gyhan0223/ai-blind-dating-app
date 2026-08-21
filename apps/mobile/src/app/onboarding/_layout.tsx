import { Stack } from 'expo-router';
import React from 'react';
import { colors } from '@/theme/tokens';

export default function OnboardingLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        gestureEnabled: false, // 온보딩 중 임의 이탈 방지 (단계 저장 후 이동)
        contentStyle: { backgroundColor: colors.bg },
      }}
    />
  );
}
