import React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui';
import type { FaceTestAsset } from '@/constants/faceTestAssets';
import { colors, radius, spacing } from '@/theme/tokens';

/**
 * 외모 취향 테스트용 추상 인상 카드.
 * 실제 얼굴 사진이 아니라 인상 축을 시각화한 일러스트 — 실서비스에서
 * synthetic face 이미지로 교체될 자리다.
 */
export function FacePlaceholder({ asset }: { asset: FaceTestAsset }) {
  const { look } = asset;
  const faceRadius = look.faceShape === 'round' ? 44 : look.faceShape === 'oval' ? 36 : 18;
  const hairHeight = look.hair === 'short' ? 22 : look.hair === 'medium' ? 34 : 52;

  return (
    <View
      style={{
        alignItems: 'center',
        backgroundColor: colors.surface,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.line,
        paddingVertical: spacing.lg,
        paddingHorizontal: spacing.md,
      }}
    >
      <View style={{ width: 96, height: 116, alignItems: 'center', marginBottom: spacing.md }}>
        <View
          style={{
            position: 'absolute',
            top: 0,
            width: 96,
            height: hairHeight + 30,
            borderTopLeftRadius: 48,
            borderTopRightRadius: 48,
            backgroundColor: look.accent,
          }}
        />
        <View
          style={{
            position: 'absolute',
            top: 14,
            width: 80,
            height: 96,
            borderRadius: faceRadius,
            backgroundColor: look.base,
          }}
        />
        {/* 눈 */}
        <View style={{ position: 'absolute', top: 58, flexDirection: 'row', gap: 26 }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: '#41372E' }} />
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: '#41372E' }} />
        </View>
        {/* 입 */}
        <View
          style={{
            position: 'absolute',
            top: 82,
            width: 18,
            height: 4,
            borderRadius: 2,
            backgroundColor: look.accent,
          }}
        />
      </View>
      <Text variant="caption" color={colors.sub} style={{ textAlign: 'center' }}>
        {asset.label}
      </Text>
    </View>
  );
}
