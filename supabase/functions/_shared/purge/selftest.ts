/**
 * 계정 삭제 작업(#13) · 얼굴 자산 정리(#11) selftest — Node 로 실행 (Deno 불필요, 외부 호출 없음).
 *   cd supabase/functions/_shared/purge && node --experimental-strip-types selftest.ts
 *
 * 실제 Storage/Didit/auth 는 호출하지 않는다 — adapter 를 인메모리로 흉내 내어 실패·재시도·동시성 시나리오를 재현한다.
 * 실제 Provider 삭제 검증(실 프로젝트)은 이 테스트가 대신하지 않는다 (docs/data-retention.md 7절).
 *
 * 보장 항목
 *   - Storage 권한 오류·네트워크 오류·bucket 없음을 성공으로 처리하지 않는다 (재조회 0건만 done)
 *   - Provider 실패(5xx/429/403/404/네트워크)·설정 누락 → 미완료 + 남은 세션 스냅샷 유지 → 재실행에서 이어서 삭제
 *   - 이미 없는 자산의 반복 삭제 = 멱등 성공 (storage 0건 · auth user_not_found)
 *   - 외부 삭제 성공 후 DB 실패 / DB 처리 후 auth 실패 → 실패한 단계만 다시, 완료한 단계는 건너뛴다
 *   - 동시 worker(lease) 는 busy · 완료된 작업 재요청은 done
 *   - 페이지 제한(100)을 넘는 객체·하위 폴더를 전부 지운다
 *   - 다른 사용자 경로가 섞이면 아무것도 지우지 않는다
 *   - 응답·감사 기록에 경로·세션 id·오류 원문이 없다
 *   - #11: 정리 큐 — 승인 행이 참조하는 경로는 지우지 않는다 · 실패 시 재시도 횟수 증가 · 반복 실행 안전
 */
import {
  type AccountPurgeDeps,
  type ClaimResult,
  deleteProviderSessions,
  deleteUserPaths,
  deleteUserStorage,
  type JobSnapshot,
  listAllObjects,
  pathsWithinUser,
  type ProviderSessionRef,
  type PurgeJobsDb,
  type PurgeMode,
  type PurgeProvider,
  type PurgeStage,
  type PurgeStorage,
  runAccountPurge,
  runAccountPurgeBatch,
  type StageState,
  type StorageObject,
} from './accountPurgeCore.ts';
import { type CleanupItem, type FaceCleanupQueue, runFaceAssetCleanup } from './faceAssetCleanupCore.ts';

let passed = 0;
let failed = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function ok(name: string, cond: boolean) {
  eq(name, cond, true);
}

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

// ---------------------------------------------------------------------------
// 인메모리 Storage — Supabase list(prefix, {limit, offset}) 비재귀 계약을 흉내 낸다
// ---------------------------------------------------------------------------
class MemStorage implements PurgeStorage {
  objects = new Set<string>();
  failList: string | null = null;
  failRemove: string | null = null;
  /** remove 가 "성공" 이라고 하지만 실제로는 지우지 않는 시나리오 */
  removeNoop = false;
  listCalls = 0;
  removeCalls = 0;
  removedPaths: string[] = [];

  async list(prefix: string, opts: { limit: number; offset: number }) {
    this.listCalls += 1;
    if (this.failList) return { ok: false as const, code: this.failList };
    const entries = new Map<string, StorageObject>();
    for (const p of this.objects) {
      if (!p.startsWith(`${prefix}/`)) continue;
      const rest = p.slice(prefix.length + 1);
      const slash = rest.indexOf('/');
      if (slash === -1) entries.set(rest, { name: rest, id: `id-${p}` });
      else entries.set(rest.slice(0, slash), { name: rest.slice(0, slash), id: null });
    }
    const sorted = [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true as const, objects: sorted.slice(opts.offset, opts.offset + opts.limit) };
  }
  async remove(paths: string[]) {
    this.removeCalls += 1;
    if (this.failRemove) return { ok: false as const, code: this.failRemove };
    let removed = 0;
    for (const p of paths) {
      if (this.removeNoop) continue;
      if (this.objects.delete(p)) {
        removed += 1;
        this.removedPaths.push(p);
      }
    }
    return { ok: true as const, removed };
  }
}

