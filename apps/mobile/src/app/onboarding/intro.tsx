import { router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { OnboardingHeader } from '@/components/OnboardingHeader';
import { Button, Card, ChipGroup, InlineNotice, Screen, Text } from '@/components/ui';
import {
  composeIntro,
  normalizePublicAnswers,
  PUBLIC_PROMPTS,
  RELATIONSHIP_GOALS,
  type RelationshipGoal,
  REQUIRED_PUBLIC_PROMPT_IDS,
} from '@/constants/questions';
import { advanceOnboarding } from '@/lib/onboarding';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { colors, radius, spacing } from '@/theme/tokens';

/**
 * 공개 소개 — 고르기만 하면 완성된다 (#39). 글쓰기 없음.
 *
 *  * 여기서 고른 내용은 전부 "상대에게 공개" 된다 (profiles 테이블 · 추천 카드).
 *  * 필수: 연애 목적 + 쉬는 날 질문. 나머지 질문은 선택 (긴 성격검사가 아니다).
 *  * 고른 항목으로 만들어지는 소개 문장을 화면에서 바로 보여준다 (서버가 카드에 싣는 문장과 같은 규칙).
 *  * 가치관 설문(비공개)은 다음 단계에서 따로 받는다 — 여기와 섞지 않는다.
 *  * 앱 재시작 후 다시 들어오면 저장된 값을 불러온다.
 */
export default function IntroStep() {
  const { session, refreshAppUser } = useSession();
  const [goal, setGoal] = useState<RelationshipGoal | null>(null);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const userId = session?.user.id;

  useEffect(() => {
    if (!userId) return;
    let mounted = true;
    supabase
      .from('profiles')
      .select('relationship_goal, public_answers')
      .eq('user_id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (!mounted || !data) return;
        if (RELATIONSHIP_GOALS.some((g) => g.value === data.relationship_goal)) {
          setGoal(data.relationship_goal as RelationshipGoal);
        }
        setAnswers(normalizePublicAnswers(data.public_answers));
      });
    return () => {
      mounted = false;
    };
  }, [userId]);

  const requiredDone = REQUIRED_PUBLIC_PROMPT_IDS.every((id) => (answers[id]?.length ?? 0) > 0);
  const valid = !!goal && requiredDone;
  const preview = composeIntro(goal, answers);

  const toggle = (promptId: string, max: number, value: string) => {
    setError(null);
    setAnswers((prev) => {
      const cur = prev[promptId] ?? [];
      if (cur.includes(value)) return { ...prev, [promptId]: cur.filter((v) => v !== value) };
      if (max === 1) return { ...prev, [promptId]: [value] };
      if (cur.length >= max) return prev; // 최대 개수 초과 시 무시
      return { ...prev, [promptId]: [...cur, value] };
    });
  };

  const save = async () => {
    if (!userId || !valid || !goal) return;
    setBusy(true);
    setError(null);
    // 코드만 저장한다 (문장은 서버/앱이 같은 규칙으로 조합). 빈 질문은 키를 넣지 않는다
    const publicAnswers = normalizePublicAnswers(answers);
    const { error: err } = await supabase
      .from('profiles')
      .update({ relationship_goal: goal, public_answers: publicAnswers })
      .eq('user_id', userId);
    if (err) {
      setBusy(false);
      setError('저장하지 못했어요. 잠시 후 다시 시도해 주세요.');
      return;
    }
    await advanceOnboarding('questionnaire');
    await refreshAppUser();
    setBusy(false);
    router.replace('/onboarding/questionnaire');
  };

  return (
    <Screen>
      <OnboardingHeader
        step="intro"
        title="고르기만 하면 소개가 완성돼요"
        subtitle="사진 대신 이 소개로 상대가 당신을 알아가요. 여기서 고른 내용은 소개받는 상대에게 공개돼요."
      />

      <Card>
        <Text variant="heading" style={{ marginBottom: spacing.sm }}>어떤 만남을 원하나요?</Text>
        <Text variant="caption" color={colors.sub} style={{ marginBottom: spacing.md }}>
          필수 · 상대에게 공개돼요.
        </Text>
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
        <Text variant="caption" color={colors.sub} style={{ marginBottom: spacing.xs }}>
          상대에게 이렇게 보여요
        </Text>
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
        <Button title="다음" onPress={save} loading={busy} disabled={!valid} />
      </View>
      <Text variant="caption" color={colors.faint} style={{ marginTop: spacing.md, textAlign: 'center' }}>
        다음 단계의 가치관 설문은 상대에게 그대로 공개되지 않아요.
      </Text>
    </Screen>
  );
}
