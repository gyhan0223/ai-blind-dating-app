import { useQuery } from '@tanstack/react-query';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Card, Screen, Text } from '@/components/ui';
import { fetchConversations } from '@/lib/chat';
import { colors, radius, spacing } from '@/theme/tokens';

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

export default function ChatsScreen() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['conversations'],
    queryFn: fetchConversations,
  });

  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch]),
  );

  return (
    <Screen>
      <Text variant="title" style={{ marginBottom: spacing.lg }}>대화</Text>

      {isLoading && (
        <View style={{ paddingVertical: spacing.xxl, alignItems: 'center' }}>
          <ActivityIndicator color={colors.accent} />
        </View>
      )}

      {!isLoading && (data?.length ?? 0) === 0 && (
        <Card>
          <Text variant="heading" style={{ marginBottom: spacing.sm }}>아직 연결된 대화가 없어요</Text>
          <Text variant="body" color={colors.sub}>
            오늘의 소개에서 서로 알아가고 싶어 하면{'\n'}여기에서 대화가 시작돼요.
          </Text>
        </Card>
      )}

      <View style={{ gap: spacing.sm }}>
        {(data ?? []).map((conv) => (
          <Pressable
            key={conv.conversationId}
            onPress={() => router.push({ pathname: '/chat/[conversationId]', params: { conversationId: conv.conversationId } })}
          >
            <Card style={{ paddingVertical: spacing.md }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text variant="heading">{conv.partnerNickname}</Text>
                <Text variant="caption" color={colors.faint}>{timeLabel(conv.lastMessageAt)}</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: spacing.xs, gap: spacing.sm }}>
                <Text
                  variant="caption"
                  color={conv.unreadCount > 0 ? colors.ink : colors.sub}
                  numberOfLines={1}
                  style={{ flex: 1 }}
                >
                  {conv.lastMessagePreview ?? '아직 메시지가 없어요. 먼저 인사해 보세요.'}
                </Text>
                {conv.unreadCount > 0 && (
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
        ))}
      </View>
    </Screen>
  );
}
