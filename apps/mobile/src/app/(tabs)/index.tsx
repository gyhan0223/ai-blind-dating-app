import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { RecommendationCard } from '@/components/RecommendationCard';
import { Button, Card, ChipGroup, InlineNotice, Screen, Text } from '@/components/ui';
import { track } from '@/lib/analytics';
import { acceptResultNotice, CONVERSATION_SLOT_LIMIT } from '@/lib/chatCore';
import { fetchNotificationPreferences, pushPermissionStatus } from '@/lib/push';
import {
  decideRecommendation,
  fetchTodayRecommendations,
  markRecommendationViewed,
  SKIP_CATEGORIES,
  type Recommendation,
  type SkipCategory,
} from '@/lib/recommendations';
import { colors, spacing } from '@/theme/tokens';

/**
 * 홈 — 오늘의 소개. 하루 한 명, 무한 스와이프 없음.
 *
 * 서로 다른 상태를 섞지 않는다 (#23):
 *  * 서버 오류(isError)       → "불러오지 못했어요" + 다시 시도. 후보 부족 문구로 바꾸지 않는다
 *  * 생성 중(inProgress)      → "준비하고 있어요" + 다시 확인
 *  * 자리 부족(slotsFull)     → "진행 중인 대화가 3개예요"
 *  * 후보 없음(exhausted)     → 전체 탐색 완료면 "조건에 맞는 분이 없어요", 탐색 상한(capReached)이면 "아직 다 살펴보지 못했어요"
 *  * 오늘 소개를 이미 확인·처리 → "오늘의 소개를 확인했어요"
 * "다시 확인" 은 같은 요청을 다시 보낼 뿐이다 — 후보 부족 뒤 1시간 안에는 서버가 다시 훑지 않는다 (재시도 제한 우회 없음).
 * 알림 안내는 기기 알림 권한이 허용돼 있고 '오늘의 소개' 알림 설정이 켜진 경우에만 보여 준다 (푸시 신규 구축은 #17).
 */
