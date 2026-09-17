#!/usr/bin/env node
/**
 * 관리자 웹 브라우저 번들 검사 (#27) — `next build` 뒤 .next/static (브라우저로 내려가는 파일) 에
 * 서버 secret 이름·service role 토큰·세션 secret·MFA/OTP 관련 서버 값이 없는지 grep 한다.
 *   cd apps/admin && npm run build && node scripts/check-admin-bundle.mjs
 * 서버 전용 chunk(.next/server) 는 검사 대상이 아니다 — 거기에는 환경변수 *이름* 이 정상적으로 있다.
 * 검사기 자체 검증: `node scripts/check-admin-bundle.mjs --selfcheck` (가짜 파일에 심은 secret 을 잡는지)
 */
import { readdirSync, readFileSync, statSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PATTERNS = [
  /SUPABASE_SERVICE_ROLE_KEY/,
  /ADMIN_SESSION_SECRET/,
  /ADMIN_PASSWORD/,
  /ADMIN_BOOTSTRAP_PASSWORD/,
  /"role":"service_role"/,
  /service_role/,
  /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\./, // JWT 형태 (service role / access token)
  /otpauth:\/\//,
  /admin_session_check|admin_member_add|admin_login_guard/, // RPC 이름이 브라우저 번들에 있으면 서버 코드가 새어 나간 것
];
// 빌드 시 넘긴 placeholder 값도 잡는다 (CI: ci-placeholder-*)
for (const name of ['SUPABASE_SERVICE_ROLE_KEY', 'ADMIN_SESSION_SECRET', 'ADMIN_PASSWORD']) {
  const v = process.env[name];
  if (v && v.length >= 8) PATTERNS.push(new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(js|css|html|json|txt|map)$/.test(e)) out.push(p);
  }
  return out;
}

function scan(root) {
  const hits = [];
  for (const f of walk(root)) {
    const text = readFileSync(f, 'utf8');
    for (const re of PATTERNS) {
      const m = text.match(re);
      if (m) hits.push(`${f}: /${re.source}/ → …${text.slice(Math.max(0, m.index - 20), m.index + 24).replace(/\s+/g, ' ')}…`);
    }
  }
  return hits;
}

if (process.argv.includes('--selfcheck')) {
  const dir = mkdtempSync(join(tmpdir(), 'admin-bundle-'));
  writeFileSync(join(dir, 'clean.js'), 'console.log("hello");');
  const clean = scan(dir);
  writeFileSync(join(dir, 'leak.js'), 'const k = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UifQ.sig"; fetch("/rpc/admin_session_check")');
  const leak = scan(dir);
  if (clean.length !== 0 || leak.length < 2) {
    console.error(`FAIL selfcheck: clean=${clean.length} leak=${leak.length}`);
    process.exit(1);
  }
  console.log('OK: admin bundle checker selfcheck (clean 0 · leak detected)');
  process.exit(0);
}

const root = join(process.cwd(), '.next', 'static');
let hits;
try {
  hits = scan(root);
} catch (e) {
  console.error(`FAIL: ${root} 를 읽을 수 없습니다 — 먼저 npm run build (${e instanceof Error ? e.message : e})`);
  process.exit(1);
}
if (hits.length > 0) {
  console.error('FAIL: 브라우저 번들에 서버 secret/RPC 흔적:');
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`OK: admin browser bundle clean (${walk(root).length} files)`);
