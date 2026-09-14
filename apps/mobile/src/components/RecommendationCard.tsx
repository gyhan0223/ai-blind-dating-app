import React from 'react';
import { View } from 'react-native';
import { Card, Divider, Text } from '@/components/ui';
import { hobbyLabel, jobLabel, keywordLabel, regionLabel } from '@/constants/options';
import { relationshipGoalLabel } from '@/constants/questions';
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

function Chip({ text }: { text: string }) {
  return (
    <View style={{ borderWidth: 1, borderColor: colors.line, borderRadius: radius.full, paddingHorizontal: 12, paddingVertical: 6 }}>
      <Text variant="caption" color={colors.inkSoft}>{text}</Text>
    </View>
  );
}

/**
 * 사진 없는 소개 카드 — 고른 항목으로 만든 소개 문장과 대화 소재가 첫인상을 만든다.
 * 서버가 만든 공개 필드 스냅샷만 표시한다 (intro 는 서버가 선택지로 조합한 문장).
 * 원시 매칭 점수·비공개 응답은 어디에도 없다 (#39).
 */
export function RecommendationCard({ card }: { card: CardData }) {
  const goal = relationshipGoalLabel(card.relationship_goal);
  const answers = card.public_answers ?? [];
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm }}>
        <Text variant="display">{card.nickname}</Text>
        <Text variant="title" color={colors.sub}>{card.age}</Text>
      </View>
      <Text variant="body" color={colors.sub} style={{ marginTop: spacing.xs }}>
        {regionLabel(card.region_code)} · {jobLabel(card.job_group)}
      </Text>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm }}>
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

      {card.intro ? (
        // 서버가 고른 항목(연애 목적 포함)으로 조합한 소개 문장 — 연애 목적을 따로 또 표시하지 않는다
        <>
          <Divider />
          <Text variant="body" style={{ lineHeight: 24 }}>{card.intro}</Text>
        </>
      ) : goal ? (
        <>
          <Divider />
          <Text variant="caption" color={colors.accent}>{goal}</Text>
        </>
      ) : null}

      {!card.intro && answers.length > 0 && (
        <>
          <Divider />
          <Text variant="caption" color={colors.sub} style={{ marginBottom: spacing.sm }}>이야기해 볼 만한 것</Text>
          <View style={{ gap: spacing.md }}>
            {answers.map((a) => (
              <View key={a.id}>
                <Text variant="label" color={colors.inkSoft}>{a.question}</Text>
                <Text variant="body" style={{ marginTop: 2 }}>{a.answer}</Text>
              </View>
            ))}
          </View>
        </>
      )}

      <Divider />

      <InfoRow label="키" value={`${card.height_cm}cm`} />
      <InfoRow label="흡연" value={SMOKING_LABEL[card.smoking] ?? card.smoking} />
      <InfoRow label="음주" value={DRINKING_LABEL[card.drinking] ?? card.drinking} />

      {card.personality_keywords.length > 0 && (
        <>
          <View style={{ height: spacing.md }} />
          <Text variant="caption" color={colors.sub} style={{ marginBottom: spacing.sm }}>스스로 고른 키워드</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
            {card.personality_keywords.map((k) => (
              <Chip key={k} text={keywordLabel(k)} />
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
              <Chip key={h} text={hobbyLabel(h)} />
            ))}
          </View>
        </>
      )}

      {card.reasons.length > 0 && (
        <>
          <Divider />
          <Text variant="caption" color={colors.sub} style={{ marginBottom: spacing.sm }}>확인된 공통점</Text>
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