export default function TodayScreen() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ['today-recommendations'],
    queryFn: fetchTodayRecommendations,
  });
  // 내 정보 화면과 같은 query key — 실제 설정·권한이 맞을 때만 "알려드릴게요" 를 쓴다 (실패해도 화면을 막지 않는다)
  const { data: notifPrefs } = useQuery({ queryKey: ['notification-preferences'], queryFn: fetchNotificationPreferences, retry: false });
  const { data: pushPermission } = useQuery({ queryKey: ['push-permission'], queryFn: pushPermissionStatus, retry: false });
  const recommendationPushOn = pushPermission === 'granted' && notifPrefs?.daily_recommendation === true;
  const [busy, setBusy] = useState(false);
  const [matchedNickname, setMatchedNickname] = useState<string | null>(null);
  const [askingSkipReason, setAskingSkipReason] = useState(false);
  const [skipCategory, setSkipCategory] = useState<SkipCategory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const viewedIds = useRef(new Set<string>());

  const pending = data?.recommendations.find((r) => r.status === 'pending') ?? null;
  const acceptedToday = data?.recommendations.filter((r) => r.status === 'accepted') ?? [];

  useEffect(() => {
    if (pending && !viewedIds.current.has(pending.id)) {
      viewedIds.current.add(pending.id);
      // 실제 확인(열람)은 서버에 멱등 기록한다 (#24 — 생성 ≠ 확인). 화면 이벤트는 보조
      markRecommendationViewed(pending.id);
      track('recommendation_viewed', { recommendation_id: pending.id, strategy: pending.strategy });
    }
  }, [pending]);

  const decide = async (
    rec: Recommendation,
    decision: 'accepted' | 'skipped',
    reasonCategory?: SkipCategory | null,
    reasonDetail?: string | null,
  ) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { matched, result } = await decideRecommendation(rec, decision, reasonCategory, reasonDetail);
      if (matched) setMatchedNickname(rec.card.nickname);
      // 자리 부족·재매칭 차단: 추천은 그대로 남고 안내만 (상대의 거절이 아니다)
      const info = result ? acceptResultNotice(result) : null;
      if (info) {
        setNotice(info);
        return;
      }
      setAskingSkipReason(false);
      setSkipCategory(null);
      await queryClient.invalidateQueries({ queryKey: ['today-recommendations'] });
      await queryClient.invalidateQueries({ queryKey: ['conversations'] });
    } catch {
      setError('처리하지 못했어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  };

  const pickCategory = (rec: Recommendation, value: SkipCategory) => {
    const category = SKIP_CATEGORIES.find((c) => c.value === value);
    if (!category?.details?.length) {
      // 세부 사유가 없는 항목(지금은 여유가 없어요 등)은 바로 제출
      decide(rec, 'skipped', value, null);
      return;
    }
    setSkipCategory(value);
  };

  return (
    <Screen>
      <Text variant="caption" color={colors.sub} style={{ marginBottom: spacing.xs }}>본심</Text>
      <Text variant="title" style={{ marginBottom: spacing.lg }}>오늘의 소개</Text>

      {isLoading && (
        <View style={{ paddingVertical: spacing.xxl, alignItems: 'center' }}>
          <ActivityIndicator color={colors.accent} />
          <Text variant="caption" color={colors.sub} style={{ marginTop: spacing.md }}>
            오늘 소개할 분을 찾고 있어요
          </Text>
        </View>
      )}

      {isError && (
        <View style={{ gap: spacing.md }}>
          <InlineNotice tone="danger" text="추천을 불러오지 못했어요. 서버와 연결하는 데 문제가 있어요 — 소개할 분이 없다는 뜻은 아니에요." />
          <Button kind="secondary" title="다시 시도" onPress={() => refetch()} loading={isFetching} />
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
          {notice && (
            <View style={{ marginTop: spacing.md, gap: spacing.sm }}>
              <InlineNotice text={notice} />
              <Button kind="ghost" title="대화 목록 보기" onPress={() => router.push('/(tabs)/chats')} />
            </View>
          )}
          {!askingSkipReason ? (
            <View style={{ marginTop: spacing.lg, gap: spacing.sm }}>
              <Button title="알아가고 싶어요" onPress={() => decide(pending, 'accepted')} loading={busy} />
              <Button
                kind="secondary"
                title="이번에는 넘길게요"
                onPress={() => setAskingSkipReason(true)}
                disabled={busy}
              />
            </View>
          ) : (
            <View style={{ marginTop: spacing.lg }}>
              <Card>
                <Text variant="heading" style={{ marginBottom: spacing.sm }}>
                  어떤 점이 아쉬웠나요?
                </Text>
                <Text variant="caption" color={colors.sub} style={{ marginBottom: spacing.md }}>
                  더 잘 맞는 분을 소개하는 데만 사용돼요. 상대에게는 전달되지 않아요.
                </Text>
                {!skipCategory ? (
                  <>
                    <ChipGroup
                      options={SKIP_CATEGORIES.map((c) => ({ value: c.value, label: c.label }))}
                      value={null}
                      onChange={(v) => !busy && pickCategory(pending, v as SkipCategory)}
                    />
                    <View style={{ gap: spacing.sm, marginTop: spacing.md }}>
                      <Button
                        kind="ghost"
                        title="답하지 않고 넘기기"
                        onPress={() => decide(pending, 'skipped', null, null)}
                        disabled={busy}
                      />
                      <Button
                        kind="ghost"
                        title="돌아가기"
                        onPress={() => setAskingSkipReason(false)}
                        disabled={busy}
                      />
                    </View>
                  </>
                ) : (
                  <>
                    <Text variant="caption" color={colors.inkSoft} style={{ marginBottom: spacing.sm }}>
                      {SKIP_CATEGORIES.find((c) => c.value === skipCategory)?.label} — 어떤 점이요?
                    </Text>
                    <ChipGroup
                      options={
                        SKIP_CATEGORIES.find((c) => c.value === skipCategory)?.details?.map((d) => ({
                          value: d.value,
                          label: d.label,
                        })) ?? []
                      }
                      value={null}
                      onChange={(v) => !busy && decide(pending, 'skipped', skipCategory, v)}
                    />
                    <View style={{ gap: spacing.sm, marginTop: spacing.md }}>
                      <Button
                        kind="ghost"
                        title="뒤로"
                        onPress={() => setSkipCategory(null)}
                        disabled={busy}
                      />
                    </View>
                  </>
                )}
              </Card>
            </View>
          )}
        </>
      )}

      {!isLoading && !isError && !pending && !matchedNickname && data?.inProgress && (
        <Card>
          <Text variant="heading" style={{ marginBottom: spacing.sm }}>오늘 소개할 분을 준비하고 있어요</Text>
          <Text variant="body" color={colors.sub} style={{ marginBottom: spacing.md }}>
            잠시 후 다시 확인해 주세요.
          </Text>
          <Button kind="secondary" title="다시 확인" onPress={() => refetch()} />
        </Card>
      )}

      {!isLoading && !isError && !pending && !matchedNickname && !data?.inProgress && data?.slotsFull && (
        <Card>
          <Text variant="heading" style={{ marginBottom: spacing.sm }}>진행 중인 대화가 {CONVERSATION_SLOT_LIMIT}개예요</Text>
          <Text variant="body" color={colors.sub} style={{ marginBottom: spacing.md }}>
            대화에 집중할 수 있도록 오늘의 소개는 쉬어요.{'\n'}대화를 하나 종료하면 다음 소개부터 다시 시작돼요.
          </Text>
          <Button kind="secondary" title="대화 목록으로" onPress={() => router.push('/(tabs)/chats')} />
        </Card>
      )}

      {!isLoading && !isError && !pending && !matchedNickname && !data?.inProgress && !data?.slotsFull && data?.exhausted && (
        <Card>
          <Text variant="heading" style={{ marginBottom: spacing.sm }}>
            {data.capReached ? '아직 다 살펴보지 못했어요' : '오늘은 소개할 분이 없어요'}
          </Text>
          <Text variant="body" color={colors.sub} style={{ marginBottom: spacing.sm }}>
            {data.capReached
              ? '오늘은 한 번에 살펴볼 수 있는 인원까지만 확인했어요. 조건에 맞는 분이 없다고 단정하지는 않아요.\n잠시 후 다시 확인해 주세요.'
              : '지금은 필수 조건에 맞는 분이 없어요. 새로운 분이 가입하면 다시 찾아볼게요.'}
          </Text>
          <Text variant="caption" color={colors.sub} style={{ marginBottom: spacing.md }}>
            하루 한 분만 소개하는 서비스라 필수 조건(나이·지역 등)을 동의 없이 넓히지 않아요. 다시 찾는 건 1시간에 한 번이에요.
            {recommendationPushOn ? '\n알림이 켜져 있어요. 소개가 준비되면 알려드릴게요.' : ''}
          </Text>
          <View style={{ gap: spacing.sm }}>
            <Button kind="secondary" title="다시 확인" onPress={() => refetch()} loading={isFetching} />
            <Button kind="ghost" title="선호 조건 보기" onPress={() => router.push('/settings/preferences')} />
          </View>
          <Text variant="caption" color={colors.sub} style={{ marginTop: spacing.sm }}>
            조건을 바꾸면 다음 소개부터 반영돼요. 이미 만들어진 소개는 바뀌지 않아요.
          </Text>
        </Card>
      )}

      {!isLoading && !isError && !pending && !matchedNickname && !data?.inProgress && !data?.slotsFull && !data?.exhausted && (
        <Card>
          <Text variant="heading" style={{ marginBottom: spacing.sm }}>오늘의 소개를 확인했어요</Text>
          <Text variant="body" color={colors.sub}>
            {acceptedToday.length > 0
              ? '상대도 알아가고 싶다고 하면 대화가 열려요.\n내일 새로운 한 분을 소개해 드릴게요.'
              : '내일 새로운 한 분을 소개해 드릴게요.'}
          </Text>
        </Card>
      )}
    </Screen>
  );
}
