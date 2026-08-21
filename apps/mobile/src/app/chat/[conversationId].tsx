import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Card, Text } from '@/components/ui';
import { track } from '@/lib/analytics';
import {
  type ChatMessage,
  fetchConversationDetail,
  fetchIcebreaker,
  fetchMessages,
  markConversationRead,
  sendMessage,
  subscribeToMessages,
} from '@/lib/chat';
import { useSession } from '@/lib/session';
import { colors, radius, spacing } from '@/theme/tokens';

/** 만남 제안 버튼이 열리는 최소 대화량 */
const MEETUP_UNLOCK_MESSAGES = 10;

export default function ChatRoom() {
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const { session } = useSession();
  const myId = session?.user.id;
  const queryClient = useQueryClient();

  const { data: detail } = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => fetchConversationDetail(conversationId!),
    enabled: !!conversationId,
  });
  const { data: initialMessages } = useQuery({
    queryKey: ['messages', conversationId],
    queryFn: () => fetchMessages(conversationId!),
    enabled: !!conversationId,
  });

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const chatStartedTracked = useRef(false);

  // 초기 로드 동기화 (렌더 중 1회 — https://react.dev/learn/you-might-not-need-an-effect)
  const [hydratedFrom, setHydratedFrom] = useState<ChatMessage[] | null>(null);
  if (initialMessages && hydratedFrom !== initialMessages) {
    setHydratedFrom(initialMessages);
    setMessages(initialMessages);
  }

  // 실시간 수신 + 읽음 처리
  useEffect(() => {
    if (!conversationId) return;
    markConversationRead(conversationId);
    const channel = subscribeToMessages(conversationId, (msg) => {
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      if (msg.sender_id !== myId) markConversationRead(conversationId);
    });
    return () => {
      channel.unsubscribe();
    };
  }, [conversationId, myId]);

  // 아이스브레이커 (대화 시작 전이면 생성)
  const { data: icebreaker } = useQuery({
    queryKey: ['icebreaker', conversationId],
    queryFn: () => fetchIcebreaker(conversationId!),
    enabled: !!conversationId && (initialMessages?.length ?? 1) === 0,
  });
  const icebreakerToShow = detail?.icebreaker ?? icebreaker ?? null;

  const send = useCallback(async () => {
    if (!conversationId || !input.trim() || sending) return;
    setSending(true);
    const content = input;
    setInput('');
    try {
      const isFirstMessage = messages.length === 0;
      const lastMessage = messages[messages.length - 1];
      await sendMessage(conversationId, content);
      if (isFirstMessage && !chatStartedTracked.current) {
        chatStartedTracked.current = true;
        track('chat_started', { conversation_id: conversationId });
      }
      if (
        lastMessage &&
        Date.now() - new Date(lastMessage.created_at).getTime() > 6 * 60 * 60 * 1000
      ) {
        track('conversation_resumed', { conversation_id: conversationId });
      }
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    } catch {
      setInput(content);
    } finally {
      setSending(false);
    }
  }, [conversationId, input, sending, messages, queryClient]);

  const meetupUnlocked =
    (detail?.totalMessages ?? 0) + messages.length - (initialMessages?.length ?? 0) >=
      MEETUP_UNLOCK_MESSAGES || (detail?.totalMessages ?? 0) >= MEETUP_UNLOCK_MESSAGES;

  const lastMyReadMessage = [...messages].reverse().find((m) => m.sender_id === myId && m.read_at);

  const renderMessage = ({ item }: { item: ChatMessage }) => {
    const mine = item.sender_id === myId;
    return (
      <View style={[styles.bubbleRow, mine ? { justifyContent: 'flex-end' } : null]}>
        <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
          <Text variant="body" color={mine ? colors.onAccent : colors.ink}>
            {item.content}
          </Text>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={['top', 'left', 'right', 'bottom']}>
      {/* 헤더 */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="chevron-back" size={24} color={colors.ink} />
        </Pressable>
        <Text variant="heading">{detail?.partnerNickname ?? ''}</Text>
        <Pressable onPress={() => setMenuOpen(!menuOpen)} hitSlop={12}>
          <Ionicons name="ellipsis-horizontal" size={22} color={colors.sub} />
        </Pressable>
      </View>

      {menuOpen && detail && (
        <View style={styles.menu}>
          <Button
            kind="secondary"
            title="이 사람을 실제로 만나보고 싶어요"
            onPress={() => {
              setMenuOpen(false);
              router.push({ pathname: '/meetup/[matchId]', params: { matchId: detail.matchId } });
            }}
            disabled={!meetupUnlocked}
          />
          {!meetupUnlocked && (
            <Text variant="caption" color={colors.faint} style={{ textAlign: 'center' }}>
              대화를 조금 더 나누면 만남을 제안할 수 있어요
            </Text>
          )}
          <Button
            kind="danger"
            title="신고 또는 차단"
            onPress={() => {
              setMenuOpen(false);
              router.push({
                pathname: '/report/[userId]',
                params: { userId: detail.partnerId, matchId: detail.matchId },
              });
            }}
          />
        </View>
      )}

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          renderItem={renderMessage}
          contentContainerStyle={{ padding: spacing.lg, gap: spacing.sm }}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          ListHeaderComponent={
            icebreakerToShow && messages.length < 4 ? (
              <Card style={{ marginBottom: spacing.md, backgroundColor: colors.warmHighlight, borderColor: colors.line }}>
                <Text variant="caption" color={colors.sub} style={{ marginBottom: spacing.xs }}>
                  이런 이야기로 시작해 보세요
                </Text>
                <Text variant="body" color={colors.inkSoft}>{icebreakerToShow.lead}</Text>
                <Text variant="heading" style={{ marginTop: spacing.xs }}>{icebreakerToShow.question}</Text>
              </Card>
            ) : null
          }
          ListFooterComponent={
            lastMyReadMessage && messages[messages.length - 1]?.id === lastMyReadMessage.id ? (
              <Text variant="caption" color={colors.faint} style={{ textAlign: 'right', marginTop: 2 }}>
                읽음
              </Text>
            ) : null
          }
        />

        {detail?.matchStatus !== 'active' && detail ? (
          <View style={styles.inputBar}>
            <Text variant="caption" color={colors.sub} style={{ flex: 1, textAlign: 'center' }}>
              종료된 대화예요.
            </Text>
          </View>
        ) : (
          <View style={styles.inputBar}>
            <TextInput
              style={styles.input}
              placeholder="메시지 보내기"
              placeholderTextColor={colors.faint}
              value={input}
              onChangeText={setInput}
              multiline
              maxLength={2000}
            />
            <Pressable
              onPress={send}
              disabled={!input.trim() || sending}
              style={[styles.sendButton, (!input.trim() || sending) && { opacity: 0.4 }]}
            >
              <Ionicons name="arrow-up" size={20} color={colors.onAccent} />
            </Pressable>
          </View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    backgroundColor: colors.surface,
  },
  menu: {
    padding: spacing.md,
    gap: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    backgroundColor: colors.surface,
  },
  bubbleRow: { flexDirection: 'row' },
  bubble: {
    maxWidth: '78%',
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: radius.lg,
  },
  bubbleMine: { backgroundColor: colors.accent, borderBottomRightRadius: radius.sm },
  bubbleTheirs: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    borderBottomLeftRadius: radius.sm,
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.surface,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.ink,
    backgroundColor: colors.bg,
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
