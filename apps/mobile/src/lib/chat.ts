import type { RealtimeChannel } from '@supabase/supabase-js';
import {
  beforeCursorFilter,
  classifySendError,
  type ChatMessage,
  type MessageCursor,
  parseStarterCache,
  type ServerMessage,
  type StarterCache,
} from './chatCore';
import { supabase } from './supabase';

export type { ChatMessage, StarterCache, StarterQuestion } from './chatCore';

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

export type ConversationAccess = {
  canChat: boolean;
  reason: 'ok' | 'forbidden' | 'ended' | 'self_restricted' | 'unavailable';
};

export type ConversationDetail = {
  conversationId: string;
  matchId: string;
  matchStatus: string;
  meetupState: string;
  mutualInterestAt: string | null;
  partnerId: string;
  partnerNickname: string;
  /** v2 캐시만. 과거 lead/question 캐시는 null 로 취급 (서버가 v2 로 재생성) */
  starters: StarterCache | null;
  totalMessages: number;
  access: ConversationAccess;
};

export const MESSAGE_PAGE_SIZE = 50;
const MESSAGE_COLUMNS = 'id, conversation_id, sender_id, content, created_at, read_at, client_message_id';

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

/** 지금 이 대화에 메시지를 보낼 수 있는지 (서버 판단: 매치 종료·차단·본인/상대 비활성) */
export async function fetchConversationAccess(conversationId: string): Promise<ConversationAccess> {
  const { data, error } = await supabase.rpc('conversation_access', { cid: conversationId });
  if (error || !data) throw new Error('대화 상태를 확인하지 못했습니다.');
  const obj = data as { can_chat?: boolean; reason?: string };
  const reason = (['ok', 'forbidden', 'ended', 'self_restricted', 'unavailable'] as const).find((r) => r === obj.reason) ?? 'forbidden';
  return { canChat: obj.can_chat === true && reason === 'ok', reason };
}

/** 대화방 상세 (상대/시작 질문 캐시/메시지 수/전송 가능 여부) */
export async function fetchConversationDetail(conversationId: string): Promise<ConversationDetail> {
  const userId = await requireUserId();

  const { data: conv, error } = await supabase
    .from('conversations')
    .select('id, icebreaker, match_id, matches(id, status, meetup_state, mutual_interest_at, user_a, user_b)')
    .eq('id', conversationId)
    .single();
  if (error || !conv) throw new Error('대화방을 찾을 수 없습니다.');

  const match = conv.matches as unknown as {
    id: string;
    status: string;
    meetup_state: string;
    mutual_interest_at: string | null;
    user_a: string;
    user_b: string;
  };
  const partnerId = match.user_a === userId ? match.user_b : match.user_a;

  const [{ data: profile }, { data: metrics }, access] = await Promise.all([
    supabase.from('profiles').select('nickname').eq('user_id', partnerId).maybeSingle(),
    supabase
      .from('conversation_metrics')
      .select('total_messages')
      .eq('conversation_id', conversationId)
      .maybeSingle(),
    fetchConversationAccess(conversationId),
  ]);

  return {
    conversationId: conv.id,
    matchId: match.id,
    matchStatus: match.status,
    meetupState: match.meetup_state,
    mutualInterestAt: match.mutual_interest_at ?? null,
    partnerId,
    partnerNickname: profile?.nickname ?? '알 수 없음',
    starters: parseStarterCache(conv.icebreaker),
    totalMessages: metrics?.total_messages ?? 0,
    access,
  };
}

/**
 * 최신 메시지부터 한 페이지. cursor 가 있으면 그보다 오래된 행 (created_at 동률은 id 로 보조 정렬).
 * 반환은 오름차순(오래된 → 최신). hasMore 는 페이지가 꽉 찼는지로 판단한다.
 */
export async function fetchMessagesPage(
  conversationId: string,
  before: MessageCursor | null = null,
  limit = MESSAGE_PAGE_SIZE,
): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
  let query = supabase
    .from('messages')
    .select(MESSAGE_COLUMNS)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);
  if (before) query = query.or(beforeCursorFilter(before));
  const { data, error } = await query;
  if (error) throw new Error('메시지를 불러오지 못했습니다.');
  const rows = ((data ?? []) as ServerMessage[]).slice().reverse();
  return { messages: rows, hasMore: rows.length >= limit };
}

/** 특정 시각 이후 행 (재연결·포그라운드 복귀 시 누락 복구). 겹치는 행은 병합 시 id 로 제거된다 */
export async function fetchMessagesSince(conversationId: string, sinceIso: string): Promise<ChatMessage[]> {
  const { data, error } = await supabase
    .from('messages')
    .select(MESSAGE_COLUMNS)
    .eq('conversation_id', conversationId)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(500);
  if (error) throw new Error('메시지를 불러오지 못했습니다.');
  return (data ?? []) as ServerMessage[];
}

export class SendMessageError extends Error {
  failure: NonNullable<ChatMessage['failure']>;
  constructor(failure: NonNullable<ChatMessage['failure']>, message: string) {
    super(message);
    this.failure = failure;
  }
}

