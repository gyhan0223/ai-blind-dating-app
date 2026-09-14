/**
 * 채팅 순수 로직 selftest (#41) — Node 로 실행 (Expo/RN 불필요).
 *   node --experimental-strip-types scripts/chat-core-selftest.mjs
 *
 * 보장:
 *   - 초기 조회 + Realtime 이벤트 중복 → 화면에 1개
 *   - 낙관적(전송 중) 메시지는 같은 client_message_id 의 서버 행이 오면 교체된다 (재시도 결과 병합)
 *   - created_at 동률은 id 로 보조 정렬, cursor 필터는 서버 인덱스 규칙과 같다
 *   - 과거 lead/question 캐시는 무효, v2 캐시만 사용
 *   - 오류 분류 · 클라이언트 식별자 형식 · 만남 상태 의미
 */
import {
  beforeCursorFilter,
  canReportOutcome,
  classifySendError,
  compareMessages,
  isBothConfirmed,
  isMutualNow,
  makeLocalMessage,
  mergeMessages,
  newClientMessageId,
  newestServerTimestamp,
  oldestCursor,
  parseStarterCache,
  removeLocal,
  resyncSince,
  setLocalStatus,
} from '../src/lib/chatCore.ts';

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
}

const conv = 'c1';
const me = 'u-me';
const them = 'u-them';
const row = (id, created_at, sender = them, extra = {}) => ({
  id,
  conversation_id: conv,
  sender_id: sender,
  content: `msg ${id}`,
  created_at,
  read_at: null,
  client_message_id: null,
  ...extra,
});

// 초기 조회 + Realtime 중복
{
  const initial = [row('m1', '2026-09-14T00:00:01Z'), row('m2', '2026-09-14T00:00:02Z')];
  const merged = mergeMessages(mergeMessages([], initial), [row('m2', '2026-09-14T00:00:02Z'), row('m3', '2026-09-14T00:00:03Z')]);
  check('중복 id 는 1개', merged.length === 3 && merged.map((m) => m.id).join() === 'm1,m2,m3');
  const updated = mergeMessages(merged, [row('m2', '2026-09-14T00:00:02Z', them, { read_at: '2026-09-14T00:00:09Z' })]);
  check('같은 id 는 새 행으로 갱신(read_at)', updated.find((m) => m.id === 'm2').read_at === '2026-09-14T00:00:09Z' && updated.length === 3);
}

// 낙관적 메시지 → 서버 행으로 교체 (전송 완료 / Realtime 이 먼저 와도)
{
  const cid = '11111111-1111-4111-8111-111111111111';
  const local = makeLocalMessage({ conversationId: conv, senderId: me, clientMessageId: cid, content: '안녕', now: new Date('2026-09-14T00:00:05Z') });
  let list = mergeMessages([row('m1', '2026-09-14T00:00:01Z')], [local]);
  check('전송 중 행은 맨 뒤·id 는 local:', list[1].id === `local:${cid}` && list[1].status === 'sending');
  const server = row('m9', '2026-09-14T00:00:00Z', me, { client_message_id: cid, content: '안녕' });
  list = mergeMessages(list, [server]);
  check('서버 행이 오면 낙관적 행 제거·1개만', list.length === 2 && list.every((m) => m.status == null) && list.some((m) => m.id === 'm9'));
  check('서버 created_at 기준으로 재정렬', list[0].id === 'm9');
  // Realtime 이 먼저, RPC 응답이 나중 → 여전히 1개
  list = mergeMessages(list, [server]);
  check('RPC 응답 재병합에도 1개', list.filter((m) => m.id === 'm9').length === 1);
  // 서버 행이 있으면 낙관적 행을 다시 넣어도 무시
  list = mergeMessages(list, [local]);
  check('저장된 뒤 낙관적 행 재삽입 무시', list.length === 2 && !list.some((m) => m.status));
}

// 실패 상태·재시도·삭제
{
  const cid = '22222222-2222-4222-8222-222222222222';
  let list = mergeMessages([], [makeLocalMessage({ conversationId: conv, senderId: me, clientMessageId: cid, content: '실패할 메시지' })]);
  list = setLocalStatus(list, cid, 'failed', 'network');
  check('실패 상태 + 사유', list[0].status === 'failed' && list[0].failure === 'network' && list[0].content === '실패할 메시지');
  list = setLocalStatus(list, cid, 'sending');
  check('재시도 시 sending', list[0].status === 'sending' && list[0].failure == null);
  check('삭제', removeLocal(list, cid).length === 0);
  check('없는 id 삭제는 무해', removeLocal(list, 'nope').length === 1);
}

