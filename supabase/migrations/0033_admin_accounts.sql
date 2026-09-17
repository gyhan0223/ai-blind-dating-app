-- 0033_admin_accounts.sql
-- Issue #27 — 관리자 개인 계정 · 최소 권한(owner/viewer) · 서버 검증 세션 · MFA 완료 기록.
--
-- 이전: 관리자 웹은 공유 ADMIN_PASSWORD + 로그인 때 입력한 임의 처리자 이름을 썼다. 이름은 검증된 개인 식별자가 아니었다.
-- 이후:
--   * 관리자 = Supabase Auth 의 개별 계정(이메일+비밀번호, app_metadata.bonsim_admin=true) + 이 테이블의 membership.
--     membership 은 서버(service role)만 만든다 — 앱 사용자가 가입하거나 user metadata 를 고쳐서 관리자가 될 수 없다
--     (권한 판정은 metadata 가 아니라 admin_members 행이다. metadata 표식은 앱 사용자 테이블에 관리자 행이 생기지 않게 하는 용도).
--   * 역할은 owner / viewer 둘 뿐. 마지막 활성 owner 는 강등·비활성화할 수 없다 (행 잠금 아래에서 판정 — 동시 변경에도 유지).
--   * 세션은 DB 행(admin_sessions)이다. 쿠키에는 세션 id + 서명만 있고 역할·MFA 여부는 매 요청 DB 에서 읽는다
--     → 비활성화·강등·세션 취소가 이미 발급된 세션에 즉시 반영된다. 세션은 MFA(aal2) 를 통과한 뒤에만 발급된다.
--   * mfa_verified_at: 이 계정이 MFA 로 로그인을 완료한 적이 있는지. 하나라도 있으면 구 공유 비밀번호 로그인 경로는 닫힌다 (admin_legacy_login_allowed).
--   * 모든 RPC 는 service role 전용 (auth.uid() 가 있으면 거부). 테이블은 RLS + grant 회수.
--   * 감사: admin_audit_log.actor 에는 관리자 auth user id(불변)가 들어가고 표시 이름은 detail.actor_name 에만 (관리자 웹).

-- ---------------------------------------------------------------------------
-- 관리자 계정은 앱 사용자 행을 만들지 않는다 (통계·추천 풀·목록에 섞이지 않게)
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(new.raw_app_meta_data->>'bonsim_admin', '') = 'true' then
    return new; -- 관리자 계정 (0033) — public.users / subscriptions 를 만들지 않는다
  end if;
  insert into public.users (id, email, phone, phone_verified_at)
  values (
    new.id,
    new.email,
    public.to_e164(new.phone),
    case when new.phone is not null then coalesce(new.phone_confirmed_at, now()) end
  )
  on conflict (id) do nothing;
  insert into public.subscriptions (user_id, plan, status)
  values (new.id, 'free', 'active')
  on conflict (user_id) do nothing;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_members
