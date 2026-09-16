import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * 계정 삭제 요청(#14)·익명화/완전 삭제(#13) — 서버 컴포넌트/서버 액션 전용.
 * 실제 삭제는 DB 를 직접 만지지 않고 Edge Function `account-purge` 를 service role key 로 호출한다.
 * 그 함수는 단계(storage → provider → db → auth)별 상태를 account_purge_jobs 에 남기고, 실패한 단계는 재호출 때 이어서 처리한다 (0028).
 * 외부 삭제(Storage·Didit)가 실패하면 "완료" 가 아니라 실패 단계·재시도 가능 여부를 돌려준다.
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

export type PurgeStage = 'storage' | 'provider' | 'db' | 'auth';
export type PurgeStageView = { status: 'pending' | 'done' | 'failed' | 'skipped'; error: string | null };

export type PurgeResult =
  | { ok: true; status: 'done'; hardDeleted: boolean; stages?: Record<PurgeStage, PurgeStageView> }
  | { ok: false; status: 'failed' | 'busy' | 'not_found' | 'not_deleted' | 'error'; error: string; retryable: boolean; stages?: Record<PurgeStage, PurgeStageView>; failedStages: string[] };

function parseStages(v: unknown): Record<PurgeStage, PurgeStageView> | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, { status?: string; error?: string | null }>;
  const pick = (k: PurgeStage): PurgeStageView => ({
    status: (['pending', 'done', 'failed', 'skipped'].includes(o[k]?.status ?? '') ? o[k]!.status : 'pending') as PurgeStageView['status'],
    error: typeof o[k]?.error === 'string' ? (o[k]!.error as string) : null,
  });
  return { storage: pick('storage'), provider: pick('provider'), db: pick('db'), auth: pick('auth') };
}

