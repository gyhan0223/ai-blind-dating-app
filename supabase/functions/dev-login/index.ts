/**
 * 개발용 로그인 Edge Function — SMS 사업자/Test OTP 설정 없이 인증 플로우를 테스트한다.
 *
 * 입력한 전화번호가 붙은 개발 계정(dev-<번호>@bonsim.dev)을 만들어 주고,
 * 클라이언트는 반환된 이메일+비밀번호로 로그인한다. 세션에 전화번호가 연결되므로
 * 이후 본인확인(identity fixture) · 온보딩 플로우는 실제 Phone Auth 와 동일하게 동작한다.
 *
 * 안전 장치:
 *  - 기본적으로 테스트 대역(010-0000-XXXX)만 허용.
 *    다른 번호까지 허용하려면: supabase secrets set ALLOW_DEV_LOGIN=1
 *  - production 배포 전 이 함수는 반드시 삭제하거나 ALLOW_DEV_LOGIN 해제 +
 *    DISABLE_DEV_LOGIN=1 로 완전히 끈다 (README 체크리스트 참고).
 */
import { corsHeaders, json, serviceClient } from '../_shared/http.ts';
import { e164ToLocalKR, normalizePhoneKR } from '../_shared/identity/identityCore.ts';

const DEV_PASSWORD = 'bonsim-dev-password'; // 시드 계정과 동일한 개발용 비밀번호

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  if (Deno.env.get('DISABLE_DEV_LOGIN') === '1') {
    return json({ error: 'disabled' }, 403);
  }

  const body = await req.json().catch(() => null);
  const phone = normalizePhoneKR(String(body?.phone ?? ''));
  if (!phone) return json({ error: 'invalid_phone' }, 400);

  const local = e164ToLocalKR(phone);
  const allowAny = Deno.env.get('ALLOW_DEV_LOGIN') === '1';
  if (!/^0100000\d{4}$/.test(local) && !allowAny) {
    return json(
      {
        error: 'dev_range_only',
        message:
          '테스트 로그인은 010-0000-XXXX 대역만 허용돼요. 다른 번호를 쓰려면 supabase secrets set ALLOW_DEV_LOGIN=1',
      },
      403,
    );
  }

  const email = `dev-${local}@bonsim.dev`;
  const db = serviceClient();

  // 이미 있으면 그대로 로그인, 없으면 전화번호가 확인된 상태로 생성.
  // 전화번호가 다른 계정에 이미 붙어 있으면(phone 충돌) 전화번호 없이 생성해
  // 최소한 플로우 테스트는 가능하게 한다.
  let { error } = await db.auth.admin.createUser({
    email,
    password: DEV_PASSWORD,
    email_confirm: true,
    phone: phone.replace(/^\+/, ''),
    phone_confirm: true,
  });
  if (error && !/already|registered|exists/i.test(error.message)) {
    const retry = await db.auth.admin.createUser({
      email,
      password: DEV_PASSWORD,
      email_confirm: true,
    });
    if (retry.error && !/already|registered|exists/i.test(retry.error.message)) {
      return json({ error: 'create_failed', message: retry.error.message }, 500);
    }
  }

  return json({ email, password: DEV_PASSWORD });
});
