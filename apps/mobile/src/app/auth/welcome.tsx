import { router } from 'expo-router';
import React from 'react';
import { View } from 'react-native';
import { Button, Screen, Text } from '@/components/ui';
import { DEV_TOOLS_ENABLED } from '@/lib/devTools';
import { supabase } from '@/lib/supabase';
import { colors, spacing } from '@/theme/tokens';

/** 시드된 테스트 계정 (supabase/seed/seed.sql) — 개발 모드 전용.
 *  리터럴 __DEV__ 조건이라 release 번들(Hermes bytecode 포함)에서는 상수 접기로
 *  계정 문자열 자체가 제거된다 (Hermes 는 미사용 모듈 상수를 DCE 하지 않으므로 필요). */
const DEV_ACCOUNTS = __DEV__
  ? [
      { label: '테스트 남성 (지훈)', email: 'demo-m1@bonsim.dev' },
      { label: '테스트 여성 (서연)', email: 'demo-f1@bonsim.dev' },
    ]
  : [];

// seed.sql 의 개발용 비밀번호 — production DB 에는 시드 계정 자체가 없어야 한다.
// 리터럴 __DEV__ 조건이라 release 번들에서는 문자열이 상수 접기로 제거된다.
const DEV_SEED_PASSWORD = __DEV__ ? 'bonsim-dev-password' : '';

export default function Welcome() {
  const [devLoading, setDevLoading] = React.useState<string | null>(null);

  const devLogin = async (email: string) => {
    if (!__DEV__ || !DEV_SEED_PASSWORD) return;
    setDevLoading(email);
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password: DEV_SEED_PASSWORD,
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
        {/* 리터럴 __DEV__ 가드 → release 번들에서 개발 UI 가 물리적으로 제거된다 (lib/devTools.ts 참고) */}
        {__DEV__ &&
          DEV_TOOLS_ENABLED &&
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