/** Edge Function account-purge 호출 — hard=true 면 auth 계정까지 삭제. 실패 단계와 재시도 가능 여부를 그대로 돌려준다 */
export async function callAccountPurge(userId: string, hard: boolean, requestedBy = 'admin'): Promise<PurgeResult> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { ok: false, status: 'error', error: 'misconfigured', retryable: false, failedStages: [] };
  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/+$/, '')}/functions/v1/account-purge`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, hard, requested_by: requestedBy.slice(0, 64) }),
      cache: 'no-store',
    });
  } catch {
    return { ok: false, status: 'error', error: 'network', retryable: true, failedStages: [] };
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const stages = parseStages(body.stages);
  if (res.ok && body.ok === true) {
    return { ok: true, status: 'done', hardDeleted: hard && stages?.auth.status === 'done', stages };
  }
  const status = (['failed', 'busy', 'not_found', 'not_deleted', 'error'] as const).find((s) => s === body.status) ?? 'error';
  const failedStages = stages
    ? (Object.keys(stages) as PurgeStage[]).filter((k) => stages[k].status === 'failed').map((k) => `${k}:${stages[k].error ?? 'failed'}`)
    : [];
  const error = typeof body.error === 'string' ? body.error : failedStages.length > 0 ? failedStages.join(', ') : status === 'error' ? `http_${res.status}` : status;
  return { ok: false, status, error, retryable: body.retryable === true, stages, failedStages };
}

export type PurgeJobSummary = {
  user_id: string;
  mode: 'anonymize' | 'hard';
  status: 'pending' | 'running' | 'failed' | 'done';
  stage_storage: PurgeStageView['status'];
  stage_provider: PurgeStageView['status'];
  stage_db: PurgeStageView['status'];
  stage_auth: PurgeStageView['status'];
  storage_error: string | null;
  provider_error: string | null;
  db_error: string | null;
  auth_error: string | null;
  attempt_count: number;
  updated_at: string;
  running: boolean;
};

/** 사용자 목록에 실릴 삭제 작업 요약 (service role RPC) */
export async function loadPurgeJobSummaries(db: SupabaseClient, userIds: string[]): Promise<Map<string, PurgeJobSummary>> {
  if (userIds.length === 0) return new Map();
  const { data } = await db.rpc('account_purge_job_summary', { p_user_ids: userIds });
  return new Map(((data ?? []) as PurgeJobSummary[]).map((j) => [j.user_id, j]));
}

/** 실패한 삭제 작업 목록 (재시도 화면용) */
export async function loadFailedPurgeJobs(db: SupabaseClient): Promise<PurgeJobSummary[]> {
  const { data } = await db
    .from('account_purge_jobs')
    .select('user_id, mode, status, stage_storage, stage_provider, stage_db, stage_auth, storage_error, provider_error, db_error, auth_error, attempt_count, updated_at, lease_until')
    .in('status', ['failed', 'running'])
    .order('updated_at', { ascending: false })
    .limit(100);
  const now = Date.now();
  return ((data ?? []) as (Omit<PurgeJobSummary, 'running'> & { lease_until: string | null })[]).map((j) => ({
    ...j,
    running: j.status === 'running' && !!j.lease_until && Date.parse(j.lease_until) > now,
  }));
}

/** 운영자가 확인 후 실패 단계를 건너뛴다 (감사 기록). db 단계는 건너뛸 수 없다 */
export async function skipPurgeStage(db: SupabaseClient, userId: string, stage: 'storage' | 'provider' | 'auth', actor: string, note: string | null) {
  const { data, error } = await db.rpc('account_purge_job_skip_stage', { p_user_id: userId, p_stage: stage, p_actor: actor, p_note: note });
  if (error) return { ok: false as const, reason: 'rpc_error' };
  const r = (data ?? {}) as { ok?: boolean; reason?: string; status?: string };
  return r.ok === true ? { ok: true as const, status: r.status ?? 'unknown' } : { ok: false as const, reason: r.reason ?? 'rejected' };
}

export const PURGE_STAGE_LABEL: Record<PurgeStage, string> = {
  storage: '저장소 이미지',
  provider: 'Didit 세션',
  db: 'DB 익명화',
  auth: '로그인 계정',
};

export const PURGE_ERROR_LABEL: Record<string, string> = {
  storage_forbidden: 'Storage 권한 오류 (service role key 확인)',
  storage_bucket_not_found: 'faces 버킷 없음 — 삭제됐다고 보지 않음',
  storage_rate_limited: 'Storage 요청 제한 — 잠시 후 재시도',
  storage_server_error: 'Storage 서버 오류 — 재시도',
  storage_network: 'Storage 네트워크 오류 — 재시도',
  storage_incomplete: '삭제 후 재조회에 객체가 남아 있음 — 재시도',
  storage_too_many_objects: '객체가 비정상적으로 많음 — 운영자 확인',
  path_out_of_scope: '사용자 범위 밖 경로 감지 — 아무것도 지우지 않음 (버그/설정 확인)',
  provider_not_configured: 'FACE_VERIFICATION_PROVIDER/DIDIT_* 설정 없음 — 설정 후 재시도',
  provider_forbidden: 'Didit API 인증 실패 (DIDIT_API_KEY)',
  provider_not_found_unconfirmed: 'Didit 404 — 이미 삭제됐는지 콘솔에서 확인 후 "건너뛰기"',
  provider_rate_limited: 'Didit 요청 제한 — 잠시 후 재시도',
  provider_server_error: 'Didit 서버 오류 — 재시도',
  provider_network: 'Didit 네트워크 오류/타임아웃 — 재시도',
  provider_kind_mismatch: '다른 Provider 의 세션 — 운영자 확인',
  db_error: 'account_purge RPC 오류 — 마이그레이션/DB 확인',
  user_not_found: '사용자 행 없음',
  user_not_deleted: '탈퇴 상태가 아님',
  auth_forbidden: 'auth admin 권한 오류',
  auth_rate_limited: 'auth 요청 제한 — 재시도',
  auth_server_error: 'auth 서버 오류 — 재시도',
  auth_network: 'auth 네트워크 오류 — 재시도',
  auth_error: 'auth 삭제 오류',
  busy: '다른 작업이 진행 중 — 잠시 후',
  network: 'account-purge 함수에 연결할 수 없음',
  misconfigured: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 없음',
};

export function describePurgeFailure(job: Pick<PurgeJobSummary, 'stage_storage' | 'stage_provider' | 'stage_db' | 'stage_auth' | 'storage_error' | 'provider_error' | 'db_error' | 'auth_error'>): string[] {
  const out: string[] = [];
  const stages: [PurgeStage, PurgeStageView['status'], string | null][] = [
    ['storage', job.stage_storage, job.storage_error],
    ['provider', job.stage_provider, job.provider_error],
    ['db', job.stage_db, job.db_error],
    ['auth', job.stage_auth, job.auth_error],
  ];
  for (const [stage, status, err] of stages) {
    if (status === 'failed') out.push(`${PURGE_STAGE_LABEL[stage]}: ${PURGE_ERROR_LABEL[err ?? ''] ?? err ?? '실패'}`);
  }
  return out;
}
