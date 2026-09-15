import { router } from 'expo-router';
import React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/ui';
import { colors, spacing } from '@/theme/tokens';

/** 내 정보 → 수정 화면 공통 헤더 (#25) — 뒤로 가기 + 제목 + 반영 시점 안내 */
export function SettingsHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={{ marginBottom: spacing.lg }}>
      <Pressable
        onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/me'))}
        accessibilityRole="button"
        accessibilityLabel="뒤로"
        hitSlop={12}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: spacing.md }}
      >
        <Ionicons name="chevron-back" size={20} color={colors.sub} />
        <Text variant="caption" color={colors.sub}>내 정보</Text>
      </Pressable>
      <Text variant="title" style={{ marginBottom: subtitle ? spacing.sm : 0 }}>{title}</Text>
      {subtitle ? <Text variant="body" color={colors.sub}>{subtitle}</Text> : null}
    </View>
  );
}

/** 저장 뒤 공통 안내 — 추천은 생성 시점 값을 읽으므로 다음 소개부터 반영된다 */
export const NEXT_RECOMMENDATION_NOTE = '저장한 내용은 다음 소개부터 반영돼요. 오늘 이미 받은 소개는 바뀌지 않아요.';
