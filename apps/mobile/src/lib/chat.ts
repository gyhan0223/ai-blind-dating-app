import type { RealtimeChannel } from '@supabase/supabase-js';
import { track } from './analytics';
import { supabase } from './supabase';

export type ConversationListItem = {
  conversationId: string;
  matchId: string;
  matchStatus: string;
  meetupState: string;
  partnerId: string;
  partnerNickname: string;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number;
};

export type ChatMessage = {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string;
  created_at: string;
  read_at: string | null;
};

export type Icebreaker = { lead: string; question: string };

export type ConversationDetail = {
  conversationId: string;
  matchId: string;
  matchStatus: string;
  meetupState: string;
  partnerId: string;
  partnerNickname: string;
  icebreaker: Icebreaker | null;
  totalMessages: number;
};

async function requireUserId(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  const id = data.user?.id;
  if (!id) throw new Error('로그인이 필요합니다.');
  return id;
}

/** 대화 목록 (활성 매치 기준) */
export async function fetchConversations(): Promise<ConversationListItem[]> {
  const userId = await requireUserId();

  const { data: matches, error } = await supabase
    .from('matches')
    .select('id, status, meetup_state, user_a, user_b, conversations(id, last_message_at)')
    .eq('status', 'active')
    .order('created_at', { ascending: false });
  if (error) throw new Error('대화를 불러오지 못했습니다.');

  const rows = (matches ?? []).filter((m) => m.conversations != null);
  const partnerIds = rows.map((m) => (m.user_a === userId ? m.user_b : m.user_a));
  if (rows.length === 0) return [];

  const { data: profiles } = await supabase
    .from('profiles')
    .select('user_id, nickname')
    .in('user_id', partnerIds);
  const nicknameMap = new Map((profiles ?? []).map((p) => [p.user_id, p.nickname]));

  const conversationIds = rows.map((m) => (m.conversations as unknown as { id: string }).id);
  const { data: recentMessages } = await supabase
    .from('messages')
    .select('conversation_id, sender_id, content, created_at, read_at')
    .in('conversation_id', conversationIds)
    .order('created_at', { ascending: false })
    .limit(300);

  const previewMap = new Map<string, { content: string; created_at: string }>();
  const unreadMap = new Map<string, number>();
  for (const msg of recentMessages ?? []) {
    if (!previewMap.has(msg.conversation_id)) {
      previewMap.set(msg.conversation_id, { content: msg.content, created_at: msg.created_at });
    }
    if (msg.sender_id !== userId && msg.read_at == null) {
      unreadMap.set(msg.conversation_id, (unreadMap.get(msg.conversation_id) ?? 0) + 1);
    }
  }

  return rows
    .map((m) => {
      const conv = m.conversations as unknown as { id: string; last_message_at: string | null };
      const partnerId = m.user_a === userId ? m.user_b : m.user_a;
      return {
        conversationId: conv.id,
        matchId: m.id,
        matchStatus: m.status,
        meetupState: m.meetup_state,
        partnerId,
        partnerNickname: nicknameMap.get(partnerId) ?? '알 수 없음',
        lastMessageAt: conv.last_message_at,
        lastMessagePreview: previewMap.get(conv.id)?.content ?? null,
        unreadCount: unreadMap.get(conv.id) ?? 0,
      };
    })
    .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
}

/** 대화방 상세 (상대/아이스브레이커/메시지 수) */
export async function fetchConversationDetail(conversationId: string): Promise<ConversationDetail> {
  const userId = await requireUserId();

  const { data: conv, error } = await supabase
    .from('conversations')
    .select('id, icebreaker, match_id, matches(id, status, meetup_state, user_a, user_b)')
    .eq('id', conversationId)
    .single();
  if (error || !conv) throw new Error('대화방을 찾을 수 없습니다.');

  const match = conv.matches as unknown as {
    id: string;
    status: string;
    meetup_state: string;
    user_a: string;
    user_b: string;
  };
  const partnerId = match.user_a === userId ? match.user_b : match.user_a;

  const [{ data: profile }, { data: metrics }] = await Promise.all([
    supabase.from('profiles').select('nickname').eq('user_id', partnerId).maybeSingle(),
    supabase
      .from('conversation_metrics')
      .select('total_messages')
      .eq('conversation_id', conversationId)
      .maybeSingle(),
  ]);

  return {
    conversationId: conv.id,
    matchId: match.id,
    matchStatus: match.status,
    meetupState: match.meetup_state,
    partnerId,
    partnerNickname: profile?.nickname ?? '알 수 없음',
    icebreaker: (conv.icebreaker as Icebreaker | null) ?? null,
    totalMessages: metrics?.total_messages ?? 0,
  };
}

