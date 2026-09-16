/**
 * 계정 삭제 작업 핵심 로직 (#13) — 순수 모듈 (의존성 주입, Node selftest 겸용).
 *
 * 한 사용자의 삭제는 4단계다. 각 단계는 성공(done)·실패(failed) 를 DB 작업 행(account_purge_jobs)에 남기고,
 * 실패한 단계는 다음 실행(배치·운영자 재시도)에서 이어서 처리한다. 완료한 단계는 건너뛴다.
 *
 *   storage  : private bucket faces/<uid>/ 아래 모든 객체 (하위 폴더·페이지 제한 포함) 삭제 → 재조회로 0건 확인
 *   provider : 작업 행에 스냅샷된 Provider(Didit) 세션 전부 DELETE. 설정 누락·네트워크·권한·429·5xx·404 는 전부 실패 (재시도 대상)
 *   db       : account_purge RPC (프로필·응답·추천·메시지 본문·얼굴 행·identity 익명화 — 한 트랜잭션)
 *   auth     : (hard 만) auth.admin.deleteUser. "user not found" 만 이미 삭제됨으로 인정한다
 *
 * 의존성: storage · provider · db 는 서로 독립이다 (외부 삭제가 실패해도 로컬 개인정보는 지운다).
 *         auth 는 db 가 done 이어야 시도한다. 전체 완료(done)는 필요한 모든 단계가 done/skipped 일 때만이다.
 *
 * 응답·감사 기록에는 고정 코드와 수치만 담는다. 경로·세션 id·오류 원문·개인정보는 넣지 않는다.
 */

export type PurgeMode = 'anonymize' | 'hard';
export type PurgeStage = 'storage' | 'provider' | 'db' | 'auth';
export type StageState = 'pending' | 'done' | 'failed' | 'skipped';

export type StorageObject = { name: string; /** null 이면 폴더 */ id: string | null };
export type StorageFailure = { ok: false; code: string };

export interface PurgeStorage {
  /** prefix(폴더) 바로 아래 항목을 offset 부터 limit 개 돌려준다 (Supabase storage list 와 같은 비재귀 계약) */
  list(prefix: string, opts: { limit: number; offset: number }): Promise<{ ok: true; objects: StorageObject[] } | StorageFailure>;
  /** 객체 삭제. 없는 경로가 섞여 있어도 오류가 아니다 — 최종 확인은 재조회가 한다 */
  remove(paths: string[]): Promise<{ ok: true; removed: number } | StorageFailure>;
}

export type ProviderSessionRef = { provider: string; session_id: string; deleted: boolean };

export interface PurgeProvider {
  readonly kind: string;
  deleteSession(sessionId: string): Promise<{ ok: boolean; httpStatus?: number }>;
}

export type ClaimResult =
  | {
      ok: true;
      leaseOwner: string;
      mode: PurgeMode;
      attemptCount: number;
      stages: Record<PurgeStage, StageState>;
      providerSessions: ProviderSessionRef[];
      userExists: boolean;
    }
  | { ok: false; reason: 'busy' | 'already_done' | 'not_found' | 'not_deleted' | 'invalid_args' | 'rpc_error'; job?: Record<string, unknown> };

export type JobSnapshot = {
  status: 'pending' | 'running' | 'failed' | 'done';
  mode: PurgeMode;
  stages: Record<PurgeStage, StageState>;
  errors: Record<PurgeStage, string | null>;
  attemptCount: number;
};

export interface PurgeJobsDb {
  claim(userId: string, mode: PurgeMode, requestedBy: string, leaseSeconds: number): Promise<ClaimResult>;
  stage(
    userId: string,
    leaseOwner: string,
    stage: PurgeStage,
    outcome: 'done' | 'failed',
    errorCode: string | null,
    detail: Record<string, unknown>,
    remainingSessions?: ProviderSessionRef[] | null,
  ): Promise<{ ok: boolean; reason?: string }>;
  release(userId: string, leaseOwner: string): Promise<{ ok: true; job: JobSnapshot } | { ok: false; reason: string }>;
  /** account_purge RPC — 실패 코드는 고정 문자열 (원문 메시지 금지) */
  purgeDb(userId: string): Promise<{ ok: true; summary: Record<string, unknown> } | { ok: false; code: string }>;
  batchTargets(graceDays: number, limit: number): Promise<{ ok: true; targets: { userId: string; mode: PurgeMode; kind: 'new' | 'retry' }[] } | { ok: false }>;
}

