import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * 추천 풀 관측 (#23) — 서버 전용. DB 함수 recommendation_pool_stats / recommendation_run_stats (0027) 를 그대로 읽는다.
 * 여기서 필터 로직을 복제하지 않는다: 값은 실제 추천 실행(recommendation_runs)과 저장된 추천 행(recommendations)에서 온다.
 * 정의·측정 한계: docs/matching-policy.md 12절.
 */

export type PoolStatRow = {
  is_total: boolean;
  gender: string | null;
  region_code: string | null;
  age_band: number | null;
  /** 추천 대상 사용자 수 — active·온보딩·본인/얼굴/성인 인증, demo 제외 (단순 가입자 수가 아니다) */
  eligible_users: number;
  /** 그중 지금 진행 중 대화가 3개 이상인 사용자 (현재 상태) */
  slots_full_now_users: number;
  /** 최근 실행에서 적격 후보 수가 측정된 사용자 (with + zero + cap) */
  measured_users: number;
  with_candidates_users: number;
  /** 최근 실행이 전체 탐색을 끝냈지만 적격 후보 0명 */
  zero_candidates_users: number;
  /** 최근 실행이 탐색 상한에 걸려 전체 규모를 알 수 없음 */
  cap_reached_users: number;
  /** 최근 실행이 진행 중 대화 3개로 중단 */
  latest_slots_full_users: number;
  /** 최근 실행이 조회·처리 오류 (0명으로 세지 않는다) */
  latest_failed_users: number;
  /** 기간 안 끝난 실행 없음 · 0027 이전 기록 · 훑지 않은 실행 */
  unmeasured_users: number;
  /** with/zero 사용자의 사용자별 관측치 — 후보가 겹치므로 합계는 내지 않는다 */
  eligible_median: number | null;
  eligible_min: number | null;
  eligible_max: number | null;
  demo_eligible_accounts: number;
  window_days: number;
  measured_at: string;
};

export type RunStatRow = {
  is_total: boolean;
  gender: string | null;
  region_code: string | null;
  age_band: number | null;
  runs: number;
  runs_ok: number;
  runs_exhausted_complete: number;
  runs_exhausted_cap: number;
  runs_slots_full: number;
  runs_failed: number;
  runs_other: number;
  recommendations_created: number;
  strategy_high_confidence: number;
  strategy_exploration: number;
  strategy_fallback: number;
  basis_scored: number;
  basis_conditions_only: number;
  basis_unmeasured: number;
  window_from: string;
  window_to: string;
};

export const DEFAULT_WINDOW_DAYS = 7;
export const WINDOW_OPTIONS = [1, 7, 14, 30] as const;

/** ?days= 파라미터 → 1~90 정수, 아니면 기본 7 */
export function parseWindowDays(raw: string | string[] | undefined): number {
  const v = Array.isArray(raw) ? raw[0] : raw;
  const n = Number.parseInt(v ?? '', 10);
  if (!Number.isFinite(n) || n < 1 || n > 90) return DEFAULT_WINDOW_DAYS;
  return n;
}

export type PoolOverview = {
  windowDays: number;
  pool: PoolStatRow[];
  runs: RunStatRow[];
  /** 조회 오류 — 화면은 이를 "데이터 없음" 으로 숨기지 않는다 */
  errors: string[];
};

export async function loadRecommendationPool(db: SupabaseClient, windowDays: number): Promise<PoolOverview> {
  const [pool, runs] = await Promise.all([
    db.rpc('recommendation_pool_stats', { p_window_days: windowDays }),
    db.rpc('recommendation_run_stats', { p_window_days: windowDays }),
  ]);
  const errors: string[] = [];
  if (pool.error) errors.push(`recommendation_pool_stats: ${pool.error.message}`);
  if (runs.error) errors.push(`recommendation_run_stats: ${runs.error.message}`);
  return {
    windowDays,
    pool: (pool.data ?? []) as PoolStatRow[],
    runs: (runs.data ?? []) as RunStatRow[],
    errors,
  };
}

export function genderLabel(g: string | null): string {
  if (g === 'male') return '남';
  if (g === 'female') return '여';
  return g ?? '전체';
}

export function ageBandLabel(b: number | null): string {
  return b == null ? '전체' : `${b}~${b + 4}`;
}

/** 기간 안 실행 분류를 "사용자 수" 단위로 설명하는 열 정의 (분모: 추천 대상 사용자) */
export const POOL_COLS: { key: keyof PoolStatRow; label: string; hint: string }[] = [
  { key: 'eligible_users', label: '추천 대상', hint: 'active·온보딩·본인/얼굴/성인 인증, demo 제외' },
  { key: 'slots_full_now_users', label: '지금 대화 3개', hint: '현재 진행 중 매치 ≥ 3 (소개 중단 상태)' },
  { key: 'with_candidates_users', label: '후보 ≥1', hint: '최근 실행이 전체 탐색을 끝냈고 적격 후보가 1명 이상' },
  { key: 'zero_candidates_users', label: '후보 0', hint: '최근 실행이 전체 탐색을 끝냈지만 적격 후보 0명' },
  { key: 'cap_reached_users', label: '상한 도달', hint: '최근 실행이 탐색 상한(500명)에 걸림 — 전체 규모 미상' },
  { key: 'latest_slots_full_users', label: '최근 실행: 자리 부족', hint: '최근 실행이 대화 3개로 소개 중단' },
  { key: 'latest_failed_users', label: '최근 실행: 오류', hint: '조회·처리 오류 — 0명으로 세지 않는다' },
  { key: 'unmeasured_users', label: '미측정', hint: '기간 안 끝난 실행 없음 · 0027 이전 기록 · 훑지 않은 실행' },
];
