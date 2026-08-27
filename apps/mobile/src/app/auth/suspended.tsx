import { router } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';
import { Button, Screen, Text } from '@/components/ui';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { colors, spacing } from '@/theme/tokens';

/** 이용 불가 상태 안내 — suspended(일시 정지) / banned(영구 차단) / deleted(탈퇴, 복구 가능) */
export default function Suspended() {
  const { appUser, signOut, refreshAppUser } = useSession();
  const [loading, setLoading] = useState(false);
  const status = appUser?.status ?? 'suspended';

  const reactivate = async () => {
    setLoading(true);
    const { data } = await supabase.functions.invoke('delete-account', {
      body: { action: 'reactivate' },
    });
    setLoading(false);
    if (data?.reactivated) {
      await refreshAppUser();
      router.replace('/');
    }
  };

  const copy =
    status === 'deleted'
      ? {
          title: '탈퇴한 계정이에요',
          body: '이 번호로 사용하던 계정이 탈퇴 처리되어 있어요.\n계정을 복구하면 프로필과 매칭 기록을 그대로 이어서 사용할 수 있어요.',
        }
      : status === 'banned'
        ? {
            title: '계정을 이용할 수 없어요',
            body: '커뮤니티 가이드라인 위반으로 계정 이용이 제한되었습니다.\n문의가 필요하다면 고객센터로 연락해 주세요.',
          }
        : {
            title: '계정 이용이 제한되었어요',
            body: '커뮤니티 가이드라인 위반으로 계정이 일시 정지되었습니다.\n문의가 필요하다면 고객센터로 연락해 주세요.',
          };

  return (
    <Screen scroll={false}>
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <Text variant="title" style={{ marginBottom: spacing.md }}>
          {copy.title}
        </Text>
        <Text variant="body" color={colors.sub}>
          {copy.body}
        </Text>
      </View>
      <View style={{ paddingBottom: spacing.lg, gap: spacing.sm }}>
        {status === 'deleted' && (
          <Button title="계정 복구하기" onPress={reactivate} loading={loading} />
        )}
        <Button kind="secondary" title="로그아웃" onPress={signOut} />
      </View>
    </Screen>
  );
}
