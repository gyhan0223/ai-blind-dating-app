/**
 * 채팅 화면의 순수 로직 (#41) — React/Supabase 의존 없음. Node 로 테스트한다 (scripts/chat-core-selftest.mjs).
 *
 *  * 메시지 병합: 초기 조회·과거 페이지·Realtime 이벤트·낙관적(전송 중) 메시지를 식별자로 합친다.
 *      - 서버 행은 id 로 중복 제거
 *      - 전송 중/실패 행은 clientMessageId 로 구분하며, 같은 clientMessageId 의 서버 행이 오면 그 행으로 교체된다
 *  * 정렬: created_at 오름차순, 동률은 id 로 보조 정렬 (서버 cursor 와 같은 규칙). 전송 중 행은 항상 맨 뒤
 *  * cursor: 가장 오래된 서버 행의 (created_at, id) — 과거 메시지 추가 조회 기준
 */

export type ServerMessage = {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string;
  created_at: string;
  read_at: string | null;
  client_message_id: string | null;
};

export type LocalStatus = 'sending' | 'failed';

/** 화면에 그리는 메시지. 서버 행이면 status 없음, 낙관적 행이면 status 가 있고 id 는 'local:<clientMessageId>' */
export type ChatMessage = ServerMessage & {
  status?: LocalStatus;
  /** 실패 사유 — 사용자에게 보여줄 짧은 분류 */
  failure?: 'blocked' | 'mismatch' | 'network' | 'rate_limited' | 'repeated';
};

export type MessageCursor = { createdAt: string; id: string };

export function isLocal(m: ChatMessage): boolean {
  return m.status != null;
}

export function compareMessages(a: ChatMessage, b: ChatMessage): number {
  const la = isLocal(a);
  const lb = isLocal(b);
  if (la !== lb) return la ? 1 : -1; // 전송 중/실패 행은 항상 서버 행 뒤
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * 기존 목록에 새 행들을 병합한다.
 *  - 서버 행: 같은 id 가 있으면 새 행으로 갱신(read_at 등), 없으면 추가.
 *    같은 client_message_id 의 낙관적 행이 있으면 그 행을 제거한다 (전송 완료 반영).
 *  - 낙관적 행: 같은 client_message_id 의 행이 있으면 상태만 갱신, 서버 행이 이미 있으면 무시.
 */
export function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  const localByClientId = new Map<string, ChatMessage>();
  const serverClientIds = new Set<string>();

  const put = (m: ChatMessage) => {
    if (isLocal(m)) {
      const cid = m.client_message_id ?? m.id;
      if (serverClientIds.has(cid)) return; // 이미 서버에 저장됨
      localByClientId.set(cid, m);
      return;
    }
    byId.set(m.id, m);
    if (m.client_message_id) {
      serverClientIds.add(m.client_message_id);
      localByClientId.delete(m.client_message_id);
    }
  };
  for (const m of existing) put(m);
  for (const m of incoming) put(m);

  return [...byId.values(), ...localByClientId.values()].sort(compareMessages);
}

/** 가장 오래된 서버 행 기준 cursor. 서버 행이 없으면 null */
export function oldestCursor(messages: ChatMessage[]): MessageCursor | null {
  let oldest: ChatMessage | null = null;
  for (const m of messages) {
    if (isLocal(m)) continue;
    if (!oldest || compareMessages(m, oldest) < 0) oldest = m;
  }
  return oldest ? { createdAt: oldest.created_at, id: oldest.id } : null;
}

/** 가장 최근 서버 행의 created_at (재동기화 시작점). 없으면 null */
export function newestServerTimestamp(messages: ChatMessage[]): string | null {
  let newest: ChatMessage | null = null;
  for (const m of messages) {
    if (isLocal(m)) continue;
    if (!newest || compareMessages(m, newest) > 0) newest = m;
  }
  return newest?.created_at ?? null;
}

/**
 * PostgREST `or` 필터 문자열 — (created_at, id) 보다 오래된 행.
 * created_at 동률은 id 로 자른다 (서버 인덱스 (conversation_id, created_at desc, id desc) 와 동일 규칙).
 */
export function beforeCursorFilter(cursor: MessageCursor): string {
  return `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`;
}

/**
 * 재동기화 시작 시각: 마지막으로 아는 서버 행보다 살짝 앞(여유 60초)에서 다시 읽어
 * 구독 재연결 사이에 놓친 행을 병합한다 (겹치는 행은 id 로 제거되므로 안전).
 */
export function resyncSince(newestIso: string | null, marginMs = 60_000): string | null {
  if (!newestIso) return null;
  const t = Date.parse(newestIso);
  if (Number.isNaN(t)) return null;
  return new Date(t - marginMs).toISOString();
}

