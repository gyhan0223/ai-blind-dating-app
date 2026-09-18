#!/usr/bin/env node
/**
 * 관리자 인증 통합 테스트 (#27) — **실제 로컬 Supabase**(Postgres · Auth(GoTrue) · PostgREST) 위에서
 * 실제 어댑터(lib/supabaseAdminAuth.ts)·코어(lib/adminAuthCore.ts)·멤버 관리(lib/adminMembers.ts)·bootstrap 스크립트,
 * 그리고 관리자 웹(Next)의 실제 HTTP 요청·쿠키 경로를 검증한다. 테스트 전용 인증 구현은 없다 — TOTP 코드 생성(RFC 6238)만 여기서 한다.
 *
 *   cd apps/admin && node --experimental-strip-types scripts/admin-auth-integration.mjs
 *   (보통은 supabase/tests/run_supabase_integration.sh 가 로컬 스택·관리자 웹을 띄운 뒤 호출한다 — docs/local-supabase-integration.md)
 *
 * 환경변수
 *   SUPABASE_URL · SUPABASE_ANON_KEY · SUPABASE_SERVICE_ROLE_KEY  — 로컬 스택 (supabase status -o env). 원격 호스트면 실행을 거부한다
 *   SUPABASE_DB_URL (선택)                                        — 로컬 확인용. 원격이면 거부. 이 스크립트는 DB 에 직접 접속하지 않는다 (PostgREST 로만)
 *   ADMIN_BASE_URL (선택)                                        — 관리자 웹 (예: http://127.0.0.1:3101). 있으면 HTTP 쿠키 경로도 검증한다
 *   ADMIN_IT_KEEP=1 (선택)                                       — 끝난 뒤 테스트 계정을 지우지 않는다 (기본은 삭제)
 *
 * 원칙
 *   * 빈 관리자 상태(admin_members 0행)에서만 시작한다 — 개발 DB 를 초기화하지 않는다. 남은 통합 테스트 계정(*@admin-it.example.com)은 시작 전에 지운다.
 *   * 비밀번호는 실행마다 난수, TOTP secret 은 메모리에만. 어떤 경로로도 출력하지 않는다 (실패 메시지는 검사 이름만).
 *   * MFA · 권한 · 세션 · rate limit 을 약화시키지 않는다. 잠금 검사는 전용 계정으로 마지막에 한다.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// 환경 — 로컬 전용
// ---------------------------------------------------------------------------
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', 'host.docker.internal', 'supabase_kong_bonsim-it']);

function assertLocalUrl(name, value) {
  if (!value) die(`${name} 이 필요합니다 (로컬 Supabase 스택 — supabase status -o env)`);
  let u;
  try {
    u = new URL(value);
  } catch {
    die(`${name} 이 URL 이 아닙니다`);
  }
  const host = u.hostname.toLowerCase();
  if (!LOCAL_HOSTS.has(host) || host.endsWith('.supabase.co') || host.endsWith('.supabase.com') || host.endsWith('.pooler.supabase.com')) {
    die(`${name} 이 로컬 호스트가 아닙니다 (${host}) — 이 테스트는 원격 프로젝트에 절대 실행하지 않는다`);
  }
}

function die(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(2);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
assertLocalUrl('SUPABASE_URL', SUPABASE_URL);
if (process.env.SUPABASE_DB_URL) assertLocalUrl('SUPABASE_DB_URL', process.env.SUPABASE_DB_URL);
if (!ANON_KEY || !SERVICE_KEY) die('SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY 가 필요합니다');
const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL || '';
if (ADMIN_BASE_URL) assertLocalUrl('ADMIN_BASE_URL', ADMIN_BASE_URL);

// 실제 어댑터·코어 — 환경변수를 확인한 뒤에 import (모듈이 process.env 를 읽는다)
const { supabaseAdminAuthProvider, supabaseAdminDirectory } = await import('../lib/supabaseAdminAuth.ts');
const core = await import('../lib/adminAuthCore.ts');
const members = await import('../lib/adminMembers.ts');
const { adminClient } = await import('../lib/supabaseAdmin.ts');
const { LOGIN_MAX_FAILURES } = await import('../lib/adminSessionCore.ts');

const HERE = dirname(fileURLToPath(import.meta.url));
const ADMIN_DIR = join(HERE, '..');
const EMAIL_DOMAIN = 'admin-it.example.com';
const service = adminClient();

// ---------------------------------------------------------------------------
// 검사 도우미 — secret 을 출력하지 않는다
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];
function check(name, ok, note) {
  if (ok) passed += 1;
  else {
    failed += 1;
    failures.push(name + (note ? ` — ${note}` : ''));
    console.error(`FAIL ${name}${note ? ` — ${note}` : ''}`);
  }
}
function section(title) {
  console.log(`\n== ${title}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newPassword = () => `It-${randomBytes(12).toString('base64url')}!9`; // 12자 이상 · 출력 금지

// TOTP (RFC 6238, SHA1 · 6자리 · 30초) — GoTrue 가 발급한 secret 으로 코드만 만든다. 검증은 GoTrue 가 한다
function base32Decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const v = alphabet.indexOf(ch);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function totp(secret, step = Math.floor(Date.now() / 30000)) {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 1_000_000).padStart(6, '0');
}
function wrongCode(secret) {
  const good = totp(secret);
  const prev = totp(secret, Math.floor(Date.now() / 30000) - 1);
  const next = totp(secret, Math.floor(Date.now() / 30000) + 1);
  let n = (Number(good) + 1) % 1_000_000;
  while ([good, prev, next].includes(String(n).padStart(6, '0'))) n = (n + 1) % 1_000_000;
  return String(n).padStart(6, '0');
}
/** 30초 경계에서 코드가 바뀌어 검증에 실패하지 않도록 남은 시간이 3초 미만이면 기다린다 */
async function waitForFreshStep() {
  const rem = 30000 - (Date.now() % 30000);
  if (rem < 3000) await sleep(rem + 200);
}

