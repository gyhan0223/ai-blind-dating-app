#!/usr/bin/env node
/**
 * release 산출물 검사 (#3) — `expo export` 로 만든 JS 번들(web · ios · android)에 개발용 우회 경로·서버 secret 이 없는지 확인한다.
 *
 *   npm run release:check              # export 실행 후 검사 (실패 시 종료 코드 1, export 실패·환경 누락은 2)
 *   npm run release:check:selfcheck    # 검사기 자체 검증 — 통제된 가짜 secret/마커를 심은 산출물을 반드시 잡아야 한다
 *   node scripts/check-release-bundle.mjs --scan <dir>   # 이미 만든 산출물(EAS 등)만 검사
 *
 * 무엇을 검사하나
 *   1) 소스: src/dev/* 는 lib/devTools.ts 의 `if (__DEV__) require(...)` 로만 불러온다 (정적 import 금지)
 *   2) 산출물: 개발용 마커(dev-login · complete-face-verification · 시드 비밀번호 · 개발용 버튼 문구 · devMockApproveFace …) 0건
 *   3) 산출물: 서버 전용 secret 이름(service_role · IDENTITY_HASH_SECRET · DIDIT_API_KEY …) 0건.
 *      공개 값(EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY / EXPO_PUBLIC_SENTRY_DSN 등)은 허용한다.
 *   4) 산출물: 현재 환경에 서버 secret 값이 있으면 그 값이 들어 있지 않은지 (이름만 보고하고 값은 절대 출력하지 않는다)
 *   5) 산출물: JWT 형태 토큰의 payload role 이 service_role 이면 실패 (anon 은 허용)
 *
 * 이 검사는 정적 검증이다 — EAS 네이티브 release 빌드·실기기 검증을 대신하지 않는다 (docs/release-checklist.md).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 개발용 우회 경로 마커 — 이름을 바꿔 검사를 피하지 않는다 (src/dev/devModules.ts 와 서버 함수 이름 기준) */
export const DEV_MARKERS = [
  'dev-login',
  'complete-face-verification',
  'bonsim-dev-password',
  'devMockApproveFace',
  'devLoginWithPhone',
  'devIdentityPass',
  'devSeedLogin',
  'DEV_SEED_ACCOUNTS',
  'demo-m1@bonsim.dev',
  '테스트로 시작하기',
  '얼굴 인증 통과',
  '테스트로 통과하기',
  'DEV_LOGIN_PASSWORD',
  '@/dev/devModules',
  'src/dev/devModules',
];

/** 서버 전용 secret 의 이름 — 번들에 이름조차 있으면 안 된다. (EXPO_PUBLIC_ 접두사가 붙은 공개 값과 구분) */
export const SECRET_NAME_PATTERNS = [
  /service_role/i,
  /SUPABASE_SERVICE_ROLE_KEY/,
  /IDENTITY_HASH_SECRET/,
  /DIDIT_API_KEY/,
  /DIDIT_WEBHOOK_SECRET/,
  /SOLAPI_API_(KEY|SECRET)/,
  /SEND_SMS_HOOK_SECRETS/,
  /ADMIN_PASSWORD/,
  /ADMIN_SESSION_SECRET/,
  /EXPO_ACCESS_TOKEN/,
  /(?<!EXPO_PUBLIC_)SENTRY_DSN(?!\w)/,
];

/** 값이 환경에 있으면 산출물에 그 값이 없어야 하는 변수 (값은 출력하지 않는다) */
export const SECRET_VALUE_ENV_NAMES = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'IDENTITY_HASH_SECRET',
  'DIDIT_API_KEY',
  'DIDIT_WEBHOOK_SECRET',
  'SOLAPI_API_KEY',
  'SOLAPI_API_SECRET',
  'SEND_SMS_HOOK_SECRETS',
  'ADMIN_PASSWORD',
  'ADMIN_SESSION_SECRET',
  'EXPO_ACCESS_TOKEN',
  'SENTRY_DSN',
  'RELEASE_CHECK_FAKE_SECRET', // selfcheck 용
];

/** 공개 값 — 번들에 있어도 된다 (anon key 는 public). 검사 대상에서 제외하기 위한 목록 (문서화 목적) */
export const PUBLIC_ENV_NAMES = ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY', 'EXPO_PUBLIC_SENTRY_DSN', 'EXPO_PUBLIC_APP_ENV', 'EXPO_PUBLIC_POLICY_BASE_URL'];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function isTextArtifact(p) {
  return /\.(js|mjs|cjs|map|json|html|hbc|txt)$/i.test(p) || !/\.(png|jpg|jpeg|gif|webp|ttf|otf|woff2?|mp4|mp3)$/i.test(p);
}

