/**
 * 본인 인증 Edge Function.
 * users.identity_verified / age_verified 는 클라이언트가 직접 수정할 수 없으므로
 * (DB 트리거로 보호) 반드시 이 함수를 통해 갱신된다.
 *
 * POST { action: 'request', name, birthDate, phone, carrier }
 *   → { requestId }
 * POST { action: 'confirm', requestId, code, name, birthDate, phone, carrier }
 *   → { verified, ageVerified }
 */
import { corsHeaders, json, requireUser, serviceClient } from '../_shared/http.ts';
import { getIdentityProvider } from '../_shared/identity/IdentityVerificationProvider.ts';

function fullYearsSince(birthDate: string): number {
  const birth = new Date(birthDate);
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const beforeBirthday =
    now.getMonth() < birth.getMonth() ||
    (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate());
  if (beforeBirthday) age -= 1;
  return age;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const body = await req.json().catch(() => null);
  if (!body) return json({ error: 'invalid_body' }, 400);

  const provider = getIdentityProvider();
  const input = {
    name: String(body.name ?? ''),
    birthDate: String(body.birthDate ?? ''),
    phone: String(body.phone ?? ''),
    carrier: String(body.carrier ?? ''),
  };

  if (body.action === 'request') {
    if (!input.name || !/^\d{4}-\d{2}-\d{2}$/.test(input.birthDate) || !input.phone) {
      return json({ error: 'invalid_input' }, 400);
    }
    const result = await provider.request(input);
    return json(result);
  }

  if (body.action === 'confirm') {
    const result = await provider.confirm(String(body.requestId ?? ''), String(body.code ?? ''), input);
    if (!result.verified) return json({ verified: false, reason: result.reason });

    const age = fullYearsSince(result.birthDate);
    if (age < 19) {
      return json({ verified: false, reason: 'underage' });
    }

    const db = serviceClient();
    const { error: userErr } = await db
      .from('users')
      .update({ identity_verified: true, age_verified: true })
      .eq('id', auth.userId);
    if (userErr) return json({ error: 'update_failed' }, 500);

    const { error: privErr } = await db.from('private_profiles').upsert({
      user_id: auth.userId,
      birth_date: result.birthDate,
      phone: result.phone,
    });
    if (privErr) return json({ error: 'update_failed' }, 500);

    return json({ verified: true, ageVerified: true });
  }

  return json({ error: 'unknown_action' }, 400);
});
