/**
 * 개발용 로그인 Edge Function — SMS 사업자/Test OTP 설정 없이 인증 플로우를 테스트한다.
 *
 * 입력한 전화번호가 붙은 개발 계정(dev-<번호>@bonsim.dev)을 만들어 주고,
 * 클라이언트는 반환된 이메일+비밀번호로 로그인한다. 세션에 전화번호가 연결되므로
 * 이후 본인확인(identity fixture) · 온보딩 플로우는 실제 Phone Auth 와 동일하게 동작한다.
 *
 * 안전 장치 (Issue #3 — fail-closed allowlist):
 *  - APP_ENV=development|staging 이면서 ALLOW_DEV_LOGIN=1 인 경우에만 동작한다.
 *    · APP_ENV 가 production / 누락 / 알 수 없는 값 → ALLOW_DEV_LOGIN 값과 무관하게 무조건 403
 *    · ALLOW_DEV_LOGIN 미설정 → development 여도 403 (explicit opt-in)
 *  - production 에는 애초에 이 함수를 배포하지 않는다 (supabase/scripts/deploy-production.sh
 *    allowlist 에서 제외). 실수로 배포되어도 위 서버 가드가 403 을 반환한다.
 *  - 허용 환경에서도 기본은 테스트 대역(010-0000-XXXX)만.
 *    다른 번호까지 필요하면 DEV_LOGIN_ALLOW_ANY_PHONE=1 을 추가로 설정한다.
 *  - DISABLE_DEV_LOGIN=1 은 긴급 kill switch 로 계속 동작한다.
 */
import { devLoginAllowed } from '../_shared/env/env.ts';
import { corsHeaders, json, serviceClient } from '../_shared/http.ts';
import { e164ToLocalKR, normalizePhoneKR } from '../_shared/identity/identityCore.ts';

// 시드 계정과 동일한 개발용 기본 비밀번호 — staging 에서는 DEV_LOGIN_PASSWORD 로 교체 권장.
// production 에서는 이 함수 자체가 403 이므로 이 값이 로그인 우회에 사용될 수 없다.
const DEV_PASSWORD = Deno.env.get('DEV_LOGIN_PASSWORD') ?? 'bonsim-dev-password';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  // fail-closed: 명시적으로 허용된 환경이 아니면 어떤 입력이든 403
  if (!devLoginAllowed()) {
    return json({ error: 'disabled' }, 403);
  }

  const body = await req.json().catch(() => null);
  const phone = normalizePhoneKR(String(body?.phone ?? ''));
  if (!phone) return json({ error: 'invalid_phone' }, 400);

  const local = e164ToLocalKR(phone);
  const allowAnyPhone = Deno.env.get('DEV_LOGIN_ALLOW_ANY_PHONE') === '1';
  if (!/^0100000\d{4}$/.test(local) && !allowAnyPhone) {
    return json(
      {
        error: 'dev_range_only',
        message:
          '테스트 로그인은 010-0000-XXXX 대역만 허용돼요. 다른 번호를 쓰려면 supabase secrets set DEV_LOGIN_ALLOW_ANY_PHONE=1',
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