class FakeProvider implements PurgeProvider {
  readonly kind = 'didit';
  failWith: number | 'network' | null = null;
  deleted: string[] = [];
  async deleteSession(id: string) {
    if (this.failWith === 'network') throw new Error('socket hang up: secret-token-xyz');
    if (this.failWith !== null) return { ok: false, httpStatus: this.failWith };
    this.deleted.push(id);
    return { ok: true, httpStatus: 200 };
  }
}

// ---------------------------------------------------------------------------
// 인메모리 작업 DB — 0028 RPC 규칙을 그대로 흉내 낸다 (lease · 단계 · release 상태 계산)
// ---------------------------------------------------------------------------
type Job = {
  mode: PurgeMode;
  status: 'pending' | 'running' | 'failed' | 'done';
  stages: Record<PurgeStage, StageState>;
  errors: Record<PurgeStage, string | null>;
  sessions: ProviderSessionRef[];
  attemptCount: number;
  leaseOwner: string | null;
  leaseUntil: number;
};

class MemJobs implements PurgeJobsDb {
  jobs = new Map<string, Job>();
  users = new Map<string, { status: string; sessions: ProviderSessionRef[]; purged: boolean }>();
  events: { stage: string; outcome: string; code: string | null; detail: Record<string, unknown> }[] = [];
  failPurge: string | null = null;
  now = 1_000_000;
  private seq = 0;

  async claim(userId: string, mode: PurgeMode, _by: string, leaseSeconds: number): Promise<ClaimResult> {
    const u = this.users.get(userId);
    let j = this.jobs.get(userId);
    if (!j) {
      if (!u) return { ok: false, reason: 'not_found' };
      if (u.status !== 'deleted' && u.status !== 'banned') return { ok: false, reason: 'not_deleted' };
      j = {
        mode,
        status: 'pending',
        stages: { storage: 'pending', provider: 'pending', db: 'pending', auth: 'pending' },
        errors: { storage: null, provider: null, db: null, auth: null },
        sessions: u.sessions.map((s) => ({ ...s })),
        attemptCount: 0,
        leaseOwner: null,
        leaseUntil: 0,
      };
      this.jobs.set(userId, j);
    } else {
      if (j.status === 'done') {
        if (mode === 'hard' && j.mode === 'anonymize') {
          j.mode = 'hard';
          j.status = 'failed';
          j.stages.auth = 'pending';
        } else return { ok: false, reason: 'already_done' };
      } else if (mode === 'hard' && j.mode === 'anonymize') j.mode = 'hard';
      if (j.status === 'running' && j.leaseUntil > this.now) {
        this.events.push({ stage: 'job', outcome: 'busy', code: null, detail: {} });
        return { ok: false, reason: 'busy' };
      }
    }
    this.seq += 1;
    j.status = 'running';
    j.leaseOwner = `lease-${this.seq}`;
    j.leaseUntil = this.now + leaseSeconds * 1000;
    j.attemptCount += 1;
    this.events.push({ stage: 'job', outcome: 'claimed', code: null, detail: { attempt: j.attemptCount } });
    return {
      ok: true,
      leaseOwner: j.leaseOwner,
      mode: j.mode,
      attemptCount: j.attemptCount,
      stages: { ...j.stages },
      providerSessions: j.sessions.map((s) => ({ ...s })),
      userExists: !!u,
    };
  }

  async stage(userId: string, lease: string, stage: PurgeStage, outcome: 'done' | 'failed', code: string | null, detail: Record<string, unknown>, remaining?: ProviderSessionRef[] | null) {
    const j = this.jobs.get(userId);
    if (!j) return { ok: false, reason: 'not_found' };
    if (j.leaseOwner !== lease || j.leaseUntil < this.now) return { ok: false, reason: 'lease_lost' };
    j.stages[stage] = outcome;
    j.errors[stage] = outcome === 'done' ? null : code;
    if (stage === 'provider') j.sessions = outcome === 'done' ? [] : (remaining ?? j.sessions).map((s) => ({ ...s }));
    this.events.push({ stage, outcome, code: outcome === 'done' ? null : code, detail });
    return { ok: true };
  }

