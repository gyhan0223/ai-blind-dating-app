/**
 * Push 발송 순수 로직 selftest (#17). 실행: node --experimental-strip-types selftest.ts
 */
import { applyTickets, buildPushBatch, chunk, MAX_EVENT_AGE_MS, PUSH_TEXT, type DequeuedEvent } from './pushCore.ts';

let passes = 0;
let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) passes += 1;
  else {
    failures += 1;
    console.error(`FAIL: ${name}`);
  }
}

const NOW = new Date('2026-09-14T09:00:00Z');
const ev = (over: Partial<DequeuedEvent>): DequeuedEvent => ({
  id: 1,
  recipient_id: 'u1',
  kind: 'new_message',
  match_id: 'm1',
  conversation_id: 'c1',
  created_at: '2026-09-14T08:59:00Z',
  attempts: 1,
  recipient_status: 'active',
  pref_enabled: true,
  tokens: [{ token: 'ExponentPushToken[aaa]', platform: 'ios' }],
  ...over,
});

// 같은 대화의 new_message 3건 → 1개 메시지, 이벤트 3개 대표
{
  const r = buildPushBatch([ev({ id: 1 }), ev({ id: 2 }), ev({ id: 3 })], NOW);
  check('같은 대화 new_message 는 1건으로 묶인다', r.messages.length === 1 && r.messages[0].eventIds.join() === '1,2,3');
  check('본문은 고정 문구 — 원문 없음', r.messages[0].message.body === PUSH_TEXT.new_message.body && !('content' in r.messages[0].message.data));
  check('data 에는 kind·id 만', Object.keys(r.messages[0].message.data).sort().join() === 'conversation_id,kind,match_id');
  const r2 = buildPushBatch([ev({ id: 1 }), ev({ id: 2, conversation_id: 'c2' })], NOW);
  check('다른 대화는 따로', r2.messages.length === 2);
}
// 토큰 2개 → 메시지 2개, 같은 이벤트 대표
{
  const r = buildPushBatch([ev({ tokens: [{ token: 'ExponentPushToken[a]', platform: 'ios' }, { token: 'ExponentPushToken[b]', platform: 'android' }] })], NOW);
  check('기기 2대 → 메시지 2개', r.messages.length === 2 && r.messages.every((m) => m.eventIds.join() === '1'));
}
// skip 사유
{
  const r = buildPushBatch(
    [
      ev({ id: 1, tokens: [] }),
      ev({ id: 2, pref_enabled: false }),
      ev({ id: 3, recipient_status: 'suspended' }),
      ev({ id: 4, kind: 'weird' }),
      ev({ id: 5, created_at: new Date(NOW.getTime() - MAX_EVENT_AGE_MS - 1000).toISOString() }),
    ],
    NOW,
  );
  const reasons = Object.fromEntries(r.skipped.map((s) => [s.reason, s.ids]));
  check('토큰 없음 → no_token', reasons.no_token?.join() === '1');
  check('설정 off → pref_off', reasons.pref_off?.join() === '2');
  check('수신자 비활성 → recipient_inactive', reasons.recipient_inactive?.join() === '3');
  check('알 수 없는 kind / 오래된 이벤트 → 발송 없이 닫힘', reasons.unknown_kind?.join() === '4,5');
  check('skip 만 있으면 메시지 없음', r.messages.length === 0);
}
// 종류별 문구·data
{
  const r = buildPushBatch([ev({ id: 1, kind: 'mutual_meetup_interest', conversation_id: null }), ev({ id: 2, kind: 'daily_recommendation', match_id: null, conversation_id: null }), ev({ id: 3, kind: 'match_created', conversation_id: null })], NOW);
  check('종류별 3건 (묶이지 않음)', r.messages.length === 3);
  const mutual = r.messages.find((m) => m.message.data.kind === 'mutual_meetup_interest')!;
  check('상호 만남 문구는 상대·의향을 드러내지 않는다', !mutual.message.body.includes('만나보고 싶어') && !('conversation_id' in mutual.message.data) && mutual.message.data.match_id === 'm1');
  const daily = r.messages.find((m) => m.message.data.kind === 'daily_recommendation')!;
  check('오늘의 소개 data 에 id 없음', Object.keys(daily.message.data).join() === 'kind');
}
// 티켓 처리
{
  const batch = buildPushBatch([ev({ id: 1, tokens: [{ token: 'ExponentPushToken[a]', platform: 'ios' }, { token: 'ExponentPushToken[b]', platform: 'ios' }] }), ev({ id: 2, conversation_id: 'c2' })], NOW).messages;
  const out = applyTickets(batch, [
    { status: 'error', details: { error: 'DeviceNotRegistered' } },
    { status: 'ok', id: 't1' },
    { status: 'error', message: 'rate', details: { error: 'MessageRateExceeded' } },
  ]);
  check('죽은 토큰은 비활성화 대상', out.deadTokens.join() === 'ExponentPushToken[a]');
  check('다른 토큰으로 성공한 이벤트는 delivered', out.deliveredEventIds.join() === '1');
  check('그 외 오류는 재시도(failed)', out.failedEventIds.join() === '2' && out.errors.join() === 'MessageRateExceeded');
  const out2 = applyTickets(batch.slice(0, 1), [{ status: 'error', details: { error: 'DeviceNotRegistered' } }]);
  check('토큰이 모두 죽으면 이벤트는 닫힌다 (재시도 무의미)', out2.deliveredEventIds.join() === '1' && out2.failedEventIds.length === 0);
  const out3 = applyTickets(batch, [{ status: 'ok' }]);
  check('티켓 부족 → 나머지 failed', out3.failedEventIds.join() === '2' && out3.errors.includes('missing_ticket'));
}
check('chunk', chunk([1, 2, 3, 4, 5], 2).map((c) => c.length).join() === '2,2,1' && chunk([], 3).length === 0);

// #26 대기 → 입장 알림: 고정 문구, data 는 kind 만 (cohort·개인정보 없음)
{
  const ev: DequeuedEvent = { id: 9, recipient_id: 'u9', kind: 'beta_admitted', match_id: null, conversation_id: null, created_at: new Date().toISOString(), attempts: 1, recipient_status: 'active', pref_enabled: true, tokens: [{ token: 'ExponentPushToken[beta]', platform: 'android' }] };
  const r = buildPushBatch([ev], new Date());
  check('beta_admitted 발송 · 고정 문구', r.messages.length === 1 && r.messages[0].message.body === PUSH_TEXT.beta_admitted.body && Object.keys(r.messages[0].message.data).join() === 'kind');
}

console.log(`push selftest: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