export interface PurgeAuth {
  /** ok+alreadyGone: Provider 가 명확히 "user not found" 를 돌려준 경우만 */
  deleteUser(userId: string): Promise<{ ok: true; alreadyGone: boolean } | { ok: false; code: string }>;
}

export type PurgeLogger = { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };

export type AccountPurgeDeps = {
  storage: PurgeStorage;
  /** null 이면 Provider 설정이 없는 환경 — provider 단계는 실패(provider_not_configured) 로 남는다 (건너뛰지 않는다) */
  provider: PurgeProvider | null;
  jobs: PurgeJobsDb;
  auth: PurgeAuth;
  log: PurgeLogger;
  /** 실패 단계 보고 (server_errors) — 코드·단계만 */
  reportFailure?: (stage: PurgeStage | 'job', code: string, userId: string) => Promise<void>;
  storagePageSize?: number;
  leaseSeconds?: number;
};

export const STORAGE_PAGE_SIZE = 100;
export const STORAGE_REMOVE_CHUNK = 100;
export const FACES_BUCKET = 'faces';
/** 무한 루프 방지 — 한 사용자 폴더에 이 이상은 비정상 (실패로 남겨 운영자가 확인) */
export const STORAGE_MAX_OBJECTS = 20_000;

// ---------------------------------------------------------------------------
// Storage: 사용자 prefix 전체 나열 (재귀 · 페이지) → 범위 검증 → 삭제 → 재조회 확인
// ---------------------------------------------------------------------------

export type StorageStageResult = { ok: true; removed: number; remaining: 0 } | { ok: false; code: string; removed: number };

export async function listAllObjects(
  storage: PurgeStorage,
  prefix: string,
  pageSize: number,
): Promise<{ ok: true; paths: string[] } | StorageFailure> {
  const paths: string[] = [];
  const folders: string[] = [prefix];
  while (folders.length > 0) {
    const dir = folders.pop() as string;
    let offset = 0;
    for (;;) {
      const page = await storage.list(dir, { limit: pageSize, offset });
      if (!page.ok) return page;
      for (const o of page.objects) {
        if (!o.name) continue;
        const full = `${dir}/${o.name}`;
        if (o.id === null) folders.push(full);
        else paths.push(full);
        if (paths.length > STORAGE_MAX_OBJECTS) return { ok: false, code: 'storage_too_many_objects' };
      }
      if (page.objects.length < pageSize) break;
      offset += pageSize;
    }
  }
  return { ok: true, paths };
}

/** 삭제 경로가 사용자 범위(<uid>/...)를 벗어나면 아무것도 지우지 않는다 */
export function pathsWithinUser(userId: string, paths: string[]): boolean {
  const root = `${userId}/`;
  return paths.every((p) => p.startsWith(root) && !p.includes('/../') && !p.startsWith('../'));
}

export async function deleteUserStorage(storage: PurgeStorage, userId: string, pageSize = STORAGE_PAGE_SIZE): Promise<StorageStageResult> {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return { ok: false, code: 'invalid_user_id', removed: 0 };
  const listed = await listAllObjects(storage, userId, pageSize);
  if (!listed.ok) return { ok: false, code: listed.code, removed: 0 };
  if (!pathsWithinUser(userId, listed.paths)) return { ok: false, code: 'path_out_of_scope', removed: 0 };

  let removed = 0;
  for (let i = 0; i < listed.paths.length; i += STORAGE_REMOVE_CHUNK) {
    const chunk = listed.paths.slice(i, i + STORAGE_REMOVE_CHUNK);
    const res = await storage.remove(chunk);
    if (!res.ok) return { ok: false, code: res.code, removed };
    removed += res.removed;
  }
  // 최종 확인: 재조회 결과가 0건일 때만 done (삭제 API 의 결과 수를 믿지 않는다)
  const verify = await listAllObjects(storage, userId, pageSize);
  if (!verify.ok) return { ok: false, code: verify.code, removed };
  if (verify.paths.length > 0) return { ok: false, code: 'storage_incomplete', removed };
  return { ok: true, removed, remaining: 0 };
}

/** 지정 경로만 삭제 (#11 얼굴 세션 정리가 공유). 사용자 범위 밖 경로는 거부. 재조회로 확인 */
export async function deleteUserPaths(
  storage: PurgeStorage,
  userId: string,
  paths: string[],
): Promise<{ ok: true; removed: number } | { ok: false; code: string }> {
  if (paths.length === 0) return { ok: true, removed: 0 };
  if (!pathsWithinUser(userId, paths)) return { ok: false, code: 'path_out_of_scope' };
  const res = await storage.remove(paths);
  if (!res.ok) return { ok: false, code: res.code };
  // 각 경로의 부모 폴더를 재조회해 남아 있지 않은지 확인
  const parents = new Set(paths.map((p) => p.slice(0, p.lastIndexOf('/'))));
  for (const dir of parents) {
    const listed = await listAllObjects(storage, dir, STORAGE_PAGE_SIZE);
    if (!listed.ok) return { ok: false, code: listed.code };
    if (listed.paths.some((p) => paths.includes(p))) return { ok: false, code: 'storage_incomplete' };
  }
  return { ok: true, removed: res.removed };
}

