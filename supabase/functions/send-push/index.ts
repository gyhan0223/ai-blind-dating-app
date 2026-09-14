/**
 * Push 발송기 (#17) — notification_events outbox → Expo Push API. service role 전용 (사용자 JWT 는 401).
 * pg_cron 등이 1분 간격으로 호출한다 (docs/push-notifications.md).
 *
 * POST { limit?: number } → { dequeued, sent, delivered, skipped, failed, dead_tokens, errors }
 *
 *  * notification_events_dequeue(limit) — skip locked 로 여러 발송기가 겹쳐도 같은 이벤트를 두 번 보내지 않는다
 *  * buildPushBatch — 종류별 고정 문구, 원문 없음, 같은 대화의 new_message 는 1건으로 묶음, 설정 off/토큰 없음/비활성 수신자는 skip
 *  * Expo API 는 100건씩. 티켓 오류 DeviceNotRegistered 는 토큰 비활성화, 그 외는 재시도(최대 5회 후 expired)
 *  * EXPO_ACCESS_TOKEN 이 있으면 Authorization 헤더로 보낸다 (Expo 대시보드에서 Enhanced Security 를 켠 경우 필수)
 */
import { corsHeaders, json, requireServiceRole, serviceClient } from '../_shared/http.ts';
import { applyTickets, buildPushBatch, chunk, type DequeuedEvent, type ExpoTicket } from '../_shared/notifications/pushCore.ts';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_CHUNK = 100;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const gate = requireServiceRole(req);
  if (gate instanceof Response) return gate;

  const body = (await req.json().catch(() => ({}))) as { limit?: number };
  const limit = Math.max(1, Math.min(500, Number(body.limit) || 200));
  const db = serviceClient();

  const { data: rows, error } = await db.rpc('notification_events_dequeue', { p_limit: limit });
  if (error) {
    console.error(`send-push dequeue failed: ${error.message}`);
    return json({ error: 'dequeue_failed' }, 500);
  }
  const events = (rows ?? []) as DequeuedEvent[];
  const built = buildPushBatch(events);

  // 발송 없이 닫는 이벤트
  for (const s of built.skipped) {
    if (s.ids.length === 0) continue;
    const { error: markErr } = await db.rpc('notification_events_mark', { p_skipped: s.ids, p_skipped_reason: s.reason });
    if (markErr) console.error(`send-push mark skipped failed: ${markErr.message}`);
  }

  const counts = { dequeued: events.length, sent: 0, delivered: 0, skipped: built.skipped.reduce((n, s) => n + s.ids.length, 0), failed: 0, dead_tokens: 0, errors: [] as string[] };
  const accessToken = Deno.env.get('EXPO_ACCESS_TOKEN');

  for (const part of chunk(built.messages, EXPO_CHUNK)) {
    let tickets: ExpoTicket[] = [];
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify(part.map((m) => m.message)),
      });
      const parsed = (await res.json().catch(() => null)) as { data?: ExpoTicket[]; errors?: unknown } | null;
      if (!res.ok || !parsed?.data) {
        throw new Error(`expo push http ${res.status}`);
      }
      tickets = parsed.data;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'expo_push_failed';
      const ids = [...new Set(part.flatMap((m) => m.eventIds))];
      const { error: markErr } = await db.rpc('notification_events_mark', { p_failed: ids, p_error: msg });
      if (markErr) console.error(`send-push mark failed failed: ${markErr.message}`);
      counts.failed += ids.length;
      counts.errors.push(msg);
      continue;
    }
    counts.sent += part.length;
    const outcome = applyTickets(part, tickets);
    counts.delivered += outcome.deliveredEventIds.length;
    counts.failed += outcome.failedEventIds.length;
    counts.errors.push(...outcome.errors);
    const { error: markErr } = await db.rpc('notification_events_mark', {
      p_delivered: outcome.deliveredEventIds,
      p_failed: outcome.failedEventIds,
      p_error: outcome.errors[0] ?? null,
    });
    if (markErr) console.error(`send-push mark failed: ${markErr.message}`);
    if (outcome.deadTokens.length > 0) {
      const { data: n } = await db.rpc('push_tokens_disable', { p_tokens: outcome.deadTokens, p_reason: 'DeviceNotRegistered' });
      counts.dead_tokens += Number(n) || 0;
    }
  }

  return json(counts);
});
