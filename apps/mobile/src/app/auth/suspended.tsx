import React from 'react';
import { View } from 'react-native';
import { Button, Screen, Text } from '@/components/ui';
import { useSession } from '@/lib/session';
import { colors, spacing } from '@/theme/tokens';

export default function Suspended() {
  const { signOut } = useSession();
  return (
    <Screen scroll={false}>
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <Text variant="title" style={{ marginBottom: spacing.md }}>
          계정 이용이 제한되었어요
        </Text>
        <Text variant="body" color={colors.sub}>
          커뮤니티 가이드라인 위반으로 계정이 일시 정지되었습니다.{'\n'}
          문의가 필요하다면 고객센터로 연락해 주세요.
        </Text>
      </View>
      <View style={{ paddingBottom: spacing.lg }}>
        <Button kind="secondary" title="로그아웃" onPress={signOut} />
      </View>
    </Screen>
  );
}