function decodeJwtRole(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof payload.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}

/**
 * 산출물 디렉터리 검사. 결과의 finding 에는 파일 상대경로·마커 이름·건수만 있다 (값 없음).
 * @param {string} dir
 * @param {Record<string, string | undefined>} env
 */
export function scanArtifacts(dir, env = process.env) {
  const findings = [];
  const files = walk(dir).filter(isTextArtifact);
  if (files.length === 0) findings.push({ kind: 'empty', file: relative(dir, dir) || '.', detail: 'no files to scan' });
  const secretValues = SECRET_VALUE_ENV_NAMES.map((name) => ({ name, value: (env[name] ?? '').trim() })).filter((s) => s.value.length >= 8);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const rel = relative(dir, file);
    for (const m of DEV_MARKERS) {
      const n = text.split(m).length - 1;
      if (n > 0) findings.push({ kind: 'dev_marker', file: rel, detail: m, count: n });
    }
    for (const re of SECRET_NAME_PATTERNS) {
      const n = (text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)) ?? []).length;
      if (n > 0) findings.push({ kind: 'secret_name', file: rel, detail: re.source, count: n });
    }
    for (const s of secretValues) {
      const n = text.split(s.value).length - 1;
      if (n > 0) findings.push({ kind: 'secret_value', file: rel, detail: s.name, count: n, valueHash: createHash('sha256').update(s.value).digest('hex').slice(0, 12) });
    }
    for (const tok of text.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) ?? []) {
      const role = decodeJwtRole(tok);
      if (role && role !== 'anon') findings.push({ kind: 'jwt_role', file: rel, detail: role, count: 1 });
    }
  }
  return { files: files.length, findings };
}

/** 소스 검사: src/dev/* 정적 import 금지 (lib/devTools.ts 의 require 만 허용) */
export function scanSource(srcDir) {
  const findings = [];
  const files = walk(srcDir).filter((p) => /\.(ts|tsx)$/.test(p) && !p.includes(`${join('src', 'dev')}${'/'}`) && !p.includes('/dev/'));
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const rel = relative(srcDir, file);
    const staticImport = /^\s*import\s[^;]*from\s+['"]@\/dev\//m.test(text) || /^\s*import\s+['"]@\/dev\//m.test(text);
    if (staticImport) findings.push({ kind: 'static_dev_import', file: rel, detail: '@/dev/* must be loaded via loadDevModules()', count: 1 });
    if (rel !== join('lib', 'devTools.ts') && /require\(['"]@\/dev\//.test(text)) {
      findings.push({ kind: 'dev_require_outside_loader', file: rel, detail: 'only lib/devTools.ts may require @/dev/*', count: 1 });
    }
  }
  return { files: files.length, findings };
}

function printFindings(title, res) {
  console.log(`${title}: ${res.files} file(s) scanned, ${res.findings.length} finding(s)`);
  for (const f of res.findings) console.log(`  - [${f.kind}] ${f.file}: ${f.detail}${f.count ? ` ×${f.count}` : ''}${f.valueHash ? ` (value sha256 ${f.valueHash}…)` : ''}`);
}

function runExport(outDir, platforms) {
  const missing = ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY'].filter((n) => !(process.env[n] ?? '').trim());
  if (missing.length > 0) {
    console.error(`release check: 환경 누락 — ${missing.join(', ')} (export 를 건너뛰지 않고 실패로 처리합니다)`);
    return false;
  }
  const args = ['expo', 'export', '--no-bytecode', '--output-dir', outDir];
  for (const p of platforms) args.push('--platform', p);
  console.log(`release check: npx ${args.join(' ')}`);
  const res = spawnSync('npx', args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, CI: '1' } });
  if (res.status !== 0) {
    console.error(`release check: expo export 실패 (exit ${res.status}) — 검사 통과로 보지 않습니다`);
    return false;
  }
  const bundles = walk(outDir).filter((p) => /\.(js|hbc)$/.test(p));
  if (bundles.length === 0) {
    console.error('release check: export 산출물에 JS 번들이 없습니다 — 실패');
    return false;
  }
  return true;
}

