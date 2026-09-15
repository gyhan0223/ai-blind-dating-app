import type { SupabaseClient } from '@supabase/supabase-js';
import { randomBytes } from 'crypto';

/** 폐쇄 베타 운영 (#26) — 서버 전용. 입장·게이트 변경은 RPC 로만 (감사 기록) */

export type CohortStats = {
  cohort_id: string;
  slug: string;
  name: string;
  signups_open: boolean;
  capacity: number | null;
  region_codes: string[];
  age_min: number | null;
  age_max: number | null;
  admitted: number;
  admitted_male: number;
  admitted_female: number;
  onboarded: number;
  got_recommendation: number;
  viewed_recommendation: number;
  liked: number;
  matched: number;
  two_way: number;
  mutual_interest: number;
  both_confirmed: number;
  active_codes: number;
  remaining_uses: number;
};

export type InviteCode = {
  code: string;
  cohort_id: string;
  max_uses: number;
  used_count: number;
  expires_at: string | null;
  active: boolean;
  created_by: string | null;
  created_at: string;
};

export type WaitlistSummary = {
  region_code: string;
  gender: string;
  age_band: number;
  waiting: number;
  admitted: number;
  oldest_waiting_at: string | null;
};

export async function loadBetaOverview(db: SupabaseClient) {
  const [{ data: gate }, { data: cohorts }, { data: codes }, { data: waitlist }] = await Promise.all([
    db.from('app_settings').select('value, updated_at, updated_by').eq('key', 'beta_gate').maybeSingle(),
    db.from('beta_cohort_stats').select('*').order('slug'),
    db.from('beta_invite_codes').select('*').order('created_at', { ascending: false }).limit(200),
    db.from('beta_waitlist_summary').select('*'),
  ]);
  const gateValue = (gate?.value ?? {}) as { enabled?: boolean };
  return {
    gateEnabled: gateValue.enabled === true,
    gateUpdatedAt: (gate?.updated_at as string | undefined) ?? null,
    gateUpdatedBy: (gate?.updated_by as string | undefined) ?? null,
    cohorts: (cohorts ?? []) as CohortStats[],
    codes: (codes ?? []) as InviteCode[],
    waitlist: (waitlist ?? []) as WaitlistSummary[],
  };
}

/** 헷갈리는 글자(0/O, 1/I) 를 뺀 대문자·숫자 코드 */
export function generateInviteCode(length = 8): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export function normalizeSlug(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return /^[a-z0-9][a-z0-9-]{1,39}$/.test(s) ? s : null;
}

export function parseRegionCodes(raw: string): string[] {
  return Array.from(new Set(raw.split(/[,\s]+/).map((r) => r.trim().toLowerCase()).filter((r) => r.length >= 2 && r.length <= 20)));
}
