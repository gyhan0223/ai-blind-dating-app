import { router } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';
import { Button, InlineNotice, Screen, Text } from '@/components/ui';
import { deleteAccountErrorText, readEdgeError } from '@/lib/edge';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { colors, spacing } from '@/theme/tokens';

/** 이용 불가 상태 안내 — suspended(일시 정지) / banned(영구 차단) / deleted(탈퇴, 복구 가능) */
export default function Suspended() {
  const { appUser, signOut, refreshAppUser } = useSession();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = appUser?.status ?? 'suspended';

  const reactivate = async () => {
    setLoading(true);
    setError(null);
    const { data, error: invokeError } = await supabase.functions.invoke('delete-account', {
      body: { action: 'reactivate' },
    });
    if (data?.reactivated) {
      await refreshAppUser();
      setLoading(false);
      router.replace('/');
      return;
    }
    // 이미 복구된 계정(not_deleted)이면 상태만 다시 읽어 진입 게이트로 보낸다
    const e = await readEdgeError(invokeError);
    setLoading(false);
    if (e.code === 'not_deleted') {
      await refreshAppUser();
      router.replace('/');
      return;
    }
    setError(deleteAccountErrorText(e));
  };

  const copy =
    status === 'deleted'
      ? {
          title: '탈퇴한 계정이에요',
          body: '이 번호로 사용하던 계정이 탈퇴 처리되어 있어요.\n탈퇴 후 30일 안에 복구하면 프로필과 대화를 그대로 이어서 쓸 수 있고, 30일이 지나 삭제된 정보는 복구되지 않아 처음부터 다시 시작해요.',
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
        {error && <InlineNotice tone="danger" text={error} />}
        {status === 'deleted' && (
          <Button title="계정 복구하기" onPress={reactivate} loading={loading} />
        )}
        <Button kind="secondary" title="로그아웃" onPress={signOut} />
      </View>
    </Screen>
  );
}
