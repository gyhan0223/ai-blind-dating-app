/**
 * 배치 sweep 오케스트레이션 selftest (#22). 실행: node --experimental-strip-types batchSelftest.ts
 * 시계·커서·대상 조회를 모두 주입해 실제 시간을 기다리지 않는다. 실패가 있으면 exit 1.
 *
 * 검증
 *  * 대상이 한 페이지보다 많아도 뒤쪽 사용자까지 처리되고, 각 사용자는 한 sweep 에 한 번만 처리된다
 *  * 시간 예산·최대 페이지에서 멈추면 next_after 를 남기고, 다음 호출이 저장된 커서에서 이어가 남은 사용자를 빠짐없이 처리한다
 *  * 사용자 한 명의 실패(throw)는 그 사용자만 failed 로 세고 나머지는 계속한다
 *  * KST 날짜가 호출 중 바뀌면 즉시 멈춘다 — 바뀐 뒤에는 이전 날짜로 아무도 처리하지 않는다
 *  * 다른 sweep 이 진행 중(lease)이면 아무것도 처리하지 않는다 · 명시 after 는 저장 커서보다 우선 · 결과 집계 매핑
 */
import { clampOptions, countOutcome, DEFAULT_MAX_PAGES, DEFAULT_PAGE_SIZE, DEFAULT_TIME_BUDGET_MS, HARD_MAX_TIME_BUDGET_MS, runBatchSweep, type SweepCounts, type SweepDeps } from './batchSweep.ts';
import type { ClaimedOutcome } from './runWithClaim.ts';

let passes = 0;
let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    passes += 1;
    console.log(`ok: ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL: ${name}`);
  }
}

const okOutcome = (over: Partial<Extract<ClaimedOutcome, { kind: 'ok' }>> = {}): ClaimedOutcome => ({
  kind: 'ok', recommendations: [], dailyLimit: 1, exhausted: false, scanned: 0, capReached: false, eligibleCount: null, createdIds: [], ...over,
});

/** 인메모리 환경: 사용자 목록·"오늘 끝난" 집합·커서 행·제어 가능한 시계 */
function env(userIds: string[], opts: { perUserMs?: number; startAt?: string; failing?: Set<string>; outcomes?: Record<string, ClaimedOutcome> } = {}) {
  let clock = Date.parse(opts.startAt ?? '2026-09-18T01:00:00Z'); // KST 10:00
  const done = new Set<string>();
  const processed: string[] = [];
  const cursor: { forDate: string | null; after: string | null; leased: boolean; saves: { after: string | null; release: boolean }[] } = { forDate: null, after: null, leased: false, saves: [] };
  const errors: unknown[] = [];
  const deps: SweepDeps = {
    now: () => new Date(clock),
    seoulToday: (now) => now.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }),
    async cursorClaim(forDate) {
      if (cursor.leased) return { claimed: false, after: null };
      if (cursor.forDate !== forDate) cursor.after = null;
      cursor.forDate = forDate;
      cursor.leased = true;
      return { claimed: true, after: cursor.after };
    },
    async cursorSave(forDate, nextAfter, release) {
      cursor.saves.push({ after: nextAfter, release });
      if (cursor.forDate === forDate) cursor.after = nextAfter;
      if (release) cursor.leased = false;
    },
    async targets(_forDate, after, limit) {
      return [...userIds].sort().filter((id) => !done.has(id) && (after === null || id > after)).slice(0, limit);
    },
    async processUser(userId) {
      clock += opts.perUserMs ?? 10;
      processed.push(userId);
      if (opts.failing?.has(userId)) throw new Error(`boom ${userId}`);
      done.add(userId);
      return opts.outcomes?.[userId] ?? okOutcome({ createdIds: ['r'] });
    },
    async reportError(e) { errors.push(e); },
  };
  return { deps, processed, done, cursor, errors, advance: (ms: number) => { clock += ms; }, setClock: (iso: string) => { clock = Date.parse(iso); } };
}