// 정렬·cursor
{
  const t = '2026-09-14T00:00:10Z';
  const list = mergeMessages([], [row('b', t), row('a', t), row('c', '2026-09-14T00:00:09Z')]);
  check('created_at 오름차순, 동률은 id 오름차순', list.map((m) => m.id).join() === 'c,a,b');
  const cur = oldestCursor(list);
  check('oldest cursor', cur.id === 'c' && cur.createdAt === '2026-09-14T00:00:09Z');
  check('newest 서버 시각', newestServerTimestamp(list) === t);
  check('cursor 필터 문자열', beforeCursorFilter({ createdAt: t, id: 'a' }) === `created_at.lt.${t},and(created_at.eq.${t},id.lt.a)`);
  const withLocal = mergeMessages(list, [makeLocalMessage({ conversationId: conv, senderId: me, clientMessageId: '33333333-3333-4333-8333-333333333333', content: 'x', now: new Date('2020-01-01T00:00:00Z') })]);
  check('낙관적 행은 created_at 이 과거여도 맨 뒤', withLocal[withLocal.length - 1].status === 'sending');
  check('cursor/newest 는 서버 행만 본다', oldestCursor(withLocal).id === 'c' && newestServerTimestamp(withLocal) === t);
  check('서버 행 없으면 cursor null', oldestCursor([withLocal[withLocal.length - 1]]) === null && newestServerTimestamp([]) === null);
  check('compareMessages 동일 행 0', compareMessages(list[0], list[0]) === 0);
}

// 재동기화 시작점
{
  check('resync 여유 60초', resyncSince('2026-09-14T00:10:00.000Z') === '2026-09-14T00:09:00.000Z');
  check('resync 없음', resyncSince(null) === null && resyncSince('bad') === null);
}

// 식별자·오류 분류
{
  const a = newClientMessageId();
  const b = newClientMessageId();
  check('client id 는 uuid 형식·매번 다름', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(a) && a !== b);
  const savedCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  const c = newClientMessageId();
  Object.defineProperty(globalThis, 'crypto', { value: savedCrypto, configurable: true });
  check('crypto 없는 런타임에서도 uuid v4 형식', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(c));
  check('오류 분류: 본문 불일치', classifySendError('message_content_mismatch') === 'mismatch');
  check('오류 분류: 차단/권한', classifySendError('new row violates row-level security policy for table "messages"') === 'blocked' && classifySendError('42501') === 'blocked');
  check('오류 분류: 그 외는 network(재시도 가능)', classifySendError('fetch failed') === 'network' && classifySendError(undefined) === 'network');
}

// 시작 질문 캐시
{
  check('과거 lead/question 캐시는 무효', parseStarterCache({ lead: '두 분 모두 경험에 투자하는 편이에요', question: '?' }) === null);
  const v2 = { version: 2, generated_at: 'x', questions: [{ id: 'general:1', text: '요즘 쉬는 날에는 어떻게 보내세요?', basis: 'general' }] };
  check('v2 캐시 사용', parseStarterCache(v2)?.questions[0].basis === 'general');
  check('깨진 v2 는 무효', parseStarterCache({ version: 2, questions: [{ id: 1 }] }) === null && parseStarterCache({ version: 2, questions: [] }) === null);
}

// 만남 상태 의미
{
  check('mutual now', isMutualNow('mutual_interest') && isMutualNow('scheduled') && !isMutualNow('interest_withdrawn') && !isMutualNow('none'));
  check('legacy completed 는 양측 확인이 아니다', !isBothConfirmed('completed') && isBothConfirmed('met_confirmed'));
  check('결과 기록 가능: 상호 관심 이력이 있으면 철회 후에도', canReportOutcome('interest_withdrawn', '2026-09-14T00:00:00Z') && canReportOutcome('completed', null) && !canReportOutcome('none', null) && !canReportOutcome('interest_withdrawn', null));
}

console.log(`chat core selftest: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