// ---------------------------------------------------------------------------
// Supabase 조회 (service role · PostgREST) — 검증용 읽기
// ---------------------------------------------------------------------------
async function memberRow(userId) {
  const { data, error } = await service.from('admin_members').select('user_id, role, status, mfa_verified_at, sessions_revoked_at').eq('user_id', userId).maybeSingle();
  if (error) throw new Error(`admin_members 조회 실패: ${error.message}`);
  return data;
}
async function appUserRowExists(userId) {
  const { data, error } = await service.from('users').select('id').eq('id', userId).maybeSingle();
  if (error) throw new Error(`users 조회 실패: ${error.message}`);
  return !!data;
}
async function auditCount(action, targetId) {
  let q = service.from('admin_audit_log').select('id', { count: 'exact', head: true }).eq('action', action);
  if (targetId) q = q.eq('target_id', targetId);
  const { count, error } = await q;
  if (error) throw new Error(`admin_audit_log 조회 실패: ${error.message}`);
  return count ?? 0;
}
async function verifiedFactorCount(userId) {
  const { data, error } = await service.auth.admin.mfa.listFactors({ userId });
  if (error) throw new Error(`factor 조회 실패: ${error.message}`);
  return data.factors.filter((f) => f.factor_type === 'totp' && f.status === 'verified').length;
}
async function findAuthUser(email) {
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers 실패: ${error.message}`);
    const u = data.users.find((x) => (x.email ?? '').toLowerCase() === email);
    if (u) return u;
    if (data.users.length < 200) break;
  }
  return null;
}
async function cleanupTestUsers() {
  let removed = 0;
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers 실패: ${error.message}`);
    for (const u of data.users) {
      if ((u.email ?? '').endsWith(`@${EMAIL_DOMAIN}`) || (u.phone ?? '') === APP_USER_PHONE) {
        const r = await service.auth.admin.deleteUser(u.id);
        if (!r.error) removed += 1;
      }
    }
    if (data.users.length < 200) break;
  }
  return removed;
}

const APP_USER_PHONE = '821000009999';
const emails = {
  owner1: `it-owner1@${EMAIL_DOMAIN}`,
  owner2: `it-owner2@${EMAIL_DOMAIN}`,
  viewer: `it-viewer@${EMAIL_DOMAIN}`,
  orphan: `it-orphan@${EMAIL_DOMAIN}`, // Auth 계정만 있고 membership 없음
  lock: `it-lock@${EMAIL_DOMAIN}`,
  http: `it-http-enroll@${EMAIL_DOMAIN}`,
};
const pw = { owner1: newPassword(), owner2: newPassword(), viewer: newPassword(), orphan: newPassword(), lock: newPassword(), http: newPassword() };
const secrets = {}; // userId → TOTP secret (메모리에만)
const ids = {};

// ---------------------------------------------------------------------------
// 0. 준비 — 로컬 스택 응답 · 빈 관리자 상태
// ---------------------------------------------------------------------------
section('0. 로컬 스택 · 초기 상태');
{
  const health = await fetch(`${SUPABASE_URL}/auth/v1/health`, { headers: { apikey: ANON_KEY } }).catch(() => null);
  if (!health || !health.ok) die(`GoTrue 가 응답하지 않습니다 (${SUPABASE_URL}/auth/v1/health)`);
  const removed = await cleanupTestUsers();
  if (removed > 0) console.log(`이전 실행의 테스트 계정 ${removed}개 삭제`);
  const { count, error } = await service.from('admin_members').select('user_id', { count: 'exact', head: true });
  if (error) die(`admin_members 를 읽을 수 없습니다 — 0033 마이그레이션이 적용된 로컬 DB 인지 확인 (${error.message})`);
  if ((count ?? 0) !== 0) die(`admin_members 에 ${count}행이 있습니다. 통합 테스트는 관리자가 없는 빈 로컬 DB 에서만 실행한다 (supabase db reset --local)`);
  check('legacy login 게이트: MFA 완료 관리자가 없으면 DB 는 허용', (await service.rpc('admin_legacy_login_allowed')).data === true);
}

