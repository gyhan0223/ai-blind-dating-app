/**
 * Push 발송 순수 로직 (#17) — Deno/Node 겸용, 네트워크 없음. send-push Edge Function 이 사용한다.
 *
 * 원칙
 *  * 본문은 종류별 고정 문구다. 메시지 원문·상대 닉네임·일방 의향·피드백·비공개 답변은 payload 에도 본문에도 없다.
 *    (잠금화면 노출 최소화 — 앱을 열어야 내용을 본다)
 *  * data 에는 앱이 화면을 열 때 필요한 kind·match_id·conversation_id 만 담는다 (deep link).
 *  * 같은 수신자·같은 대화의 new_message 이벤트는 한 번에 하나로 묶는다 (연타 방지). 이벤트 id 는 모두 delivered 처리.
 *  * 토큰 없음 / 설정 off / 수신자 비활성 → 발송하지 않고 skipped 로 닫는다 (재시도하지 않는다).
 */

export type NotificationKind = 'new_message' | 'mutual_meetup_interest' | 'daily_recommendation' | 'match_created';

export interface DequeuedEvent {
  id: number;
  recipient_id: string;
  kind: string;
  match_id: string | null;
  conversation_id: string | null;
  created_at: string;
  attempts: number;
  recipient_status: string;
  pref_enabled: boolean;
  tokens: { token: string; platform: string }[];
}

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  sound: 'default';
  channelId: 'default';
  priority: 'high';
  data: { kind: NotificationKind; match_id?: string; conversation_id?: string };
}

export interface BuildResult {
  /** 보낼 메시지와 그 메시지가 대표하는 이벤트 id (티켓 오류 시 재시도 대상) */
  messages: { message: ExpoPushMessage; eventIds: number[] }[];
  /** 발송 없이 닫을 이벤트 */
  skipped: { ids: number[]; reason: 'no_token' | 'pref_off' | 'recipient_inactive' | 'unknown_kind' }[];
}

export const PUSH_TEXT: Record<NotificationKind, { title: string; body: string }> = {
  new_message: { title: '본심', body: '새 메시지가 도착했어요.' },
  mutual_meetup_interest: { title: '본심', body: '만남에 대한 새 소식이 있어요. 앱에서 확인해 보세요.' },
  daily_recommendation: { title: '본심', body: '오늘의 소개가 도착했어요.' },
  match_created: { title: '본심', body: '새로운 대화가 열렸어요. 첫 인사를 건네 보세요.' },
};

/** 이벤트가 오래됐으면(예: 6시간) 보내지 않는다 — 발송기가 오래 멈췄다 켜졌을 때 몰아서 울리지 않게 */
export const MAX_EVENT_AGE_MS = 6 * 60 * 60 * 1000;

function isKind(k: string): k is NotificationKind {
  return k === 'new_message' || k === 'mutual_meetup_interest' || k === 'daily_recommendation' || k === 'match_created';
}

export function buildPushBatch(events: DequeuedEvent[], now: Date = new Date()): BuildResult {
  const messages: BuildResult['messages'] = [];
  const skipped = new Map<BuildResult['skipped'][number]['reason'], number[]>();
  const skip = (reason: BuildResult['skipped'][number]['reason'], id: number) => {
    const arr = skipped.get(reason) ?? [];
    arr.push(id);
    skipped.set(reason, arr);
  };

  // 수신자+대화 단위로 new_message 를 묶는다. 다른 종류는 이벤트마다 1건.
  const groups = new Map<string, { kind: NotificationKind; ev: DequeuedEvent; ids: number[] }>();
  for (const e of events) {
    if (!isKind(e.kind)) {
      skip('unknown_kind', e.id);
      continue;
    }
    if (e.recipient_status !== 'active') {
      skip('recipient_inactive', e.id);
      continue;
    }
    if (!e.pref_enabled) {
      skip('pref_off', e.id);
      continue;
    }
    const tokens = (e.tokens ?? []).filter((t) => typeof t.token === 'string' && t.token.length > 0);
    if (tokens.length === 0) {
      skip('no_token', e.id);
      continue;
    }
    const age = now.getTime() - Date.parse(e.created_at);
    if (Number.isFinite(age) && age > MAX_EVENT_AGE_MS) {
      // 오래된 이벤트는 조용히 닫는다 (skipped 로 기록 — 이유는 no_token 과 구분)
      skip('unknown_kind', e.id);
      continue;
    }
    const key =
      e.kind === 'new_message' ? `${e.recipient_id}:new_message:${e.conversation_id ?? ''}` : `${e.recipient_id}:${e.kind}:${e.id}`;
    const g = groups.get(key);
    if (g) g.ids.push(e.id);
    else groups.set(key, { kind: e.kind, ev: e, ids: [e.id] });
  }

  for (const g of groups.values()) {
    const text = PUSH_TEXT[g.kind];
    const data: ExpoPushMessage['data'] = { kind: g.kind };
    if (g.ev.match_id) data.match_id = g.ev.match_id;
    if (g.ev.conversation_id) data.conversation_id = g.ev.conversation_id;
    for (const t of g.ev.tokens) {
      messages.push({
        message: { to: t.token, title: text.title, body: text.body, sound: 'default', channelId: 'default', priority: 'high', data },
        eventIds: g.ids,
      });
    }
  }

  return {
    messages,
    skipped: [...skipped.entries()].map(([reason, ids]) => ({ reason, ids })),
  };
}

/** Expo Push API 응답 티켓 */
export interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

export interface TicketOutcome {
  deliveredEventIds: number[];
  failedEventIds: number[];
  /** 더 이상 유효하지 않은 토큰 (DeviceNotRegistered) — 비활성화 대상 */
  deadTokens: string[];
  errors: string[];
}

/**
 * 티켓을 메시지 순서대로 대응시켜 결과를 나눈다.
 *  - ok → 그 메시지의 이벤트 delivered
 *  - DeviceNotRegistered → 토큰 비활성화. 같은 이벤트가 다른 토큰으로 ok 였으면 delivered, 아니면 (토큰이 모두 죽었으니) delivered 로 닫는다 — 재시도해도 보낼 곳이 없다
 *  - 그 외 오류 → failed (재시도)
 */
export function applyTickets(batch: BuildResult['messages'], tickets: ExpoTicket[]): TicketOutcome {
  const delivered = new Set<number>();
  const failed = new Set<number>();
  const deadTokens = new Set<string>();
  const errors: string[] = [];
  batch.forEach((m, i) => {
    const t = tickets[i];
    if (!t) {
      for (const id of m.eventIds) failed.add(id);
      errors.push('missing_ticket');
      return;
    }
    if (t.status === 'ok') {
      for (const id of m.eventIds) delivered.add(id);
      return;
    }
    const code = t.details?.error ?? 'unknown';
    if (code === 'DeviceNotRegistered') {
      deadTokens.add(m.message.to);
      for (const id of m.eventIds) delivered.add(id);
      return;
    }
    errors.push(code);
    for (const id of m.eventIds) failed.add(id);
  });
  // 같은 이벤트가 어느 토큰으로든 성공했으면 delivered 우선
  for (const id of delivered) failed.delete(id);
  return { deliveredEventIds: [...delivered], failedEventIds: [...failed], deadTokens: [...deadTokens], errors };
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
