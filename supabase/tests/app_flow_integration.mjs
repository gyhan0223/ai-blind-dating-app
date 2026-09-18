#!/usr/bin/env node
/**
 * 앱 요청 통합 테스트 — **실제 로컬 Supabase 스택**(GoTrue · PostgREST · Realtime · Edge Runtime) 에
 * 모바일 앱과 같은 SDK(@supabase/supabase-js) 로 앱이 보내는 요청을 그대로 보낸다 (#13 #24 #17).
 *
 *   로컬 테스트 계정(dev-login Edge Function, 010-0000-04XX 대역) 6개를 만들어 로그인하고
 *   본인확인(verify-identity, mock) → 얼굴 인증(complete-face-verification, mock) → 프로필/소개/설문/가치관/선호(RLS) → 온보딩 완료
 *   → 추천(daily-recommendation · 열람 · 수락 → 매치) → 대화(목록 · 접근 · send_message 멱등 · 읽음 · 지표 · icebreaker)
 *   → **메시지 실시간 전달**(Realtime postgres_changes: 상대가 보낸 메시지 INSERT · 매치 상태 UPDATE)
 *   → 차단(트리거 매치 종료 · 실시간 통지 · 전송 차단 · 오늘 추천 응답에서 제외 · 이후 추천 제외)
 *   → 탈퇴(delete-account · 세션 무효화 · 상대 대화 unavailable · 재로그인 → 복구) → 나가기 · 넘기기 를 순서대로 검사한다.
 *
 *   node supabase/tests/app_flow_integration.mjs
 *   (보통은 supabase/tests/run_supabase_integration.sh 가 로컬 스택 · functions serve 를 띄운 뒤 호출한다 — docs/local-supabase-integration.md)
 *
 * 환경변수
 *   SUPABASE_URL · SUPABASE_ANON_KEY            — 로컬 스택 (supabase status -o env). 원격 호스트면 실행을 거부한다
 *   SUPABASE_SERVICE_ROLE_KEY                    — 이전 실행이 남긴 테스트 계정 정리에만 쓴다 (검사 자체는 사용자 JWT 로만)
 *   APP_IT_KEEP=1 (선택)                          — 끝난 뒤 테스트 계정을 지우지 않는다 (기본은 삭제)
 *   APP_IT_REALTIME_TIMEOUT_MS (선택, 기본 15000) — 실시간 수신 대기 상한
 *
 * 원칙
 *   * 검사는 앱과 같은 경로(anon key + 사용자 JWT · Edge Function · RPC · Realtime 채널)로만 한다. service role 은 계정 정리에만.
 *   * 계정 이메일·비밀번호·토큰·service key 는 어떤 경로로도 출력하지 않는다 (실패 메시지는 검사 이름·상태 코드만).
 *   * 서버 정책(rate limit · RLS · 트리거 · 세션 무효화)을 약화시키거나 우회하지 않는다.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

// ---------------------------------------------------------------------------
// 환경 — 로컬 전용
// ---------------------------------------------------------------------------
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', 'host.docker.internal']);

function die(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(2);
}

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

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
assertLocalUrl('SUPABASE_URL', SUPABASE_URL);
if (!ANON_KEY || !SERVICE_KEY) die('SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY 가 필요합니다');
const KEEP = process.env.APP_IT_KEEP === '1';
const REALTIME_TIMEOUT_MS = Number(process.env.APP_IT_REALTIME_TIMEOUT_MS ?? 15000);
// postgres_changes 는 놓친 행을 나중에 채워 주지 않는다. 클라이언트가 SUBSCRIBED 를 받아도 서버측 WAL 커서가
// 살짝 뒤에 살아나므로, 구독 직후 보낸 첫 메시지가 커서보다 앞서면 영영 전달되지 않는다.
// 구독 확인 뒤 이 시간만큼 기다렸다가 전송해 WAL 구독이 확실히 살아난 뒤에 보낸다.
const REALTIME_SETTLE_MS = Number(process.env.APP_IT_REALTIME_SETTLE_MS ?? 4000);

// ---------------------------------------------------------------------------
// SDK — 앱과 같은 @supabase/supabase-js (apps/mobile 의 node_modules 우선, 없으면 apps/admin)
// ---------------------------------------------------------------------------
function loadSupabaseJs() {
  for (const app of ['mobile', 'admin']) {
    try {
      const req = createRequire(join(ROOT, 'apps', app, 'package.json'));
      const entry = req.resolve('@supabase/supabase-js');
      const mod = req('@supabase/supabase-js');
      let version = '?';
      let dir = dirname(entry);
      for (let i = 0; i < 6; i += 1) {
        try {
          const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
          if (pkg.name === '@supabase/supabase-js') {
            version = pkg.version;
            break;
          }
        } catch {}
        dir = dirname(dir);
      }
      return { createClient: mod.createClient, source: `apps/${app}`, version };
    } catch {}
  }
  return die('@supabase/supabase-js 를 찾지 못했습니다 — apps/mobile 또는 apps/admin 에서 npm ci');
}
const sdk = loadSupabaseJs();
const { createClient } = sdk;
console.log(`== SDK: @supabase/supabase-js ${sdk.version} (${sdk.source}) · Node ${process.version}`);

// ---------------------------------------------------------------------------
// 검사 도우미 — secret 을 출력하지 않는다
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];
class Abort extends Error {}

function check(name, ok, note) {
  if (ok) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    failures.push(name + (note ? ` — ${note}` : ''));
    console.log(`  FAIL ${name}${note ? ` — ${note}` : ''}`);
  }
  return !!ok;
}
/** 이후 단계가 의존하는 검사 — 실패하면 시나리오를 중단한다 */
function must(name, ok, note) {
  if (!check(name, ok, note)) throw new Abort(name);
}
function section(title) {
  console.log(`\n== ${title}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (e) => (e ? `${e.message ?? ''} ${e.code ?? ''} ${e.details ?? ''}`.trim() : '');
/** Realtime 소켓 연결 상태 (진단용 — 버전에 따라 메서드가 없을 수 있어 방어적으로) */
function rtConnected(u) {
  try {
    return typeof u.client.realtime.isConnected === 'function' ? u.client.realtime.isConnected() : 'n/a';
  } catch {
    return 'err';
  }
}

// ---------------------------------------------------------------------------
// 클라이언트 · Edge 호출 (앱의 supabase.ts / edge.ts 와 같은 경로)
// ---------------------------------------------------------------------------
const clients = [];
function anonClient() {
  const c = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  clients.push(c);
  return c;
}
const service = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

/** functions.invoke 결과를 { status, data } 로 — 오류 본문의 error 코드는 읽되 원문·개인정보는 출력하지 않는다 */
async function invoke(client, name, body) {
  const { data, error } = await client.functions.invoke(name, { body });
  if (!error) return { status: 200, data };
  const ctx = error.context;
  if (ctx && typeof ctx.status === 'number') {
    let json = null;
    try {
      json = await ctx.clone().json();
    } catch {}
    return { status: ctx.status, data: json, code: json && typeof json.error === 'string' ? json.error : null };
  }
  return { status: 0, data: null, code: error.name ?? 'fetch_error' };
}
const edgeNote = (r) => `status=${r.status}${r.code ? ` error=${r.code}` : ''}`;

// ---------------------------------------------------------------------------
// 테스트 계정 — dev-login 대역 010-0000-04XX (이메일 dev-010000004XX@bonsim.dev, 서버가 만든다)
// ---------------------------------------------------------------------------
const PHONE_PREFIX = '010000004';
const TEST_EMAIL_RE = /^dev-010000004\d{2}@bonsim\.dev$/;

async function cleanupTestAccounts(label) {
  let removed = 0;
  let page = 1;
  for (;;) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: 200 });
    if (error) die(`${label}: 테스트 계정 목록 조회 실패 (service role)`);
    const users = data?.users ?? [];
    for (const u of users) {
      if (TEST_EMAIL_RE.test(u.email ?? '')) {
        const { error: delErr } = await service.auth.admin.deleteUser(u.id);
        if (delErr) die(`${label}: 테스트 계정 삭제 실패`);
        removed += 1;
      }
    }
    if (users.length < 200) break;
    page += 1;
  }
  console.log(`== ${label}: 이전 테스트 계정 ${removed}개 정리`);
}

/** 앱의 devLoginWithPhone 과 같은 순서: dev-login → signInWithPassword */
async function devLogin(label, suffix) {
  const local = `${PHONE_PREFIX}${suffix}`;
  const e164 = `+82${local.slice(1)}`;
  const client = anonClient();
  const r = await invoke(client, 'dev-login', { phone: e164 });
  must(`${label} dev-login 200 (email/password 발급)`, r.status === 200 && r.data?.email && r.data?.password, edgeNote(r));
  const { data, error } = await client.auth.signInWithPassword({ email: r.data.email, password: r.data.password });
  must(`${label} GoTrue 비밀번호 로그인`, !error && data?.user?.id && data?.session?.access_token, error ? 'sign-in error' : '');
  const token = data.session.access_token;
  // Node 의 @supabase/supabase-js 는 Realtime 소켓에 사용자 JWT 를 자동으로 싣지 않는다.
  // 이걸 안 하면 postgres_changes 가 anon 으로 RLS 를 평가해 messages/matches 행을 하나도 못 받는다 (앱은 세션이 있어 자동 적용됨).
  try {
    await client.realtime.setAuth(token);
  } catch {}
  return { label, client, userId: data.user.id, suffix, token };
}

// ---------------------------------------------------------------------------
// 온보딩 — 앱 화면이 보내는 요청 그대로 (identity → face → profile → intro → questionnaire → values → preferences → done)
// ---------------------------------------------------------------------------
const QUESTION_IDS = [
  'p01', 'p02', 'p03', 'p04', 'p05', 'p06', 'p07', 'p08', 'p09', 'p10',
  'l01', 'l02', 'l03', 'l04', 'l05', 'l06', 'l07', 'l08',
  'r01', 'r02', 'r03', 'r04', 'r05', 'r06', 'r07', 'r08',
];

async function advance(u, step) {
  const { error } = await u.client
    .from('users')
    .update({ onboarding_step: step, onboarding_completed: step === 'done', last_active_at: new Date().toISOString() })
    .eq('id', u.userId);
  return error;
}

async function onboard(u, p) {
  const birthDate = `${p.birthYear}-03-15`;
  // 본인확인 (mock provider — 아무 6자리 코드. identityKey 는 로그인 번호 fixture 에서)
  let r = await invoke(u.client, 'verify-identity', { action: 'request', name: p.nickname, birthDate, carrier: 'SKT' });
  must(`${u.label} verify-identity request → requestId`, r.status === 200 && typeof r.data?.requestId === 'string', edgeNote(r));
  r = await invoke(u.client, 'verify-identity', { action: 'confirm', requestId: r.data.requestId, code: '123456', name: p.nickname, birthDate, carrier: 'SKT' });
  must(
    `${u.label} verify-identity confirm → verified (created/relinked)`,
    r.status === 200 && r.data?.verified === true && ['created', 'relinked'].includes(r.data?.result) && r.data?.ageVerified === true,
    `${edgeNote(r)} result=${r.data?.result ?? ''}`,
  );
  must(`${u.label} onboarding_step=face`, !(await advance(u, 'face')));
  // 얼굴 인증 (개발용 mock 즉시 승인)
  r = await invoke(u.client, 'complete-face-verification', { scenario: 'approved' });
  must(`${u.label} complete-face-verification → approved`, r.status === 200 && r.data?.verified === true && r.data?.status === 'approved', edgeNote(r));
  must(`${u.label} onboarding_step=profile`, !(await advance(u, 'profile')));
  // 프로필 (RLS insert own · 본인확인 출생연도와 일치해야 한다)
  let res = await u.client.from('profiles').upsert({
    user_id: u.userId,
    nickname: p.nickname,
    birth_year: p.birthYear,
    gender: p.gender,
    seeking_gender: p.gender === 'male' ? 'female' : 'male',
    region_code: p.region,
    height_cm: p.height,
    job_group: p.job,
    smoking: 'none',
    drinking: 'sometimes',
    education: 'bachelor',
    religion: 'none',
    mbti: null,
    exercise: 'sometimes',
    hobbies: p.hobbies,
    personality_keywords: p.keywords,
  });
  must(`${u.label} profiles upsert`, !res.error, errText(res.error));
  must(`${u.label} onboarding_step=intro`, !(await advance(u, 'intro')));
  res = await u.client
    .from('profiles')
    .update({ relationship_goal: 'serious', public_answers: { day_off: ['rest_home', 'cafe'], together: ['food_tour'], important: 'honest_talk' } })
    .eq('user_id', u.userId);
  must(`${u.label} 소개(relationship_goal · public_answers) 저장`, !res.error, errText(res.error));
  must(`${u.label} onboarding_step=questionnaire`, !(await advance(u, 'questionnaire')));
  res = await u.client
    .from('questionnaire_responses')
    .upsert(QUESTION_IDS.map((id, i) => ({ user_id: u.userId, question_id: id, value: 1 + ((i + p.seed) % 5) })));
  must(`${u.label} 설문 ${QUESTION_IDS.length}문항 upsert`, !res.error, errText(res.error));
  must(`${u.label} onboarding_step=values`, !(await advance(u, 'values')));
  res = await u.client.from('private_profiles').upsert({
    user_id: u.userId,
    marriage_intent: 4,
    children_intent: 3,
    long_distance_ok: 2,
    contact_frequency: 4,
    date_frequency: 3,
    personal_time_need: 3,
    opposite_sex_friends_ok: 3,
    spending_style: 3,
    religion_importance: 1,
    sensitive_answers: {},
    sensitive_visibility: { past_relationships: false },
  });
  must(`${u.label} 가치관(private_profiles) upsert`, !res.error, errText(res.error));
  must(`${u.label} onboarding_step=preferences`, !(await advance(u, 'preferences')));
  res = await u.client.rpc('preferences_save', {
    p_settings: {
      age_min: 25,
      age_max: 38,
      age_direction: 'any',
      height_min: null,
      height_max: null,
      regions: p.regions,
      smoking_pref: 'any',
      personality_keywords: [],
      personality_importance: 4,
      values_importance: 4,
      lifestyle_importance: 3,
      relationship_importance: 3,
    },
    p_dealbreakers: p.regionStrict ? [{ kind: 'regions', value: { codes: p.regions } }] : [],
  });
  must(`${u.label} preferences_save RPC${p.regionStrict ? ' (지역 필수 조건)' : ''}`, !res.error, errText(res.error));
  const doneErr = await advance(u, 'done');
  must(`${u.label} 온보딩 완료 (onboarding_completed=true — 인증 뒤라 트리거 허용)`, !doneErr, errText(doneErr));
  const me = await u.client
    .from('users')
    .select('status, onboarding_completed, identity_verified, face_verified, age_verified')
    .eq('id', u.userId)
    .single();
  must(
    `${u.label} users 행: active · 온보딩 완료 · 본인/얼굴/성인 인증 플래그 (서버만 갱신)`,
    !me.error && me.data.status === 'active' && me.data.onboarding_completed && me.data.identity_verified && me.data.face_verified && me.data.age_verified,
    errText(me.error) || JSON.stringify(me.data),
  );
}

// ---------------------------------------------------------------------------
// 추천 · 대화 (앱 recommendations.ts / chat.ts 와 같은 요청)
// ---------------------------------------------------------------------------
async function fetchToday(u) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const r = await invoke(u.client, 'daily-recommendation', {});
    if (r.status !== 200) return r;
    const recs = r.data?.recommendations ?? [];
    if (!(r.data?.in_progress === true && recs.length === 0) || attempt === 2) return r;
    await sleep(1500);
  }
  return { status: 0, data: null };
}

async function conversationLists(u) {
  const { data: matches, error } = await u.client
    .from('matches')
    .select('id, status, meetup_state, user_a, user_b, close_kind, closed_by, closed_at, conversations(id, last_message_at)')
    .order('created_at', { ascending: false });
  if (error) return { error };
  const rows = (matches ?? []).filter((m) => m.conversations != null);
  const partnerIds = rows.map((m) => (m.user_a === u.userId ? m.user_b : m.user_a));
  const { data: profiles } = partnerIds.length
    ? await u.client.from('profiles').select('user_id, nickname').in('user_id', partnerIds)
    : { data: [] };
  const nick = new Map((profiles ?? []).map((p) => [p.user_id, p.nickname]));
  const items = rows.map((m) => {
    const conv = Array.isArray(m.conversations) ? m.conversations[0] : m.conversations;
    const partnerId = m.user_a === u.userId ? m.user_b : m.user_a;
    return {
      conversationId: conv?.id,
      matchId: m.id,
      matchStatus: m.status,
      closeKind: m.close_kind ?? null,
      partnerId,
      partnerNickname: nick.get(partnerId) ?? (m.status === 'active' ? '알 수 없음' : '종료된 대화 상대'),
      embedIsObject: !Array.isArray(m.conversations),
    };
  });
  return { active: items.filter((c) => c.matchStatus === 'active'), closed: items.filter((c) => c.matchStatus !== 'active') };
}

async function access(u, conversationId) {
  const { data, error } = await u.client.rpc('conversation_access', { cid: conversationId });
  return error ? { can_chat: false, reason: `error:${errText(error)}` } : data;
}

async function send(u, conversationId, clientMessageId, content) {
  const { data, error } = await u.client.rpc('send_message', { p_conversation_id: conversationId, p_client_message_id: clientMessageId, p_content: content });
  const row = Array.isArray(data) ? data[0] : data;
  return { row, error };
}

/** 앱 chat.ts subscribeToConversation 과 같은 채널 — 새 메시지 INSERT · 매치 UPDATE */
function subscribe(u, conversationId, matchId) {
  // 구독 직전 현재 사용자 JWT 를 Realtime 에 다시 실어 준다 (재로그인·토큰 갱신 후에도 RLS 통과)
  try {
    if (u.token) u.client.realtime.setAuth(u.token);
  } catch {}
  const inbox = { messages: [], matchUpdates: [], statuses: [], lastError: null };
  const waiters = [];
  const notify = () => {
    for (const w of waiters.splice(0)) w();
  };
  const channel = u.client
    .channel(`conversation:${conversationId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` }, (payload) => {
      inbox.messages.push(payload.new);
      notify();
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'matches', filter: `id=eq.${matchId}` }, (payload) => {
      inbox.matchUpdates.push(payload.new);
      notify();
    })
    .subscribe((status, err) => {
      inbox.statuses.push(status);
      if (err) inbox.lastError = err;
      notify();
    });
  /** 조건이 참이 될 때까지(또는 timeout) 기다린다 — 폴링 없이 이벤트 도착 시 재평가 */
  const waitFor = (pred, timeoutMs = REALTIME_TIMEOUT_MS) =>
    new Promise((resolve) => {
      if (pred(inbox)) return resolve(true);
      let done = false;
      const tick = () => {
        if (done) return;
        if (pred(inbox)) finish(true);
        else waiters.push(tick);
      };
      const timer = setTimeout(() => finish(pred(inbox)), timeoutMs);
      function finish(v) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const i = waiters.indexOf(tick);
        if (i >= 0) waiters.splice(i, 1);
        resolve(v);
      }
      waiters.push(tick);
      return undefined;
    });
  const close = () => u.client.removeChannel(channel);
  return { inbox, waitFor, close };
}

async function subscribed(sub, label) {
  const ok = await sub.waitFor((i) => i.statuses.includes('SUBSCRIBED'), 20000);
  const last = sub.inbox.statuses[sub.inbox.statuses.length - 1] ?? '(none)';
  must(
    `${label} Realtime 채널 SUBSCRIBED (postgres_changes messages/matches)`,
    ok,
    `status=${last}${sub.inbox.lastError ? ' (channel error — 로컬 config.toml [realtime] enabled=true 인지)' : ''}`,
  );
  // WAL 커서가 살아날 여유 — 이 뒤에 보낸 메시지부터 확실히 전달된다 (postgres_changes 는 놓친 행을 채우지 않는다)
  await sleep(REALTIME_SETTLE_MS);
}

// ---------------------------------------------------------------------------
// 시나리오
// ---------------------------------------------------------------------------
async function run() {
  await cleanupTestAccounts('시작');

  // ===== 1. 로컬 테스트 계정 + 온보딩 (A 남·서울, B 여·서울) =====
  section('1) 로컬 테스트 계정 (dev-login) · 온보딩 — A(남·서울) · B(여·서울)');
  const A = await devLogin('A', '01');
  const B = await devLogin('B', '02');
  check('A·B 는 서로 다른 계정', A.userId !== B.userId);
  {
    const again = anonClient();
    const r = await invoke(again, 'dev-login', { phone: '+821000000401' });
    check('같은 번호 dev-login 재호출 → 같은 계정 (200)', r.status === 200 && r.data?.email, edgeNote(r));
  }
  {
    const r = await invoke(A.client, 'daily-recommendation', {});
    check('온보딩 전 daily-recommendation → 403 not_ready', r.status === 403 && r.code === 'not_ready', edgeNote(r));
  }
  await onboard(A, { nickname: '통합A', birthYear: 1993, gender: 'male', region: 'seoul', height: 178, job: 'it', hobbies: ['travel', 'sports'], keywords: ['calm', 'honest'], regions: ['seoul'], regionStrict: false, seed: 1 });
  await onboard(B, { nickname: '통합B', birthYear: 1995, gender: 'female', region: 'seoul', height: 163, job: 'creative', hobbies: ['travel', 'cafe'], keywords: ['positive', 'curious'], regions: ['seoul'], regionStrict: false, seed: 2 });
  {
    // 본인확인 결과와 다른 출생연도는 거부 (프로필 보호 트리거)
    const res = await A.client.from('profiles').update({ birth_year: 1990 }).eq('user_id', A.userId);
    check('A 출생연도 변경 시도 → 거부 (본인확인 값과 잠김)', !!res.error, res.error ? '' : 'update allowed');
  }

  // ===== 2. 추천 =====
  section('2) 추천 — A 와 B 가 서로 소개된다 (후보는 서로뿐)');
  let rA = await fetchToday(A);
  must('A daily-recommendation 200', rA.status === 200, edgeNote(rA));
  const recsA = rA.data.recommendations ?? [];
  must('A 오늘 추천 1건 · daily_limit 1 · exhausted 아님', recsA.length === 1 && rA.data.daily_limit === 1 && rA.data.exhausted !== true, JSON.stringify({ n: recsA.length, exhausted: rA.data.exhausted, slots_full: rA.data.slots_full }));
  const recAB = recsA[0];
  must('A 의 추천 후보 = B', recAB.candidate_id === B.userId && recAB.status === 'pending');
  {
    const card = recAB.card ?? {};
    check('카드: 닉네임·나이·지역·인증 배지 (공개 필드만)', card.nickname === '통합B' && typeof card.age === 'number' && card.region_code === 'seoul' && card.identity_verified === true && card.face_verified === true, JSON.stringify(Object.keys(card)));
    check('카드에 비공개 필드 없음 (private/설문/점수/전화)', !('marriage_intent' in card) && !('phone' in card) && !('score_total' in card) && !('questionnaire' in card));
    check('카드 소개 문장(intro)·public_answers 포함', typeof card.intro === 'string' && card.intro.length > 0 && Array.isArray(card.public_answers), `intro=${typeof card.intro}`);
    const again = await fetchToday(A);
    check('A 재요청 → 같은 추천 (하루 1건 멱등)', again.status === 200 && (again.data.recommendations ?? []).length === 1 && again.data.recommendations[0].id === recAB.id, edgeNote(again));
    const viewed = await A.client.rpc('recommendation_mark_viewed', { p_recommendation_id: recAB.id });
    const viewed2 = await A.client.rpc('recommendation_mark_viewed', { p_recommendation_id: recAB.id });
    check('recommendation_mark_viewed 멱등', !viewed.error && !viewed2.error, errText(viewed.error || viewed2.error));
    const row = await A.client.from('recommendations').select('viewed_at, status').eq('id', recAB.id).single();
    check('viewed_at 기록됨 (RLS own)', !row.error && row.data.viewed_at != null, errText(row.error));
    const other = await B.client.from('recommendations').select('id').eq('id', recAB.id);
    check('B 는 A 의 추천 행을 볼 수 없음 (RLS)', !other.error && (other.data ?? []).length === 0);
  }
  const rB = await fetchToday(B);
  must('B daily-recommendation 200 · 후보 = A', rB.status === 200 && (rB.data.recommendations ?? []).length === 1 && rB.data.recommendations[0].candidate_id === A.userId, edgeNote(rB));
  const recBA = rB.data.recommendations[0];
  {
    const acc = await A.client.rpc('recommendation_accept', { p_recommendation_id: recAB.id });
    must('A 수락 → liked (상대 미수락)', !acc.error && acc.data?.result === 'liked' && !acc.data?.match_id, errText(acc.error) || JSON.stringify(acc.data));
    const retry = await A.client.rpc('recommendation_accept', { p_recommendation_id: recAB.id });
    check('A 수락 재시도 → liked · retry=true (멱등)', !retry.error && retry.data?.result === 'liked' && retry.data?.retry === true, JSON.stringify(retry.data));
  }
  const accB = await B.client.rpc('recommendation_accept', { p_recommendation_id: recBA.id });
  must('B 수락 → matched · match_id', !accB.error && accB.data?.result === 'matched' && typeof accB.data?.match_id === 'string', errText(accB.error) || JSON.stringify(accB.data));
  const match1 = accB.data.match_id;

  // ===== 3. 대화 + 실시간 =====
  section('3) 대화 — 목록 · 접근 · 전송(멱등) · 실시간 수신 · 읽음 · 지표 · icebreaker');
  const listA = await conversationLists(A);
  must('A 대화 목록: 진행 중 1 · 대화방 id 있음', !listA.error && listA.active.length === 1 && !!listA.active[0].conversationId, errText(listA.error));
  const conv1 = listA.active[0].conversationId;
  check('A 목록: 상대 닉네임 = 통합B (매치 중 프로필 공개)', listA.active[0].partnerNickname === '통합B', listA.active[0].partnerNickname);
  check('matches→conversations 임베드가 단일 객체 (앱 chat.ts 가 기대하는 형태)', listA.active[0].embedIsObject === true);
  const listB = await conversationLists(B);
  check('B 대화 목록: 같은 대화방', !listB.error && listB.active.length === 1 && listB.active[0].conversationId === conv1);
  {
    const acc = await access(A, conv1);
    check('A conversation_access → ok', acc.can_chat === true && acc.reason === 'ok', JSON.stringify(acc));
    const stranger = anonClient();
    const { data, error } = await stranger.rpc('conversation_access', { cid: conv1 });
    check('비로그인 conversation_access → forbidden', !error && data?.reason === 'forbidden' && data?.can_chat === false, errText(error) || JSON.stringify(data));
  }
  const subB = subscribe(B, conv1, match1);
  await subscribed(subB, 'B');
  const subA = subscribe(A, conv1, match1);
  await subscribed(subA, 'A');

  const cid1 = crypto.randomUUID();
  const m1 = await send(A, conv1, cid1, '안녕하세요, 반가워요!');
  must('A send_message RPC → 저장 행', !m1.error && m1.row?.id && m1.row.sender_id === A.userId && m1.row.client_message_id === cid1, errText(m1.error));
  {
    const got = await subB.waitFor((i) => i.messages.some((m) => m.id === m1.row.id));
    must(
      `B 가 A 의 메시지를 Realtime 으로 수신 (${REALTIME_TIMEOUT_MS}ms 안)`,
      got,
      `received=${subB.inbox.messages.length} A_received=${subA.inbox.messages.length} B_connected=${rtConnected(B)} statuses=${subB.inbox.statuses.join('>')}`,
    );
    const evt = subB.inbox.messages.find((m) => m.id === m1.row.id);
    check('실시간 payload 에 본문·발신자·conversation_id 포함', evt.content === '안녕하세요, 반가워요!' && evt.sender_id === A.userId && evt.conversation_id === conv1);
    const echo = await subA.waitFor((i) => i.messages.some((m) => m.id === m1.row.id));
    check('발신자 A 도 같은 INSERT 를 수신 (양쪽 구독)', echo);
  }
  {
    const again = await send(A, conv1, cid1, '안녕하세요, 반가워요!');
    check('같은 client_message_id 재전송 → 같은 행 (중복 없음)', !again.error && again.row?.id === m1.row.id, errText(again.error));
    const mismatch = await send(A, conv1, cid1, '다른 내용');
    check('같은 키 · 다른 내용 → message_content_mismatch', !!mismatch.error && errText(mismatch.error).includes('message_content_mismatch'), errText(mismatch.error));
    const empty = await send(A, conv1, crypto.randomUUID(), '   ');
    check('빈 본문 → invalid_content', !!empty.error && errText(empty.error).includes('invalid_content'), errText(empty.error));
    await sleep(300);
    check('재전송·거부된 전송은 Realtime 으로 오지 않음 (B 수신 1건)', subB.inbox.messages.filter((m) => m.conversation_id === conv1).length === 1, `received=${subB.inbox.messages.length}`);
  }
  {
    const page = await B.client
      .from('messages')
      .select('id, conversation_id, sender_id, content, created_at, read_at, client_message_id')
      .eq('conversation_id', conv1)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(50);
    check('B 메시지 페이지 조회: 1건 · 안 읽음', !page.error && page.data?.length === 1 && page.data[0].read_at == null, errText(page.error));
    const read = await B.client.from('messages').update({ read_at: new Date().toISOString() }).eq('conversation_id', conv1).neq('sender_id', B.userId).is('read_at', null).select('id');
    check('B 읽음 처리 (상대 메시지만) → 1건', !read.error && (read.data ?? []).length === 1, errText(read.error));
    const seen = await A.client.from('messages').select('read_at').eq('id', m1.row.id).single();
    check('A 가 read_at 을 봄', !seen.error && seen.data.read_at != null);
    const m2 = await send(B, conv1, crypto.randomUUID(), '저도 반가워요 :)');
    check('B 답장 저장', !m2.error && m2.row?.sender_id === B.userId, errText(m2.error));
    const gotA = await subA.waitFor((i) => i.messages.some((m) => m2.row && m.id === m2.row.id));
    check('A 가 B 의 답장을 Realtime 으로 수신', gotA);
    const metrics = await A.client.from('conversation_metrics').select('total_messages').eq('conversation_id', conv1).maybeSingle();
    check('conversation_metrics.total_messages = 2', !metrics.error && metrics.data?.total_messages === 2, errText(metrics.error) || JSON.stringify(metrics.data));
    const detail = await A.client.from('conversations').select('id, icebreaker, match_id, matches(id, status, meetup_state, mutual_interest_at, close_kind, closed_by, user_a, user_b)').eq('id', conv1).single();
    check('대화방 상세 조회 (conversations + matches 임베드)', !detail.error && detail.data?.matches?.status === 'active', errText(detail.error));
    const ice = await invoke(A.client, 'icebreaker', { conversationId: conv1 });
    check('icebreaker Edge → 200 · 시작 질문 캐시', ice.status === 200 && ice.data && typeof ice.data === 'object' && 'icebreaker' in ice.data, edgeNote(ice));
    const outsider = anonClient();
    const leak = await outsider.from('messages').select('id').eq('conversation_id', conv1);
    check('비로그인(anon) 메시지 조회 → 0행', !leak.error && (leak.data ?? []).length === 0, errText(leak.error));
  }

  // ===== 4. 차단 =====
  section('4) 차단 — A 가 B 를 차단: 트리거 매치 종료 · Realtime 통지 · 전송 차단 · 추천 제외');
  {
    const blk = await A.client.from('blocks').insert({ blocker_id: A.userId, blocked_id: B.userId });
    must('A blocks insert', !blk.error, errText(blk.error));
    const dup = await A.client.from('blocks').insert({ blocker_id: A.userId, blocked_id: B.userId });
    check('같은 차단 재시도 → duplicate 오류 (앱은 무시)', !!dup.error && /duplicate/i.test(errText(dup.error)), errText(dup.error));
    const gotB = await subB.waitFor((i) => i.matchUpdates.some((m) => m.id === match1 && m.status === 'blocked'));
    check('B 가 매치 UPDATE(status=blocked) 를 Realtime 으로 수신', gotB, `updates=${JSON.stringify(subB.inbox.matchUpdates.map((m) => m.status))}`);
    const mt = await B.client.from('matches').select('status, close_kind').eq('id', match1).single();
    check('matches.status = blocked (트리거)', !mt.error && mt.data.status === 'blocked', errText(mt.error) || JSON.stringify(mt.data));
    const accA = await access(A, conv1);
    const accB2 = await access(B, conv1);
    check('차단 뒤 conversation_access → ended (양쪽)', accA.reason === 'ended' && accB2.reason === 'ended', JSON.stringify([accA, accB2]));
    const blocked = await send(B, conv1, crypto.randomUUID(), '차단 뒤 전송');
    check('차단 뒤 B 전송 → 거부', !!blocked.error, 'send allowed');
    const blocked2 = await send(A, conv1, crypto.randomUUID(), '차단자 전송');
    check('차단 뒤 A 전송 → 거부', !!blocked2.error, 'send allowed');
    const hist = await B.client.from('messages').select('id').eq('conversation_id', conv1);
    check('차단 뒤에도 이전 메시지 열람 가능 (2건)', !hist.error && (hist.data ?? []).length === 2);
    const listA2 = await conversationLists(A);
    check('A 목록: 진행 중 0 · 종료 1 · 상대 닉네임 숨김', !listA2.error && listA2.active.length === 0 && listA2.closed.length === 1 && listA2.closed[0].partnerNickname === '종료된 대화 상대', JSON.stringify(listA2.closed?.map((c) => c.partnerNickname)));
    const seeB = await A.client.from('profiles').select('nickname').eq('user_id', B.userId);
    check('차단 뒤 상대 프로필 RLS 로 비공개 (0행)', !seeB.error && (seeB.data ?? []).length === 0);
    const other = await B.client.from('blocks').select('id').eq('blocker_id', A.userId);
    check('B 는 자신이 차단당한 사실을 조회할 수 없음 (RLS)', !other.error && (other.data ?? []).length === 0);
    const rA2 = await fetchToday(A);
    check('차단 뒤 A 오늘 추천 응답: 차단 상대 제외 (0건 · exhausted 아님)', rA2.status === 200 && (rA2.data.recommendations ?? []).length === 0 && rA2.data.exhausted !== true, `${edgeNote(rA2)} n=${(rA2.data?.recommendations ?? []).length}`);
  }
  subA.close();
  subB.close();

  // ===== 5. 두 번째 쌍 (C 여·부산, D 남·부산 — 지역 필수 조건으로 서로만 후보) =====
  section('5) 두 번째 쌍 — C(여·부산) · D(남·부산), 지역 필수 조건 → 서로만 소개 → 매치');
  const C = await devLogin('C', '03');
  const D = await devLogin('D', '04');
  await onboard(C, { nickname: '통합C', birthYear: 1996, gender: 'female', region: 'busan', height: 160, job: 'education', hobbies: ['reading', 'pets'], keywords: ['calm', 'detailed'], regions: ['busan'], regionStrict: true, seed: 3 });
  await onboard(D, { nickname: '통합D', birthYear: 1994, gender: 'male', region: 'busan', height: 175, job: 'finance', hobbies: ['games', 'movies'], keywords: ['humorous', 'positive'], regions: ['busan'], regionStrict: true, seed: 4 });
  const rC = await fetchToday(C);
  must('C 추천 → D (A 는 지역 필수 조건으로 제외)', rC.status === 200 && (rC.data.recommendations ?? []).length === 1 && rC.data.recommendations[0].candidate_id === D.userId, `${edgeNote(rC)} cand=${rC.data?.recommendations?.[0]?.candidate_id === A.userId ? 'A' : rC.data?.recommendations?.length}`);
  const rD = await fetchToday(D);
  must('D 추천 → C (B 는 지역 필수 조건으로 제외)', rD.status === 200 && (rD.data.recommendations ?? []).length === 1 && rD.data.recommendations[0].candidate_id === C.userId, edgeNote(rD));
  {
    const a1 = await C.client.rpc('recommendation_accept', { p_recommendation_id: rC.data.recommendations[0].id });
    must('C 수락 → liked', !a1.error && a1.data?.result === 'liked', errText(a1.error) || JSON.stringify(a1.data));
  }
  const accD = await D.client.rpc('recommendation_accept', { p_recommendation_id: rD.data.recommendations[0].id });
  must('D 수락 → matched', !accD.error && accD.data?.result === 'matched' && accD.data?.match_id, errText(accD.error) || JSON.stringify(accD.data));
  const match2 = accD.data.match_id;
  const listC = await conversationLists(C);
  must('C 대화 목록: 진행 중 1', !listC.error && listC.active.length === 1 && listC.active[0].matchId === match2, errText(listC.error));
  const conv2 = listC.active[0].conversationId;
  const subC = subscribe(C, conv2, match2);
  await subscribed(subC, 'C');
  {
    const m = await send(D, conv2, crypto.randomUUID(), '부산에서 인사드려요');
    must('D 전송', !m.error && m.row?.id, errText(m.error));
    const got = await subC.waitFor((i) => i.messages.some((x) => x.id === m.row.id));
    check('C 가 D 의 메시지를 Realtime 으로 수신 (두 번째 대화방)', got);
  }

  // ===== 6. 탈퇴 → 상대 대화 unavailable → 재로그인 복구 =====
  section('6) 탈퇴 — D delete-account: 세션 무효화 · C 의 대화 unavailable · 재로그인 후 복구');
  {
    const del = await invoke(D.client, 'delete-account', { action: 'delete' });
    must('D delete-account → deleted:true', del.status === 200 && del.data?.deleted === true, edgeNote(del));
    const revoked = await invoke(D.client, 'delete-account', { action: 'reactivate' });
    check('탈퇴 직후 기존 세션으로 Edge 호출 → 401 (global sign-out)', revoked.status === 401, edgeNote(revoked));
    const refresh = await D.client.auth.refreshSession();
    check('탈퇴 직후 refresh token 도 무효', !!refresh.error || !refresh.data?.session, refresh.error ? '' : 'refresh succeeded');
    const accC = await access(C, conv2);
    check('C conversation_access → unavailable (상대 탈퇴)', accC.can_chat === false && accC.reason === 'unavailable', JSON.stringify(accC));
    const blocked = await send(C, conv2, crypto.randomUUID(), '탈퇴한 상대에게');
    check('탈퇴한 상대에게 전송 → 거부', !!blocked.error, 'send allowed');
    const stale = await D.client.from('users').select('status').eq('id', D.userId).maybeSingle();
    console.log(`  info 탈퇴 직후 기존 access token 의 PostgREST 조회: ${stale.error ? 'error' : `status=${stale.data?.status ?? 'null'}`} (JWT 만료까지 유효 — 세션 검사는 GoTrue/Edge 에서)`);
  }
  const D2 = await devLogin('D(재로그인)', '04');
  must('재로그인은 같은 계정', D2.userId === D.userId);
  {
    const me = await D2.client.from('users').select('status').eq('id', D2.userId).single();
    check('재로그인 뒤 users.status = deleted (앱은 복구 안내 화면)', !me.error && me.data.status === 'deleted', errText(me.error) || JSON.stringify(me.data));
    const rec = await invoke(D2.client, 'daily-recommendation', {});
    check('탈퇴 상태 daily-recommendation → 403 not_ready', rec.status === 403 && rec.code === 'not_ready', edgeNote(rec));
    const re = await invoke(D2.client, 'delete-account', { action: 'reactivate' });
    must('reactivate → reactivated:true · fresh_start:false (유예 중 복구)', re.status === 200 && re.data?.reactivated === true && re.data?.fresh_start === false, edgeNote(re));
    const again = await invoke(D2.client, 'delete-account', { action: 'reactivate' });
    check('이미 복구된 계정 reactivate → 400 not_deleted', again.status === 400 && again.code === 'not_deleted', edgeNote(again));
    const me2 = await D2.client.from('users').select('status, onboarding_completed').eq('id', D2.userId).single();
    check('복구 뒤 status=active · 온보딩 완료 유지', !me2.error && me2.data.status === 'active' && me2.data.onboarding_completed === true, JSON.stringify(me2.data));
    const accC = await access(C, conv2);
    check('복구 뒤 C conversation_access → ok (대화 이어짐)', accC.can_chat === true && accC.reason === 'ok', JSON.stringify(accC));
    const m = await send(D2, conv2, crypto.randomUUID(), '다시 돌아왔어요');
    check('복구 뒤 D 전송 가능', !m.error && m.row?.id, errText(m.error));
    const got = await subC.waitFor((i) => i.messages.some((x) => m.row && x.id === m.row.id));
    check('복구 뒤 메시지도 C 에게 Realtime 전달', got);
  }

  // ===== 7. 대화 나가기 =====
  section('7) 대화 나가기 — D 가 나감: 한 번만 종료 · 이유 비공개 · Realtime 통지 · 이전 메시지 열람');
  {
    const lv = await D2.client.rpc('conversation_leave', { p_match_id: match2, p_reason: 'not_a_fit' });
    must('D conversation_leave → left', !lv.error && lv.data?.already_closed === false && lv.data?.close_kind === 'left' && lv.data?.closed_by === D2.userId, errText(lv.error) || JSON.stringify(lv.data));
    const got = await subC.waitFor((i) => i.matchUpdates.some((m) => m.id === match2 && m.status !== 'active'));
    check('C 가 매치 종료 UPDATE 를 Realtime 으로 수신', got, `updates=${JSON.stringify(subC.inbox.matchUpdates.map((m) => m.status))}`);
    const evt = subC.inbox.matchUpdates.find((m) => m.id === match2 && m.status !== 'active');
    check('Realtime 매치 payload 에 종료 이유 없음 (상대 비공개)', !evt || !('reason' in evt));
    const accC = await access(C, conv2);
    check('C conversation_access → ended', accC.reason === 'ended', JSON.stringify(accC));
    const lv2 = await C.client.rpc('conversation_leave', { p_match_id: match2, p_reason: null });
    check('C 도 나가기 → already_closed:true', !lv2.error && lv2.data?.already_closed === true, errText(lv2.error) || JSON.stringify(lv2.data));
    const exitsC = await C.client.from('conversation_exits').select('reason').eq('match_id', match2);
    check('C 는 상대의 종료 이유를 볼 수 없음 (0행)', !exitsC.error && (exitsC.data ?? []).length === 0);
    const exitsD = await D2.client.from('conversation_exits').select('reason').eq('match_id', match2);
    check('D 본인 종료 이유는 조회됨', !exitsD.error && exitsD.data?.length === 1 && exitsD.data[0].reason === 'not_a_fit', JSON.stringify(exitsD.data));
    const hist = await C.client.from('messages').select('id').eq('conversation_id', conv2);
    check('종료된 대화의 이전 메시지 열람 가능 (2건)', !hist.error && (hist.data ?? []).length === 2, `${(hist.data ?? []).length}`);
    const listC2 = await conversationLists(C);
    check('C 목록: 종료 1 (close_kind=left)', !listC2.error && listC2.closed.length === 1 && listC2.closed[0].closeKind === 'left');
  }
  subC.close();

  // ===== 8. 넘기기 · 차단 후 추천 제외 =====
  section('8) 넘기기 — E(여·부산): D 소개 → 넘김 → 재요청에 새 소개 없음 · 재결정 거부');
  const E = await devLogin('E', '05');
  await onboard(E, { nickname: '통합E', birthYear: 1997, gender: 'female', region: 'busan', height: 165, job: 'office', hobbies: ['movies'], keywords: ['energetic'], regions: ['busan'], regionStrict: true, seed: 5 });
  {
    const r = await fetchToday(E);
    must('E 추천 → D (복구·나간 뒤 다시 후보)', r.status === 200 && (r.data.recommendations ?? []).length === 1 && r.data.recommendations[0].candidate_id === D.userId, edgeNote(r));
    const rec = r.data.recommendations[0];
    const skip = await E.client
      .from('recommendations')
      .update({ status: 'skipped', decided_at: new Date().toISOString(), skip_reason: 'age', skip_reason_detail: 'too_old' })
      .eq('id', rec.id)
      .select('status');
    check('E 넘기기 (앱 update) → skipped', !skip.error && skip.data?.[0]?.status === 'skipped', errText(skip.error));
    const r2 = await fetchToday(E);
    check('넘긴 뒤 재요청 → 새 소개 없음 (하루 1건 소진 · pending 0)', r2.status === 200 && (r2.data.recommendations ?? []).every((x) => x.status !== 'pending') && r2.data.exhausted !== true, `${edgeNote(r2)} statuses=${JSON.stringify((r2.data?.recommendations ?? []).map((x) => x.status))}`);
    const redo = await E.client.from('recommendations').update({ status: 'accepted', decided_at: new Date().toISOString() }).eq('id', rec.id);
    check('skipped → accepted 재결정 → 거부', !!redo.error, 'update allowed');
  }
  section('8b) 차단 후 추천 제외 — F(여·부산) 가 D 를 먼저 차단 → 소개 없음(exhausted)');
  const F = await devLogin('F', '06');
  await onboard(F, { nickname: '통합F', birthYear: 1995, gender: 'female', region: 'busan', height: 158, job: 'medical', hobbies: ['cooking'], keywords: ['thoughtful'], regions: ['busan'], regionStrict: true, seed: 6 });
  {
    const blk = await F.client.from('blocks').insert({ blocker_id: F.userId, blocked_id: D.userId });
    must('F blocks D', !blk.error, errText(blk.error));
    const r = await fetchToday(F);
    check('F 추천 → 0건 · exhausted:true (차단한 D 는 후보에서 제외)', r.status === 200 && (r.data.recommendations ?? []).length === 0 && r.data.exhausted === true, `${edgeNote(r)} n=${(r.data?.recommendations ?? []).length} exhausted=${r.data?.exhausted}`);
  }

  // ===== 9. 정리 =====
  section('9) 정리');
  {
    const outsider = anonClient();
    const { data, error } = await outsider.from('profiles').select('user_id');
    check('anon 프로필 조회 → 0행', !error && (data ?? []).length === 0, errText(error));
  }
}

let exitCode = 0;
try {
  await run();
} catch (e) {
  if (e instanceof Abort) {
    console.error(`\n중단: 이후 단계가 의존하는 검사 실패 — ${e.message}`);
  } else {
    console.error(`\n예외: ${e?.message ?? e}`);
    failed += 1;
    failures.push(`exception: ${e?.message ?? e}`);
  }
  exitCode = 1;
} finally {
  for (const c of clients) {
    try {
      await c.removeAllChannels();
      c.realtime.disconnect();
    } catch {}
  }
  if (!KEEP) {
    try {
      await cleanupTestAccounts('종료');
    } catch (e) {
      console.error(`정리 실패: ${e?.message ?? e}`);
      exitCode = exitCode || 1;
    }
  } else {
    console.log('== APP_IT_KEEP=1: 테스트 계정 유지');
  }
}
console.log(`\n== app integration: ${passed} passed, ${failed} failed`);
if (failures.length) {
  for (const f of failures) console.log(`   - ${f}`);
}
process.exit(failed > 0 || exitCode ? 1 : 0);