// ---------------------------------------------------------------------------
// 1. bootstrap — 실제 스크립트 (service role) · 재-bootstrap 거부 · 앱 사용자 행 없음
// ---------------------------------------------------------------------------
section('1. bootstrap (scripts/admin-bootstrap.mjs)');
function runBootstrap(args, password) {
  const env = { ...process.env, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY };
  if (password) env.ADMIN_BOOTSTRAP_PASSWORD = password;
  const r = spawnSync(process.execPath, [join(ADMIN_DIR, 'scripts', 'admin-bootstrap.mjs'), ...args], { env, encoding: 'utf8', cwd: ADMIN_DIR });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
{
  const first = runBootstrap(['create-owner', '--email', emails.owner1, '--name', 'IT Owner'], pw.owner1);
  check('첫 owner 생성 성공', first.code === 0 && first.out.includes('완료'), first.code === 0 ? undefined : first.out.replace(pw.owner1, '***').slice(0, 200));
  const u1 = await findAuthUser(emails.owner1);
  ids.owner1 = u1?.id;
  check('owner1 Auth 계정 · app_metadata.bonsim_admin', !!u1 && u1.app_metadata?.bonsim_admin === 'true');
  const m1 = ids.owner1 ? await memberRow(ids.owner1) : null;
  check('owner1 membership role=owner active · MFA 미완료', m1?.role === 'owner' && m1?.status === 'active' && m1?.mfa_verified_at === null);
  check('관리자 계정은 public.users 행을 만들지 않는다', ids.owner1 ? !(await appUserRowExists(ids.owner1)) : false);
  check('bootstrap 감사 기록', ids.owner1 ? (await auditCount('admin_bootstrap', ids.owner1)) === 1 : false);

  const again = runBootstrap(['create-owner', '--email', emails.owner2, '--name', 'IT Owner 2'], pw.owner2);
  check('활성 owner 가 있으면 재-bootstrap 거부 (exit 1)', again.code === 1 && again.out.includes('활성 owner 가 이미 있습니다'));
  check('재-bootstrap 은 Auth 계정도 만들지 않는다', (await findAuthUser(emails.owner2)) === null);
  const list = runBootstrap(['list']);
  check('bootstrap list 에 owner 표시', list.code === 0 && /owner\s+active\s+IT Owner/.test(list.out));
}

// ---------------------------------------------------------------------------
// 2. 어댑터 + 코어 — 실제 GoTrue · 실제 DB RPC
// ---------------------------------------------------------------------------
section('2. 로그인 → TOTP 등록 → challenge/verify → aal2 → 서버 세션 (실제 GoTrue)');
const provider = supabaseAdminAuthProvider();
const directory = supabaseAdminDirectory();
const SECRET = randomBytes(32).toString('hex');
const deps = { provider, directory, secret: SECRET, now: () => Date.now(), legacy: { enabled: false, password: undefined } };
const ip = (n) => `10.99.0.${n}`; // 어댑터 검사는 IP 키를 나눠 HTTP 경로(untrusted-client 공유 키)와 섞이지 않게

/** 비밀번호 → (등록 또는 검증) → 세션. 반환 { session, pending } */
async function loginFull(email, password, userId, clientIp) {
  const login = await core.runPasswordLogin(deps, { email, password, clientIp });
  if (!login.ok) return { error: `password:${login.reason}` };
  let pending = login.pending;
  if (login.next === 'enroll') {
    const e = await core.runMfaEnrollStart(deps, pending, 'IT');
    if (!e.ok) return { error: `enroll:${e.reason}` };
    secrets[userId] = e.secret;
    pending = e.pending;
  }
  await waitForFreshStep();
  const v = await core.runMfaVerify(deps, pending, totp(secrets[userId]));
  if (!v.ok) return { error: `verify:${v.reason}` };
  return { session: v.session, userId: v.userId, role: v.role };
}

{
  // 틀린 비밀번호 → 자격 증명 실패 (실패 집계)
  const bad = await core.runPasswordLogin(deps, { email: emails.owner1, password: `${pw.owner1}x`, clientIp: ip(1) });
  check('틀린 비밀번호 → bad_credentials', !bad.ok && bad.reason === 'bad_credentials');

  const login = await core.runPasswordLogin(deps, { email: emails.owner1, password: pw.owner1, clientIp: ip(1) });
  check('비밀번호 통과 → factor 없음 → next=enroll', login.ok && login.next === 'enroll');
  if (!login.ok) die('owner1 비밀번호 로그인 실패 — 이후 검사를 진행할 수 없다');
  check('pending 토큰은 세션이 아니다 (resolveSession null)', (await core.resolveSession(deps, login.pending)) === null);
  check('pending 상태에서는 세션 발급 기록이 없다 (admin_sessions 0행)', (await service.from('admin_sessions').select('id', { count: 'exact', head: true }).eq('member_user_id', ids.owner1)).count === 0);

  const enroll = await core.runMfaEnrollStart(deps, login.pending, 'IT');
  check('TOTP 등록 시작 → GoTrue 가 secret · otpauth URI · QR(SVG) 발급', enroll.ok && /^[A-Z2-7]{16,}$/.test(enroll.secret) && enroll.uri.startsWith('otpauth://totp/') && enroll.qrCodeSvg.startsWith('data:image/svg+xml'));
  if (!enroll.ok) die('TOTP 등록 실패');
  secrets[ids.owner1] = enroll.secret;
  check('등록 직후 verified factor 0', (await verifiedFactorCount(ids.owner1)) === 0);

  await waitForFreshStep();
  const wrong = await core.runMfaVerify(deps, enroll.pending, wrongCode(enroll.secret));
  check('틀린 TOTP 코드 → bad_code (GoTrue 가 거부)', !wrong.ok && wrong.reason === 'bad_code');
  check('틀린 코드 감사 기록 admin_mfa_failed', (await auditCount('admin_mfa_failed', ids.owner1)) === 1);
  check('형식이 아닌 코드(5자리) → bad_code', !(await core.runMfaVerify(deps, enroll.pending, '12345')).ok);

  await waitForFreshStep();
  const ok = await core.runMfaVerify(deps, enroll.pending, totp(enroll.secret));
  check('올바른 코드 → challenge/verify → aal2 확인 → 서버 세션 발급 (role owner)', ok.ok && ok.role === 'owner' && ok.userId === ids.owner1);
  if (!ok.ok) die(`owner1 MFA 검증 실패: ${ok.reason}`);
  check('GoTrue: verified TOTP factor 1개', (await verifiedFactorCount(ids.owner1)) === 1);
  const m = await memberRow(ids.owner1);
  check('admin_members.mfa_verified_at 기록', !!m?.mfa_verified_at);
  check('legacy login 게이트: MFA 완료 관리자가 생기면 DB 가 닫는다', (await service.rpc('admin_legacy_login_allowed')).data === false);
  const s = await core.resolveSession(deps, ok.session);
  check('세션 쿠키 값 → DB check → owner · 이름', s?.role === 'owner' && s?.displayName === 'IT Owner' && s?.userId === ids.owner1 && s?.legacy === false);
  check('admin_login 감사 기록', (await auditCount('admin_login', ids.owner1)) === 1);

  // aal 수준을 GoTrue 에 직접 확인 — 비밀번호만 통과한 토큰은 aal1, TOTP 검증 토큰은 aal2
  const direct = await provider.signInWithPassword(emails.owner1, pw.owner1);
  check('직접 확인: 비밀번호 토큰의 assuranceLevel = aal1', direct.ok && (await provider.assuranceLevel(direct.tokens.accessToken)) === 'aal1');
  if (direct.ok) {
    const f = await provider.listFactors(direct.tokens);
    await waitForFreshStep();
    const v = f.ok ? await provider.challengeAndVerify(direct.tokens, f.verified[0], totp(enroll.secret)) : { ok: false };
    check('직접 확인: challenge+verify 토큰의 assuranceLevel = aal2', v.ok && (await provider.assuranceLevel(v.tokens.accessToken)) === 'aal2');
    if (v.ok) await provider.signOut(v.tokens.accessToken);
    await provider.signOut(direct.tokens.accessToken);
  }
  check('위조 access token 의 assuranceLevel = null (허용 아님)', (await provider.assuranceLevel('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.bad')) === null);

  // 만료·변조 세션
  const [p, sig] = ok.session.split('.');
  const flipped = `${p}.${sig.slice(0, -1)}${sig.endsWith('a') ? 'b' : 'a'}`;
  check('서명 변조 세션 → 거부', (await core.resolveSession(deps, flipped)) === null);
  check('다른 키로 서명한 세션 → 거부', (await core.resolveSession(deps, core.sessionToken('other-secret-0123456789abcdef', 'ffffffff-ffff-4fff-8fff-ffffffffffff'))) === null);
  check('payload 만 바꾼 세션 → 거부', (await core.resolveSession(deps, `${Buffer.from(JSON.stringify({ v: 2, k: 's', sid: '00000000-0000-4000-8000-000000000000', iat: 1, exp: 9999999999, nonce: 'x' })).toString('base64url')}.${sig}`)) === null);
  const st = core.verifyToken(SECRET, ok.session);
  check('만료된 토큰(exp 지남) → 거부', (await core.resolveSession(deps, core.sessionToken(SECRET, st.sid, Date.now() - (core.ADMIN_SESSION_TTL_SECONDS + 60) * 1000))) === null);
  check('없는 세션 id 로 서명만 맞춘 토큰 → 거부', (await core.resolveSession(deps, core.sessionToken(SECRET, '00000000-0000-4000-8000-000000000000'))) === null);
  // DB 쪽 만료: expires_at 을 과거로 (service role · 서버 전용 테이블)
  const { error: expErr } = await service.from('admin_sessions').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('id', st.sid);
  check('DB 세션 만료(expires_at 과거) → 거부', !expErr && (await core.resolveSession(deps, ok.session)) === null);
  const pendingExpired = core.issueToken(SECRET, { v: 2, k: 'p', sub: ids.owner1, purpose: 'login', at: 'x', rt: 'y', fid: 'z', iat: 1, exp: Math.floor(Date.now() / 1000) - 1 });
  check('만료된 pending → no_pending', (await core.runMfaVerify(deps, pendingExpired, '123456')).reason === 'no_pending');
  ids.owner1Session = null;
}

section('3. 비관리자 거부 — 앱 사용자 · membership 없는 Auth 계정');
{
  const app = await service.auth.admin.createUser({ phone: APP_USER_PHONE, phone_confirm: true, password: pw.orphan });
  check('앱 사용자(전화번호) Auth 계정 생성', !app.error && !!app.data?.user);
  ids.app = app.data?.user?.id;
  check('앱 사용자는 public.users 행이 생긴다 (트리거)', ids.app ? await appUserRowExists(ids.app) : false);
  // 앱 사용자에 이메일·비밀번호를 붙여 관리자 로그인 시도 — membership 없음 → 거부
  const withEmail = await service.auth.admin.updateUserById(ids.app, { email: `it-appuser@${EMAIL_DOMAIN}`, email_confirm: true, password: pw.orphan });
  check('앱 사용자에 이메일 부여', !withEmail.error);
  const r1 = await core.runPasswordLogin(deps, { email: `it-appuser@${EMAIL_DOMAIN}`, password: pw.orphan, clientIp: ip(2) });
  check('앱 사용자 계정으로 관리자 로그인 → bad_credentials (membership 없음)', !r1.ok && r1.reason === 'bad_credentials');
  check('감사: admin_login_not_member', (await auditCount('admin_login_not_member', ids.app)) === 1);
  const add = await service.rpc('admin_member_add', { p_actor: ids.owner1, p_target: ids.app, p_display_name: 'x', p_role: 'viewer' });
  check('앱 사용자를 관리자로 추가 → app_user_not_allowed (DB)', add.data?.ok === false && add.data?.reason === 'app_user_not_allowed');

  const orphan = await provider.createAdminUser(emails.orphan, pw.orphan);
  check('membership 없는 관리자 표식 계정 생성', orphan.ok);
  ids.orphan = orphan.ok ? orphan.userId : null;
  const r2 = await core.runPasswordLogin(deps, { email: emails.orphan, password: pw.orphan, clientIp: ip(2) });
  check('membership 없는 Auth 계정 → bad_credentials', !r2.ok && r2.reason === 'bad_credentials');
  check('membership 없는 계정도 public.users 행 없음 (bonsim_admin 표식)', ids.orphan ? !(await appUserRowExists(ids.orphan)) : false);
  const fakeSession = await directory.sessionIssue(ids.orphan, 3600);
  check('membership 없는 계정에는 세션 발급 자체가 거부된다 (admin_session_issue not_active)', fakeSession === null);
}

section('4. viewer — 허용된 조회만 · 관리자 조치는 서버(DB RPC)가 거부');
{
  const o1 = await loginFull(emails.owner1, pw.owner1, ids.owner1, ip(3));
  check('owner1 재로그인 (factor 있음 → verify 경로)', !!o1.session);
  const ownerSession = await core.resolveSession(deps, o1.session);
  if (!ownerSession) die('owner1 세션을 만들 수 없다');
  ids.owner1Session = o1.session;

  const addV = await members.addAdminMember(ownerSession, { email: emails.viewer, displayName: 'IT Viewer', role: 'viewer', password: pw.viewer });
  check('owner 가 viewer 추가 (adminMembers.addAdminMember · 실제 createUser + RPC)', addV.ok, addV.ok ? undefined : addV.reason);
  ids.viewer = (await findAuthUser(emails.viewer))?.id;
  check('viewer 도 public.users 행 없음', ids.viewer ? !(await appUserRowExists(ids.viewer)) : false);
  check('약한 초기 비밀번호는 거부 (weak_password · Auth 호출 없음)', (await members.addAdminMember(ownerSession, { email: `it-weak@${EMAIL_DOMAIN}`, displayName: 'x', role: 'viewer', password: 'short' })).reason === 'weak_password' && (await findAuthUser(`it-weak@${EMAIL_DOMAIN}`)) === null);

  const v = await loginFull(emails.viewer, pw.viewer, ids.viewer, ip(4));
  check('viewer 로그인 → TOTP 등록 → 세션 (role viewer)', v.role === 'viewer', v.error);
  const viewerSession = v.session ? await core.resolveSession(deps, v.session) : null;
  check('viewer 세션: hasRole(viewer) ○ · hasRole(owner) ×', !!viewerSession && core.hasRole(viewerSession, 'viewer') && !core.hasRole(viewerSession, 'owner'));
  if (viewerSession) {
    check('viewer 의 역할 변경 → forbidden (DB)', (await members.setAdminRole(viewerSession, ids.viewer, 'owner')).reason === 'forbidden');
    check('viewer 의 owner 비활성화 → forbidden (DB)', (await members.setAdminStatus(viewerSession, ids.owner1, 'disabled')).reason === 'forbidden');
    check('viewer 의 타인 세션 취소 → forbidden (DB)', (await members.revokeAdminSessions(viewerSession, ids.owner1)).reason === 'forbidden');
    check('viewer 의 MFA 초기화 → forbidden', (await members.resetAdminMfa(viewerSession, ids.owner1)).reason === 'forbidden');
    check('viewer 의 관리자 추가 → forbidden (DB) · Auth 계정 정리', (await members.addAdminMember(viewerSession, { email: `it-byviewer@${EMAIL_DOMAIN}`, displayName: 'x', role: 'viewer', password: newPassword() })).reason === 'forbidden' && (await findAuthUser(`it-byviewer@${EMAIL_DOMAIN}`)) === null);
    check('viewer 의 역할·상태는 그대로', (await memberRow(ids.viewer))?.role === 'viewer' && (await memberRow(ids.owner1))?.status === 'active');
    check('viewer 가 허용된 조회(관리자 목록 로드 — 서버 데이터)는 가능', (await members.loadAdminMembers()).some((m) => m.user_id === ids.viewer));
  }
  ids.viewerSession = v.session;
}

section('5. 강등 · 비활성화 · 세션 취소가 기존 세션의 다음 요청에 반영 · 마지막 owner 보호');
{
  const ownerSession = await core.resolveSession(deps, ids.owner1Session);
  if (!ownerSession) die('owner1 세션이 없다 — 4절 실패로 진행 불가');
  const addO2 = await members.addAdminMember(ownerSession, { email: emails.owner2, displayName: 'IT Owner 2', role: 'owner', password: pw.owner2 });
  check('owner1 이 owner2 추가', addO2.ok, addO2.reason);
  ids.owner2 = (await findAuthUser(emails.owner2))?.id;
  const o2 = await loginFull(emails.owner2, pw.owner2, ids.owner2, ip(5));
  check('owner2 로그인 → 세션 (owner)', o2.role === 'owner', o2.error);
  if (!o2.session) die(`owner2 로그인 실패 (${o2.error}) — 5절 진행 불가`);
  const s2 = o2.session;

  check('강등 전: owner2 세션은 owner', (await core.resolveSession(deps, s2))?.role === 'owner');
  check('owner1 이 owner2 강등', (await members.setAdminRole(ownerSession, ids.owner2, 'viewer')).ok);
  check('강등이 기존 세션의 다음 요청에 반영 (role viewer)', (await core.resolveSession(deps, s2))?.role === 'viewer');
  check('강등된 세션으로 owner 조치 → forbidden', (await members.setAdminRole(await core.resolveSession(deps, s2), ids.owner1, 'viewer')).reason === 'forbidden');

  check('owner1 이 owner2 비활성화', (await members.setAdminStatus(ownerSession, ids.owner2, 'disabled')).ok);
  check('비활성화가 기존 세션에 즉시 반영 (거부)', (await core.resolveSession(deps, s2)) === null);
  const dl = await core.runPasswordLogin(deps, { email: emails.owner2, password: pw.owner2, clientIp: ip(5) });
  check('비활성 계정 로그인 → disabled', !dl.ok && dl.reason === 'disabled');
  check('owner1 이 owner2 재활성화', (await members.setAdminStatus(ownerSession, ids.owner2, 'active')).ok);
  check('재활성화해도 이전 세션은 살아나지 않는다 (sessions_revoked_at)', (await core.resolveSession(deps, s2)) === null);

  const o2b = await loginFull(emails.owner2, pw.owner2, ids.owner2, ip(5));
  check('owner2 재로그인 성공 (기존 factor 로 verify)', !!o2b.session, o2b.error);
  if (!o2b.session) die('owner2 재로그인 실패 — 진행 불가');
  check('owner1 이 owner2 세션 전체 취소', (await members.revokeAdminSessions(ownerSession, ids.owner2)).ok);
  check('세션 취소가 다음 요청에 반영', (await core.resolveSession(deps, o2b.session)) === null);
  check('취소 감사 기록', (await auditCount('admin_sessions_revoked', ids.owner2)) >= 1);

  // 마지막 활성 owner 보호 — owner2 는 viewer 상태
  check('마지막 owner 자기 강등 → last_owner', (await members.setAdminRole(ownerSession, ids.owner1, 'viewer')).reason === 'last_owner');
  check('마지막 owner 자기 비활성화 → last_owner', (await members.setAdminStatus(ownerSession, ids.owner1, 'disabled')).reason === 'last_owner');
  check('owner1 여전히 active owner', (await memberRow(ids.owner1))?.role === 'owner' && (await memberRow(ids.owner1))?.status === 'active');
  check('owner2 를 다시 owner 로', (await members.setAdminRole(ownerSession, ids.owner2, 'owner')).ok);
  check('owner 가 둘이면 owner1 강등 가능 → 되돌리기', (await members.setAdminRole(ownerSession, ids.owner1, 'viewer')).ok && (await members.setAdminRole(await core.resolveSession(deps, (await loginFull(emails.owner2, pw.owner2, ids.owner2, ip(5))).session), ids.owner1, 'owner')).ok);
  check('owner1 복귀 확인', (await memberRow(ids.owner1))?.role === 'owner');

  // owner 의 MFA 초기화 → 대상은 다음 로그인에서 재등록
  const o1s = await core.resolveSession(deps, ids.owner1Session);
  if (!o1s) die('owner1 세션이 없다');
  check('owner1 이 owner2 MFA 초기화', (await members.resetAdminMfa(o1s, ids.owner2)).ok);
  check('초기화 뒤 GoTrue factor 0', (await verifiedFactorCount(ids.owner2)) === 0);
  const relogin = await core.runPasswordLogin(deps, { email: emails.owner2, password: pw.owner2, clientIp: ip(5) });
  check('초기화된 계정은 다음 로그인에서 enroll', relogin.ok && relogin.next === 'enroll');
  delete secrets[ids.owner2];

  // 로그아웃 = 세션 취소 → 같은 쿠키 값 재사용 불가
  const o1v = core.verifyToken(SECRET, ids.owner1Session);
  check('로그아웃(sessionRevoke) 성공', await directory.sessionRevoke(o1v.sid));
  check('로그아웃 뒤 기존 세션 쿠키 → 거부', (await core.resolveSession(deps, ids.owner1Session)) === null);
  check('취소된 세션 id 재취소는 false', (await directory.sessionRevoke(o1v.sid)) === false);
}

section('6. 비밀번호 변경(재인증) · 잠금 — 전용 계정');
{
  const v = await loginFull(emails.viewer, pw.viewer, ids.viewer, ip(6));
  const vs = v.session ? await core.resolveSession(deps, v.session) : null;
  check('viewer 재로그인', !!vs, v.error);
  if (vs) {
    const newPw = newPassword();
    check('틀린 현재 비밀번호로 변경 → bad_credentials', (await core.runChangePassword(deps, vs, { password: `${pw.viewer}x`, code: totp(secrets[ids.viewer]), newPassword: newPw, clientIp: ip(6) })).reason === 'bad_credentials');
    await waitForFreshStep();
    check('틀린 코드로 변경 → bad_credentials', (await core.runChangePassword(deps, vs, { password: pw.viewer, code: wrongCode(secrets[ids.viewer]), newPassword: newPw, clientIp: ip(6) })).reason === 'bad_credentials');
    await waitForFreshStep();
    const ch = await core.runChangePassword(deps, vs, { password: pw.viewer, code: totp(secrets[ids.viewer]), newPassword: newPw, clientIp: ip(6) });
    check('올바른 비밀번호+코드 → 비밀번호 변경 (GoTrue updateUser)', ch.ok, ch.reason);
    if (ch.ok) {
      check('변경 뒤 모든 세션 취소', (await core.resolveSession(deps, v.session)) === null);
      check('옛 비밀번호 로그인 실패', (await core.runPasswordLogin(deps, { email: emails.viewer, password: pw.viewer, clientIp: ip(6) })).reason === 'bad_credentials');
      pw.viewer = newPw;
      check('새 비밀번호 로그인 성공', (await core.runPasswordLogin(deps, { email: emails.viewer, password: pw.viewer, clientIp: ip(6) })).ok);
    }
  }

  // 잠금 — 5회/15분. 전용 계정·전용 IP 키 (다른 검사와 공유하지 않는다)
  const ownerSession = await core.resolveSession(deps, (await loginFull(emails.owner1, pw.owner1, ids.owner1, ip(7))).session);
  if (!ownerSession) die('owner1 재로그인 실패 — 6절 진행 불가');
  check('lock 계정 추가', (await members.addAdminMember(ownerSession, { email: emails.lock, displayName: 'IT Lock', role: 'viewer', password: pw.lock })).ok);
  ids.lock = (await findAuthUser(emails.lock))?.id;
  let last;
  for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) last = await core.runPasswordLogin(deps, { email: emails.lock, password: `${pw.lock}x`, clientIp: ip(8) });
  check('비밀번호 5회 실패 → locked', !last.ok && last.reason === 'locked' && (last.lockedSeconds ?? 0) > 0);
  check('잠금 중에는 올바른 비밀번호도 거부 (GoTrue 호출 전)', (await core.runPasswordLogin(deps, { email: emails.lock, password: pw.lock, clientIp: ip(8) })).reason === 'locked');
  check('같은 계정, 다른 IP 도 계정 키로 잠김', (await core.runPasswordLogin(deps, { email: emails.lock, password: pw.lock, clientIp: ip(9) })).reason === 'locked');
  check('다른 계정은 영향 없음 (IP 키 다름)', (await core.runPasswordLogin(deps, { email: emails.owner1, password: pw.owner1, clientIp: ip(10) })).ok);
  check('잠금 감사 기록', (await auditCount('admin_login_locked')) >= 1);

  // MFA 잠금 — owner2 (factor 초기화됨 → 등록 pending 에서 틀린 코드 5회)
  const l = await core.runPasswordLogin(deps, { email: emails.owner2, password: pw.owner2, clientIp: ip(11) });
  const e = l.ok ? await core.runMfaEnrollStart(deps, l.pending, 'IT') : { ok: false };
  check('owner2 등록 pending', e.ok);
  if (e.ok) {
    let r;
    for (let i = 0; i < 5; i += 1) {
      await waitForFreshStep();
      r = await core.runMfaVerify(deps, e.pending, wrongCode(e.secret));
    }
    check('틀린 코드 5회 → MFA locked', !r.ok && r.reason === 'locked');
    await waitForFreshStep();
    check('잠금 중에는 올바른 코드도 거부 (GoTrue 호출 전)', (await core.runMfaVerify(deps, e.pending, totp(e.secret))).reason === 'locked');
    check('MFA 잠금 감사 기록', (await auditCount('admin_mfa_locked', ids.owner2)) >= 1);
    check('잠금 중 세션 발급 없음', (await service.from('admin_sessions').select('id', { count: 'exact', head: true }).eq('member_user_id', ids.owner2).is('revoked_at', null).gt('expires_at', new Date().toISOString())).count === 0);
  }
}

