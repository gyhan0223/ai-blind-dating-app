import { router } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { OnboardingHeader } from '@/components/OnboardingHeader';
import { Button, Card, ChipGroup, Divider, InlineNotice, LikertScale, Screen, Text } from '@/components/ui';
import { VALUE_AXES } from '@/constants/questions';
import { advanceOnboarding } from '@/lib/onboarding';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { colors, spacing } from '@/theme/tokens';

const PAST_RELATIONSHIP_OPTIONS = [
  { value: 'none', label: '없어요' },
  { value: 'few', label: '1~2번' },
  { value: 'several', label: '3번 이상' },
] as const;

/** 연애 가치관 설문 — 민감 항목은 선택 응답 + 공개 여부 분리 */
export default function ValuesStep() {
  const { session, refreshAppUser } = useSession();
  const [values, setValues] = useState<Record<string, number>>({});
  const [pastRelationships, setPastRelationships] = useState<string | null>(null);
  const [shareSensitive, setShareSensitive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const complete = VALUE_AXES.every((a) => values[a.key] != null);

  const save = async () => {
    const userId = session?.user.id;
    if (!userId || !complete) return;
    setBusy(true);
    setError(null);

    const sensitiveAnswers: Record<string, string> = {};
    if (pastRelationships) sensitiveAnswers.past_relationships = pastRelationships;

    const { error: err } = await supabase.from('private_profiles').upsert({
      user_id: userId,
      ...values,
      sensitive_answers: sensitiveAnswers,
      sensitive_visibility: { past_relationships: shareSensitive },
    });
    if (err) {
      setBusy(false);
      setError('저장하지 못했어요. 잠시 후 다시 시도해 주세요.');
      return;
    }
    await advanceOnboarding('preferences');
    await refreshAppUser();
    setBusy(false);
    router.replace('/onboarding/preferences');
  };

  return (
    <Screen>
      <OnboardingHeader
        step="values"
        title="연애에 대한 생각"
        subtitle="비슷한 방향을 보는 사람을 찾기 위한 질문이에요."
      />

      <View style={{ gap: spacing.md }}>
        {VALUE_AXES.map((axis) => (
          <Card key={axis.key}>
            <Text variant="heading" style={{ marginBottom: spacing.md }}>
              {axis.title}
            </Text>
            <LikertScale
              value={values[axis.key] ?? null}
              onChange={(v) => setValues((prev) => ({ ...prev, [axis.key]: v }))}
              lowLabel={axis.lowLabel}
              highLabel={axis.highLabel}
            />
          </Card>
        ))}
      </View>

      <Divider />

      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, marginBottom: spacing.sm }}>
          <Text variant="heading">지난 연애 경험</Text>
          <Text variant="caption" color={colors.faint}>선택 · 답하지 않아도 돼요</Text>
        </View>
        <ChipGroup
          options={PAST_RELATIONSHIP_OPTIONS.map((o) => ({ value: o.value as string, label: o.label }))}
          value={pastRelationships}
          onChange={setPastRelationships}
        />
        {pastRelationships && (
          <Pressable
            onPress={() => setShareSensitive(!shareSensitive)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md }}
          >
            <View
              style={{
                width: 22,
                height: 22,
                borderRadius: 6,
                borderWidth: 1.5,
                borderColor: shareSensitive ? colors.accent : colors.line,
                backgroundColor: shareSensitive ? colors.accent : colors.surface,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {shareSensitive && <Text variant="caption" color={colors.onAccent}>✓</Text>}
            </View>
            <Text variant="caption" color={colors.sub}>
              매칭된 상대가 물어보면 이 답변을 공유해도 괜찮아요
            </Text>
          </Pressable>
        )}
      </Card>

      {error && (
        <View style={{ marginTop: spacing.md }}>
          <InlineNotice tone="danger" text={error} />
        </View>
      )}

      <View style={{ marginTop: spacing.xl }}>
        <Button title="다음" onPress={save} loading={busy} disabled={!complete} />
      </View>
    </Screen>
  );
}
