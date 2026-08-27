import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import React from 'react';
import { Alert, View } from 'react-native';
import { Button, Card, Divider, Screen, Text } from '@/components/ui';
import { jobLabel, regionLabel } from '@/constants/options';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { colors, radius, spacing } from '@/theme/tokens';

async function fetchMe() {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) throw new Error('로그인이 필요합니다.');
  const [{ data: profile }, { data: sub }] = await Promise.all([
    supabase.from('profiles').select('*').eq('user_id', userId).maybeSingle(),
    supabase.from('subscriptions').select('plan, status').eq('user_id', userId).maybeSingle(),
  ]);
  return { profile, plan: sub?.status === 'active' ? (sub?.plan ?? 'free') : 'free' };
}

export default function MeScreen() {
  const { appUser, signOut } = useSession();
  const { data } = useQuery({ queryKey: ['me'], queryFn: fetchMe });

  const confirmSignOut = () => {
    Alert.alert('로그아웃할까요?', undefined, [
      { text: '취소', style: 'cancel' },
      {
        text: '로그아웃',
        style: 'destructive',
        onPress: async () => {
          await signOut();
          router.replace('/auth/welcome');
        },
      },
    ]);
  };

  const confirmDelete = () => {
    Alert.alert('정말 탈퇴할까요?', '추천과 매칭이 중단돼요. 같은 번호로 다시 로그인하면 복구할 수 있어요.', [
      { text: '취소', style: 'cancel' },
      {
        text: '탈퇴하기',
        style: 'destructive',
        onPress: async () => {
          // 콘텐츠/인증/identity 보존 정책은 서버(delete-account Edge Function)가 분리 처리
          await supabase.functions.invoke('delete-account', { body: { action: 'delete' } });
          await signOut();
          router.replace('/auth/welcome');
        },
      },
    ]);
  };

  return (
    <Screen>
      <Text variant="title" style={{ marginBottom: spacing.lg }}>내 정보</Text>

      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text variant="display">{data?.profile?.nickname ?? '...'}</Text>
          <View
            style={{
              backgroundColor: data?.plan === 'plus' ? colors.warmHighlight : colors.surfaceSubtle,
              borderRadius: radius.full,
              paddingHorizontal: 12,
              paddingVertical: 5,
            }}
          >
            <Text variant="caption" color={colors.inkSoft}>
              {data?.plan === 'plus' ? 'Plus' : 'Free'}
            </Text>
          </View>
        </View>
        {data?.profile && (
          <Text variant="body" color={colors.sub} style={{ marginTop: spacing.xs }}>
            {regionLabel(data.profile.region_code)} · {jobLabel(data.profile.job_group)}
          </Text>
        )}
        <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md }}>
          {appUser?.identity_verified && (
            <View style={{ backgroundColor: colors.accentSoft, borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 4 }}>
              <Text variant="caption" color={colors.accent}>본인 인증 ✓</Text>
            </View>
          )}
          {appUser?.face_verified && (
            <View style={{ backgroundColor: colors.accentSoft, borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 4 }}>
              <Text variant="caption" color={colors.accent}>얼굴 인증 ✓</Text>
            </View>
          )}
        </View>
      </Card>

      <View style={{ height: spacing.md }} />

      <Card>
        <Text variant="heading" style={{ marginBottom: spacing.sm }}>본심 Plus</Text>
        <Text variant="body" color={colors.sub}>
          하루 한 명의 추천이 더해지고, 지역을 넓혀 소개받을 수 있어요.{'\n'}
          Plus 여도 매칭 기준은 똑같아요 — 더 좋은 상대를 돈으로 살 수는 없어요.
        </Text>
        <Text variant="caption" color={colors.faint} style={{ marginTop: spacing.sm }}>
          결제는 준비 중이에요.
        </Text>
      </Card>

      <View style={{ height: spacing.md }} />

      <Card>
        <Text variant="heading" style={{ marginBottom: spacing.sm }}>내 정보와 안전</Text>
        <Text variant="body" color={colors.sub}>
          얼굴 사진은 상대에게 절대 공개되지 않아요.{'\n'}
          설문과 피드백은 매칭에만 사용돼요.
        </Text>
        <Divider />
        <Text variant="caption" color={colors.sub}>
          탈퇴하면 추천과 매칭이 즉시 중단돼요.{'\n'}
          중복 가입 방지를 위해 본인확인 기록은 정책에 따라 보관될 수 있어요.
        </Text>
      </Card>

      <View style={{ marginTop: spacing.xl, gap: spacing.sm }}>
        <Button kind="secondary" title="로그아웃" onPress={confirmSignOut} />
        <Button kind="ghost" title="회원 탈퇴" onPress={confirmDelete} />
      </View>
    </Screen>
  );
}
