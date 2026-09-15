/**
 * 민감정보 마스킹 selftest (#20) — 앱 규칙이 서버 규칙과 같은지, Sentry 이벤트 형태에서 원문·연락처가 제거되는지.
 *   node --experimental-strip-types scripts/redact-selftest.mjs
 */
import { redact, redactDeep } from '../src/lib/redactCore.ts';

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
}

check('전화번호', redact('call +821012345678 or 010-1234-5678') === 'call [phone] or [phone]');
check('이메일·JWT·해시·얼굴 경로', redact('a@b.co eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghijklmnop 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 faces/u/liveness/reference.jpg') === '[email] [jwt] [hash] faces/[path]');
check('OTP', redact('인증번호 123456') === '인증번호 [otp]');
check('uuid 유지', redact('11111111-1111-4111-8111-111111111111') === '11111111-1111-4111-8111-111111111111');

const event = {
  message: 'send failed for +821011112222',
  exception: { values: [{ type: 'Error', value: 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghijklmnop' }] },
  user: { id: 'u1', email: 'x@y.com', phone: '01011112222' },
  extra: { content: '메시지 원문', conversation_id: 'c1', card: { nickname: '닉' }, note: 'x' },
  breadcrumbs: [{ category: 'http', data: { url: 'https://api/x?token=abc12345' } }],
  request: { headers: { Authorization: 'Bearer abcdefgh12345678' } },
};
const out = redactDeep(event);
check('message/exception 값 마스킹', out.message === 'send failed for [phone]' && out.exception.values[0].value === 'token [jwt]');
check('user 에 email/phone 없음, id 유지', out.user.id === 'u1' && !('email' in out.user) && !('phone' in out.user));
check('extra 의 원문·카드·note 제거, id 유지', !('content' in out.extra) && !('card' in out.extra) && !('note' in out.extra) && out.extra.conversation_id === 'c1');
check('breadcrumb url 의 token 마스킹', out.breadcrumbs[0].data.url === 'https://api/x?token=[redacted]');
check('Authorization 헤더 마스킹', out.request.headers.Authorization === 'Bearer [token]');

console.log(`redact selftest: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
