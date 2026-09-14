import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { Alert, Linking, Platform, Switch, View } from 'react-native';
import { Button, Card, Divider, Screen, Text } from '@/components/ui';
import { jobLabel, regionLabel } from '@/constants/options';
import { composeIntro } from '@/constants/questions';
import {
  DEFAULT_PREFERENCES,
  fetchNotificationPreferences,
  type NotificationPreferences,
  pushPermissionStatus,
  registerPushToken,
  saveNotificationPreferences,
  unregisterPushToken,
} from '@/lib/push';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { colors, radius, spacing } from '@/theme/tokens';

/**
 * 내 정보.
 * Plus/결제 관련 UI 는 MVP(#29/#39) 에서 제거 — 결제가 없으므로 진입점·플랜 표시·"준비 중" 안내를 두지 않는다.
 * (subscriptions 테이블과 재도입용 구조는 서버에 그대로 남아 있다.)
 * 소개 항목·선호조건 수정은 #25 에서 제공한다 — 여기서는 상대에게 보이는 문장을 확인만 한다.
 */
async function fetchMe() {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) throw new Error('로그인이 필요합니다.');
  const { data: profile } = await supabase
    .from('profiles')
    .select('nickname, region_code, job_group, relationship_goal, public_answers')
    .eq('user_id', userId)
    .maybeSingle();
  return { profile };
}

const PREF_ITEMS: { key: keyof NotificationPreferences; label: string }[] = [
  { key: 'daily_recommendation', label: '오늘의 소개 도착' },
  { key: 'match_created', label: '새 대화가 열림' },
  { key: 'new_message', label: '새 메시지' },
  { key: 'mutual_meetup_interest', label: '만남 관련 소식' },
];

export default function MeScreen() {
  const { appUser, signOut } = useSession();
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['me'], queryFn: fetchMe });
  const { data: prefs } = useQuery({ queryKey: ['notification-preferences'], queryFn: fetchNotificationPreferences });
  const { data: permission } = useQuery({ queryKey: ['push-permission'], queryFn: pushPermissionStatus });
  const [prefError, setPrefError] = useState<string | null>(null);

  const togglePref = async (key: keyof NotificationPreferences, value: boolean) => {
    const next = { ...(prefs ?? DEFAULT_PREFERENCES), [key]: value };
    queryClient.setQueryData(['notification-preferences'], next);
    setPrefError(null);
    try {
      await saveNotificationPreferences(next);
    } catch {
      setPrefError('알림 설정을 저장하지 못했어요.');
      queryClient.invalidateQueries({ queryKey: ['notification-preferences'] });
    }
  };
  const profile = data?.profile;
  // 카드에 실리는 문장과 같은 규칙으로 고른 항목을 문장으로 만든다 (서버 composeIntro 와 동일)
  const intro = profile ? composeIntro(profile.relationship_goal, profile.public_answers) : null;

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
          await unregisterPushToken();
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
        <Text variant="display">{profile?.nickname ?? '...'}</Text>
        {profile && (
          <Text variant="body" color={colors.sub} style={{ marginTop: spacing.xs }}>
            {regionLabel(profile.region_code)} · {jobLabel(profile.job_group)}
          </Text>
        )}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md }}>
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
        <Text variant="heading" style={{ marginBottom: spacing.xs }}>상대에게 보이는 소개</Text>
        <Text variant="caption" color={colors.sub} style={{ marginBottom: spacing.md }}>
          사진 대신 고른 항목으로 만든 이 문장이 소개돼요.
        </Text>
        <Text variant="body" style={{ lineHeight: 24 }}>
          {intro ?? '아직 고른 소개가 없어요.'}
        </Text>
      </Card>

      <View style={{ height: spacing.md }} />

      <Card>
        <Text variant="heading" style={{ marginBottom: spacing.xs }}>알림</Text>
        <Text variant="caption" color={colors.sub} style={{ marginBottom: spacing.sm }}>
          알림에는 메시지 내용이나 상대 이름이 들어가지 않아요. 앱을 열어야 볼 수 있어요.
        </Text>
        {permission === 'denied' && Platform.OS !== 'web' && (
          <View style={{ marginBottom: spacing.sm }}>
            <Text variant="caption" color={colors.danger} style={{ marginBottom: spacing.xs }}>
              기기 설정에서 알림이 꺼져 있어요.
            </Text>
            <Button kind="secondary" title="기기 알림 설정 열기" onPress={() => Linking.openSettings()} />
          </View>
        )}
        {permission === 'undetermined' && (
          <View style={{ marginBottom: spacing.sm }}>
            <Button
              kind="secondary"
              title="알림 켜기"
              onPress={async () => {
                await registerPushToken({ askPermission: true });
                queryClient.invalidateQueries({ queryKey: ['push-permission'] });
              }}
            />
          </View>
        )}
        {PREF_ITEMS.map((item) => (
          <View key={item.key} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6 }}>
            <Text variant="body">{item.label}</Text>
            <Switch
              value={(prefs ?? DEFAULT_PREFERENCES)[item.key]}
              onValueChange={(v) => togglePref(item.key, v)}
              trackColor={{ true: colors.accent }}
              accessibilityLabel={`${item.label} 알림`}
            />
          </View>
        ))}
        {prefError && (
          <Text variant="caption" color={colors.danger} style={{ marginTop: spacing.xs }}>{prefError}</Text>
        )}
      </Card>

      <View style={{ height: spacing.md }} />

      <Card>
        <Text variant="heading" style={{ marginBottom: spacing.sm }}>내 정보와 안전</Text>
        <Text variant="body" color={colors.sub}>
          인증에 쓴 얼굴 정보는 상대에게 공개되지 않고, 소개 상대를 고르는 데도 쓰이지 않아요.{'\n'}
          가치관 설문과 피드백은 소개 기준에만 참고되고 상대에게 그대로 보이지 않아요.
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