-- ---------------------------------------------------------------------------
create table if not exists public.admin_members (
  user_id              uuid primary key references auth.users (id) on delete cascade,
  display_name         text not null check (char_length(display_name) between 1 and 40),
  role                 text not null check (role in ('owner', 'viewer')),
  status               text not null default 'active' check (status in ('active', 'disabled')),
  mfa_verified_at      timestamptz,
  sessions_revoked_at  timestamptz,
  created_by           uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

comment on table public.admin_members is '관리자 membership (#27). 서버 전용. 권한의 유일한 근거 — user metadata 가 아니다';

create trigger admin_members_touch_updated_at
  before update on public.admin_members
  for each row execute function public.touch_updated_at();

alter table public.admin_members enable row level security;
revoke all on public.admin_members from public, anon, authenticated;
grant all on public.admin_members to service_role;

-- ---------------------------------------------------------------------------
-- admin_sessions — 쿠키가 가리키는 서버 세션. aal2(MFA 완료) 만 발급된다
-- ---------------------------------------------------------------------------
create table if not exists public.admin_sessions (
  id              uuid primary key default gen_random_uuid(),
  member_user_id  uuid not null references public.admin_members (user_id) on delete cascade,
  aal             text not null default 'aal2' check (aal = 'aal2'),
  issued_at       timestamptz not null default now(),
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  last_seen_at    timestamptz not null default now()
);

create index if not exists admin_sessions_member_idx on public.admin_sessions (member_user_id, issued_at desc);

alter table public.admin_sessions enable row level security;
revoke all on public.admin_sessions from public, anon, authenticated;
grant all on public.admin_sessions to service_role;

-- ---------------------------------------------------------------------------
-- 헬퍼
-- ---------------------------------------------------------------------------
create or replace function public.admin_server_only()
returns void
language plpgsql
as $$
begin
  if auth.uid() is not null then
    raise exception 'server only' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.admin_server_only() from public, anon, authenticated;

/** 활성 owner 행을 모두 잠근 뒤 수를 돌려준다 — 마지막 owner 보호의 직렬화 지점 */
create or replace function public.admin_lock_active_owners()
returns int
language plpgsql
as $$
declare n int;
begin
  perform 1 from public.admin_members where role = 'owner' and status = 'active' for update;
  select count(*) into n from public.admin_members where role = 'owner' and status = 'active';
  return n;
end;
$$;
revoke all on function public.admin_lock_active_owners() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- bootstrap — 활성 owner 가 하나도 없을 때만 첫 owner 를 만든다 (서버 전용 스크립트가 호출)
-- ---------------------------------------------------------------------------
create or replace function public.admin_member_bootstrap(p_user_id uuid, p_display_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  perform public.admin_server_only();
  if p_user_id is null or coalesce(btrim(p_display_name), '') = '' then
    raise exception 'invalid arguments';
  end if;
  if not exists (select 1 from auth.users where id = p_user_id) then
    return jsonb_build_object('ok', false, 'reason', 'auth_user_not_found');
  end if;
  n := public.admin_lock_active_owners();
  if n > 0 then
    return jsonb_build_object('ok', false, 'reason', 'owner_exists');
  end if;
  insert into public.admin_members (user_id, display_name, role, status)
  values (p_user_id, left(btrim(p_display_name), 40), 'owner', 'active')
  on conflict (user_id) do update set role = 'owner', status = 'active', display_name = excluded.display_name;
  perform public.admin_audit_record(p_user_id::text, 'admin_bootstrap', 'admin_member', p_user_id::text,
    jsonb_build_object('actor_name', left(btrim(p_display_name), 40), 'role', 'owner'));
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 멤버 관리 — 실행자(p_actor)는 활성 owner 여야 한다. 실행자 id 는 서버가 세션에서 넣는다 (요청 입력이 아니다)
-- ---------------------------------------------------------------------------
create or replace function public.admin_actor_is_owner(p_actor uuid)
returns boolean
language sql
stable
as $$
  select exists (select 1 from public.admin_members where user_id = p_actor and role = 'owner' and status = 'active');
$$;
revoke all on function public.admin_actor_is_owner(uuid) from public, anon, authenticated;

create or replace function public.admin_member_add(p_actor uuid, p_target uuid, p_display_name text, p_role text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.admin_server_only();
  if not public.admin_actor_is_owner(p_actor) then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  if p_target is null or p_role not in ('owner', 'viewer') or coalesce(btrim(p_display_name), '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if not exists (select 1 from auth.users where id = p_target) then
    return jsonb_build_object('ok', false, 'reason', 'auth_user_not_found');
  end if;
  -- 앱 사용자(전화번호 로그인·public.users 행) 는 관리자가 될 수 없다 — 별도 관리자 계정을 만든다
  if exists (select 1 from public.users where id = p_target) then
    return jsonb_build_object('ok', false, 'reason', 'app_user_not_allowed');
  end if;
  if exists (select 1 from public.admin_members where user_id = p_target) then
    return jsonb_build_object('ok', false, 'reason', 'already_member');
  end if;
  insert into public.admin_members (user_id, display_name, role, status, created_by)
  values (p_target, left(btrim(p_display_name), 40), p_role, 'active', p_actor);
  perform public.admin_audit_record(p_actor::text, 'admin_member_add', 'admin_member', p_target::text, jsonb_build_object('role', p_role));
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.admin_member_set_role(p_actor uuid, p_target uuid, p_role text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare m public.admin_members%rowtype; owners int;
begin
  perform public.admin_server_only();
  if not public.admin_actor_is_owner(p_actor) then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  if p_role not in ('owner', 'viewer') then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  owners := public.admin_lock_active_owners(); -- 동시 강등 직렬화
  select * into m from public.admin_members where user_id = p_target for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if m.role = p_role then return jsonb_build_object('ok', true, 'changed', false); end if;
  if m.role = 'owner' and m.status = 'active' and p_role = 'viewer' and owners <= 1 then
    return jsonb_build_object('ok', false, 'reason', 'last_owner');
  end if;
  update public.admin_members set role = p_role where user_id = p_target;
  perform public.admin_audit_record(p_actor::text, 'admin_member_role', 'admin_member', p_target::text, jsonb_build_object('from', m.role, 'to', p_role));
  return jsonb_build_object('ok', true, 'changed', true);
end;
$$;

create or replace function public.admin_member_set_status(p_actor uuid, p_target uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare m public.admin_members%rowtype; owners int;
begin
  perform public.admin_server_only();
  if not public.admin_actor_is_owner(p_actor) then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  if p_status not in ('active', 'disabled') then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  owners := public.admin_lock_active_owners();
  select * into m from public.admin_members where user_id = p_target for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if m.status = p_status then return jsonb_build_object('ok', true, 'changed', false); end if;
  if m.role = 'owner' and m.status = 'active' and p_status = 'disabled' and owners <= 1 then
    return jsonb_build_object('ok', false, 'reason', 'last_owner');
  end if;
  update public.admin_members
     set status = p_status,
         sessions_revoked_at = case when p_status = 'disabled' then clock_timestamp() else sessions_revoked_at end
   where user_id = p_target;
  if p_status = 'disabled' then
    update public.admin_sessions set revoked_at = now() where member_user_id = p_target and revoked_at is null;
  end if;
  perform public.admin_audit_record(p_actor::text, 'admin_member_status', 'admin_member', p_target::text, jsonb_build_object('from', m.status, 'to', p_status));
  return jsonb_build_object('ok', true, 'changed', true);
end;
$$;

/** 대상의 모든 세션 취소. p_actor 가 null 이면 서버 전용 복구 절차(bootstrap 스크립트) — 그 외에는 활성 owner 또는 본인 */
create or replace function public.admin_member_revoke_sessions(p_actor uuid, p_target uuid, p_reason text default 'revoke')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  perform public.admin_server_only();
  if p_actor is not null and p_actor <> p_target and not public.admin_actor_is_owner(p_actor) then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  if not exists (select 1 from public.admin_members where user_id = p_target) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  update public.admin_members set sessions_revoked_at = clock_timestamp() where user_id = p_target;
  update public.admin_sessions set revoked_at = clock_timestamp() where member_user_id = p_target and revoked_at is null;
  get diagnostics n = row_count;
  perform public.admin_audit_record(coalesce(p_actor::text, 'server-bootstrap'), 'admin_sessions_revoked', 'admin_member', p_target::text,
    jsonb_build_object('sessions', n, 'reason', left(coalesce(p_reason, 'revoke'), 40)));
  return jsonb_build_object('ok', true, 'sessions', n);
end;
$$;

-- ---------------------------------------------------------------------------
-- 세션 — MFA(aal2) 통과 뒤에만 발급. 매 요청 check 가 멤버 상태·역할·취소 여부를 DB 에서 읽는다
-- ---------------------------------------------------------------------------
create or replace function public.admin_session_issue(p_member uuid, p_ttl_seconds int default 43200)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare m public.admin_members%rowtype; sid uuid;
begin
  perform public.admin_server_only();
  if p_member is null or p_ttl_seconds is null or p_ttl_seconds < 60 or p_ttl_seconds > 86400 then
    raise exception 'invalid arguments';
  end if;
  select * into m from public.admin_members where user_id = p_member;
  if not found or m.status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'not_active');
  end if;
  -- issued_at 은 clock_timestamp(): 같은 트랜잭션/초 안의 취소(sessions_revoked_at)와 순서가 구분되게
  insert into public.admin_sessions (member_user_id, aal, issued_at, expires_at)
  values (p_member, 'aal2', clock_timestamp(), clock_timestamp() + make_interval(secs => p_ttl_seconds))
  returning id into sid;
  update public.admin_members set mfa_verified_at = coalesce(mfa_verified_at, now()) where user_id = p_member;
  return jsonb_build_object('ok', true, 'session_id', sid, 'role', m.role, 'display_name', m.display_name);
end;
$$;

create or replace function public.admin_session_check(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare s public.admin_sessions%rowtype; m public.admin_members%rowtype;
begin
  perform public.admin_server_only();
  if p_session_id is null then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  select * into s from public.admin_sessions where id = p_session_id;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if s.revoked_at is not null then return jsonb_build_object('ok', false, 'reason', 'revoked'); end if;
  if s.expires_at <= now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  select * into m from public.admin_members where user_id = s.member_user_id;
  if not found or m.status <> 'active' then return jsonb_build_object('ok', false, 'reason', 'member_inactive'); end if;
  if m.sessions_revoked_at is not null and s.issued_at <= m.sessions_revoked_at then
    return jsonb_build_object('ok', false, 'reason', 'revoked');
  end if;
  update public.admin_sessions set last_seen_at = now() where id = p_session_id and last_seen_at < now() - interval '1 minute';
  return jsonb_build_object('ok', true, 'user_id', m.user_id, 'role', m.role, 'display_name', m.display_name, 'aal', s.aal, 'expires_at', s.expires_at);
end;
$$;

create or replace function public.admin_session_revoke(p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  perform public.admin_server_only();
  update public.admin_sessions set revoked_at = now() where id = p_session_id and revoked_at is null;
  get diagnostics n = row_count;
  return n = 1;
end;
$$;

/** 구 공유 비밀번호 로그인 허용 여부 — MFA 로 로그인을 완료한 관리자가 하나도 없을 때만. 전환이 끝나면 자동으로 닫힌다 */
create or replace function public.admin_legacy_login_allowed()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.admin_server_only();
  return not exists (select 1 from public.admin_members where mfa_verified_at is not null);
end;
$$;

create or replace function public.admin_sessions_prune(p_keep interval default interval '7 days')
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  perform public.admin_server_only();
  delete from public.admin_sessions where (revoked_at is not null and revoked_at < now() - p_keep) or expires_at < now() - p_keep;
  get diagnostics n = row_count;
  return n;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.admin_member_bootstrap(uuid, text)',
    'public.admin_member_add(uuid, uuid, text, text)',
    'public.admin_member_set_role(uuid, uuid, text)',
    'public.admin_member_set_status(uuid, uuid, text)',
    'public.admin_member_revoke_sessions(uuid, uuid, text)',
    'public.admin_session_issue(uuid, int)',
    'public.admin_session_check(uuid)',
    'public.admin_session_revoke(uuid)',
    'public.admin_legacy_login_allowed()',
    'public.admin_sessions_prune(interval)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