/**
 * 메시지 전송 — 서버 RPC send_message (멱등).
 * 같은 clientMessageId 로 재시도하면 서버가 저장된 행을 돌려준다 (저장 성공 후 응답 유실 복구, 중복 없음).
 * 본문·이벤트 기록은 서버가 한다 (클라이언트 track 없음).
 */
export async function sendMessage(
  conversationId: string,
  clientMessageId: string,
  content: string,
): Promise<ChatMessage> {
  const trimmed = content.trim();
  if (!trimmed) throw new SendMessageError('network', '빈 메시지는 보낼 수 없습니다.');
  const { data, error } = await supabase.rpc('send_message', {
    p_conversation_id: conversationId,
    p_client_message_id: clientMessageId,
    p_content: trimmed,
  });
  if (error) {
    const failure = classifySendError(`${error.message} ${error.code ?? ''} ${error.details ?? ''}`);
    throw new SendMessageError(failure, error.message);
  }
  const row = (Array.isArray(data) ? data[0] : data) as ServerMessage | null | undefined;
  if (!row?.id) throw new SendMessageError('network', '메시지를 보내지 못했습니다.');
  return row;
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

export type MessageSubscription = {
  channel: RealtimeChannel;
};

/**
 * 새 메시지 + 매치 상태 실시간 구독.
 * onStatus('SUBSCRIBED') 는 최초 연결과 재연결 모두에서 불린다 — 호출 측이 그 시점에 서버와 재동기화한다.
 */
export function subscribeToConversation(
  conversationId: string,
  matchId: string,
  handlers: {
    onMessage: (message: ChatMessage) => void;
    onMatchChanged: () => void;
    onStatus: (status: 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR') => void;
  },
): RealtimeChannel {
  return supabase
    .channel(`conversation:${conversationId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` },
      (payload) => handlers.onMessage(payload.new as ServerMessage),
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'matches', filter: `id=eq.${matchId}` },
      () => handlers.onMatchChanged(),
    )
    .subscribe((status) => handlers.onStatus(status));
}

/** 대화 시작 질문 (서버 규칙 기반, 공개 답변만 사용). 실패하면 null — 질문 없이도 대화할 수 있다 */
export async function fetchStarterQuestions(conversationId: string): Promise<StarterCache | null> {
  const { data, error } = await supabase.functions.invoke('icebreaker', {
    body: { conversationId },
  });
  if (error) return null;
  return parseStarterCache((data as { icebreaker?: unknown } | null)?.icebreaker);
}

// ---------------------------------------------------------------------------
// 안전: 신고 / 차단
// ---------------------------------------------------------------------------

export type ReportReason =
  | 'unpleasant_conversation'
  | 'sexual_remarks'
  | 'harassment'
  | 'threat'
  | 'stalking'
  | 'scam_money'
  | 'personal_info_request'
  | 'impersonation'
  | 'false_info'
  | 'underage'
  | 'spam'
  | 'other';

/** 사유 목록 (docs/moderation-policy.md). urgentAllowed: 신고자가 "긴급" 을 표시할 수 있는 사유. 위협·스토킹·미성년 의심은 서버가 자동 긴급 */
export const REPORT_REASONS: { value: ReportReason; label: string; urgentAllowed?: boolean }[] = [
  { value: 'unpleasant_conversation', label: '불쾌한 대화' },
  { value: 'sexual_remarks', label: '성적인 발언', urgentAllowed: true },
  { value: 'harassment', label: '성희롱·괴롭힘', urgentAllowed: true },
  { value: 'threat', label: '위협적인 언행', urgentAllowed: true },
  { value: 'stalking', label: '스토킹', urgentAllowed: true },
  { value: 'scam_money', label: '금전 요구·사기', urgentAllowed: true },
  { value: 'personal_info_request', label: '연락처·신상 요구' },
  { value: 'impersonation', label: '사칭이 의심됨' },
  { value: 'false_info', label: '프로필 허위 정보' },
  { value: 'underage', label: '미성년자 의심' },
  { value: 'spam', label: '스팸·광고' },
  { value: 'other', label: '기타' },
];

export async function reportUser(
  reportedId: string,
  reason: ReportReason,
  detail: string,
  matchId?: string,
  urgent = false,
): Promise<void> {
  const userId = await requireUserId();
  const allowUrgent = REPORT_REASONS.find((r) => r.value === reason)?.urgentAllowed === true;
  const { error } = await supabase.from('reports').insert({
    reporter_id: userId,
    reported_id: reportedId,
    match_id: matchId ?? null,
    reason,
    detail: detail.trim() || null,
    severity: urgent && allowUrgent ? 'urgent' : 'normal',
  });
  if (error) throw new Error('신고를 접수하지 못했습니다.');
}

/** 차단 — DB 트리거가 매치를 종료하고, 이후 서로 추천되지 않는다. 대화 이력은 삭제하지 않는다 */
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
