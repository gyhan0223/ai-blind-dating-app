#!/usr/bin/env node
/**
 * 관리자 bootstrap · 복구 — 서버 전용 스크립트 (#27). service role key 가 있는 곳(운영자 PC·CI 비밀 환경)에서만 실행한다.
 * 공개 HTTP 경로가 없다 — 이 스크립트가 유일한 "첫 owner 생성" 과 "모든 owner 잠김" 복구 경로다.
 *
 *   node scripts/admin-bootstrap.mjs create-owner --email you@example.com --name "운영자"
 *       비밀번호는 ADMIN_BOOTSTRAP_PASSWORD 환경변수 또는 프롬프트(표시 안 됨)로 받는다. argv 로 받지 않는다 (셸 이력·프로세스 목록 노출 방지).
 *       활성 owner 가 이미 있으면 거부한다 (추가 관리자는 관리자 웹 /admins 에서).
 *   node scripts/admin-bootstrap.mjs reset-mfa --email you@example.com
 *       해당 관리자의 MFA factor 를 모두 삭제하고 세션을 취소한다. 다음 로그인에서 다시 등록한다.
 *   node scripts/admin-bootstrap.mjs list
 *
 * 필요한 환경변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (apps/admin/.env.local 을 자동으로 읽지 않는다 — 셸에서 export)
 * 출력에 비밀번호·secret·토큰은 나오지 않는다.
 */
import { createInterface } from 'node:readline';
import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
const cmd = args[0];
function opt(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function fail(msg) {
  console.error(`오류: ${msg}`);
  process.exit(1);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) fail('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.');
const db = createClient(url, key, { auth: { persistSession: false } });

async function promptHidden(question) {
  if (process.env.ADMIN_BOOTSTRAP_PASSWORD) return process.env.ADMIN_BOOTSTRAP_PASSWORD;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const mute = { on: false };
  const origWrite = rl._writeToOutput;
  rl._writeToOutput = function (s) {
    if (mute.on) return;
    origWrite.call(rl, s);
  };
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      mute.on = false;
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
    mute.on = true;
  });
}

async function findUserByEmail(email) {
  // 관리자 계정 수는 작다 — 첫 페이지들에서 찾는다
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) fail(`Auth 조회 실패: ${error.message}`);
    const u = data.users.find((x) => (x.email ?? '').toLowerCase() === email);
    if (u) return u;
    if (data.users.length < 200) break;
  }
  return null;
}

async function createOwner() {
  const email = (opt('email') ?? '').trim().toLowerCase();
  const name = (opt('name') ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('--email 이 올바르지 않습니다.');
  if (!name) fail('--name 이 필요합니다.');
  const password = await promptHidden('초기 비밀번호 (12자 이상, 입력이 표시되지 않습니다): ');
  if (!password || password.length < 12) fail('비밀번호는 12자 이상이어야 합니다.');

  const { data: owners, error: oerr } = await db.from('admin_members').select('user_id').eq('role', 'owner').eq('status', 'active');
  if (oerr) fail(`admin_members 조회 실패 (0033 마이그레이션 적용 여부 확인): ${oerr.message}`);
  if ((owners ?? []).length > 0) fail('활성 owner 가 이미 있습니다. 추가 관리자는 관리자 웹 /admins 에서 만드세요.');

  let user = await findUserByEmail(email);
  if (user) {
    if (user.app_metadata?.bonsim_admin !== 'true') fail('이 이메일은 앱 사용자 계정입니다. 관리자 전용 이메일을 쓰세요.');
    console.log('기존 관리자 Auth 계정을 재사용합니다 (비밀번호는 바꾸지 않습니다).');
  } else {
    const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { bonsim_admin: 'true' } });
    if (error || !data?.user) fail(`Auth 계정 생성 실패: ${error?.message ?? 'unknown'}`);
    user = data.user;
  }
  const { data: r, error } = await db.rpc('admin_member_bootstrap', { p_user_id: user.id, p_display_name: name });
  if (error) fail(`bootstrap RPC 실패: ${error.message}`);
  if (!r?.ok) fail(`bootstrap 거부: ${r?.reason}`);
  console.log(`완료: owner ${name} (${user.id.slice(0, 8)}…) 를 만들었습니다. 관리자 웹에 로그인해 인증 앱(TOTP)을 등록하세요.`);
}

async function resetMfa() {
  const email = (opt('email') ?? '').trim().toLowerCase();
  if (!email) fail('--email 이 필요합니다.');
  const user = await findUserByEmail(email);
  if (!user) fail('해당 이메일의 Auth 계정이 없습니다.');
  const { data: member } = await db.from('admin_members').select('user_id, display_name').eq('user_id', user.id).maybeSingle();
  if (!member) fail('관리자 membership 이 없는 계정입니다.');
  const { data: factors, error: ferr } = await db.auth.admin.mfa.listFactors({ userId: user.id });
  if (ferr) fail(`factor 조회 실패: ${ferr.message}`);
  for (const f of factors.factors) {
    const { error } = await db.auth.admin.mfa.deleteFactor({ id: f.id, userId: user.id });
    if (error) fail(`factor 삭제 실패: ${error.message}`);
  }
  const { data: r, error } = await db.rpc('admin_member_revoke_sessions', { p_actor: null, p_target: user.id, p_reason: 'bootstrap_reset_mfa' });
  if (error || !r?.ok) fail(`세션 취소 실패: ${error?.message ?? r?.reason}`);
  await db.rpc('admin_audit_record', { p_actor: 'server-bootstrap', p_action: 'admin_mfa_reset', p_target_type: 'admin_member', p_target_id: user.id, p_detail: { by: 'bootstrap', factors: factors.factors.length } });
  console.log(`완료: ${member.display_name} 의 MFA factor ${factors.factors.length}개 삭제 · 세션 취소. 다음 로그인에서 다시 등록합니다.`);
}

async function list() {
  const { data, error } = await db.from('admin_members').select('user_id, display_name, role, status, mfa_verified_at, created_at').order('created_at');
  if (error) fail(error.message);
  for (const m of data ?? []) console.log(`${m.role.padEnd(6)} ${m.status.padEnd(8)} ${m.display_name.padEnd(12)} ${m.user_id.slice(0, 8)}… MFA:${m.mfa_verified_at ? '완료' : '미등록'}`);
  if ((data ?? []).length === 0) console.log('(관리자 없음 — create-owner 로 첫 owner 를 만드세요)');
}

const run = { 'create-owner': createOwner, 'reset-mfa': resetMfa, list };
if (!run[cmd]) fail('사용법: create-owner --email <이메일> --name <이름> | reset-mfa --email <이메일> | list');
run[cmd]().catch((e) => fail(e instanceof Error ? e.message : String(e)));