// ---------------------------------------------------------------------------
// Provider: 스냅샷 세션 전부 삭제. 명확한 성공(2xx)만 삭제됨으로 표시한다.
//   404 를 "이미 없음" 으로 볼 수 있는지는 Didit 공식 문서로 확인하지 못했다 (기존 계약 테스트: 404 = 실패). 운영자가 확인 후 건너뛴다.
// ---------------------------------------------------------------------------

export type ProviderStageResult = { ok: true; deleted: number } | { ok: false; code: string; deleted: number; remaining: ProviderSessionRef[] };

export async function deleteProviderSessions(provider: PurgeProvider | null, sessions: ProviderSessionRef[]): Promise<ProviderStageResult> {
  const pending = sessions.filter((s) => !s.deleted && s.session_id);
  if (pending.length === 0) return { ok: true, deleted: 0 };
  if (!provider) return { ok: false, code: 'provider_not_configured', deleted: 0, remaining: sessions };

  let deleted = 0;
  let lastCode = 'provider_delete_failed';
  const remaining: ProviderSessionRef[] = [];
  for (const s of sessions) {
    if (s.deleted) {
      remaining.push(s);
      continue;
    }
    if (s.provider !== provider.kind) {
      // 다른 Provider 의 세션은 이 환경에서 지울 수 없다 — 실패로 남긴다 (건너뛰지 않는다)
      lastCode = 'provider_kind_mismatch';
      remaining.push(s);
      continue;
    }
    let res: { ok: boolean; httpStatus?: number };
    try {
      res = await provider.deleteSession(s.session_id);
    } catch {
      res = { ok: false };
    }
    if (res.ok) {
      deleted += 1;
      remaining.push({ ...s, deleted: true });
    } else {
      lastCode = providerFailureCode(res.httpStatus);
      remaining.push(s);
    }
  }
  if (remaining.every((s) => s.deleted)) return { ok: true, deleted };
  return { ok: false, code: lastCode, deleted, remaining };
}

export function providerFailureCode(httpStatus: number | undefined): string {
  if (httpStatus === undefined) return 'provider_network';
  if (httpStatus === 401 || httpStatus === 403) return 'provider_forbidden';
  if (httpStatus === 404) return 'provider_not_found_unconfirmed';
  if (httpStatus === 429) return 'provider_rate_limited';
  if (httpStatus >= 500) return 'provider_server_error';
  return `provider_http_${httpStatus}`;
}

// ---------------------------------------------------------------------------
// 작업 실행
// ---------------------------------------------------------------------------

export type PurgeRunResult = {
  user_id: string;
  ok: boolean;
  status: 'done' | 'failed' | 'busy' | 'not_found' | 'not_deleted' | 'error';
  mode?: PurgeMode;
  attempt_count?: number;
  retryable: boolean;
  stages?: Record<PurgeStage, { status: StageState; error: string | null }>;
  /** 이번 실행에서 처리한 수치 (감사용) */
  counts?: { storage_removed?: number; provider_deleted?: number; auth_already_gone?: boolean };
  db_summary?: Record<string, unknown>;
};

function stagesView(job: JobSnapshot): Record<PurgeStage, { status: StageState; error: string | null }> {
  return {
    storage: { status: job.stages.storage, error: job.errors.storage },
    provider: { status: job.stages.provider, error: job.errors.provider },
    db: { status: job.stages.db, error: job.errors.db },
    auth: { status: job.stages.auth, error: job.errors.auth },
  };
}

