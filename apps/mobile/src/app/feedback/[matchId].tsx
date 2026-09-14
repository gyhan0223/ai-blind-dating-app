import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Button, Card, ChipGroup, InlineNotice, LikertScale, Screen, Text } from '@/components/ui';
import { type Concern, fetchMeetupStatus, submitMeetupFeedback, type TriState } from '@/lib/meetup';
import { colors, spacing } from '@/theme/tokens';

const TRI_OPTIONS: { value: TriState; label: string }[] = [
  { value: 'yes', label: '네' },
  { value: 'no', label: '아니요' },
  { value: 'not_sure', label: '아직 모르겠어요' },
];

const CONCERN_OPTIONS: { value: Concern; label: string }[] = [
  { value: 'appearance_mismatch', label: '외모 취향 차이' },
  { value: 'conversation', label: '대화' },
  { value: 'goal_mismatch', label: '연애 목적 차이' },
  { value: 'other', label: '기타' },
];

/**
 * 만남 후 비공개 피드백 (#41) — 모두 선택 질문. 상대에게는 제출 여부도, 내용도 공개되지 않는다.
 * 본인이 ‘만났어요’ 라고 응답한 매치에서만 열린다 (상대의 확인을 기다리지 않는다).
 */
export default function FeedbackScreen() {
  const { matchId } = useLocalSearchParams<{ matchId: string }>();
  const queryClient = useQueryClient();
  const { data, isLoading, error: loadError } = useQuery({
    queryKey: ['meetup', matchId],
    queryFn: () => fetchMeetupStatus(matchId!),
    enabled: !!matchId,
  });

  const [satisfaction, setSatisfaction] = useState<number | null>(null);
  const [metAgain, setMetAgain] = useState<TriState | null>(null);
  const [nextIntro, setNextIntro] = useState<TriState | null>(null);
  const [concerns, setConcerns] = useState<Concern[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const [hydratedFor, setHydratedFor] = useState<string | null>(null);
  if (data && hydratedFor !== data.matchId) {
    setHydratedFor(data.matchId);
    if (data.myFeedback) {
      setSatisfaction(data.myFeedback.overallSatisfaction);
      setMetAgain(data.myFeedback.metAgainIntent);
      setNextIntro(data.myFeedback.nextIntroIntent);
      setConcerns(data.myFeedback.concerns);
    }
  }

  const answered = satisfaction != null || metAgain != null || nextIntro != null || concerns.length > 0;

  const save = async () => {
    if (!matchId || !answered) return;
    setBusy(true);
    setError(null);
    try {
      await submitMeetupFeedback(matchId, {
        overallSatisfaction: satisfaction,
        metAgainIntent: metAgain,
        nextIntroIntent: nextIntro,
        concerns,
      });
      await queryClient.invalidateQueries({ queryKey: ['meetup', matchId] });
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : '저장하지 못했어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) {
    return (
      <Screen scroll={false}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.accent} />
        </View>
      </Screen>
    );
  }

  if (loadError || !data) {
    return (
      <Screen>
        <Text variant="title" style={{ marginTop: spacing.md, marginBottom: spacing.sm }}>불러오지 못했어요</Text>
        <Text variant="body" color={colors.sub} style={{ marginBottom: spacing.lg }}>잠시 후 다시 시도해 주세요.</Text>
        <Button kind="ghost" title="돌아가기" onPress={() => router.back()} />
      </Screen>
    );
  }

  if (data.myOutcome !== 'met') {
    return (
      <Screen>
        <Text variant="title" style={{ marginTop: spacing.md, marginBottom: spacing.sm }}>먼저 만남 여부를 기록해 주세요</Text>
        <Text variant="body" color={colors.sub} style={{ marginBottom: spacing.lg }}>
          ‘만났어요’ 라고 기록한 뒤에 만남 후 이야기를 남길 수 있어요. 상대의 확인은 기다리지 않아도 돼요.
        </Text>
        <Button title="만남 여부 기록하러 가기" onPress={() => router.replace({ pathname: '/meetup/[matchId]', params: { matchId: matchId! } })} />
        <Button kind="ghost" title="돌아가기" onPress={() => router.back()} />
      </Screen>
    );
  }

  if (done) {
    return (
      <Screen scroll={false}>
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <Text variant="title" style={{ marginBottom: spacing.md }}>고마워요</Text>
          <Text variant="body" color={colors.sub}>
            알려주신 내용은 서비스를 확인하고 개선하는 데만 쓰여요.{'\n'}
            상대에게는 제출 여부도, 내용도 공개되지 않아요.
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
      <Text variant="title" style={{ marginTop: spacing.md, marginBottom: spacing.sm }}>
        만나보니 어땠나요?
      </Text>
      <Text variant="caption" color={colors.sub} style={{ marginBottom: spacing.lg }}>
        모두 선택 질문이에요. 답하고 싶은 것만 답해도 돼요. 상대에게는 공개되지 않아요.
      </Text>

      <View style={{ gap: spacing.md }}>
        <Card>
          <Text variant="heading" style={{ marginBottom: spacing.md }}>전체적으로 만남은 어땠나요?</Text>
          <LikertScale value={satisfaction} onChange={setSatisfaction} lowLabel="아쉬웠어요" highLabel="아주 좋았어요" />
        </Card>
        <Card>
          <Text variant="heading" style={{ marginBottom: spacing.md }}>이 분을 다시 만나고 싶나요?</Text>
          <ChipGroup options={TRI_OPTIONS} value={metAgain} onChange={setMetAgain} />
        </Card>
        <Card>
          <Text variant="heading" style={{ marginBottom: spacing.xs }}>다음 소개도 이용하고 싶나요?</Text>
          <Text variant="caption" color={colors.faint} style={{ marginBottom: spacing.md }}>
            좋은 인연이 생겨서 더 필요 없을 수도 있어요. 어느 쪽이든 괜찮아요.
          </Text>
          <ChipGroup options={TRI_OPTIONS} value={nextIntro} onChange={setNextIntro} />
        </Card>
        <Card>
          <Text variant="heading" style={{ marginBottom: spacing.xs }}>아쉬웠던 점이 있다면요? (여러 개 가능)</Text>
          <Text variant="caption" color={colors.faint} style={{ marginBottom: spacing.md }}>
            없으면 비워 두세요.
          </Text>
          <ChipGroup multiple options={CONCERN_OPTIONS} values={concerns} onChangeMultiple={setConcerns} />
        </Card>
      </View>

      {error && (
        <View style={{ marginTop: spacing.md }}>
          <InlineNotice tone="danger" text={error} />
        </View>
      )}

      <View style={{ marginTop: spacing.xl, gap: spacing.sm }}>
        <Button title={data.myFeedback ? '수정해서 보내기' : '보내기'} onPress={save} loading={busy} disabled={!answered} />
        <Button kind="ghost" title="나중에 할게요" onPress={() => router.back()} />
      </View>
    </Screen>
  );
}