/** 낙관적(전송 중) 메시지 행 */
export function makeLocalMessage(input: {
  conversationId: string;
  senderId: string;
  clientMessageId: string;
  content: string;
  now?: Date;
}): ChatMessage {
  return {
    id: `local:${input.clientMessageId}`,
    conversation_id: input.conversationId,
    sender_id: input.senderId,
    content: input.content,
    created_at: (input.now ?? new Date()).toISOString(),
    read_at: null,
    client_message_id: input.clientMessageId,
    status: 'sending',
  };
}

/** 낙관적 행의 상태 변경 (없으면 그대로) */
export function setLocalStatus(
  messages: ChatMessage[],
  clientMessageId: string,
  status: LocalStatus,
  failure?: ChatMessage['failure'],
): ChatMessage[] {
  return messages.map((m) =>
    isLocal(m) && m.client_message_id === clientMessageId ? { ...m, status, failure } : m,
  );
}

export function removeLocal(messages: ChatMessage[], clientMessageId: string): ChatMessage[] {
  return messages.filter((m) => !(isLocal(m) && m.client_message_id === clientMessageId));
}

/**
 * 클라이언트 메시지 식별자 — 작성 시 1회 발급, 재시도에도 같은 값을 쓴다.
 * crypto.randomUUID 가 없는 런타임(Hermes 등)에서는 Math.random 기반 v4 형식으로 만든다.
 * 유일성은 (대화, 발신자) 안에서만 필요하므로 충분하다.
 */
export function newClientMessageId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
    else if (i === 14) out += '4';
    else if (i === 19) out += hex[(Math.random() * 4) | 8];
    else out += hex[(Math.random() * 16) | 0];
  }
  return out;
}

/** 서버 오류 → 실패 분류 (본문은 잃지 않는다) */
export function classifySendError(message: string | null | undefined): NonNullable<ChatMessage['failure']> {
  const m = message ?? '';
  if (m.includes('message_content_mismatch')) return 'mismatch';
  if (m.includes('rate_limited')) return 'rate_limited';
  if (m.includes('repeated_content')) return 'repeated';
  if (m.includes('row-level security') || m.includes('42501') || m.includes('permission denied')) return 'blocked';
  return 'network';
}

// ---------------------------------------------------------------------------
// 대화 시작 질문 캐시 (서버 _shared/matching/starterQuestions.ts 의 v2 형식과 동기)
// ---------------------------------------------------------------------------
export type StarterBasis = 'shared' | 'partner' | 'general';
export type StarterQuestion = { id: string; text: string; basis: StarterBasis; promptId?: string; value?: string };
export type StarterCache = { version: 2; generated_at: string; questions: StarterQuestion[] };

/** v2 형식이 아니면 null — 과거 { lead, question } 캐시는 화면에 다시 노출하지 않는다 */
export function parseStarterCache(raw: unknown): StarterCache | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 2 || !Array.isArray(obj.questions)) return null;
  const questions: StarterQuestion[] = [];
  for (const q of obj.questions as unknown[]) {
    if (!q || typeof q !== 'object') return null;
    const item = q as Record<string, unknown>;
    if (typeof item.id !== 'string' || typeof item.text !== 'string') return null;
    if (item.basis !== 'shared' && item.basis !== 'partner' && item.basis !== 'general') return null;
    questions.push({
      id: item.id,
      text: item.text,
      basis: item.basis,
      promptId: typeof item.promptId === 'string' ? item.promptId : undefined,
      value: typeof item.value === 'string' ? item.value : undefined,
    });
  }
  if (questions.length === 0) return null;
  return { version: 2, generated_at: typeof obj.generated_at === 'string' ? obj.generated_at : '', questions };
}

// ---------------------------------------------------------------------------
// 만남 상태 (서버 matches.meetup_state 의 의미를 화면 문구로)
// ---------------------------------------------------------------------------
export type MeetupState = 'none' | 'mutual_interest' | 'interest_withdrawn' | 'scheduled' | 'completed' | 'met_confirmed';

/** 현재 서로의 만남 의향이 확인된 상태인지 (날짜·지역 공개 조건) */
export function isMutualNow(state: string): boolean {
  return state === 'mutual_interest' || state === 'scheduled';
}

/** 양측이 각자 "만났음" 이라고 응답한 상태인지. legacy 'completed' 는 아니다 */
export function isBothConfirmed(state: string): boolean {
  return state === 'met_confirmed';
}

/** 만남 결과 응답을 받을 수 있는 상태인지 (상호 관심이 한 번이라도 있었거나 과거 앱이 만남 상태를 남긴 매치) */
export function canReportOutcome(state: string, mutualInterestAt: string | null): boolean {
  return mutualInterestAt != null || (state !== 'none' && state !== 'interest_withdrawn');
}
