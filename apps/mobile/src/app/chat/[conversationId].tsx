import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
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
import {
  type ChatMessage,
  fetchConversationDetail,
  fetchMessagesPage,
  fetchMessagesSince,
  fetchStarterQuestions,
  markConversationRead,
  sendMessage,
  SendMessageError,
  subscribeToConversation,
} from '@/lib/chat';
import {
  makeLocalMessage,
  mergeMessages,
  newClientMessageId,
  newestServerTimestamp,
  oldestCursor,
  removeLocal,
  resyncSince,
  setLocalStatus,
  type StarterQuestion,
} from '@/lib/chatCore';
import { useSession } from '@/lib/session';
import { colors, radius, spacing } from '@/theme/tokens';

/** 시작 질문 카드를 보여주는 최대 메시지 수 (그 뒤엔 접는다 — 강요하지 않는다) */
const STARTER_VISIBLE_UNTIL = 4;

function accessMessage(reason: string): string {
  switch (reason) {
    case 'ended':
      return '종료된 대화예요. 이전 대화는 볼 수 있지만 새 메시지는 보낼 수 없어요.';
    case 'unavailable':
      return '지금은 대화할 수 없는 상대예요.';
    case 'self_restricted':
      return '현재 계정 상태에서는 메시지를 보낼 수 없어요.';
    default:
      return '이 대화에 참여할 수 없어요.';
  }
}

