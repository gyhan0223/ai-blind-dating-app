import { createClient } from '@supabase/supabase-js';

/**
 * service role 클라이언트 — 서버 컴포넌트/액션에서만 사용한다.
 * 이 키는 절대 브라우저로 내려가지 않는다.
 */
export function adminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.');
  }
  return createClient(url, key, { auth: { persistSession: false } });
}
