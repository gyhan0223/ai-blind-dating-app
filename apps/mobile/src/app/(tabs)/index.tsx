import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { RecommendationCard } from '@/components/RecommendationCard';
import { Button, Card, InlineNotice, Screen, Text } from '@/components/ui';
import { track } from '@/lib/analytics';
import {
  decideRecommendation,
  fetchTodayRecommendations,
  type Recommendation,
} from '@/lib/recommendations';
import { colors, spacing } from '@/theme/tokens';

/** 홈 — 오늘의 소개. 하루 한 명, 무한 스와이프 없음. */
export default function TodayScreen() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['today-recommendations'],
    queryFn: fetchTodayRecommendations,
  });
  const [busy, setBusy] = useState(false);
  const [matchedNickname, setMatchedNickname] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const viewedIds = useRef(new Set<string>());

  const pending = data?.recommendations.find((r) => r.status === 'pending') ?? null;
  const acceptedToday = data?.recommendations.filter((r) => r.status === 'accepted') ?? [];

  useEffect(() => {
    if (pending && !viewedIds.current.has(pending.id)) {
      viewedIds.current.add(pending.id);
      track('recommendation_viewed', { recommendation_id: pending.id, strategy: pending.strategy });
    }
  }, [pending]);

  const decide = async (rec: Recommendation, decision: 'accepted' | 'skipped') => {
    setBusy(true);
    setError(null);
    try {
      const { matched } = await decideRecommendation(rec, decision);
      if (matched) setMatchedNickname(rec.card.nickname);
      await queryClient.invalidateQueries({ queryKey: ['today-recommendations'] });
      await queryClient.invalidateQueries({ queryKey: ['conversations'] });
    } catch {
      setError('처리하지 못했어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Text variant="caption" color={colors.sub} style={{ marginBottom: spacing.xs }}>본심</Text>
      <Text variant="title" style={{ marginBottom: spacing.lg }}>오늘의 소개</Text>

      {isLoading && (
        <View style={{ paddingVertical: spacing.xxl, alignItems: 'center' }}>
          <ActivityIndicator color={colors.accent} />
          <Text variant="caption" color={colors.sub} style={{ marginTop: spacing.md }}>
            잘 맞을 가능성이 높은 분을 찾고 있어요
          </Text>
        </View>
      )}

      {isError && (
        <View style={{ gap: spacing.md }}>
          <InlineNotice tone="danger" text="추천을 불러오지 못했어요." />
          <Button kind="secondary" title="다시 시도" onPress={() => refetch()} />
        </View>
      )}

      {matchedNickname && (
        <View style={{ marginBottom: spacing.md }}>
          <Card style={{ backgroundColor: colors.accentSoft, borderColor: colors.accent }}>
            <Text variant="heading" color={colors.accent} style={{ marginBottom: spacing.sm }}>
              {matchedNickname}님과 연결되었어요
            </Text>
            <Text variant="body" color={colors.inkSoft} style={{ marginBottom: spacing.md }}>
              서로 알아가고 싶어 해요. 첫 인사를 건네 보세요.
            </Text>
            <Button title="대화 시작하기" onPress={() => router.push('/(tabs)/chats')} />
          </Card>
        </View>
      )}

      {!isLoading && !isError && pending && (
        <>
          <RecommendationCard card={pending.card} />
          {error && (
            <View style={{ marginTop: spacing.md }}>
              <InlineNotice tone="danger" text={error} />
            </View>
          )}
          <View style={{ marginTop: spacing.lg, gap: spacing.sm }}>
            <Button title="알아가고 싶어요" onPress={() => decide(pending, 'accepted')} loading={busy} />
            <Button
              kind="secondary"
              title="이번에는 넘길게요"
              onPress={() => decide(pending, 'skipped')}
              disabled={busy}
            />
          </View>
        </>
      )}

      {!isLoading && !isError && !pending && !matchedNickname && (
        <Card>
          <Text variant="heading" style={{ marginBottom: spacing.sm }}>
            {acceptedToday.length > 0 ? '오늘의 소개를 확인했어요' : '오늘 소개할 수 있는 분이 없어요'}
          </Text>
          <Text variant="body" color={colors.sub}>
            {acceptedToday.length > 0
              ? '상대도 알아가고 싶다고 하면 대화가 열려요.\n내일 새로운 한 분을 소개해 드릴게요.'
              : '조건에 맞는 분을 찾는 중이에요.\n내일 다시 확인해 주세요.'}
          </Text>
        </Card>
      )}
    </Screen>
  );
}