export async function fetchMessages(conversationId: string): Promise<ChatMessage[]> {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) throw new Error('메시지를 불러오지 못했습니다.');
  return (data ?? []) as ChatMessage[];
}

export async function sendMessage(conversationId: string, content: string): Promise<void> {
  const userId = await requireUserId();
  const trimmed = content.trim();
  if (!trimmed) return;
  const { error } = await supabase.from('messages').insert({
    conversation_id: conversationId,
    sender_id: userId,
    content: trimmed,
  });
  if (error) throw new Error('메시지를 보내지 못했습니다.');
  track('message_sent', { conversation_id: conversationId });
}

/** 상대가 보낸 안 읽은 메시지를 읽음 처리 */
export async function markConversationRead(conversationId: string): Promise<void> {
  const userId = await requireUserId();
  await supabase
    .from('messages')
    .update({ read_at: new Date().toISOString() })
    .eq('conversation_id', conversationId)
    .neq('sender_id', userId)
    .is('read_at', null);
}

/** 새 메시지 실시간 구독 */
export function subscribeToMessages(
  conversationId: string,
  onMessage: (message: ChatMessage) => void,
): RealtimeChannel {
  return supabase
    .channel(`messages:${conversationId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `conversation_id=eq.${conversationId}`,
      },
      (payload) => onMessage(payload.new as ChatMessage),
    )
    .subscribe();
}

/** 아이스브레이커 (서버 규칙 기반 생성, 대화방에 캐시) */
export async function fetchIcebreaker(conversationId: string): Promise<Icebreaker | null> {
  const { data, error } = await supabase.functions.invoke('icebreaker', {
    body: { conversationId },
  });
  if (error) return null;
  return (data?.icebreaker as Icebreaker | null) ?? null;
}

// ---------------------------------------------------------------------------
// 안전: 신고 / 차단
// ---------------------------------------------------------------------------

export type ReportReason =
  | 'unpleasant_conversation'
  | 'sexual_remarks'
  | 'threat'
  | 'impersonation'
  | 'spam'
  | 'other';

export const REPORT_REASONS: { value: ReportReason; label: string }[] = [
  { value: 'unpleasant_conversation', label: '불쾌한 대화' },
  { value: 'sexual_remarks', label: '성적인 발언' },
  { value: 'threat', label: '위협적인 언행' },
  { value: 'impersonation', label: '사칭이 의심됨' },
  { value: 'spam', label: '스팸·광고' },
  { value: 'other', label: '기타' },
];

export async function reportUser(
  reportedId: string,
  reason: ReportReason,
  detail: string,
  matchId?: string,
): Promise<void> {
  const userId = await requireUserId();
  const { error } = await supabase.from('reports').insert({
    reporter_id: userId,
    reported_id: reportedId,
    match_id: matchId ?? null,
    reason,
    detail: detail.trim() || null,
  });
  if (error) throw new Error('신고를 접수하지 못했습니다.');
}

/** 차단 — DB 트리거가 매치를 종료하고, 이후 서로 추천되지 않는다. */
export async function blockUser(blockedId: string): Promise<void> {
  const userId = await requireUserId();
  const { error } = await supabase.from('blocks').insert({
    blocker_id: userId,
    blocked_id: blockedId,
  });
  if (error && !`${error.message}`.includes('duplicate')) {
    throw new Error('차단하지 못했습니다.');
  }
}
