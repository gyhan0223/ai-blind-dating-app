import React, { useState } from 'react';
import { View } from 'react-native';
import { Button, Card, ChipGroup, InlineNotice, Text } from '@/components/ui';
import {
  composeIntro,
  normalizePublicAnswers,
  PUBLIC_PROMPTS,
  RELATIONSHIP_GOALS,
  type RelationshipGoal,
  REQUIRED_PUBLIC_PROMPT_IDS,
} from '@/constants/questions';
import { colors, radius, spacing } from '@/theme/tokens';

export type IntroFormValues = { goal: RelationshipGoal | null; answers: Record<string, string[]> };

/**
 * 공개 소개 폼 — 고르기만 하면 완성 (#39). 온보딩(intro 단계)과 내 정보 → 소개 수정(#25)이 함께 쓴다.
 * 여기서 고른 내용은 전부 상대에게 공개된다. 코드만 저장하고 문장은 앱·서버가 같은 규칙으로 만든다.
 */
export function IntroForm({
  initial,
  submitLabel,
  busy,
  error,
  onSubmit,
}: {
  initial: IntroFormValues;
  submitLabel: string;
  busy: boolean;
  error: string | null;
  onSubmit: (values: IntroFormValues) => void;
}) {
  const [goal, setGoal] = useState<RelationshipGoal | null>(initial.goal);
  const [answers, setAnswers] = useState<Record<string, string[]>>(initial.answers);

  const requiredDone = REQUIRED_PUBLIC_PROMPT_IDS.every((id) => (answers[id]?.length ?? 0) > 0);
  const valid = !!goal && requiredDone;
  const preview = composeIntro(goal, answers);

  const toggle = (promptId: string, max: number, value: string) => {
    setAnswers((prev) => {
      const cur = prev[promptId] ?? [];
      if (cur.includes(value)) return { ...prev, [promptId]: cur.filter((v) => v !== value) };
      if (max === 1) return { ...prev, [promptId]: [value] };
      if (cur.length >= max) return prev; // 최대 개수 초과 시 무시
      return { ...prev, [promptId]: [...cur, value] };
    });
  };

  return (
    <View>
      <Card>
        <Text variant="heading" style={{ marginBottom: spacing.sm }}>어떤 만남을 원하나요?</Text>
        <Text variant="caption" color={colors.sub} style={{ marginBottom: spacing.md }}>필수 · 상대에게 공개돼요.</Text>
        <ChipGroup
          options={RELATIONSHIP_GOALS.map((g) => ({ value: g.value as string, label: g.label }))}
          value={goal}
          onChange={(v) => setGoal(v as RelationshipGoal)}
        />
      </Card>

      {PUBLIC_PROMPTS.map((p) => {
        const required = (REQUIRED_PUBLIC_PROMPT_IDS as readonly string[]).includes(p.id);
        const picked = answers[p.id] ?? [];
        return (
          <View key={p.id} style={{ marginTop: spacing.md }}>
            <Card>
              <Text variant="heading" style={{ marginBottom: spacing.sm }}>{p.question}</Text>
              <Text variant="caption" color={colors.sub} style={{ marginBottom: spacing.md }}>
                {required ? '필수' : '선택'} · 최대 {p.max}개 · 상대에게 공개돼요.
              </Text>
              <ChipGroup
                multiple
                options={p.options.map((o) => ({ value: o.value, label: o.label }))}
                values={picked}
                onChangeMultiple={(next) => {
                  // ChipGroup 은 토글된 전체 배열을 주므로 바뀐 항목 하나를 찾아 max 규칙을 적용한다
                  const changed = next.find((v) => !picked.includes(v)) ?? picked.find((v) => !next.includes(v));
                  if (changed) toggle(p.id, p.max, changed);
                }}
              />
            </Card>
          </View>
        );
      })}

      <View style={{ marginTop: spacing.lg, backgroundColor: colors.warmHighlight, borderRadius: radius.md, padding: spacing.md }}>
        <Text variant="caption" color={colors.sub} style={{ marginBottom: spacing.xs }}>상대에게 이렇게 보여요</Text>
        <Text variant="body" color={colors.inkSoft} style={{ lineHeight: 24 }}>
          {preview ?? '항목을 고르면 여기에 소개 문장이 만들어져요.'}
        </Text>
      </View>

      {error && (
        <View style={{ marginTop: spacing.md }}>
          <InlineNotice tone="danger" text={error} />
        </View>
      )}

      <View style={{ marginTop: spacing.xl }}>
        <Button
          title={submitLabel}
          onPress={() => goal && onSubmit({ goal, answers: normalizePublicAnswers(answers) })}
          loading={busy}
          disabled={!valid}
        />
      </View>
    </View>
  );
}
