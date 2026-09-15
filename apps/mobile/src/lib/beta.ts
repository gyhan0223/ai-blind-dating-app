/**
 * 폐쇄 베타 입장 (#26) — 서버 RPC 호출 모음. 판정은 전부 서버(0025)가 한다.
 *
 *  * beta_access_state(): open(게이트 꺼짐) | admitted | waitlisted | invite_required
 *  * beta_redeem_invite(code): 실패는 예외가 아니라 error 필드 (rate_limited | invalid_code | code_exhausted | cohort_closed | cohort_full)
 *  * beta_join_waitlist(region, birthYear, gender): 최소 정보만 — 프로필·본인확인·얼굴 데이터는 만들지 않는다
 */
import { supabase } from './supabase';

export type BetaAccess = 'open' | 'admitted' | 'waitlisted' | 'invite_required';

export type BetaAccessState = {
  gateEnabled: boolean;
  state: BetaAccess;
  cohort: { slug: string; name: string } | null;
  waitlistedAt: string | null;
};

export type InviteError = 'rate_limited' | 'invalid_code' | 'code_exhausted' | 'cohort_closed' | 'cohort_full';

function parseState(raw: unknown): BetaAccessState {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const st = d.state;
  const state: BetaAccess = st === 'admitted' || st === 'waitlisted' || st === 'invite_required' ? st : 'open';
  const c = d.cohort as { slug?: unknown; name?: unknown } | null | undefined;
  return {
    gateEnabled: d.gate_enabled === true,
    state,
    cohort: c && typeof c.slug === 'string' && typeof c.name === 'string' ? { slug: c.slug, name: c.name } : null,
    waitlistedAt: typeof d.waitlisted_at === 'string' ? d.waitlisted_at : null,
  };
}

/** 내 입장 상태. RPC 가 없거나(마이그레이션 전) 실패하면 open 으로 본다 — 최종 방어선은 서버(프로필 생성·온보딩 완료·Edge 거부) */
export async function fetchBetaAccessState(): Promise<BetaAccessState> {
  const { data, error } = await supabase.rpc('beta_access_state');
  if (error) return { gateEnabled: false, state: 'open', cohort: null, waitlistedAt: null };
  return parseState(data);
}

export async function redeemInvite(code: string): Promise<{ state: BetaAccessState; error: InviteError | null; retryAfterSeconds: number | null }> {
  const { data, error } = await supabase.rpc('beta_redeem_invite', { p_code: code });
  if (error) throw error;
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const err = typeof d.error === 'string' ? (d.error as InviteError) : null;
  const retry = typeof d.retry_after_seconds === 'number' ? d.retry_after_seconds : typeof d.retry_after_seconds === 'string' ? Number(d.retry_after_seconds) : null;
  return { state: parseState(data), error: err, retryAfterSeconds: retry };
}

export async function joinWaitlist(input: { regionCode: string; birthYear: number; gender: 'male' | 'female' }): Promise<BetaAccessState> {
  const { data, error } = await supabase.rpc('beta_join_waitlist', {
    p_region_code: input.regionCode,
    p_birth_year: input.birthYear,
    p_gender: input.gender,
  });
  if (error) throw error;
  return parseState(data);
}

export const INVITE_ERROR_TEXT: Record<InviteError, string> = {
  rate_limited: '시도가 너무 많아요. 잠시 후 다시 입력해 주세요.',
  invalid_code: '초대코드를 확인해 주세요. 만료되었거나 없는 코드예요.',
  code_exhausted: '이미 사용된 초대코드예요. 초대해 준 분께 새 코드를 부탁해 주세요.',
  cohort_closed: '지금은 이 모집이 닫혀 있어요. 대기 등록을 해 두면 다시 열릴 때 알려드려요.',
  cohort_full: '이 모집은 정원이 찼어요. 대기 등록을 해 두면 자리가 나면 알려드려요.',
};
