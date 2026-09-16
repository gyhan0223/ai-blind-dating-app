import { router } from 'expo-router';
import React from 'react';
import { View } from 'react-native';
import { Button, Screen, Text } from '@/components/ui';
import { DEV_TOOLS_ENABLED, loadDevModules } from '@/lib/devTools';
import { colors, spacing } from '@/theme/tokens';

/** 시드된 테스트 계정 로그인 — 계정 목록·비밀번호는 @/dev/devModules 에 있고 개발 빌드에서만 로드된다 (#3) */
const devModules = loadDevModules();

export default function Welcome() {
  const [devLoading, setDevLoading] = React.useState<string | null>(null);

  // 리터럴 __DEV__ 삼항 — release 번들에서는 핸들러 본문까지 제거된다
  const devLogin = __DEV__
    ? async (email: string) => {
        if (!devModules) return;
        setDevLoading(email);
        const { ok } = await devModules.devSeedLogin(email);
        setDevLoading(null);
        if (ok) router.replace('/');
      }
    : undefined;

  return (
    <Screen scroll={false}>
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <Text variant="caption" color={colors.sub} style={{ marginBottom: spacing.sm }}>
          본심
        </Text>
        <Text variant="display" style={{ marginBottom: spacing.md }}>
          사진 없이 대화로{'\n'}먼저 알아가는 소개팅
        </Text>
        <Text variant="body" color={colors.inkSoft}>
          사진을 고를 필요가 없어요.{'\n'}
          짧은 소개와 대화로 서로를 알아가요.{'\n\n'}
          하루 한 명, 본인확인을 마친 분만{'\n'}
          소개해 드려요.
        </Text>
      </View>
      <View style={{ gap: spacing.sm, paddingBottom: spacing.lg }}>
        <Button title="시작하기" onPress={() => router.push('/auth/login')} />
        {/* 리터럴 __DEV__ 가드 → release 번들에서 개발 UI 가 물리적으로 제거된다 (lib/devTools.ts 참고) */}
        {__DEV__ &&
          DEV_TOOLS_ENABLED &&
          devModules &&
          devModules.DEV_SEED_ACCOUNTS.map((acc) => (
            <Button
              key={acc.email}
              kind="secondary"
              title={acc.label}
              loading={devLoading === acc.email}
              onPress={() => devLogin?.(acc.email)}
            />
          ))}
      </View>
    </Screen>
  );
}