function selfcheck() {
  const fake = 'fake-secret-value-for-selfcheck-0123456789';
  const env = { ...process.env, RELEASE_CHECK_FAKE_SECRET: fake };
  const dirtyDir = mkdtempSync(join(tmpdir(), 'release-check-dirty-'));
  const cleanDir = mkdtempSync(join(tmpdir(), 'release-check-clean-'));
  try {
    // service_role JWT 형태 (서명은 가짜)
    const fakeJwt = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from('{"role":"service_role","iss":"selfcheck"}').toString('base64url')}.${'x'.repeat(24)}`;
    writeFileSync(join(dirtyDir, 'entry.js'), `var a="dev-login";var b="complete-face-verification";var c="${fake}";var d="SUPABASE_SERVICE_ROLE_KEY";var e="${fakeJwt}";var f="테스트로 시작하기";`);
    const anonJwt = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from('{"role":"anon","iss":"selfcheck"}').toString('base64url')}.${'y'.repeat(24)}`;
    writeFileSync(join(cleanDir, 'entry.js'), `var a="EXPO_PUBLIC_SUPABASE_ANON_KEY";var b="${anonJwt}";var c="EXPO_PUBLIC_SENTRY_DSN";var d="signInWithOtp";`);
    const dirty = scanArtifacts(dirtyDir, env);
    const clean = scanArtifacts(cleanDir, env);
    const kinds = new Set(dirty.findings.map((f) => f.kind));
    const checks = [
      ['dev marker caught', kinds.has('dev_marker') && dirty.findings.filter((f) => f.kind === 'dev_marker').length >= 3],
      ['secret name caught', kinds.has('secret_name')],
      ['planted secret value caught (by name only)', dirty.findings.some((f) => f.kind === 'secret_value' && f.detail === 'RELEASE_CHECK_FAKE_SECRET')],
      ['service_role jwt caught', dirty.findings.some((f) => f.kind === 'jwt_role' && f.detail === 'service_role')],
      ['no value printed', !JSON.stringify(dirty.findings).includes(fake)],
      ['clean bundle passes (anon key / public names allowed)', clean.findings.length === 0],
      ['empty dir is not a pass', scanArtifacts(mkdtempSync(join(tmpdir(), 'release-check-empty-')), env).findings.some((f) => f.kind === 'empty')],
    ];
    let failed = 0;
    for (const [name, ok] of checks) {
      if (ok) console.log(`  ok   ${name}`);
      else {
        failed += 1;
        console.error(`  FAIL ${name}`);
      }
    }
    // 소스 검사 자체도 확인: src/dev 정적 import 를 심은 임시 소스는 잡혀야 한다
    const srcTmp = mkdtempSync(join(tmpdir(), 'release-check-src-'));
    writeFileSync(join(srcTmp, 'bad.tsx'), "import { devMockApproveFace } from '@/dev/devModules';\n");
    const srcRes = scanSource(srcTmp);
    if (srcRes.findings.some((f) => f.kind === 'static_dev_import')) console.log('  ok   static dev import caught');
    else {
      failed += 1;
      console.error('  FAIL static dev import not caught');
    }
    console.log(`release check selfcheck: ${checks.length + 1 - failed} passed, ${failed} failed`);
    return failed === 0;
  } finally {
    rmSync(dirtyDir, { recursive: true, force: true });
    rmSync(cleanDir, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selfcheck')) process.exit(selfcheck() ? 0 : 1);

  const srcRes = scanSource(join(ROOT, 'src'));
  printFindings('source check (src/dev static import)', srcRes);

  let outDir;
  const scanIdx = args.indexOf('--scan');
  if (scanIdx >= 0) {
    outDir = args[scanIdx + 1];
    if (!outDir || !existsSync(outDir)) {
      console.error('release check: --scan <dir> 가 존재하지 않습니다');
      process.exit(2);
    }
  } else {
    outDir = mkdtempSync(join(tmpdir(), 'bonsim-release-export-'));
    const platforms = args.includes('--android-only') ? ['android'] : ['web', 'ios', 'android'];
    if (!runExport(outDir, platforms)) process.exit(2);
  }
  const res = scanArtifacts(outDir, process.env);
  printFindings(`artifact check (${outDir})`, res);
  const failed = srcRes.findings.length + res.findings.length;
  if (failed > 0) {
    console.error(`release check: FAILED (${failed} finding(s)) — 개발 우회 경로/서버 secret 이 산출물 또는 소스에 남아 있습니다`);
    process.exit(1);
  }
  console.log('release check: OK — 개발용 마커·서버 secret 이름/값·service_role 토큰 없음 (정적 검증. EAS release 빌드·실기기 확인은 별도)');
}

main();