const ids = (n: number, prefix = 'u') => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(4, '0')}`);

await (async () => {
  // 1) 페이지 3장(250명, 100명씩) → 한 호출로 전부 처리, 중복 없음, 완료 후 커서 null
  {
    const e = env(ids(250));
    const r = await runBatchSweep(e.deps, { pageSize: 100, timeBudgetMs: 60_000, maxPages: 20 });
    check('대상이 한 페이지보다 많아도 뒤쪽 사용자까지 처리 (250명·3페이지)', r.processed === 250 && r.pages === 3 && r.created === 250 && e.processed.length === 250);
    check('한 sweep 에 같은 사용자 두 번 없음', new Set(e.processed).size === 250);
    check('완료 → next_after=null · sweep_completed · 커서 해제', r.sweep_completed && r.next_after === null && r.stopped_reason === 'completed' && e.cursor.after === null && !e.cursor.leased);
    check('페이지 경계마다 커서 저장(2회) + 마지막 release 저장', e.cursor.saves.filter((s) => !s.release).length === 2 && e.cursor.saves[e.cursor.saves.length - 1].release);
    check('id 오름차순으로 처리', e.processed.join() === [...ids(250)].sort().join());
  }

  // 2) 시간 예산: 한 사용자 1초, 예산 30초 → 30명에서 멈춤. 다음 호출이 저장 커서에서 이어가 나머지를 처리 (누락·중복 없음)
  {
    const e = env(ids(75), { perUserMs: 1000 });
    const r1 = await runBatchSweep(e.deps, { pageSize: 50, timeBudgetMs: 30_000, maxPages: 20 });
    check('시간 예산에서 멈춤 (30명 처리, next_after=마지막 처리 사용자)', r1.stopped_reason === 'time_budget' && r1.processed === 30 && r1.next_after === 'u0029' && !r1.sweep_completed);
    check('멈출 때 커서 저장 + lease 해제', e.cursor.after === 'u0029' && !e.cursor.leased);
    const r2 = await runBatchSweep(e.deps, { pageSize: 50, timeBudgetMs: 30_000, maxPages: 20 });
    check('다음 호출은 저장된 커서부터 이어간다 (u0030 부터 30명)', r2.processed === 30 && e.processed[30] === 'u0030' && r2.next_after === 'u0059');
    const r3 = await runBatchSweep(e.deps, { pageSize: 50, timeBudgetMs: 30_000, maxPages: 20 });
    check('세 번째 호출로 나머지 15명 처리 후 완료', r3.processed === 15 && r3.sweep_completed && r3.next_after === null);
    check('세 호출 합쳐 75명 전원 정확히 한 번', e.processed.length === 75 && new Set(e.processed).size === 75);
    // 완료 뒤 다음 호출: 처음부터 — 이미 끝난 사용자는 대상 조회가 빼 주므로 0명
    const r4 = await runBatchSweep(e.deps, { pageSize: 50, timeBudgetMs: 30_000, maxPages: 20 });
    check('완료 후 호출은 처음부터 시작하되 대상이 없으면 0명·완료', r4.processed === 0 && r4.sweep_completed && r4.pages === 0);
  }

  // 2b) 앞쪽 사용자가 다시 대상이 돼도(1시간 재시도) 뒤쪽 사용자가 밀리지 않는다: 커서가 뒤쪽을 먼저 처리
  {
    const e = env(ids(40), { perUserMs: 1000 });
    const r1 = await runBatchSweep(e.deps, { pageSize: 10, timeBudgetMs: 20_000, maxPages: 20 });
    check('첫 호출 20명 (u0000~u0019)', r1.processed === 20 && r1.next_after === 'u0019');
    // 앞쪽 20명이 다시 대상이 됐다 (exhausted 1시간 경과를 흉내)
    for (const id of ids(20)) e.done.delete(id);
    const r2 = await runBatchSweep(e.deps, { pageSize: 10, timeBudgetMs: 20_000, maxPages: 20 });
    check('앞쪽이 다시 대상이어도 두 번째 호출은 뒤쪽 20명(u0020~)을 먼저 처리', r2.processed === 20 && e.processed.slice(20).join() === ids(40).slice(20).join());
    const r3 = await runBatchSweep(e.deps, { pageSize: 10, timeBudgetMs: 20_000, maxPages: 20 });
    check('뒤쪽까지 훑어 sweep 을 끝낸 다음 호출에서야 앞쪽 20명을 다시 처리', r2.sweep_completed && r3.processed === 20 && e.processed.slice(40).join() === ids(20).join());
  }

  // 3) 최대 페이지 상한
  {
    const e = env(ids(500));
    const r = await runBatchSweep(e.deps, { pageSize: 100, timeBudgetMs: 60_000, maxPages: 2 });
    check('max_pages 에서 멈춤 (200명, next_after 유지)', r.stopped_reason === 'max_pages' && r.processed === 200 && r.next_after === 'u0199' && e.cursor.after === 'u0199');
  }

  // 4) 사용자 한 명 실패 → 그 사용자만 failed, 나머지 계속, 오류 보고 1건
  {
    const e = env(ids(5), { failing: new Set(['u0002']) });
    const r = await runBatchSweep(e.deps, { pageSize: 100 });
    check('실패 사용자 격리: processed=5 · created=4 · failed=1 · 보고 1건', r.processed === 5 && r.created === 4 && r.failed === 1 && e.errors.length === 1 && r.sweep_completed);
  }

  // 5) KST 날짜 변경: 23:59:59 KST 에 시작해 처리 중 자정을 넘기면 멈춘다 — 이전 날짜로 더 만들지 않는다
  {
    const e = env(ids(10), { perUserMs: 1000, startAt: '2026-09-18T14:59:58Z' }); // KST 23:59:58
    const r = await runBatchSweep(e.deps, { pageSize: 100, timeBudgetMs: 60_000 });
    check('for_date 는 시작 시점 KST 날짜', r.for_date === '2026-09-18');
    check('자정을 넘기면 date_changed 로 멈춤 (2명 처리 후)', r.stopped_reason === 'date_changed' && r.processed === 2 && !r.sweep_completed);
    check('처리한 사용자는 모두 시작 날짜로 처리됐고 lease 는 해제', e.processed.length === 2 && !e.cursor.leased);
    // 다음 호출: 새 날짜 → 커서 초기화(처음부터) — 이전 날짜에 처리한 사용자도 새 날짜 대상이면 다시 처리된다 (하루 1명은 날짜별)
    e.done.clear();
    const r2 = await runBatchSweep(e.deps, { pageSize: 100, timeBudgetMs: 60_000 });
    check('새 날짜 호출은 처음부터 (for_date 변경·커서 무시)', r2.for_date === '2026-09-19' && r2.processed === 10 && e.processed[2] === 'u0000');
  }

  // 6) 다른 sweep 진행 중 → 아무것도 하지 않음
  {
    const e = env(ids(5));
    e.cursor.leased = true;
    const r = await runBatchSweep(e.deps, {});
    check('lease 중이면 sweep_in_progress · 0명 · 커서 저장 없음', r.stopped_reason === 'sweep_in_progress' && r.processed === 0 && e.cursor.saves.length === 0);
  }

  // 7) 명시 after 는 저장 커서보다 우선 (수동 실행)
  {
    const e = env(ids(10));
    e.cursor.forDate = '2026-09-18';
    e.cursor.after = 'u0007';
    const r = await runBatchSweep(e.deps, { pageSize: 100, after: 'u0004' });
    check('after 명시 → 그 다음부터 (u0005~u0009, 5명)', r.processed === 5 && e.processed[0] === 'u0005');
    const e2 = env(ids(10));
    e2.cursor.forDate = '2026-09-18';
    e2.cursor.after = 'u0007';
    const r2 = await runBatchSweep(e2.deps, { pageSize: 100, after: null });
    check('after=null 명시 → 처음부터 (10명)', r2.processed === 10);
    const e3 = env(ids(10));
    e3.cursor.forDate = '2026-09-18';
    e3.cursor.after = 'u0007';
    const r3 = await runBatchSweep(e3.deps, { pageSize: 100 });
    check('after 생략 → 저장 커서(u0007) 다음부터 (2명)', r3.processed === 2 && e3.processed[0] === 'u0008');
  }

  // 8) 결과 집계 매핑 + 옵션 클램프
  {
    const c: SweepCounts = { processed: 0, created: 0, exhausted: 0, exhausted_cap_reached: 0, slots_full: 0, skipped: 0, failed: 0 };
    countOutcome(c, okOutcome({ createdIds: ['x'] }));
    countOutcome(c, okOutcome({ exhausted: true }));
    countOutcome(c, okOutcome({ exhausted: true, capReached: true }));
    countOutcome(c, okOutcome({ slotsFull: true }));
    countOutcome(c, okOutcome({ skipped: true }));
    countOutcome(c, okOutcome({ inProgress: true }));
    countOutcome(c, { kind: 'lookup_failed', stage: 'safety' });
    countOutcome(c, { kind: 'not_ready' });
    check('집계 매핑: created 1 · exhausted 2(cap 1) · slots_full 1 · skipped 2 · failed 2', c.created === 1 && c.exhausted === 2 && c.exhausted_cap_reached === 1 && c.slots_full === 1 && c.skipped === 2 && c.failed === 2);
    const d = clampOptions({});
    check('기본 옵션 (100명·50초·20페이지)', d.pageSize === DEFAULT_PAGE_SIZE && d.timeBudgetMs === DEFAULT_TIME_BUDGET_MS && d.maxPages === DEFAULT_MAX_PAGES);
    const x = clampOptions({ pageSize: 9999, timeBudgetMs: 10 * 60_000, maxPages: -1 });
    check('상한 클램프 (300명·120초) · 잘못된 값은 기본값', x.pageSize === 300 && x.timeBudgetMs === HARD_MAX_TIME_BUDGET_MS && x.maxPages === DEFAULT_MAX_PAGES);
  }

  // 9) 사용자 처리 중 예외가 아닌 커서 저장 실패는 결과를 막지 않는다 / 대상 조회 실패는 lease 를 놓고 throw
  {
    const e = env(ids(3));
    e.deps.targets = async () => { throw new Error('targets down'); };
    let threw = false;
    try { await runBatchSweep(e.deps, {}); } catch { threw = true; }
    check('대상 조회 실패 → throw (호출자가 500) · lease 해제', threw && !e.cursor.leased);
  }
})();

console.log(`\nbatch sweep selftest: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
