import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Button, Card, ChipGroup, Divider, InlineNotice, LikertScale, Text } from '@/components/ui';
import { VALUE_AXES } from '@/constants/questions';
import { colors, spacing } from '@/theme/tokens';

export type ValuesFormState = {
  values: Record<string, number>;
  pastRelationships: string | null;
  shareSensitive: boolean;
};

export const EMPTY_VALUES_FORM: ValuesFormState = { values: {}, pastRelationships: null, shareSensitive: false };

const PAST_RELATIONSHIP_OPTIONS = [
  { value: 'none', label: '없어요' },
  { value: 'few', label: '1~2번' },
  { value: 'several', label: '3번 이상' },
] as const;

/**
 * 연애 가치관 폼 — 온보딩(values 단계)과 내 정보 → 가치관 다시 답하기(#25)가 함께 쓴다.
 * 비공개 응답이다. 민감 항목(지난 연애)은 선택 응답 + 공개 여부 분리.
 */
export function ValuesForm({
  initial,
  submitLabel,
  busy,
  error,
  onSubmit,
}: {
  initial: ValuesFormState;
  submitLabel: string;
  busy: boolean;
  error: string | null;
  onSubmit: (state: ValuesFormState) => void;
}) {
  const [values, setValues] = useState<Record<string, number>>(initial.values);
  const [pastRelationships, setPastRelationships] = useState<string | null>(initial.pastRelationships);
  const [shareSensitive, setShareSensitive] = useState(initial.shareSensitive);
  const complete = VALUE_AXES.every((a) => values[a.key] != null);

  return (
    <View>
      <View style={{ gap: spacing.md }}>
        {VALUE_AXES.map((axis) => (
          <Card key={axis.key}>
            <Text variant="heading" style={{ marginBottom: spacing.md }}>{axis.title}</Text>
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
            <Text variant="caption" color={colors.sub}>매칭된 상대가 물어보면 이 답변을 공유해도 괜찮아요</Text>
          </Pressable>
        )}
        {pastRelationships && (
          <View style={{ marginTop: spacing.sm }}>
            <Button kind="ghost" title="답변 지우기" onPress={() => { setPastRelationships(null); setShareSensitive(false); }} />
          </View>
        )}
      </Card>

      {error && (
        <View style={{ marginTop: spacing.md }}>
          <InlineNotice tone="danger" text={error} />
        </View>
      )}

      <View style={{ marginTop: spacing.xl }}>
        <Button title={submitLabel} onPress={() => complete && onSubmit({ values, pastRelationships, shareSensitive })} loading={busy} disabled={!complete} />
      </View>
    </View>
  );
}