export default function ChatRoom() {
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const { session } = useSession();
  const myId = session?.user.id;
  const queryClient = useQueryClient();

  const { data: detail, refetch: refetchDetail } = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => fetchConversationDetail(conversationId!),
    enabled: !!conversationId,
  });

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [input, setInput] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [startersOpen, setStartersOpen] = useState(true);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  // 화면 재진입 시 스크롤 하단 유지용
  const stickToEnd = useRef(true);

  const applyIncoming = useCallback((incoming: ChatMessage[]) => {
    setMessages((prev) => mergeMessages(prev, incoming));
  }, []);

  /** 서버와 재동기화 — 구독 재연결·포그라운드 복귀·초기 진입 */
  const resync = useCallback(async () => {
    if (!conversationId) return;
    const since = resyncSince(newestServerTimestamp(messagesRef.current));
    try {
      if (since) {
        applyIncoming(await fetchMessagesSince(conversationId, since));
      } else {
        const page = await fetchMessagesPage(conversationId);
        applyIncoming(page.messages);
        setHasMore(page.hasMore);
      }
      setLoadError(null);
    } catch {
      setLoadError('메시지를 불러오지 못했어요. 네트워크를 확인해 주세요.');
    } finally {
      setInitialLoaded(true);
    }
    markConversationRead(conversationId);
  }, [conversationId, applyIncoming]);

  // 구독을 먼저 열고(연결 시점 이벤트 유실 방지) SUBSCRIBED 마다 재동기화한다.
  useEffect(() => {
    if (!conversationId || !detail?.matchId) return;
    let cancelled = false;
    const channel = subscribeToConversation(conversationId, detail.matchId, {
      onMessage: (msg) => {
        if (cancelled) return;
        applyIncoming([msg]);
        if (msg.sender_id !== myId) markConversationRead(conversationId);
      },
      onMatchChanged: () => {
        if (cancelled) return;
        refetchDetail();
        queryClient.invalidateQueries({ queryKey: ['meetup', detail.matchId] });
        queryClient.invalidateQueries({ queryKey: ['conversations'] });
      },
      onStatus: (status) => {
        if (cancelled) return;
        if (status === 'SUBSCRIBED') resync();
      },
    });
    // 구독 확립 전에도 첫 화면은 그린다 (SUBSCRIBED 시 한 번 더 병합 — id 로 중복 제거)
    resync();
    return () => {
      cancelled = true;
      channel.unsubscribe();
    };
  }, [conversationId, detail?.matchId, myId, applyIncoming, resync, refetchDetail, queryClient]);

  // 포그라운드 복귀 시 재동기화
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        resync();
        refetchDetail();
      }
    });
    return () => sub.remove();
  }, [resync, refetchDetail]);

  const loadOlder = useCallback(async () => {
    if (!conversationId || loadingMore) return;
    const cursor = oldestCursor(messagesRef.current);
    if (!cursor) return;
    setLoadingMore(true);
    stickToEnd.current = false;
    try {
      const page = await fetchMessagesPage(conversationId, cursor);
      applyIncoming(page.messages);
      setHasMore(page.hasMore);
    } catch {
      setLoadError('이전 메시지를 불러오지 못했어요.');
    } finally {
      setLoadingMore(false);
    }
  }, [conversationId, loadingMore, applyIncoming]);

  // 시작 질문 — 캐시(v2)가 없으면 서버에서 생성. 실패해도 대화는 가능
  const serverMessageCount = messages.filter((m) => m.status == null).length;
  const { data: fetchedStarters } = useQuery({
    queryKey: ['starters', conversationId],
    queryFn: () => fetchStarterQuestions(conversationId!),
    enabled: !!conversationId && !!detail && detail.starters == null && initialLoaded && serverMessageCount < STARTER_VISIBLE_UNTIL,
    staleTime: Infinity,
  });
  const starters = detail?.starters ?? fetchedStarters ?? null;
  const showStarters =
    !!starters && startersOpen && initialLoaded && serverMessageCount < STARTER_VISIBLE_UNTIL && detail?.access.canChat;

  const canChat = detail?.access.canChat ?? false;

  /** 전송 — 작성 시 발급한 clientMessageId 를 재시도에도 그대로 쓴다 */
  const deliver = useCallback(
    async (clientMessageId: string, content: string) => {
      if (!conversationId) return;
      try {
        const saved = await sendMessage(conversationId, clientMessageId, content);
        applyIncoming([saved]);
        queryClient.invalidateQueries({ queryKey: ['conversations'] });
      } catch (e) {
        const failure = e instanceof SendMessageError ? e.failure : 'network';
        setMessages((prev) => setLocalStatus(prev, clientMessageId, 'failed', failure));
        if (failure === 'blocked') refetchDetail();
      }
    },
    [conversationId, applyIncoming, queryClient, refetchDetail],
  );

  const send = useCallback(() => {
    const content = input.trim();
    if (!conversationId || !myId || !content || !canChat) return;
    const clientMessageId = newClientMessageId();
    setInput('');
    stickToEnd.current = true;
    setMessages((prev) =>
      mergeMessages(prev, [makeLocalMessage({ conversationId, senderId: myId, clientMessageId, content })]),
    );
    deliver(clientMessageId, content);
  }, [conversationId, myId, input, canChat, deliver]);

  const retry = useCallback(
    (m: ChatMessage) => {
      if (!m.client_message_id) return;
      setMessages((prev) => setLocalStatus(prev, m.client_message_id!, 'sending'));
      deliver(m.client_message_id, m.content);
    },
    [deliver],
  );

  const discardFailed = useCallback((m: ChatMessage) => {
    if (!m.client_message_id) return;
    // 작성 내용은 입력창으로 되돌려 잃지 않게 한다
    setInput((cur) => (cur.trim() ? cur : m.content));
    setMessages((prev) => removeLocal(prev, m.client_message_id!));
  }, []);

  const applyStarter = useCallback((q: StarterQuestion) => {
    // 자동 발송하지 않는다 — 입력창에 넣고 사용자가 고쳐서 보낸다
    setInput(q.text);
  }, []);

  const lastMyReadMessage = [...messages].reverse().find((m) => m.status == null && m.sender_id === myId && m.read_at);

  const renderMessage = ({ item }: { item: ChatMessage }) => {
    const mine = item.sender_id === myId;
    const failed = item.status === 'failed';
    return (
      <View style={[styles.bubbleRow, mine ? { justifyContent: 'flex-end' } : null]}>
        <View style={{ maxWidth: '78%', alignItems: mine ? 'flex-end' : 'flex-start' }}>
          <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs, item.status === 'sending' && { opacity: 0.6 }]}>
            <Text variant="body" color={mine ? colors.onAccent : colors.ink}>
              {item.content}
            </Text>
          </View>
          {item.status === 'sending' && (
            <Text variant="caption" color={colors.faint} style={{ marginTop: 2 }}>보내는 중…</Text>
          )}
          {failed && (
            <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: 2, alignItems: 'center' }}>
              <Text variant="caption" color={colors.danger}>
                {item.failure === 'blocked'
                  ? '보낼 수 없어요'
                  : item.failure === 'mismatch'
                    ? '이미 다른 내용으로 보낸 메시지예요'
                    : '전송 실패'}
              </Text>
              {item.failure === 'network' && (
                <Pressable onPress={() => retry(item)} hitSlop={8}>
                  <Text variant="caption" color={colors.accent}>다시 보내기</Text>
                </Pressable>
              )}
              <Pressable onPress={() => discardFailed(item)} hitSlop={8}>
                <Text variant="caption" color={colors.sub}>{item.failure === 'network' ? '지우기' : '입력창으로'}</Text>
              </Pressable>
            </View>
          )}
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
        <Pressable onPress={() => setMenuOpen(!menuOpen)} hitSlop={12} accessibilityLabel="대화 메뉴">
          <Ionicons name="ellipsis-horizontal" size={22} color={colors.sub} />
        </Pressable>
      </View>

      {menuOpen && detail && (
        <View style={styles.menu}>
          {detail.matchStatus === 'active' && (
            <Button
              kind="secondary"
              title={
                detail.meetupState === 'met_confirmed'
                  ? '만남 후 이야기 남기기'
                  : detail.meetupState === 'mutual_interest'
                    ? '만남 · 서로 만나고 싶어 해요'
                    : '이 사람을 실제로 만나보고 싶어요'
              }
              onPress={() => {
                setMenuOpen(false);
                router.push({ pathname: '/meetup/[matchId]', params: { matchId: detail.matchId } });
              }}
            />
          )}
          {detail.matchStatus !== 'active' && detail.mutualInterestAt && (
            <Button
              kind="secondary"
              title="만남 결과·후기 남기기"
              onPress={() => {
                setMenuOpen(false);
                router.push({ pathname: '/meetup/[matchId]', params: { matchId: detail.matchId } });
              }}
            />
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
          onContentSizeChange={() => {
            if (stickToEnd.current) listRef.current?.scrollToEnd({ animated: false });
          }}
          onEndReached={() => {
            stickToEnd.current = true;
          }}
          ListHeaderComponent={
            <View>
              {hasMore && (
                <Button
                  kind="ghost"
                  title={loadingMore ? '불러오는 중…' : '이전 메시지 보기'}
                  onPress={loadOlder}
                  disabled={loadingMore}
                />
              )}
              {loadError && (
                <Pressable onPress={resync}>
                  <Text variant="caption" color={colors.danger} style={{ textAlign: 'center', marginBottom: spacing.sm }}>
                    {loadError} (눌러서 다시 시도)
                  </Text>
                </Pressable>
              )}
              {showStarters && starters && (
                <Card style={{ marginBottom: spacing.md, backgroundColor: colors.warmHighlight, borderColor: colors.line }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.xs }}>
                    <Text variant="caption" color={colors.sub}>공개 소개를 바탕으로 고른 질문이에요</Text>
                    <Pressable onPress={() => setStartersOpen(false)} hitSlop={8} accessibilityLabel="질문 카드 닫기">
                      <Ionicons name="close" size={16} color={colors.sub} />
                    </Pressable>
                  </View>
                  <Text variant="caption" color={colors.faint} style={{ marginBottom: spacing.sm }}>
                    골라서 고쳐 보내도 되고, 그냥 바로 대화해도 괜찮아요.
                  </Text>
                  <View style={{ gap: spacing.sm }}>
                    {starters.questions.map((q) => (
                      <Pressable
                        key={q.id}
                        onPress={() => applyStarter(q)}
                        style={styles.starter}
                        accessibilityRole="button"
                        accessibilityLabel={`질문 사용: ${q.text}`}
                      >
                        <Text variant="caption" color={colors.faint} style={{ marginBottom: 2 }}>
                          {q.basis === 'shared' ? '둘 다 고른 항목' : q.basis === 'partner' ? '상대가 고른 항목' : '가볍게 시작하기'}
                        </Text>
                        <Text variant="body" color={colors.ink}>{q.text}</Text>
                      </Pressable>
                    ))}
                  </View>
                </Card>
              )}
            </View>
          }
          ListFooterComponent={
            lastMyReadMessage && messages[messages.length - 1]?.id === lastMyReadMessage.id ? (
              <Text variant="caption" color={colors.faint} style={{ textAlign: 'right', marginTop: 2 }}>
                읽음
              </Text>
            ) : null
          }
        />

        {detail && !canChat ? (
          <View style={styles.inputBar}>
            <Text variant="caption" color={colors.sub} style={{ flex: 1, textAlign: 'center' }}>
              {accessMessage(detail.access.reason)}
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
              editable={!!detail}
            />
            <Pressable
              onPress={send}
              disabled={!input.trim() || !detail}
              style={[styles.sendButton, (!input.trim() || !detail) && { opacity: 0.4 }]}
              accessibilityRole="button"
              accessibilityLabel="보내기"
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
  starter: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
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
