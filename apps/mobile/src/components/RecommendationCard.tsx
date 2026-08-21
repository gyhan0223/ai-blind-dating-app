import React from 'react';
import { View } from 'react-native';
import { Card, Divider, Text } from '@/components/ui';
import { hobbyLabel, jobLabel, keywordLabel, regionLabel } from '@/constants/options';
import type { RecommendationCard as CardData } from '@/lib/recommendations';
import { colors, radius, spacing } from '@/theme/tokens';

const SMOKING_LABEL: Record<string, string> = { none: '비흡연', sometimes: '가끔 흡연', regular: '흡연' };
const DRINKING_LABEL: Record<string, string> = { none: '음주 안 함', sometimes: '가끔 음주', often: '자주 음주' };

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 }}>
      <Text variant="caption" color={colors.sub}>{label}</Text>
      <Text variant="label">{value}</Text>
    </View>
  );
}

/**
 * 사진 없는 소개 카드 — 타이포그래피와 정보 구조가 첫인상을 만든다.
 * 원시 매칭 점수는 어디에도 표시하지 않는다.
 */
export function RecommendationCard({ card }: { card: CardData }) {
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm }}>
        <Text variant="display">{card.nickname}</Text>
        <Text variant="title" color={colors.sub}>{card.age}</Text>
      </View>

      <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm }}>
        {card.identity_verified && (
          <View style={{ backgroundColor: colors.accentSoft, borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 4 }}>
            <Text variant="caption" color={colors.accent}>본인 인증 ✓</Text>
          </View>
        )}
        {card.face_verified && (
          <View style={{ backgroundColor: colors.accentSoft, borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 4 }}>
            <Text variant="caption" color={colors.accent}>얼굴 인증 ✓</Text>
          </View>
        )}
      </View>

      <Divider />

      <InfoRow label="지역" value={regionLabel(card.region_code)} />
      <InfoRow label="키" value={`${card.height_cm}cm`} />
      <InfoRow label="직업" value={jobLabel(card.job_group)} />
      <InfoRow label="흡연" value={SMOKING_LABEL[card.smoking] ?? card.smoking} />
      <InfoRow label="음주" value={DRINKING_LABEL[card.drinking] ?? card.drinking} />

      {card.personality_keywords.length > 0 && (
        <>
          <Divider />
          <Text variant="caption" color={colors.sub} style={{ marginBottom: spacing.sm }}>이런 사람이에요</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
            {card.personality_keywords.map((k) => (
              <View key={k} style={{ borderWidth: 1, borderColor: colors.line, borderRadius: radius.full, paddingHorizontal: 12, paddingVertical: 6 }}>
                <Text variant="caption" color={colors.inkSoft}>{keywordLabel(k)}</Text>
              </View>
            ))}
          </View>
        </>
      )}

      {card.hobbies.length > 0 && (
        <>
          <View style={{ height: spacing.md }} />
          <Text variant="caption" color={colors.sub} style={{ marginBottom: spacing.sm }}>요즘 즐기는 것</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
            {card.hobbies.map((h) => (
              <View key={h} style={{ borderWidth: 1, borderColor: colors.line, borderRadius: radius.full, paddingHorizontal: 12, paddingVertical: 6 }}>
                <Text variant="caption" color={colors.inkSoft}>{hobbyLabel(h)}</Text>
              </View>
            ))}
          </View>
        </>
      )}

      {card.reasons.length > 0 && (
        <>
          <Divider />
          <View style={{ backgroundColor: colors.warmHighlight, borderRadius: radius.md, padding: spacing.md, gap: 6 }}>
            {card.reasons.map((reason) => (
              <Text key={reason} variant="body" color={colors.inkSoft}>
                {reason}
              </Text>
            ))}
          </View>
        </>
      )}
    </Card>
  );
}
