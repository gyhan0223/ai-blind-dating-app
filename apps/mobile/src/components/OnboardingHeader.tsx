import React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui';
import { colors, radius, spacing } from '@/theme/tokens';

const STEPS = ['identity', 'face', 'profile', 'questionnaire', 'values', 'preferences', 'appearance'];

export function OnboardingHeader({ step, title, subtitle }: { step: string; title: string; subtitle?: string }) {
  const index = Math.max(0, STEPS.indexOf(step));
  const progress = (index + 1) / STEPS.length;
  return (
    <View style={{ marginBottom: spacing.lg }}>
      <View
        style={{
          height: 4,
          borderRadius: radius.full,
          backgroundColor: colors.line,
          marginBottom: spacing.lg,
          overflow: 'hidden',
        }}
      >
        <View
          style={{
            width: `${Math.round(progress * 100)}%`,
            height: 4,
            backgroundColor: colors.accent,
          }}
        />
      </View>
      <Text variant="title" style={{ marginBottom: subtitle ? spacing.sm : 0 }}>
        {title}
      </Text>
      {subtitle ? (
        <Text variant="body" color={colors.sub}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}
