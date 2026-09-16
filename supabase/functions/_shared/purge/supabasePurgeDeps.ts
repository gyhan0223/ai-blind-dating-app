/**
 * accountPurgeCore 의존성 — Supabase 구현 (Deno Edge Function 전용, service role).
 * 오류는 고정 코드로만 바꾼다. 원문 메시지·경로·세션 id·토큰은 응답/감사 기록/로그에 넣지 않는다.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type { FaceLivenessProvider } from '../face/FaceLivenessProvider.ts';
import { reportServerError } from '../observability/report.ts';
import {
  type ClaimResult,
  FACES_BUCKET,
  type JobSnapshot,
  type ProviderSessionRef,
  type PurgeAuth,
  type PurgeJobsDb,
  type PurgeMode,
  type PurgeProvider,
  type PurgeStage,
  type PurgeStorage,
  type StageState,
  type StorageObject,
} from './accountPurgeCore.ts';

type StorageErrLike = { message?: string; status?: number; statusCode?: string | number } | null | undefined;

/** Storage 오류 → 고정 코드. 어떤 오류도 "이미 삭제됨" 이 아니다 */
export function storageErrorCode(err: StorageErrLike): string {
  const status = Number(err?.status ?? err?.statusCode ?? NaN);
  const msg = (err?.message ?? '').toLowerCase();
  if (status === 401 || status === 403) return 'storage_forbidden';
  if (status === 404 || /bucket not found/.test(msg)) return 'storage_bucket_not_found';
  if (status === 429) return 'storage_rate_limited';
  if (status >= 500) return 'storage_server_error';
  if (/fetch|network|socket|timeout|abort/.test(msg)) return 'storage_network';
  return 'storage_error';
}

export class SupabasePurgeStorage implements PurgeStorage {
  constructor(private readonly db: SupabaseClient, private readonly bucket = FACES_BUCKET) {}

  async list(prefix: string, opts: { limit: number; offset: number }) {
    try {
      const { data, error } = await this.db.storage.from(this.bucket).list(prefix, {
        limit: opts.limit,
        offset: opts.offset,
        sortBy: { column: 'name', order: 'asc' },
      });
      if (error) return { ok: false as const, code: storageErrorCode(error as StorageErrLike) };
      const objects: StorageObject[] = (data ?? []).map((o) => ({ name: o.name, id: (o as { id?: string | null }).id ?? null }));
      return { ok: true as const, objects };
    } catch (e) {
      return { ok: false as const, code: storageErrorCode(e as StorageErrLike) };
    }
  }

  async remove(paths: string[]) {
    try {
      const { data, error } = await this.db.storage.from(this.bucket).remove(paths);
      if (error) return { ok: false as const, code: storageErrorCode(error as StorageErrLike) };
      return { ok: true as const, removed: data?.length ?? 0 };
    } catch (e) {
      return { ok: false as const, code: storageErrorCode(e as StorageErrLike) };
    }
  }
}

/** FaceLivenessProvider → PurgeProvider (세션 삭제만 노출) */
export function purgeProviderFrom(provider: FaceLivenessProvider | null): PurgeProvider | null {
  if (!provider) return null;
  return {
    kind: provider.kind,
    deleteSession: (id) => provider.deleteSession(id),
  };
}

function rec(data: unknown): Record<string, unknown> | null {
  return typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
}

function stageOf(v: unknown): StageState {
  return v === 'done' || v === 'failed' || v === 'skipped' ? v : 'pending';
}

function snapshotFromJob(j: Record<string, unknown>): JobSnapshot {
  const status = j.status === 'done' || j.status === 'failed' || j.status === 'running' ? j.status : 'pending';
  return {
    status,
    mode: j.mode === 'hard' ? 'hard' : 'anonymize',
    stages: { storage: stageOf(j.stage_storage), provider: stageOf(j.stage_provider), db: stageOf(j.stage_db), auth: stageOf(j.stage_auth) },
    errors: {
      storage: typeof j.storage_error === 'string' ? j.storage_error : null,
      provider: typeof j.provider_error === 'string' ? j.provider_error : null,
      db: typeof j.db_error === 'string' ? j.db_error : null,
      auth: typeof j.auth_error === 'string' ? j.auth_error : null,
    },
    attemptCount: Number(j.attempt_count ?? 0),
  };
}

export class SupabasePurgeJobs implements PurgeJobsDb {
  constructor(private readonly db: SupabaseClient) {}

