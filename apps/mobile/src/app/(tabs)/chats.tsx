import { useQuery } from '@tanstack/react-query';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Card, InlineNotice, Screen, Text } from '@/components/ui';
import { type ConversationListItem, fetchConversations } from '@/lib/chat';
import { closedNotice, CONVERSATION_SLOT_LIMIT, slotsAreFull, slotsLabel } from '@/lib/chatCore';
import { useSession } from '@/lib/session';
import { colors, radius, spacing } from '@/theme/tokens';

/** 공통 매치 상태 라벨 — 일방 의향은 여기에 없다 (서버가 둘 다 yes 일 때만 상태를 바꾼다) */
function meetupLabel(state: string): string | null {
  switch (state) {
    case 'mutual_interest':
      return '서로 만나고 싶어 해요';
    case 'met_confirmed':
      return '만남 확인됨';
    default:
      return null;
  }
}

function timeLabel(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

function ConversationRow({ conv, myId, closed }: { conv: ConversationListItem; myId: string | null; closed: boolean }) {
  const notice = closed
    ? closedNotice({ matchStatus: conv.matchStatus, closeKind: conv.closeKind, closedBy: conv.closedBy, myId })
    : null;
  return (
    <Pressable onPress={() => router.push({ pathname: '/chat/[conversationId]', params: { conversationId: conv.conversationId } })}>
      <Card style={{ paddingVertical: spacing.md, opacity: closed ? 0.75 : 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flex: 1 }}>
            <Text variant="heading">{conv.partnerNickname}</Text>
            {!closed && meetupLabel(conv.meetupState) && (
              <Text variant="caption" color={colors.accent}>{meetupLabel(conv.meetupState)}</Text>
            )}
          </View>
          <Text variant="caption" color={colors.faint}>{timeLabel(closed ? conv.closedAt ?? conv.lastMessageAt : conv.lastMessageAt)}</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: spacing.xs, gap: spacing.sm }}>
          <Text
            variant="caption"
            color={notice ? colors.sub : conv.unreadCount > 0 ? colors.ink : colors.sub}
            numberOfLines={1}
            style={{ flex: 1 }}
          >
            {notice ?? conv.lastMessagePreview ?? '아직 메시지가 없어요. 먼저 인사해 보세요.'}
          </Text>
          {!closed && conv.unreadCount > 0 && (
            <View
              style={{
                minWidth: 20,
                height: 20,
                borderRadius: radius.full,
                backgroundColor: colors.accent,
                alignItems: 'center',
                justifyContent: 'center',
                paddingHorizontal: 6,
              }}
            >
              <Text variant="caption" color={colors.onAccent}>{conv.unreadCount}</Text>
            </View>
          )}
        </View>
      </Card>
    </Pressable>
  );
}

/**
 * 대화 목록 (#24) — 진행 중인 대화는 최대 3개(내 개수만 표시, 상대 개수는 없다).
 * 종료된 대화는 따로 접어 두고, 열면 이전 메시지 열람·신고만 가능하다.
 */
export default function ChatsScreen() {
  const { session } = useSession();
  const myId = session?.user.id ?? null;
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['conversations'],
    queryFn: fetchConversations,
  });
  const [showClosed, setShowClosed] = useState(false);

  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch]),
  );

  const active = data?.active ?? [];
  const closed = data?.closed ?? [];
  const full = slotsAreFull(active.length);

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: spacing.lg }}>
        <Text variant="title">대화</Text>
        {!isLoading && !isError && (
          <Text variant="caption" color={full ? colors.accent : colors.sub}>진행 중 {slotsLabel(active.length)}</Text>
        )}
      </View>

      {isLoading && (
        <View style={{ paddingVertical: spacing.xxl, alignItems: 'center' }}>
          <ActivityIndicator color={colors.accent} />
        </View>
      )}

      {isError && (
        <View style={{ marginBottom: spacing.md }}>
          <InlineNotice tone="danger" text="대화를 불러오지 못했어요. 당겨서 다시 시도해 주세요." />
        </View>
      )}

      {!isLoading && !isError && full && (
        <View style={{ marginBottom: spacing.md }}>
          <InlineNotice
            text={`진행 중인 대화가 ${CONVERSATION_SLOT_LIMIT}개예요. 오늘의 소개는 쉬고, 대화를 하나 종료하면 다음 소개부터 다시 시작돼요.`}
          />
        </View>
      )}

      {!isLoading && !isError && active.length === 0 && (
        <Card>
          <Text variant="heading" style={{ marginBottom: spacing.sm }}>아직 진행 중인 대화가 없어요</Text>
          <Text variant="body" color={colors.sub}>
            오늘의 소개에서 서로 알아가고 싶어 하면{'\n'}여기에서 대화가 시작돼요.
          </Text>
        </Card>
      )}

      <View style={{ gap: spacing.sm }}>
        {active.map((conv) => (
          <ConversationRow key={conv.conversationId} conv={conv} myId={myId} closed={false} />
        ))}
      </View>

      {closed.length > 0 && (
        <View style={{ marginTop: spacing.xl }}>
          <Pressable onPress={() => setShowClosed((v) => !v)} accessibilityRole="button" accessibilityLabel="종료된 대화 펼치기">
            <Text variant="caption" color={colors.sub} style={{ marginBottom: spacing.sm }}>
              종료된 대화 {closed.length} {showClosed ? '접기' : '보기'}
            </Text>
          </Pressable>
          {showClosed && (
            <View style={{ gap: spacing.sm }}>
              {closed.map((conv) => (
                <ConversationRow key={conv.conversationId} conv={conv} myId={myId} closed />
              ))}
            </View>
          )}
        </View>
      )}
    </Screen>
  );
}