export async function runAccountPurge(
  input: { userId: string; mode: PurgeMode; requestedBy: string },
  deps: AccountPurgeDeps,
): Promise<PurgeRunResult> {
  const { jobs, log } = deps;
  const userId = input.userId;
  const report = deps.reportFailure ?? (async () => {});

  const claim = await jobs.claim(userId, input.mode, input.requestedBy, deps.leaseSeconds ?? 300);
  if (!claim.ok) {
    switch (claim.reason) {
      case 'busy':
        return { user_id: userId, ok: false, status: 'busy', retryable: true };
      case 'already_done':
        return { user_id: userId, ok: true, status: 'done', retryable: false, mode: input.mode };
      case 'not_found':
        return { user_id: userId, ok: false, status: 'not_found', retryable: false };
      case 'not_deleted':
        return { user_id: userId, ok: false, status: 'not_deleted', retryable: false };
      default:
        await report('job', claim.reason, userId);
        return { user_id: userId, ok: false, status: 'error', retryable: true };
    }
  }

  const lease = claim.leaseOwner;
  const counts: NonNullable<PurgeRunResult['counts']> = {};
  const finished = (s: StageState) => s === 'done' || s === 'skipped';
  let leaseLost = false;

  const record = async (
    stage: PurgeStage,
    outcome: 'done' | 'failed',
    code: string | null,
    detail: Record<string, unknown>,
    remaining?: ProviderSessionRef[] | null,
  ) => {
    const r = await jobs.stage(userId, lease, stage, outcome, code, detail, remaining);
    if (!r.ok) {
      leaseLost = true;
      log.error(`[account-purge] stage ${stage} could not be recorded (${r.reason ?? 'unknown'})`);
    }
    if (outcome === 'failed') {
      log.warn(`[account-purge] stage ${stage} failed (${code})`);
      await report(stage, code ?? 'failed', userId);
    } else {
      log.info(`[account-purge] stage ${stage} done`);
    }
  };

  // 1) storage
  if (!finished(claim.stages.storage) && !leaseLost) {
    const res = await deleteUserStorage(deps.storage, userId, deps.storagePageSize ?? STORAGE_PAGE_SIZE);
    counts.storage_removed = res.removed;
    if (res.ok) await record('storage', 'done', null, { removed: res.removed });
    else await record('storage', 'failed', res.code, { removed: res.removed });
  }

  // 2) provider
  if (!finished(claim.stages.provider) && !leaseLost) {
    const res = await deleteProviderSessions(deps.provider, claim.providerSessions);
    counts.provider_deleted = res.deleted;
    if (res.ok) await record('provider', 'done', null, { deleted: res.deleted });
    else await record('provider', 'failed', res.code, { deleted: res.deleted, remaining: res.remaining.filter((s) => !s.deleted).length }, res.remaining);
  }

  // 3) db — storage/provider 결과와 무관하게 진행
  let dbSummary: Record<string, unknown> | undefined;
  if (!finished(claim.stages.db) && !leaseLost) {
    const res = await jobs.purgeDb(userId);
    if (res.ok) {
      dbSummary = res.summary;
      await record('db', 'done', null, {});
    } else {
      await record('db', 'failed', res.code, {});
    }
  }

  // 4) auth — hard 만, db done 뒤에만
  if (claim.mode === 'hard' && !finished(claim.stages.auth) && !leaseLost) {
    const dbDone = finished(claim.stages.db) || dbSummary !== undefined;
    if (dbDone) {
      const res = await deps.auth.deleteUser(userId);
      if (res.ok) {
        counts.auth_already_gone = res.alreadyGone;
        await record('auth', 'done', null, { already_gone: res.alreadyGone });
      } else {
        await record('auth', 'failed', res.code, {});
      }
    } else {
      log.warn('[account-purge] auth stage deferred until db stage is done');
    }
  }

  const released = await jobs.release(userId, lease);
  if (!released.ok) {
    await report('job', released.reason, userId);
    return { user_id: userId, ok: false, status: 'error', retryable: true, mode: claim.mode, counts };
  }
  const job = released.job;
  return {
    user_id: userId,
    ok: job.status === 'done',
    status: job.status === 'done' ? 'done' : 'failed',
    mode: job.mode,
    attempt_count: job.attemptCount,
    retryable: job.status !== 'done',
    stages: stagesView(job),
    counts,
    db_summary: dbSummary,
  };
}

export async function runAccountPurgeBatch(
  input: { graceDays: number; limit: number },
  deps: AccountPurgeDeps,
): Promise<{ ok: boolean; processed: number; succeeded: number; results: PurgeRunResult[] }> {
  const targets = await deps.jobs.batchTargets(input.graceDays, input.limit);
  if (!targets.ok) return { ok: false, processed: 0, succeeded: 0, results: [] };
  const results: PurgeRunResult[] = [];
  for (const t of targets.targets) {
    results.push(await runAccountPurge({ userId: t.userId, mode: t.mode, requestedBy: 'batch' }, deps));
  }
  return { ok: true, processed: results.length, succeeded: results.filter((r) => r.ok).length, results };
}
