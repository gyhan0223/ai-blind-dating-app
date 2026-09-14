import { router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { OnboardingHeader } from '@/components/OnboardingHeader';
import { Button, Card, ChipGroup, Field, InlineNotice, Screen, Text } from '@/components/ui';
import {
  INTRO_MAX_LENGTH,
  INTRO_MIN_LENGTH,
  PUBLIC_ANSWER_MAX_LENGTH,
  PUBLIC_PROMPTS,
  RELATIONSHIP_GOALS,
  type RelationshipGoal,
} from '@/constants/questions';
import { advanceOnboarding } from '@/lib/onboarding';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { colors, spacing } from '@/theme/tokens';

/**
 * 공개 자기소개 (#39) — 사진 대신 상대가 나를 알아갈 재료.
 *
 *  * 여기 입력하는 내용은 전부 "상대에게 공개" 된다 (profiles 테이블 · 추천 카드).
 *  * 필수: 연애 목적 + 짧은 자기소개. 질문 답변은 선택 (긴 성격검사가 아니다).
 *  * 가치관 설문(비공개)은 다음 단계에서 따로 받는다 — 여기와 섞지 않는다.
 *  * 앱 재시작 후 다시 들어오면 저장된 값을 불러온다.
 */
export default function IntroStep() {
  const { session, refreshAppUser } = useSession();
  const [goal, setGoal] = useState<RelationshipGoal | null>(null);
  const [intro, setIntro] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const userId = session?.user.id;

  useEffect(() => {
    if (!userId) return;
    let mounted = true;
    supabase
      .from('profiles')
      .select('intro, relationship_goal, public_answers')
      .eq('user_id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (!mounted || !data) return;
        if (typeof data.intro === 'string') setIntro(data.intro);
        if (RELATIONSHIP_GOALS.some((g) => g.value === data.relationship_goal)) {
          setGoal(data.relationship_goal as RelationshipGoal);
        }
        const saved = data.public_answers as Record<string, unknown> | null;
        if (saved && typeof saved === 'object') {
          const next: Record<string, string> = {};
          for (const p of PUBLIC_PROMPTS) {
            const v = saved[p.id];
            if (typeof v === 'string') next[p.id] = v;
          }
          setAnswers(next);
        }
      });
    return () => {
      mounted = false;
    };
  }, [userId]);

  const introTrimmed = intro.trim();
  const valid = !!goal && introTrimmed.length >= INTRO_MIN_LENGTH && introTrimmed.length <= INTRO_MAX_LENGTH;

  const save = async () => {
    if (!userId || !valid || !goal) return;
    setBusy(true);
    setError(null);
    const publicAnswers: Record<string, string> = {};
    for (const p of PUBLIC_PROMPTS) {
      const v = (answers[p.id] ?? '').trim();
      if (v.length > 0) publicAnswers[p.id] = v.slice(0, PUBLIC_ANSWER_MAX_LENGTH);
    }
    const { error: err } = await supabase
      .from('profiles')
      .update({ intro: introTrimmed, relationship_goal: goal, public_answers: publicAnswers })
      .eq('user_id', userId);
    if (err) {
      setBusy(false);
      setError('저장하지 못했어요. 입력값을 확인해 주세요.');
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
        title="나를 소개해 주세요"
        subtitle="사진 대신 이 소개로 상대가 당신을 알아가요. 여기 적는 내용은 소개받는 상대에게 공개돼요."
      />

      <Card>
        <Text variant="heading" style={{ marginBottom: spacing.sm }}>어떤 만남을 원하나요?</Text>
        <Text variant="caption" color={colors.sub} style={{ marginBottom: spacing.md }}>
          상대에게 공개돼요.
        </Text>
        <ChipGroup
          options={RELATIONSHIP_GOALS.map((g) => ({ value: g.value as string, label: g.label }))}
          value={goal}
          onChange={(v) => setGoal(v as RelationshipGoal)}
        />
      </Card>

      <View style={{ height: spacing.md }} />

      <Card>
        <Text variant="heading" style={{ marginBottom: spacing.sm }}>짧은 자기소개</Text>
        <Text variant="caption" color={colors.sub} style={{ marginBottom: spacing.md }}>
          평소 모습, 요즘 관심사, 어떤 대화를 좋아하는지 편하게 적어 주세요. 상대에게 공개돼요.
        </Text>
        <Field
          label={`자기소개 (${INTRO_MIN_LENGTH}~${INTRO_MAX_LENGTH}자)`}
          placeholder="예: 주말엔 동네 산책하고 집에서 요리해요. 잔잔하게 대화 나누는 걸 좋아합니다."
          multiline
          maxLength={INTRO_MAX_LENGTH}
          value={intro}
          onChangeText={setIntro}
          hint={`${introTrimmed.length}/${INTRO_MAX_LENGTH}`}
        />
      </Card>

      <View style={{ height: spacing.md }} />

      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, marginBottom: spacing.sm }}>
          <Text variant="heading">이야깃거리</Text>
          <Text variant="caption" color={colors.faint}>선택</Text>
        </View>
        <Text variant="caption" color={colors.sub} style={{ marginBottom: spacing.md }}>
          답한 질문만 상대에게 공개돼요. 첫 대화를 시작하기 좋은 소재가 돼요.
        </Text>
        {PUBLIC_PROMPTS.map((p) => (
          <Field
            key={p.id}
            label={p.question}
            placeholder="짧게 적어도 괜찮아요"
            multiline
            maxLength={PUBLIC_ANSWER_MAX_LENGTH}
            value={answers[p.id] ?? ''}
            onChangeText={(v) => setAnswers((prev) => ({ ...prev, [p.id]: v }))}
          />
        ))}
      </Card>

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