// ---------------------------------------------------------------------------
// 7. 관리자 웹 HTTP 경로 — 실제 Next 서버 · 쿠키 · 서버 액션 (JS 없는 폼 POST 와 같은 경로)
// ---------------------------------------------------------------------------
if (ADMIN_BASE_URL) {
  section(`7. 관리자 웹 HTTP 요청·쿠키 경로 (${ADMIN_BASE_URL})`);
  const origin = new URL(ADMIN_BASE_URL).origin;

  class Browser {
    constructor() { this.jar = new Map(); }
    cookieHeader() { return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
    absorb(res) {
      for (const sc of res.headers.getSetCookie?.() ?? []) {
        const [pair, ...attrs] = sc.split(';');
        const i = pair.indexOf('=');
        const name = pair.slice(0, i).trim();
        const value = pair.slice(i + 1).trim();
        const gone = attrs.some((a) => /max-age=0/i.test(a) || /expires=.*1970/i.test(a)) || value === '';
        if (gone) this.jar.delete(name);
        else this.jar.set(name, value);
      }
    }
    async get(path) {
      const res = await fetch(`${ADMIN_BASE_URL}${path}`, { redirect: 'manual', headers: { cookie: this.cookieHeader(), accept: 'text/html' } });
      this.absorb(res);
      return { status: res.status, location: res.headers.get('location'), html: await res.text() };
    }
    /** 서버 액션 폼 제출 — 브라우저가 JS 없이 <form action={serverAction}> 을 보내는 것과 같은 요청 (multipart/form-data + $ACTION_ID_ 숨은 필드) */
    async post(path, actionId, fields) {
      const body = new FormData();
      for (const [k, v] of Object.entries(fields)) body.append(k, v);
      body.append(`$ACTION_ID_${actionId}`, '');
      const res = await fetch(`${ADMIN_BASE_URL}${path}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie: this.cookieHeader(), origin, accept: 'text/html' },
        body,
      });
      this.absorb(res);
      return { status: res.status, location: res.headers.get('location'), html: await res.text() };
    }
    has(name) { return this.jar.has(name); }
    set(name, value) { this.jar.set(name, value); }
    cookie(name) { return this.jar.get(name); }
  }

  /** HTML 의 <form> 들에서 서버 액션 id 와 필드 이름을 뽑는다 */
  function forms(html) {
    const out = [];
    const re = /<form\b[\s\S]*?<\/form>/g;
    let m;
    while ((m = re.exec(html))) {
      const f = m[0];
      const id = /\$ACTION_ID_([0-9a-f]+)/.exec(f)?.[1];
      const names = [...f.matchAll(/name="([^"]+)"/g)].map((x) => x[1]).filter((n) => !n.startsWith('$ACTION'));
      if (id) out.push({ id, names });
    }
    return out;
  }
  const isRedirectTo = (r, path) => (r.status === 303 || r.status === 307 || r.status === 302) && !!r.location && (r.location === path || r.location.endsWith(path) || new URL(r.location, ADMIN_BASE_URL).pathname + new URL(r.location, ADMIN_BASE_URL).search === path);

  const anon = new Browser();
  check('HTTP: 미로그인 /users → /login', isRedirectTo(await anon.get('/users'), '/login'));
  check('HTTP: 미로그인 /admins → /login', isRedirectTo(await anon.get('/admins'), '/login'));
  check('HTTP: 미로그인 / → /login', isRedirectTo(await anon.get('/'), '/login'));
  check('HTTP: 공개 정책 페이지는 로그인 없이 200', (await anon.get('/policy/privacy')).status === 200);
  const loginPage = await anon.get('/login');
  const loginForm = forms(loginPage.html).find((f) => f.names.includes('email') && f.names.includes('password'));
  check('HTTP: /login 200 · 로그인 폼(서버 액션) 있음 · 구 공유 비밀번호 폼 없음', loginPage.status === 200 && !!loginForm && !forms(loginPage.html).some((f) => f.names.includes('actor')));
  if (!loginForm) die('로그인 폼의 서버 액션 id 를 찾을 수 없다 — Next 렌더링 확인');

  // owner1: 비밀번호 → pending 쿠키만 → 보호 페이지·mutation 불가
  const ob = new Browser();
  const badPw = await ob.post('/login', loginForm.id, { email: emails.owner1, password: `${pw.owner1}x` });
  check('HTTP: 틀린 비밀번호 → /login?error=bad_credentials · 쿠키 없음', isRedirectTo(badPw, '/login?error=bad_credentials') && !ob.has('bonsim_admin') && !ob.has('bonsim_admin_pending'));
  const step1 = await ob.post('/login', loginForm.id, { email: emails.owner1, password: pw.owner1 });
  check('HTTP: 비밀번호 통과 → /login/mfa · pending 쿠키만', isRedirectTo(step1, '/login/mfa') && ob.has('bonsim_admin_pending') && !ob.has('bonsim_admin'));
  check('HTTP: pending 만으로 /users → /login', isRedirectTo(await ob.get('/users'), '/login'));
  check('HTTP: pending 만으로 / → /login', isRedirectTo(await ob.get('/'), '/login'));
  const mfaPage = await ob.get('/login/mfa');
  const mfaForm = forms(mfaPage.html).find((f) => f.names.includes('code'));
  check('HTTP: /login/mfa 200 · 코드 입력 폼 · (factor 있음) QR 없음', mfaPage.status === 200 && !!mfaForm && !mfaPage.html.includes('otpauth://'));
  if (!mfaForm) die('MFA 폼을 찾을 수 없다');
  await waitForFreshStep();
  const badCode = await ob.post('/login/mfa', mfaForm.id, { code: wrongCode(secrets[ids.owner1]) });
  check('HTTP: 틀린 TOTP → /login/mfa?error=bad_code · 세션 쿠키 없음', isRedirectTo(badCode, '/login/mfa?error=bad_code') && !ob.has('bonsim_admin'));
  await waitForFreshStep();
  const good = await ob.post('/login/mfa', mfaForm.id, { code: totp(secrets[ids.owner1]) });
  check('HTTP: 올바른 TOTP → / · 세션 쿠키 발급 · pending 삭제', isRedirectTo(good, '/') && ob.has('bonsim_admin') && !ob.has('bonsim_admin_pending'));
  check('HTTP: 세션 쿠키가 서명 토큰 형식(p.sig)', /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(ob.cookie('bonsim_admin') ?? ''));
  const home = await ob.get('/');
  check('HTTP: owner 대시보드 200 · 이름·역할 표시', home.status === 200 && home.html.includes('IT Owner') && home.html.includes('>owner<'));
  const adminsPage = await ob.get('/admins');
  const memberForm = forms(adminsPage.html).find((f) => f.names.includes('op') && f.names.includes('user_id'));
  const addForm = forms(adminsPage.html).find((f) => f.names.includes('display_name'));
  check('HTTP: owner /admins 200 · 멤버 조치 폼 · 추가 폼', adminsPage.status === 200 && !!memberForm && !!addForm);
  if (!memberForm || !addForm) die('/admins 의 서버 액션 id 를 찾을 수 없다');
  const logoutForm = forms(home.html).find((f) => f.names.length === 0);
  check('HTTP: 로그아웃 폼(레이아웃) 있음', !!logoutForm);

  // pending 만으로 mutation 직접 호출 → 거부 (owner2 로 새 pending)
  const pb = new Browser();
  await pb.post('/login', loginForm.id, { email: emails.owner2, password: pw.owner2 });
  check('HTTP: owner2 pending 쿠키', pb.has('bonsim_admin_pending') && !pb.has('bonsim_admin'));
  const pendingMut = await pb.post('/admins', memberForm.id, { user_id: ids.viewer, op: 'disable' });
  check('HTTP: pending 만으로 mutation 서버 액션 → /login · 대상 변화 없음', isRedirectTo(pendingMut, '/login') && (await memberRow(ids.viewer))?.status === 'active');

  // 변조 쿠키
  const tb = new Browser();
  const [tp, ts] = (ob.cookie('bonsim_admin') ?? 'a.b').split('.');
  tb.set('bonsim_admin', `${tp}.${ts.slice(0, -2)}xx`);
  check('HTTP: 변조 세션 쿠키 → /login', isRedirectTo(await tb.get('/'), '/login'));
  tb.set('bonsim_admin', core.sessionToken('not-the-server-secret-0123456789', '00000000-0000-4000-8000-000000000000'));
  check('HTTP: 다른 키로 서명한 쿠키 → /login', isRedirectTo(await tb.get('/users'), '/login'));
  tb.set('bonsim_admin', 'v1-legacy-cookie-value');
  check('HTTP: 예전 형식 쿠키 → /login', isRedirectTo(await tb.get('/users'), '/login'));

  // 새 관리자의 HTTP 등록 흐름 (QR/secret 이 HTML 에만) → viewer 권한 검증
  const addHttp = await ob.post('/admins', addForm.id, { email: emails.http, display_name: 'IT Http', role: 'viewer', password: pw.http, password2: pw.http });
  check('HTTP: owner 가 관리자 추가 폼 → /admins?done=added', isRedirectTo(addHttp, '/admins?done=added'));
  ids.http = (await findAuthUser(emails.http))?.id;
  const vb = new Browser();
  await vb.post('/login', loginForm.id, { email: emails.http, password: pw.http });
  const enrollPage = await vb.get('/login/mfa');
  const secretMatch = /<code>([A-Z2-7]{16,})<\/code>/.exec(enrollPage.html);
  check('HTTP: 첫 로그인 /login/mfa 가 등록 화면 (QR SVG · 수동 키)', enrollPage.status === 200 && enrollPage.html.includes('data:image/svg+xml') && !!secretMatch);
  if (secretMatch) {
    secrets[ids.http] = secretMatch[1];
    const enrollForm = forms(enrollPage.html).find((f) => f.names.includes('code'));
    // 브라우저처럼 숨은 필드(fid = 등록 화면이 발급한 factor id)도 함께 보낸다
    const fid = /name="fid" value="([^"]+)"/.exec(enrollPage.html)?.[1] ?? '';
    check('HTTP: 등록 폼에 factor id 숨은 필드', fid.length > 0);
    await waitForFreshStep();
    check('HTTP: 모르는 factor id 로 등록 코드 제출 → /login?error=expired (no_pending) · 세션 없음', isRedirectTo(await vb.post('/login/mfa', enrollForm.id, { code: totp(secrets[ids.http]), fid: '00000000-0000-4000-8000-000000000000' }), '/login?error=expired') && !vb.has('bonsim_admin'));
    // no_pending 은 pending 쿠키를 지운다 → 비밀번호부터 다시 (등록 화면이 새 factor 를 발급한다)
    await vb.post('/login', loginForm.id, { email: emails.http, password: pw.http });
    const enrollPage2 = await vb.get('/login/mfa');
    const secret2 = /<code>([A-Z2-7]{16,})<\/code>/.exec(enrollPage2.html)?.[1];
    const fid2 = /name="fid" value="([^"]+)"/.exec(enrollPage2.html)?.[1] ?? '';
    check('HTTP: 새로고침/재진입 시 새 factor·새 키 발급', !!secret2 && secret2 !== secrets[ids.http] && fid2 && fid2 !== fid);
    secrets[ids.http] = secret2 ?? secrets[ids.http];
    await waitForFreshStep();
    const done = await vb.post('/login/mfa', enrollForm.id, { code: totp(secrets[ids.http]), fid: fid2 });
    check('HTTP: 등록 코드 → 세션 (viewer)', isRedirectTo(done, '/') && vb.has('bonsim_admin'));
    check('HTTP: viewer /users 200 (허용된 조회)', (await vb.get('/users')).status === 200);
    check('HTTP: viewer /audit 200', (await vb.get('/audit')).status === 200);
    const denied = await vb.get('/admins');
    check('HTTP: viewer /admins → /?denied=1', isRedirectTo(denied, '/?denied=1'));
    const vh = await vb.get('/');
    check('HTTP: viewer 대시보드에 관리자 메뉴 없음 (표시) — 서버 검사는 아래', vh.status === 200 && !vh.html.includes('href="/admins"'));
    const mut = await vb.post('/admins', memberForm.id, { user_id: ids.http, op: 'promote' });
    check('HTTP: viewer 가 mutation 서버 액션 직접 호출 → /?denied=1 · 역할 그대로', isRedirectTo(mut, '/?denied=1') && (await memberRow(ids.http))?.role === 'viewer');
    const mut2 = await vb.post('/admins', memberForm.id, { user_id: ids.owner1, op: 'disable' });
    check('HTTP: viewer 의 owner 비활성화 시도 → 거부 · owner 그대로', isRedirectTo(mut2, '/?denied=1') && (await memberRow(ids.owner1))?.status === 'active');
    const usersPage = await vb.get('/users');
    check('HTTP: viewer /users 에 정지 조치 폼 없음 (표시)', !forms(usersPage.html).some((f) => f.names.includes('status')));

    // owner 가 HTTP 로 강등/비활성화/취소 → viewer 브라우저의 다음 요청에 반영
    check('HTTP: owner 가 http 사용자 승격 → done', isRedirectTo(await ob.post('/admins', memberForm.id, { user_id: ids.http, op: 'promote' }), '/admins?done=promote'));
    check('HTTP: 승격이 기존 세션 다음 요청에 반영 (/admins 200)', (await vb.get('/admins')).status === 200);
    check('HTTP: owner 가 다시 강등 → done', isRedirectTo(await ob.post('/admins', memberForm.id, { user_id: ids.http, op: 'demote' }), '/admins?done=demote'));
    check('HTTP: 강등이 기존 세션에 반영 (/admins → denied)', isRedirectTo(await vb.get('/admins'), '/?denied=1'));
    check('HTTP: owner 가 세션 취소 → done', isRedirectTo(await ob.post('/admins', memberForm.id, { user_id: ids.http, op: 'revoke' }), '/admins?done=revoke'));
    check('HTTP: 취소가 기존 세션에 반영 (/ → /login)', isRedirectTo(await vb.get('/'), '/login'));
    // 재로그인 뒤 비활성화
    await vb.post('/login', loginForm.id, { email: emails.http, password: pw.http });
    await waitForFreshStep();
    const re = await vb.post('/login/mfa', mfaForm.id, { code: totp(secrets[ids.http]) });
    check('HTTP: 재로그인 (기존 factor)', isRedirectTo(re, '/') && vb.has('bonsim_admin'));
    check('HTTP: owner 가 비활성화 → done', isRedirectTo(await ob.post('/admins', memberForm.id, { user_id: ids.http, op: 'disable' }), '/admins?done=disable'));
    check('HTTP: 비활성화가 기존 세션에 반영 (/users → /login)', isRedirectTo(await vb.get('/users'), '/login'));
    const dis = await vb.post('/login', loginForm.id, { email: emails.http, password: pw.http });
    check('HTTP: 비활성 계정 로그인 → /login?error=disabled', isRedirectTo(dis, '/login?error=disabled'));
  }

  // 마지막 owner 보호 (owner2 를 viewer 로 두고) · 로그아웃
  check('HTTP: owner2 강등', isRedirectTo(await ob.post('/admins', memberForm.id, { user_id: ids.owner2, op: 'demote' }), '/admins?done=demote'));
  check('HTTP: 마지막 owner 자기 강등 → /admins?error=last_owner', isRedirectTo(await ob.post('/admins', memberForm.id, { user_id: ids.owner1, op: 'demote' }), '/admins?error=last_owner'));
  check('HTTP: 마지막 owner 자기 비활성화 → last_owner', isRedirectTo(await ob.post('/admins', memberForm.id, { user_id: ids.owner1, op: 'disable' }), '/admins?error=last_owner'));
  check('HTTP: owner1 은 여전히 active owner', (await memberRow(ids.owner1))?.role === 'owner' && (await memberRow(ids.owner1))?.status === 'active');
  const sessionCookie = ob.cookie('bonsim_admin');
  const lo = logoutForm ? await ob.post('/', logoutForm.id, {}) : { status: 0 };
  check('HTTP: 로그아웃 → /login · 세션 쿠키 삭제', isRedirectTo(lo, '/login') && !ob.has('bonsim_admin'));
  const replay = new Browser();
  replay.set('bonsim_admin', sessionCookie);
  check('HTTP: 로그아웃한 세션 쿠키 재사용 → /login', isRedirectTo(await replay.get('/'), '/login'));
  check('HTTP: 로그아웃한 쿠키로 mutation → /login', isRedirectTo(await replay.post('/admins', memberForm.id, { user_id: ids.owner2, op: 'promote' }), '/login'));
  check('HTTP: 로그아웃 감사 기록', (await auditCount('admin_logout')) >= 1);
} else {
  console.log('\n(ADMIN_BASE_URL 없음 — 관리자 웹 HTTP 경로는 건너뜀. run_supabase_integration.sh 가 관리자 웹을 띄워 함께 검증한다)');
}

// ---------------------------------------------------------------------------
// 마무리 — 테스트 계정 삭제 (기본) · 결과
// ---------------------------------------------------------------------------
section('정리');
if (process.env.ADMIN_IT_KEEP === '1') console.log('ADMIN_IT_KEEP=1 — 테스트 계정을 남긴다');
else {
  const removed = await cleanupTestUsers();
  const { count } = await service.from('admin_members').select('user_id', { count: 'exact', head: true });
  check(`테스트 계정 삭제 (${removed}) → admin_members 0행 (cascade)`, count === 0);
}

console.log(`\nadmin auth integration: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('실패 목록:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
