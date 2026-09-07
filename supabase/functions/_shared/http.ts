/**
 * Edge Function 공통 헬퍼 (Deno 런타임).
 * - CORS
 * - 호출자 JWT 검증 → userId
 * - service role 클라이언트 (RLS 우회는 서버에서만)
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
}

/** 상수 시간 문자열 비교 (secret 비교용) */
function timingSafeEqualString(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.byteLength === 0 || x.byteLength !== y.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < x.byteLength; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * 서버 전용 호출자 인증 — Authorization 헤더가 이 프로젝트의 service role key 와 정확히 같아야 한다.
 * 관리자 웹(Next.js 서버 액션)처럼 service role key 를 가진 서버만 통과한다. 사용자 JWT 는 401.
 * (service role key 는 이미 RLS 를 우회하는 최상위 secret 이므로 이 검사가 추가 권한을 만들지 않는다)
 */
export function requireServiceRole(req: Request): { ok: true } | Response {
  const expected = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!expected || !token || !timingSafeEqualString(token, expected)) {
    return json({ error: 'unauthorized' }, 401);
  }
  return { ok: true };
}

/** Authorization 헤더의 사용자 JWT 를 검증하고 userId(+토큰)를 돌려준다. */
export async function requireUser(
  req: Request,
): Promise<{ userId: string; token: string } | Response> {
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'unauthorized' }, 401);

  const anon = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { auth: { persistSession: false } },
  );
  const { data, error } = await anon.auth.getUser(token);
  if (error || !data.user) return json({ error: 'unauthorized' }, 401);
  return { userId: data.user.id, token };
}
