import { router } from 'expo-router';
import React, { useMemo, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { OnboardingHeader } from '@/components/OnboardingHeader';
import { Button, Card, InlineNotice, LikertScale, Screen, Text } from '@/components/ui';
import { QUESTIONS } from '@/constants/questions';
import { advanceOnboarding } from '@/lib/onboarding';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { colors, spacing } from '@/theme/tokens';

const PAGE_SIZE = 5;

/** 성격·라이프스타일·연애 스타일 설문 (1~5) */
export default function QuestionnaireStep() {
  const { session, refreshAppUser } = useSession();
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pages = useMemo(() => {
    const chunks: (typeof QUESTIONS)[] = [];
    for (let i = 0; i < QUESTIONS.length; i += PAGE_SIZE) {
      chunks.push(QUESTIONS.slice(i, i + PAGE_SIZE));
    }
    return chunks;
  }, []);

  const currentQuestions = pages[page] ?? [];
  const pageComplete = currentQuestions.every((q) => answers[q.id] != null);
  const isLastPage = page === pages.length - 1;
  const scrollRef = useRef<ScrollView>(null);

  const goToPage = (p: number) => {
    setPage(p);
    scrollRef.current?.scrollTo({ y: 0, animated: true });
  };

  const next = async () => {
    if (!isLastPage) {
      goToPage(page + 1);
      return;
    }
    const userId = session?.user.id;
    if (!userId) return;
    setBusy(true);
    setError(null);
    const rows = QUESTIONS.map((q) => ({
      user_id: userId,
      question_id: q.id,
      value: answers[q.id],
    }));
    const { error: err } = await supabase.from('questionnaire_responses').upsert(rows);
    if (err) {
      setBusy(false);
      setError('저장하지 못했어요. 잠시 후 다시 시도해 주세요.');
      return;
    }
    await advanceOnboarding('values');
    await refreshAppUser();
    setBusy(false);
    router.replace('/onboarding/values');
  };

  return (
    <Screen scrollRef={scrollRef}>
      <OnboardingHeader
        step="questionnaire"
        title="나에 대한 질문"
        subtitle={`평소 모습 그대로 답해 주세요. 정답은 없어요. (${page + 1}/${pages.length})`}
      />

      <View style={{ gap: spacing.md }}>
        {currentQuestions.map((q) => (
          <Card key={q.id}>
            <Text variant="heading" style={{ marginBottom: spacing.md }}>
              {q.text}
            </Text>
            <LikertScale
              value={answers[q.id] ?? null}
              onChange={(v) => setAnswers((prev) => ({ ...prev, [q.id]: v }))}
            />
          </Card>
        ))}
      </View>

      {error && (
        <View style={{ marginTop: spacing.md }}>
          <InlineNotice tone="danger" text={error} />
        </View>
      )}

      <View style={{ marginTop: spacing.xl, gap: spacing.sm }}>
        <Button
          title={isLastPage ? '설문 완료' : '다음'}
          onPress={next}
          loading={busy}
          disabled={!pageComplete}
        />
        {page > 0 && <Button kind="ghost" title="이전" onPress={() => goToPage(page - 1)} />}
      </View>
      <Text variant="caption" color={colors.faint} style={{ marginTop: spacing.md, textAlign: 'center' }}>
        답변은 매칭에만 사용되며 상대에게 그대로 공개되지 않아요.
      </Text>
    </Screen>
  );
}
