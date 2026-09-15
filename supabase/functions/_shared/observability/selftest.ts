/**
 * 민감정보 마스킹 selftest (#20). 실행: node --experimental-strip-types selftest.ts
 */
import { redact, safeErrorMessage, sanitizeContext } from './redact.ts';

let passes = 0;
let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) passes += 1;
  else {
    failures += 1;
    console.error(`FAIL: ${name}`);
  }
}

check('전화번호 E.164', redact('user +821012345678 failed') === 'user [phone] failed');
check('전화번호 010', redact('번호 010-1234-5678 / 01012345678') === '번호 [phone] / [phone]');
check('이메일', redact('mail a.b+c@example.co.kr x') === 'mail [email] x');
check('JWT', redact('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghijklmnop').includes('[jwt]') && !redact('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghijklmnop').includes('eyJ'));
check('Bearer 토큰', redact('bearer sb_secret_ABCDEFG12345') === 'bearer [token]');
check('api key/secret 값', redact('DIDIT_API_KEY=abcd1234efgh secret: "s3cr3tvalue"') === 'DIDIT_API_KEY=[redacted] secret: "[redacted]"');
check('얼굴 경로', redact('upload faces/1b2c/liveness/reference.jpg ok') === 'upload faces/[path] ok');
check('identity 해시', redact('hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 dup') === 'hash [hash] dup');
check('uuid 는 유지 (opaque id)', redact('user 11111111-1111-4111-8111-111111111111') === 'user 11111111-1111-4111-8111-111111111111');
check('OTP', redact('인증번호는 123456 입니다') === '인증번호는 [otp] 입니다' && redact('otp: 4321') === 'otp: [otp]');
check('일반 숫자는 유지', redact('scanned 500 candidates, http 500') === 'scanned 500 candidates, http 500');
check('길이 제한', redact('x'.repeat(3000)).length === 2001);
check('null 안전', redact(null) === '' && redact(undefined) === '');

const ctx = sanitizeContext({
  function: 'send-push', user_id: 'u1', match_id: 'm1', content: '비밀 메시지', phone: '01011112222',
  card: { nickname: 'x' }, http_status: 500, reason: 'user +821011112222', nested: { a: 1 }, reference_path: 'faces/x',
});
check('컨텍스트 allowlist — 원문·연락처·카드·경로 키 제거', !('content' in ctx) && !('phone' in ctx) && !('card' in ctx) && !('nested' in ctx) && !('reference_path' in ctx));
check('컨텍스트 허용 키 유지 + 값 마스킹', ctx.function === 'send-push' && ctx.user_id === 'u1' && ctx.http_status === 500 && ctx.reason === 'user [phone]');

const e = safeErrorMessage(new Error('failed for +821012345678 with token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghijklmnop'));
check('Error 메시지 마스킹', e.message === 'failed for [phone] with token [jwt]' && e.name === 'Error');
check('문자열 오류·기타', safeErrorMessage('x a@b.co').message === 'x [email]' && safeErrorMessage(42).message === 'unknown_error');

console.log(`observability selftest: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