  async release(userId: string, lease: string) {
    const j = this.jobs.get(userId);
    if (!j) return { ok: false as const, reason: 'not_found' };
    if (j.leaseOwner !== lease) return { ok: false as const, reason: 'lease_lost' };
    const fin = (s: StageState) => s === 'done' || s === 'skipped';
    const complete = fin(j.stages.storage) && fin(j.stages.provider) && fin(j.stages.db) && (j.mode === 'anonymize' || fin(j.stages.auth));
    j.status = complete ? 'done' : 'failed';
    j.leaseOwner = null;
    j.leaseUntil = 0;
    this.events.push({ stage: 'job', outcome: 'released', code: null, detail: { status: j.status } });
    const snap: JobSnapshot = { status: j.status, mode: j.mode, stages: { ...j.stages }, errors: { ...j.errors }, attemptCount: j.attemptCount };
    return { ok: true as const, job: snap };
  }

  async purgeDb(userId: string) {
    if (this.failPurge) return { ok: false as const, code: this.failPurge };
    const u = this.users.get(userId);
    if (!u) return { ok: false as const, code: 'user_not_found' };
    u.purged = true;
    u.sessions = []; // face_verifications 행 삭제 — 세션 id 는 DB 에서 사라진다 (스냅샷만 남는다)
    return { ok: true as const, summary: { profiles: 1, face_verifications: 1 } };
  }

  async batchTargets(_grace: number, limit: number) {
    const targets: { userId: string; mode: PurgeMode; kind: 'new' | 'retry' }[] = [];
    for (const [id, u] of this.users) {
      if (u.status === 'deleted' && !this.jobs.has(id)) targets.push({ userId: id, mode: 'anonymize', kind: 'new' });
    }
    for (const [id, j] of this.jobs) if (j.status === 'failed') targets.push({ userId: id, mode: j.mode, kind: 'retry' });
    return { ok: true as const, targets: targets.slice(0, limit) };
  }
}

class MemAuth {
  users = new Set<string>();
  failWith: string | null = null;
  calls = 0;
  async deleteUser(userId: string) {
    this.calls += 1;
    if (this.failWith) return { ok: false as const, code: this.failWith };
    if (!this.users.has(userId)) return { ok: true as const, alreadyGone: true };
    this.users.delete(userId);
    return { ok: true as const, alreadyGone: false };
  }
}

function setup(opts: { sessions?: ProviderSessionRef[]; objects?: string[]; status?: string; provider?: FakeProvider | null } = {}) {
  const storage = new MemStorage();
  for (const o of opts.objects ?? [`${U1}/liveness/reference.jpg`]) storage.objects.add(o);
  const provider = opts.provider === undefined ? new FakeProvider() : opts.provider;
  const jobs = new MemJobs();
  jobs.users.set(U1, { status: opts.status ?? 'deleted', sessions: opts.sessions ?? [{ provider: 'didit', session_id: 'sess-secret-1', deleted: false }], purged: false });
  const auth = new MemAuth();
  auth.users.add(U1);
  const reports: string[] = [];
  const deps: AccountPurgeDeps = {
    storage,
    provider,
    jobs,
    auth,
    log: silent,
    reportFailure: async (stage, code) => {
      reports.push(`${stage}:${code}`);
    },
  };
  return { storage, provider, jobs, auth, deps, reports };
}

