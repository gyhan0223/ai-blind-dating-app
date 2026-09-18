#!/usr/bin/env node
/**
 * migration 파일명 버전 중복 검사 — 재발 방지 (0032 충돌: identity_verification_sessions 와 recommendation_batch_sweep 가 같은 번호를 썼다).
 *
 *   node supabase/scripts/check-migration-versions.mjs              # supabase/migrations 검사
 *   node supabase/scripts/check-migration-versions.mjs --dir <경로>  # 다른 디렉터리
 *   node supabase/scripts/check-migration-versions.mjs --selfcheck   # 임시 fixture(같은 버전 2개)로 검사기가 실제로 실패하는지 확인
 *
 * 규칙 (Supabase CLI 와 같은 파일명 패턴 `<version>_<name>.sql`, version = 앞의 숫자열):
 *   * 같은 version 이 두 파일 이상이면 실패 (exit 1) — CLI 는 version 을 supabase_migrations.schema_migrations 의 PK 로 기록하므로
 *     두 번째 파일에서 `db push` / `supabase start` 가 duplicate key 로 멈추고, 원격에 한쪽만 적용된 경우 다른 쪽은 영원히 "적용됨" 으로 오인된다.
 *   * 패턴에 맞지 않는 .sql 파일은 CLI 가 조용히 건너뛰므로 실패로 취급한다.
 *   * 검사만 한다 — 파일을 바꾸지 않는다. DB 접속 없음.
 * run_local_check.sh 가 마이그레이션 적용 전에, CI(db · supabase-integration job)가 첫 단계로 실행한다.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE_PATTERN = /^([0-9]+)_(.*)\.sql$/;

export function checkMigrationDir(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const byVersion = new Map();
  const malformed = [];
  for (const f of files) {
    const m = FILE_PATTERN.exec(f);
    if (!m) {
      malformed.push(f);
      continue;
    }
    const list = byVersion.get(m[1]) ?? [];
    list.push(f);
    byVersion.set(m[1], list);
  }
  const duplicates = [...byVersion.entries()].filter(([, list]) => list.length > 1);
  return { count: files.length, versions: byVersion.size, duplicates, malformed };
}

function report(dir) {
  const r = checkMigrationDir(dir);
  let ok = true;
  for (const [version, list] of r.duplicates) {
    ok = false;
    console.error(`FAIL: migration version ${version} 이 ${list.length}개 파일에 중복됩니다:`);
    for (const f of list) console.error(`  - ${f}`);
  }
  for (const f of r.malformed) {
    ok = false;
    console.error(`FAIL: 파일명이 <version>_<name>.sql 패턴이 아닙니다 (Supabase CLI 가 건너뜁니다): ${f}`);
  }
  if (!ok) {
    console.error('→ 미적용 파일을 다음 빈 번호로 옮기세요. 이미 원격에 적용된 번호는 바꾸지 말고 docs/local-supabase-integration.md 5절을 따르세요.');
    return false;
  }
  console.log(`OK: ${r.count} migration files, ${r.versions} unique versions, no duplicates (${dir})`);
  return true;
}

const args = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));

if (args.includes('--selfcheck')) {
  const dir = mkdtempSync(join(tmpdir(), 'migration-versions-'));
  try {
    writeFileSync(join(dir, '0001_a.sql'), 'select 1;');
    writeFileSync(join(dir, '0002_b.sql'), 'select 1;');
    const clean = checkMigrationDir(dir);
    writeFileSync(join(dir, '0002_c.sql'), 'select 1;');
    writeFileSync(join(dir, 'notes.sql'), 'select 1;');
    const dirty = checkMigrationDir(dir);
    const ok =
      clean.duplicates.length === 0 && clean.malformed.length === 0 &&
      dirty.duplicates.length === 1 && dirty.duplicates[0][0] === '0002' && dirty.duplicates[0][1].join() === '0002_b.sql,0002_c.sql' &&
      dirty.malformed.join() === 'notes.sql';
    if (!ok) {
      console.error(`FAIL selfcheck: clean=${JSON.stringify(clean)} dirty=${JSON.stringify(dirty)}`);
      process.exit(1);
    }
    // 실제 CLI 경로(report → exit 1)도 확인한다
    const stderrWrite = process.stderr.write.bind(process.stderr);
    let captured = '';
    process.stderr.write = (chunk) => { captured += String(chunk); return true; };
    const dirtyOk = report(dir);
    process.stderr.write = stderrWrite;
    if (dirtyOk || !captured.includes('0002_b.sql') || !captured.includes('0002_c.sql')) {
      console.error('FAIL selfcheck: report() 가 중복 파일명을 출력하며 실패하지 않았습니다');
      process.exit(1);
    }
    console.log('OK: migration version checker selfcheck (중복 없음 통과 · 같은 버전 2개 → 파일명 출력 후 실패)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  process.exit(0);
}

const dirArg = args.indexOf('--dir');
const dir = dirArg >= 0 && args[dirArg + 1] ? resolve(args[dirArg + 1]) : resolve(here, '..', 'migrations');
process.exit(report(dir) ? 0 : 1);
