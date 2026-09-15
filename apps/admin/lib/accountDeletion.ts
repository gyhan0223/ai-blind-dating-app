import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * 계정 삭제 요청(#14)·익명화/완전 삭제(#13) — 서버 컴포넌트/서버 액션 전용.
 * 실제 삭제는 DB 를 직접 만지지 않고 Edge Function `account-purge` 를 service role key 로 호출한다
 * (얼굴 storage·Didit 세션 삭제 → account_purge RPC → (hard) auth 계정 삭제 순서를 그 함수가 보장).
 */

export type DeletionRequestRow = {
  id: string;
  contact: string;
  note: string | null;
  status: 'pending' | 'done' | 'rejected';
  admin_note: string | null;
  user_id: string | null;
  created_at: string;
  handled_at: string | null;
};

/** 공개 페이지 입력 정리 — 전화번호는 숫자만 남기고 E.164 로, 이메일은 소문자 */
export function normalizeContact(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (v.includes('@')) {
    const email = v.toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 120 ? email : null;
  }
  const digits = v.replace(/[^0-9]/g, '');
  if (digits.startsWith('82') && digits.length >= 11) return `+${digits}`;
  if (digits.startsWith('010') && digits.length === 11) return `+82${digits.slice(1)}`;
  return null;
}

/** 요청 연락처로 사용자 찾기 (전화 E.164 또는 이메일). 여러 명이면 null — 운영자가 수동 확인 */
export async function findUserByContact(db: SupabaseClient, contact: string): Promise<string | null> {
  const column = contact.includes('@') ? 'email' : 'phone';
  const { data } = await db.from('users').select('id').eq(column, contact).limit(2);
  if (!data || data.length !== 1) return null;
  return data[0].id as string;
}

export type PurgeResult = { ok: true; hardDeleted: boolean } | { ok: false; error: string };

/** Edge Function account-purge 호출 — hard=true 면 auth 계정까지 삭제 */
export async function callAccountPurge(userId: string, hard: boolean): Promise<PurgeResult> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { ok: false, error: 'misconfigured' };
  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/+$/, '')}/functions/v1/account-purge`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, hard }),
      cache: 'no-store',
    });
  } catch {
    return { ok: false, error: 'network' };
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (res.ok && body.ok === true) return { ok: true, hardDeleted: body.hard_deleted === true };
  return { ok: false, error: typeof body.error === 'string' ? body.error : `http_${res.status}` };
}