async function main() {
  // ── 범위 검증 ──────────────────────────────────────────────────────────
  ok('paths within user', pathsWithinUser(U1, [`${U1}/a.jpg`, `${U1}/liveness/x/ref.jpg`]));
  ok('other user path rejected', !pathsWithinUser(U1, [`${U1}/a.jpg`, `${U2}/b.jpg`]));
  ok('traversal rejected', !pathsWithinUser(U1, [`${U1}/../${U2}/b.jpg`]));
  ok('prefix-collision rejected', !pathsWithinUser(U1, [`${U1}x/b.jpg`]));

  // ── 정상 익명화 ────────────────────────────────────────────────────────
  {
    const t = setup();
    const r = await runAccountPurge({ userId: U1, mode: 'anonymize', requestedBy: 'test' }, t.deps);
    eq('anonymize ok', [r.ok, r.status, r.retryable], [true, 'done', false]);
    eq('anonymize stages', r.stages, {
      storage: { status: 'done', error: null },
      provider: { status: 'done', error: null },
      db: { status: 'done', error: null },
      auth: { status: 'pending', error: null },
    });
    eq('storage emptied', t.storage.objects.size, 0);
    eq('provider session deleted', t.provider!.deleted, ['sess-secret-1']);
    eq('auth untouched in anonymize', t.auth.calls, 0);
    eq('session snapshot cleared after provider done', t.jobs.jobs.get(U1)!.sessions, []);
    const again = await runAccountPurge({ userId: U1, mode: 'anonymize', requestedBy: 'test' }, t.deps);
    eq('re-run of done job → done without work', [again.ok, again.status, t.storage.removeCalls], [true, 'done', 1]);
  }

  // ── 완전 삭제 (hard) ───────────────────────────────────────────────────
  {
    const t = setup();
    const r = await runAccountPurge({ userId: U1, mode: 'hard', requestedBy: 'test' }, t.deps);
    eq('hard ok', [r.ok, r.status, r.stages?.auth.status], [true, 'done', 'done']);
    ok('auth deleted once', t.auth.calls === 1 && !t.auth.users.has(U1));
    // 이미 없는 auth 사용자 = 명확한 not found → 멱등 성공
    const t2 = setup();
    t2.auth.users.clear();
    const r2 = await runAccountPurge({ userId: U1, mode: 'hard', requestedBy: 'test' }, t2.deps);
    eq('auth already gone is idempotent success', [r2.ok, r2.counts?.auth_already_gone], [true, true]);
  }

  // ── 상태 검증 ──────────────────────────────────────────────────────────
  {
    const t = setup({ status: 'active' });
    const r = await runAccountPurge({ userId: U1, mode: 'anonymize', requestedBy: 'test' }, t.deps);
    eq('active user refused', [r.ok, r.status, t.storage.removeCalls], [false, 'not_deleted', 0]);
    const r2 = await runAccountPurge({ userId: U2, mode: 'anonymize', requestedBy: 'test' }, t.deps);
    eq('unknown user not_found', r2.status, 'not_found');
  }

  // ── Storage 오류는 성공이 아니다 ───────────────────────────────────────
  for (const code of ['storage_forbidden', 'storage_network', 'storage_bucket_not_found', 'storage_server_error']) {
    const t = setup();
    t.storage.failList = code;
    const r = await runAccountPurge({ userId: U1, mode: 'anonymize', requestedBy: 'test' }, t.deps);
    eq(`storage ${code} → failed stage`, [r.ok, r.status, r.retryable, r.stages?.storage], [false, 'failed', true, { status: 'failed', error: code }]);
    eq(`storage ${code} → db still done (independent)`, r.stages?.db.status, 'done');
    eq(`storage ${code} → provider still done`, r.stages?.provider.status, 'done');
    ok(`storage ${code} reported`, t.reports.includes(`storage:${code}`));
    // 재실행: storage 만 다시 — provider/db 는 건너뛴다
    t.storage.failList = null;
    const before = t.provider!.deleted.length;
    const r2 = await runAccountPurge({ userId: U1, mode: 'anonymize', requestedBy: 'test' }, t.deps);
    eq(`storage ${code} retry → done`, [r2.ok, r2.status, r2.attempt_count], [true, 'done', 2]);
    eq(`storage ${code} retry skips provider`, t.provider!.deleted.length, before);
  }
  {
    const t = setup();
    t.storage.failRemove = 'storage_forbidden';
    const r = await runAccountPurge({ userId: U1, mode: 'anonymize', requestedBy: 'test' }, t.deps);
    eq('remove forbidden → failed', r.stages?.storage, { status: 'failed', error: 'storage_forbidden' });
    ok('objects untouched', t.storage.objects.size === 1);
  }
  {
    // remove 가 성공을 돌려주지만 객체가 남아 있으면 완료가 아니다 (재조회가 최종 판정)
    const t = setup();
    t.storage.removeNoop = true;
    const r = await runAccountPurge({ userId: U1, mode: 'anonymize', requestedBy: 'test' }, t.deps);
    eq('remove noop → storage_incomplete', r.stages?.storage, { status: 'failed', error: 'storage_incomplete' });
  }
  {
    // 이미 아무것도 없는 사용자: 멱등 성공
    const t = setup({ objects: [] });
    const r = await runAccountPurge({ userId: U1, mode: 'anonymize', requestedBy: 'test' }, t.deps);
    eq('empty storage → done with 0 removed', [r.stages?.storage.status, r.counts?.storage_removed], ['done', 0]);
  }

  // ── 페이지 제한·하위 폴더 ──────────────────────────────────────────────
  {
    const objects: string[] = [];
    for (let i = 0; i < 250; i += 1) objects.push(`${U1}/liveness/row-${String(i).padStart(3, '0')}/reference.jpg`);
    for (let i = 0; i < 130; i += 1) objects.push(`${U1}/legacy-${String(i).padStart(3, '0')}.jpg`);
    objects.push(`${U1}/liveness/reference.jpg`, `${U2}/liveness/reference.jpg`);
    const t = setup({ objects });
    const listed = await listAllObjects(t.storage, U1, 100);
    ok('lists beyond page limit incl. subfolders', listed.ok && listed.paths.length === 381);
    const r = await runAccountPurge({ userId: U1, mode: 'anonymize', requestedBy: 'test' }, t.deps);
    eq('paged storage → done', [r.ok, r.counts?.storage_removed], [true, 381]);
    eq('other user object untouched', [...t.storage.objects], [`${U2}/liveness/reference.jpg`]);
    ok('every removed path in user scope', t.storage.removedPaths.every((p) => p.startsWith(`${U1}/`)));
  }
  {
    // 나열 결과에 다른 사용자 경로가 섞이면(adapter 오류/버그) 아무것도 지우지 않는다
    const bad: PurgeStorage = {
      list: async (prefix, o) => (o.offset === 0 && prefix === U1 ? { ok: true, objects: [{ name: 'x.jpg', id: 'i' }] } : { ok: true, objects: [] }),
      remove: async () => ({ ok: true, removed: 1 }),
    };
    const r = await deleteUserPaths(bad, U1, [`${U2}/x.jpg`]);
    eq('deleteUserPaths out of scope', r, { ok: false, code: 'path_out_of_scope' });
    const r2 = await deleteUserStorage(bad, 'not-a-uuid');
    eq('invalid user id refused', r2, { ok: false, code: 'invalid_user_id', removed: 0 });
  }

  // ── Provider 실패·설정 누락 → 미완료 + 재시도 정보 유지 ───────────────
  for (const failWith of [500, 429, 403, 404, 'network'] as const) {
    const t = setup({ sessions: [{ provider: 'didit', session_id: 'sess-a', deleted: false }, { provider: 'didit', session_id: 'sess-b', deleted: false }] });
    t.provider!.failWith = failWith;
    const r = await runAccountPurge({ userId: U1, mode: 'anonymize', requestedBy: 'test' }, t.deps);
    eq(`provider ${failWith} → failed`, [r.ok, r.status, r.retryable, r.stages?.provider.status], [false, 'failed', true, 'failed']);
    ok(`provider ${failWith} → error code`, /^provider_/.test(r.stages?.provider.error ?? ''));
    eq(`provider ${failWith} → db done anyway`, r.stages?.db.status, 'done');
    eq(`provider ${failWith} → sessions retained`, t.jobs.jobs.get(U1)!.sessions.map((s) => s.deleted), [false, false]);
    eq(`provider ${failWith} → user sessions gone from db`, t.jobs.users.get(U1)!.sessions, []);
    t.provider!.failWith = null;
    const r2 = await runAccountPurge({ userId: U1, mode: 'anonymize', requestedBy: 'test' }, t.deps);
    eq(`provider ${failWith} retry → done`, [r2.ok, t.provider!.deleted], [true, ['sess-a', 'sess-b']]);
    eq(`provider ${failWith} retry → storage skipped`, t.storage.removeCalls, 1);
  }
  {
    const t = setup({ provider: null });
    const r = await runAccountPurge({ userId: U1, mode: 'anonymize', requestedBy: 'test' }, t.deps);
    eq('provider not configured → failed, not skipped', r.stages?.provider, { status: 'failed', error: 'provider_not_configured' });
    eq('provider not configured → sessions retained', t.jobs.jobs.get(U1)!.sessions.length, 1);
    eq('not configured → not done', [r.ok, r.retryable], [false, true]);
    // 이후 provider 를 설정하고 재실행하면 완료
    t.deps.provider = new FakeProvider();
    const r2 = await runAccountPurge({ userId: U1, mode: 'anonymize', requestedBy: 'test' }, t.deps);
    eq('configured later → done', [r2.ok, (t.deps.provider as FakeProvider).deleted], [true, ['sess-secret-1']]);
  }
  {
    // 부분 성공: 첫 세션 성공 뒤 두 번째 실패 → 성공한 세션은 deleted 로 표시되어 다시 호출되지 않는다
    let n = 0;
    const p: PurgeProvider = { kind: 'didit', deleteSession: async () => (n++ === 0 ? { ok: true } : { ok: false, httpStatus: 503 }) };
    const res = await deleteProviderSessions(p, [{ provider: 'didit', session_id: 'a', deleted: false }, { provider: 'didit', session_id: 'b', deleted: false }]);
    eq('partial provider success retained', res, { ok: false, code: 'provider_server_error', deleted: 1, remaining: [{ provider: 'didit', session_id: 'a', deleted: true }, { provider: 'didit', session_id: 'b', deleted: false }] });
    const res2 = await deleteProviderSessions(p, (res as { remaining: ProviderSessionRef[] }).remaining);
    eq('retry only remaining', [res2.ok, n], [false, 3]);
    const none = await deleteProviderSessions(null, []);
    eq('no sessions → done even without provider', none, { ok: true, deleted: 0 });
    const other = await deleteProviderSessions(new FakeProvider(), [{ provider: 'acme', session_id: 'x', deleted: false }]);
    eq('other provider kind → failed (not skipped)', other.ok === false && other.code, 'provider_kind_mismatch');
  }

  // ── 외부 성공 후 DB 실패 / DB 후 auth 실패 ────────────────────────────
  {
    const t = setup();
    t.jobs.failPurge = 'db_error';
    const r = await runAccountPurge({ userId: U1, mode: 'hard', requestedBy: 'test' }, t.deps);
    eq('db failed → job failed', [r.ok, r.stages?.storage.status, r.stages?.provider.status, r.stages?.db], [false, 'done', 'done', { status: 'failed', error: 'db_error' }]);
    eq('auth not attempted before db done', [r.stages?.auth.status, t.auth.calls], ['pending', 0]);
    t.jobs.failPurge = null;
    const r2 = await runAccountPurge({ userId: U1, mode: 'hard', requestedBy: 'test' }, t.deps);
    eq('retry → db + auth done, storage/provider skipped', [r2.ok, r2.stages?.db.status, r2.stages?.auth.status, t.storage.removeCalls, t.provider!.deleted.length], [true, 'done', 'done', 1, 1]);
  }
  {
    const t = setup();
    t.auth.failWith = 'auth_server_error';
    const r = await runAccountPurge({ userId: U1, mode: 'hard', requestedBy: 'test' }, t.deps);
    eq('auth failed → job failed with db done', [r.ok, r.stages?.db.status, r.stages?.auth], [false, 'done', { status: 'failed', error: 'auth_server_error' }]);
    t.auth.failWith = null;
    const r2 = await runAccountPurge({ userId: U1, mode: 'hard', requestedBy: 'test' }, t.deps);
    eq('auth retry → done, db not re-run', [r2.ok, t.jobs.events.filter((e) => e.stage === 'db').length], [true, 1]);
  }
  {
    // anonymize 완료 뒤 hard 요청 → auth 단계만 추가 실행
    const t = setup();
    await runAccountPurge({ userId: U1, mode: 'anonymize', requestedBy: 'test' }, t.deps);
    const r = await runAccountPurge({ userId: U1, mode: 'hard', requestedBy: 'admin' }, t.deps);
    eq('anonymize→hard upgrade runs auth only', [r.ok, r.mode, r.stages?.auth.status, t.storage.removeCalls, t.auth.calls], [true, 'hard', 'done', 1, 1]);
  }

  // ── 동시 worker / 중복 요청 ───────────────────────────────────────────
  {
    const t = setup();
    const slowStorage = new MemStorage();
    slowStorage.objects.add(`${U1}/liveness/reference.jpg`);
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const origList = slowStorage.list.bind(slowStorage);
    slowStorage.list = async (p, o) => {
      await gate;
      return origList(p, o);
    };
    t.deps.storage = slowStorage;
    const first = runAccountPurge({ userId: U1, mode: 'anonymize', requestedBy: 'worker-1' }, t.deps);
    await new Promise((r) => setTimeout(r, 5));
    const second = await runAccountPurge({ userId: U1, mode: 'anonymize', requestedBy: 'worker-2' }, t.deps);
    eq('second worker busy', [second.ok, second.status, second.retryable], [false, 'busy', true]);
    release();
    const r1 = await first;
    eq('first worker completes', [r1.ok, r1.attempt_count], [true, 1]);
    eq('busy recorded', t.jobs.events.some((e) => e.outcome === 'busy'), true);
  }
  {
    // lease 만료 뒤 다른 worker 가 이어받는다 (죽은 worker)
    const t = setup();
    const claim = await t.jobs.claim(U1, 'anonymize', 'dead', 60);
    ok('dead worker claimed', claim.ok);
    t.jobs.now += 61_000;
    const r = await runAccountPurge({ userId: U1, mode: 'anonymize', requestedBy: 'alive' }, t.deps);
    eq('expired lease taken over', [r.ok, r.attempt_count], [true, 2]);
    // 죽은 worker 의 늦은 기록은 거부된다
    const late = await t.jobs.stage(U1, (claim as { leaseOwner: string }).leaseOwner, 'storage', 'done', null, {});
    eq('stale lease cannot record', late, { ok: false, reason: 'lease_lost' });
  }

  // ── 배치: 신규 + 재시도 ───────────────────────────────────────────────
  {
    const t = setup();
    t.jobs.users.set(U2, { status: 'deleted', sessions: [], purged: false });
    t.provider!.failWith = 503;
    const b1 = await runAccountPurgeBatch({ graceDays: 30, limit: 100 }, t.deps);
    eq('batch processes both, U1 fails on provider', [b1.processed, b1.succeeded], [2, 1]);
    t.provider!.failWith = null;
    const b2 = await runAccountPurgeBatch({ graceDays: 30, limit: 100 }, t.deps);
    eq('batch retries failed job only', [b2.processed, b2.succeeded, b2.results[0].user_id], [1, 1, U1]);
  }

  // ── 민감정보 비노출 ────────────────────────────────────────────────────
  {
    const t = setup({ sessions: [{ provider: 'didit', session_id: 'sess-secret-1', deleted: false }] });
    t.provider!.failWith = 'network';
    t.storage.failList = 'storage_network';
    const r = await runAccountPurge({ userId: U1, mode: 'hard', requestedBy: 'test' }, t.deps);
    const text = JSON.stringify(r) + JSON.stringify(t.jobs.events) + t.reports.join(' ');
    ok('no session id in response/audit', !text.includes('sess-secret-1'));
    ok('no storage path in response/audit', !text.includes('liveness/reference'));
    ok('no raw error text in response/audit', !text.includes('secret-token-xyz') && !text.includes('socket hang up'));
  }

  // ── #11 얼굴 자산 정리 큐 ─────────────────────────────────────────────
  {
    const storage = new MemStorage();
    storage.objects.add(`${U1}/liveness/row-old/reference.jpg`);
    storage.objects.add(`${U1}/liveness/row-new/reference.jpg`);
    const provider = new FakeProvider();
    const items: CleanupItem[] = [
      { id: 'c1', userId: U1, storagePath: `${U1}/liveness/row-old/reference.jpg`, provider: 'didit', providerSessionId: 'old-sess', attemptCount: 0 },
      { id: 'c2', userId: U1, storagePath: null, provider: 'didit', providerSessionId: 'expired-sess', attemptCount: 0 },
      { id: 'c3', userId: U2, storagePath: `${U1}/liveness/row-new/reference.jpg`, provider: null, providerSessionId: null, attemptCount: 0 }, // 다른 사용자 범위 → 거부
    ];
    const outcomes: { id: string; outcome: string; code: string | null }[] = [];
    const queue: FaceCleanupQueue = {
      claim: async (limit) => ({ ok: true, items: items.slice(0, limit) }),
      finish: async (id, outcome, code) => {
        outcomes.push({ id, outcome, code });
        return { ok: true };
      },
    };
    const r = await runFaceAssetCleanup({ limit: 10 }, { storage, provider, queue, log: silent });
    eq('cleanup processed', [r.ok, r.processed, r.succeeded], [true, 3, 2]);
    eq('cleanup outcomes', outcomes, [
      { id: 'c1', outcome: 'done', code: null },
      { id: 'c2', outcome: 'done', code: null },
      { id: 'c3', outcome: 'failed', code: 'path_out_of_scope' },
    ]);
    eq('old asset removed, new asset kept', [...storage.objects], [`${U1}/liveness/row-new/reference.jpg`]);
    eq('provider sessions of old rows deleted', provider.deleted, ['old-sess', 'expired-sess']);

    // provider 미설정 → storage 는 지우되 항목은 실패로 남아 재시도된다
    const storage2 = new MemStorage();
    storage2.objects.add(`${U1}/liveness/row-old/reference.jpg`);
    const out2: { id: string; outcome: string; code: string | null }[] = [];
    const r2 = await runFaceAssetCleanup(
      { limit: 10 },
      { storage: storage2, provider: null, queue: { claim: async () => ({ ok: true, items: [items[0]] }), finish: async (id, outcome, code) => (out2.push({ id, outcome, code }), { ok: true }) }, log: silent },
    );
    eq('cleanup without provider → failed item', [r2.succeeded, out2], [0, [{ id: 'c1', outcome: 'failed', code: 'provider_not_configured' }]]);
    eq('cleanup storage still removed', storage2.objects.size, 0);
    // 반복 실행: 이미 지워진 경로는 멱등 성공
    const out3: { id: string; outcome: string; code: string | null }[] = [];
    const r3 = await runFaceAssetCleanup(
      { limit: 10 },
      { storage: storage2, provider: new FakeProvider(), queue: { claim: async () => ({ ok: true, items: [items[0]] }), finish: async (id, outcome, code) => (out3.push({ id, outcome, code }), { ok: true }) }, log: silent },
    );
    eq('cleanup retry after asset gone → done', [r3.succeeded, out3[0].outcome], [1, 'done']);
    // 큐 조회 실패 → ok:false (아무것도 지우지 않는다)
    const r4 = await runFaceAssetCleanup({ limit: 10 }, { storage: storage2, provider: null, queue: { claim: async () => ({ ok: false }), finish: async () => ({ ok: true }) }, log: silent });
    eq('queue unavailable → not ok', [r4.ok, r4.processed], [false, 0]);
  }

  console.log(`purge selftest: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
