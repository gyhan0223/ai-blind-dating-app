import { router } from 'expo-router';
import React from 'react';
import { View } from 'react-native';
import { Button, Screen, Text } from '@/components/ui';
import { DEV_LOGIN_ENABLED, supabase } from '@/lib/supabase';
import { colors, spacing } from '@/theme/tokens';

/** 시드된 테스트 계정 (supabase/seed/seed.sql) — 개발 모드 전용 */
const DEV_ACCOUNTS = [
  { label: '테스트 남성 (지훈)', email: 'demo-m1@bonsim.dev' },
  { label: '테스트 여성 (서연)', email: 'demo-f1@bonsim.dev' },
];

export default function Welcome() {
  const [devLoading, setDevLoading] = React.useState<string | null>(null);

  const devLogin = async (email: string) => {
    setDevLoading(email);
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password: 'bonsim-dev-password',
    });
    setDevLoading(null);
    if (!error) router.replace('/');
  };

  return (
    <Screen scroll={false}>
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <Text variant="caption" color={colors.sub} style={{ marginBottom: spacing.sm }}>
          본심
        </Text>
        <Text variant="display" style={{ marginBottom: spacing.md }}>
          얼굴부터 보지 않는{'\n'}소개팅
        </Text>
        <Text variant="body" color={colors.inkSoft}>
          사진을 고를 필요가 없어요.{'\n'}
          평소의 당신 그대로 시작하세요.{'\n\n'}
          우리는 얼굴 한 장보다{'\n'}
          서로 잘 맞을 가능성을 먼저 봅니다.
        </Text>
      </View>
      <View style={{ gap: spacing.sm, paddingBottom: spacing.lg }}>
        <Button title="시작하기" onPress={() => router.push('/auth/login')} />
        {DEV_LOGIN_ENABLED &&
          DEV_ACCOUNTS.map((acc) => (
            <Button
              key={acc.email}
              kind="secondary"
              title={acc.label}
              loading={devLoading === acc.email}
              onPress={() => devLogin(acc.email)}
            />
          ))}
      </View>
    </Screen>
  );
}