  async claim(userId: string, mode: PurgeMode, requestedBy: string, leaseSeconds: number): Promise<ClaimResult> {
    const { data, error } = await this.db.rpc('account_purge_job_claim', {
      p_user_id: userId,
      p_mode: mode,
      p_requested_by: requestedBy,
      p_lease_seconds: leaseSeconds,
    });
    const r = error ? null : rec(data);
    if (!r) return { ok: false, reason: 'rpc_error' };
    if (r.ok !== true) {
      const reason = r.reason;
      if (reason === 'busy' || reason === 'already_done' || reason === 'not_found' || reason === 'not_deleted' || reason === 'invalid_args') {
        return { ok: false, reason, job: rec(r.job) ?? undefined };
      }
      return { ok: false, reason: 'rpc_error' };
    }
    const stages = rec(r.stages) ?? {};
    const sessions = Array.isArray(r.provider_sessions) ? (r.provider_sessions as ProviderSessionRef[]) : [];
    return {
      ok: true,
      leaseOwner: String(r.lease_owner),
      mode: r.mode === 'hard' ? 'hard' : 'anonymize',
      attemptCount: Number(r.attempt_count ?? 0),
      stages: { storage: stageOf(stages.storage), provider: stageOf(stages.provider), db: stageOf(stages.db), auth: stageOf(stages.auth) },
      providerSessions: sessions
        .filter((s) => typeof s?.session_id === 'string')
        .map((s) => ({ provider: String(s.provider ?? ''), session_id: s.session_id, deleted: s.deleted === true })),
      userExists: r.user_exists === true,
    };
  }

  async stage(
    userId: string,
    leaseOwner: string,
    stage: PurgeStage,
    outcome: 'done' | 'failed',
    errorCode: string | null,
    detail: Record<string, unknown>,
    remainingSessions?: ProviderSessionRef[] | null,
  ) {
    const { data, error } = await this.db.rpc('account_purge_job_stage', {
      p_user_id: userId,
      p_lease_owner: leaseOwner,
      p_stage: stage,
      p_outcome: outcome,
      p_error_code: errorCode,
      p_detail: detail,
      p_remaining_sessions: remainingSessions ?? null,
    });
    const r = error ? null : rec(data);
    if (!r) return { ok: false, reason: 'rpc_error' };
    return r.ok === true ? { ok: true } : { ok: false, reason: typeof r.reason === 'string' ? r.reason : 'rejected' };
  }

  async release(userId: string, leaseOwner: string) {
    const { data, error } = await this.db.rpc('account_purge_job_release', { p_user_id: userId, p_lease_owner: leaseOwner });
    const r = error ? null : rec(data);
    if (!r) return { ok: false as const, reason: 'rpc_error' };
    if (r.ok !== true) return { ok: false as const, reason: typeof r.reason === 'string' ? r.reason : 'rejected' };
    return { ok: true as const, job: snapshotFromJob(rec(r.job) ?? {}) };
  }

  async purgeDb(userId: string) {
    const { data, error } = await this.db.rpc('account_purge', { p_user_id: userId });
    if (error) {
      const code = (error as { code?: string }).code;
      // 0019: P0002 not_found · P0001 not_deleted · 42501 server only. 나머지는 db_error
      const mapped = code === 'P0002' ? 'user_not_found' : code === 'P0001' ? 'user_not_deleted' : 'db_error';
      return { ok: false as const, code: mapped };
    }
    return { ok: true as const, summary: rec(data) ?? {} };
  }

  async batchTargets(graceDays: number, limit: number) {
    const { data, error } = await this.db.rpc('account_purge_batch_targets', { p_grace: `${graceDays} days`, p_limit: limit });
    if (error || !Array.isArray(data)) return { ok: false as const };
    return {
      ok: true as const,
      targets: (data as { user_id: string; kind: string; mode: string }[]).map((t) => ({
        userId: t.user_id,
        mode: t.mode === 'hard' ? ('hard' as const) : ('anonymize' as const),
        kind: t.kind === 'retry' ? ('retry' as const) : ('new' as const),
      })),
    };
  }
}

export class SupabasePurgeAuth implements PurgeAuth {
  constructor(private readonly db: SupabaseClient) {}

  async deleteUser(userId: string) {
    try {
      const { error } = await this.db.auth.admin.deleteUser(userId);
      if (!error) return { ok: true as const, alreadyGone: false };
      const status = (error as { status?: number }).status;
      const msg = (error.message ?? '').toLowerCase();
      // 명확한 "없음" 만 이미 삭제됨으로 본다 (GoTrue admin API: 404 user_not_found)
      if (status === 404 && /user.*not.*found/.test(msg)) return { ok: true as const, alreadyGone: true };
      if (status === 401 || status === 403) return { ok: false as const, code: 'auth_forbidden' };
      if (status === 429) return { ok: false as const, code: 'auth_rate_limited' };
      if (status !== undefined && status >= 500) return { ok: false as const, code: 'auth_server_error' };
      return { ok: false as const, code: 'auth_error' };
    } catch {
      return { ok: false as const, code: 'auth_network' };
    }
  }
}

/** 실패 단계 보고 — server_errors 에 코드·단계·사용자 id 만 */
export function purgeFailureReporter(db: SupabaseClient, fn: string) {
  return async (stage: PurgeStage | 'job', code: string, userId: string) => {
    await reportServerError(db, fn, new Error(`${stage}:${code}`), { stage, code, user_id: userId });
  };
}
