import { router, useLocalSearchParams } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';
import { Button, Card, ChipGroup, InlineNotice, LikertScale, Screen, Text } from '@/components/ui';
import { submitMeetupFeedback } from '@/lib/meetup';
import { colors, spacing } from '@/theme/tokens';

/**
 * 만남 후 피드백 — MatchingEngine 이 학습할 수 있는 형태로 저장된다.
 * 상대에게는 절대 공개되지 않는다.
 */
export default function FeedbackScreen() {
  const { matchId } = useLocalSearchParams<{ matchId: string }>();
  const [metAgain, setMetAgain] = useState<'yes' | 'no' | null>(null);
  const [appearance, setAppearance] = useState<number | null>(null);
  const [comfort, setComfort] = useState<number | null>(null);
  const [valuesFit, setValuesFit] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const save = async () => {
    if (!matchId || !metAgain) return;
    setBusy(true);
    setError(null);
    try {
      await submitMeetupFeedback(matchId, {
        metAgainIntent: metAgain,
        appearanceAttraction: appearance,
        conversationComfort: comfort,
        valuesFit,
      });
      setDone(true);
    } catch {
      setError('저장하지 못했어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Screen scroll={false}>
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <Text variant="title" style={{ marginBottom: spacing.md }}>고마워요</Text>
          <Text variant="body" color={colors.sub}>
            알려주신 내용은 다음 소개를 더 잘 맞게 만드는 데만 사용돼요.{'\n'}
            상대에게는 공개되지 않아요.
          </Text>
        </View>
        <View style={{ paddingBottom: spacing.lg }}>
          <Button title="홈으로" onPress={() => router.replace('/(tabs)')} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <Text variant="title" style={{ marginTop: spacing.md, marginBottom: spacing.lg }}>
        만나보니 어땠나요?
      </Text>

      <Card>
        <Text variant="heading" style={{ marginBottom: spacing.md }}>다시 만나고 싶나요?</Text>
        <ChipGroup
          options={[
            { value: 'yes', label: '네, 또 만나고 싶어요' },
            { value: 'no', label: '아니요' },
          ]}
          value={metAgain}
          onChange={(v) => setMetAgain(v as 'yes' | 'no')}
        />
      </Card>

      <Text variant="caption" color={colors.sub} style={{ marginVertical: spacing.md }}>
        아래는 선택 질문이에요. 답해주시면 소개 기준이 더 정교해져요.
      </Text>

      <View style={{ gap: spacing.md }}>
        <Card>
          <Text variant="heading" style={{ marginBottom: spacing.md }}>실제로 봤을 때 외적으로 끌렸나요?</Text>
          <LikertScale value={appearance} onChange={setAppearance} lowLabel="아니었어요" highLabel="많이 끌렸어요" />
        </Card>
        <Card>
          <Text variant="heading" style={{ marginBottom: spacing.md }}>대화는 편했나요?</Text>
          <LikertScale value={comfort} onChange={setComfort} lowLabel="어색했어요" highLabel="아주 편했어요" />
        </Card>
        <Card>
          <Text variant="heading" style={{ marginBottom: spacing.md }}>가치관이 잘 맞았나요?</Text>
          <LikertScale value={valuesFit} onChange={setValuesFit} lowLabel="달랐어요" highLabel="잘 맞았어요" />
        </Card>
      </View>

      {error && (
        <View style={{ marginTop: spacing.md }}>
          <InlineNotice tone="danger" text={error} />
        </View>
      )}

      <View style={{ marginTop: spacing.xl, gap: spacing.sm }}>
        <Button title="보내기" onPress={save} loading={busy} disabled={!metAgain} />
        <Button kind="ghost" title="나중에 할게요" onPress={() => router.back()} />
      </View>
    </Screen>
  );
}
