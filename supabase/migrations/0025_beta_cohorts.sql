-- 0025_beta_cohorts.sql
-- Issue #26 — 폐쇄 베타 cohort · 초대코드 · 가입 인원 제어.
--
-- 모델
--   * app_settings.beta_gate {"enabled": bool} — 게이트 스위치. 꺼져 있으면 모두 입장(일반 공개). 켜져 있으면 "입장 허가(users.beta_admitted_at)" 가 있어야
--     본인확인·얼굴 인증·프로필 생성·온보딩 완료로 나아갈 수 있다. 베타 종료 = 스위치를 끄는 것뿐이며 cohort_id 는 측정용으로 남는다.
--   * beta_cohorts — 지역·연령대·정원·모집 ON/OFF 의 최소 운영 단위. 사용자는 users.cohort_id 로 묶인다.
--   * beta_invite_codes — cohort 에 묶인 코드(사용 횟수·만료). 사용자가 beta_redeem_invite() 로 입장한다.
--   * beta_waitlist — 초대 없이 온 사용자가 남기는 최소 정보(지역·출생연도·성별). 프로필·본인확인·얼굴 데이터는 만들지 않는다.
--     운영자가 cohort 로 입장시키면(beta_admit_waitlist) outbox 에 beta_admitted 알림이 쌓인다 (#17 send-push 가 발송).
--
-- 강제 지점 (클라이언트 우회 불가)
--   * profiles insert 정책: beta_access_allowed_self()
--   * users_guard_onboarding_completion: 입장 허가 없이 onboarding_completed 불가
--   * verify-identity / start-face-liveness Edge Function: beta_access_allowed(uid) 확인 (서버)
--   * users.cohort_id / beta_admitted_at: 최종 사용자 변경 불가
--
-- 검증: supabase/tests/beta_tests.sql

-- ---------------------------------------------------------------------------
-- 1) 설정 · cohort · 초대코드 · 대기 목록
-- ---------------------------------------------------------------------------
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table public.app_settings enable row level security;
revoke all on public.app_settings from public, anon, authenticated;
grant all on public.app_settings to service_role;
insert into public.app_settings (key, value) values ('beta_gate', '{"enabled": false}'::jsonb) on conflict (key) do nothing;

create table if not exists public.beta_cohorts (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  name         text not null check (char_length(name) between 1 and 60),
  region_codes text[] not null default '{}',
  age_min      int check (age_min is null or age_min between 19 and 80),
  age_max      int check (age_max is null or age_max between 19 and 80),
  capacity     int check (capacity is null or capacity > 0),
  signups_open boolean not null default true,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (age_min is null or age_max is null or age_min <= age_max)
);
create trigger beta_cohorts_touch_updated_at before update on public.beta_cohorts for each row execute function public.touch_updated_at();
alter table public.beta_cohorts enable row level security;
revoke all on public.beta_cohorts from public, anon, authenticated;
grant all on public.beta_cohorts to service_role;

create table if not exists public.beta_invite_codes (
  code       text primary key check (code ~ '^[A-Z0-9]{6,12}$'),
  cohort_id  uuid not null references public.beta_cohorts (id) on delete cascade,
  max_uses   int not null default 1 check (max_uses > 0),
  used_count int not null default 0 check (used_count >= 0),
  expires_at timestamptz,
  active     boolean not null default true,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists beta_invite_codes_cohort_idx on public.beta_invite_codes (cohort_id);
alter table public.beta_invite_codes enable row level security;
revoke all on public.beta_invite_codes from public, anon, authenticated;
grant all on public.beta_invite_codes to service_role;

alter table public.users
  add column if not exists cohort_id uuid references public.beta_cohorts (id) on delete set null,
  add column if not exists beta_admitted_at timestamptz;
create index if not exists users_cohort_idx on public.users (cohort_id);

create table if not exists public.beta_waitlist (
  user_id     uuid primary key references public.users (id) on delete cascade,
  region_code text not null check (char_length(region_code) between 2 and 20),
  birth_year  int not null check (birth_year between 1950 and 2010),
  gender      text not null check (gender in ('male', 'female')),
  created_at  timestamptz not null default now(),
  admitted_at timestamptz,
  notified_at timestamptz
);
create index if not exists beta_waitlist_pending_idx on public.beta_waitlist (created_at) where admitted_at is null;
alter table public.beta_waitlist enable row level security;
-- 본인 행 조회만 (쓰기는 RPC)
create policy beta_waitlist_select_own on public.beta_waitlist for select using (user_id = auth.uid());

comment on table public.beta_waitlist is '초대 없는 사용자의 대기 등록 (#26). 지역·출생연도·성별만 — 프로필·본인확인·얼굴 데이터는 만들지 않는다';

-- 사용자는 cohort_id / beta_admitted_at 을 바꿀 수 없다
-- SECURITY INVOKER — 서버 RPC(beta_redeem_invite 등, DEFINER) 의 갱신은 통과하고 사용자 직접 update 만 막는다
create or replace function public.guard_user_beta_columns()
returns trigger
language plpgsql
as $$
begin
  if public.is_end_user_request()
     and (new.cohort_id is distinct from old.cohort_id or new.beta_admitted_at is distinct from old.beta_admitted_at) then
    raise exception 'beta admission is server managed' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists users_guard_beta_columns on public.users;
create trigger users_guard_beta_columns before update on public.users for each row execute function public.guard_user_beta_columns();

-- 익명화(purge) 시 대기 정보도 지운다 (0019 account_purge 는 users 행을 남긴다)
create or replace function public.handle_user_purged_waitlist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.purged_at is not null and old.purged_at is null then
    delete from public.beta_waitlist where user_id = new.id;
  end if;
  return new;
end;
$$;
drop trigger if exists users_purged_waitlist on public.users;
create trigger users_purged_waitlist after update of purged_at on public.users for each row execute function public.handle_user_purged_waitlist();

-- ---------------------------------------------------------------------------
-- 2) 접근 판정
-- ---------------------------------------------------------------------------
create or replace function public.beta_gate_enabled()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select (value->>'enabled')::boolean from public.app_settings where key = 'beta_gate'), false);
$$;
revoke all on function public.beta_gate_enabled() from public, anon, authenticated;
grant execute on function public.beta_gate_enabled() to service_role;

-- 서버용: 특정 사용자의 입장 허가 여부
create or replace function public.beta_access_allowed(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select (not public.beta_gate_enabled())
      or exists (select 1 from public.users u where u.id = p_user and u.beta_admitted_at is not null);
$$;
revoke all on function public.beta_access_allowed(uuid) from public, anon, authenticated;
grant execute on function public.beta_access_allowed(uuid) to service_role;

-- 정책용: 호출자 본인만
create or replace function public.beta_access_allowed_self()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null and public.beta_access_allowed(auth.uid());
$$;
revoke all on function public.beta_access_allowed_self() from public, anon;
grant execute on function public.beta_access_allowed_self() to authenticated, service_role;

-- 앱용: 내 상태 — open(게이트 꺼짐) | admitted | waitlisted | invite_required
create or replace function public.beta_access_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  gate boolean := public.beta_gate_enabled();
  u record;
  w record;
  c_slug text;
  c_name text;
  st text;
begin
  if uid is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  select cohort_id, beta_admitted_at into u from public.users where id = uid;
  select created_at into w from public.beta_waitlist where user_id = uid and admitted_at is null;
  if u.cohort_id is not null then
    select slug, name into c_slug, c_name from public.beta_cohorts where id = u.cohort_id;
  end if;
  st := case
    when not gate then 'open'
    when u.beta_admitted_at is not null then 'admitted'
    when w.created_at is not null then 'waitlisted'
    else 'invite_required'
  end;
  return jsonb_build_object(
    'gate_enabled', gate,
    'state', st,
    'cohort', case when c_slug is null then null else jsonb_build_object('slug', c_slug, 'name', c_name) end,
    'waitlisted_at', w.created_at
  );
end;
$$;
revoke all on function public.beta_access_state() from public, anon;
grant execute on function public.beta_access_state() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) 강제 — profiles insert · 온보딩 완료
-- ---------------------------------------------------------------------------
drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
  for insert with check (user_id = auth.uid() and public.beta_access_allowed_self());

create or replace function public.guard_onboarding_completion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null
     and new.onboarding_completed
     and not old.onboarding_completed then
    if not (new.identity_verified and new.face_verified) then
      raise exception 'onboarding cannot be completed before identity and face verification';
    end if;
    if not public.beta_access_allowed(new.id) then
      raise exception 'onboarding cannot be completed without beta admission' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) 사용자 RPC — 대기 등록 · 초대코드 사용
-- ---------------------------------------------------------------------------
create or replace function public.beta_join_waitlist(p_region_code text, p_birth_year int, p_gender text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  admitted timestamptz;
begin
  if uid is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  select beta_admitted_at into admitted from public.users where id = uid;
  if admitted is not null or not public.beta_gate_enabled() then
    return public.beta_access_state();
  end if;
  insert into public.beta_waitlist as w (user_id, region_code, birth_year, gender)
  values (uid, lower(trim(p_region_code)), p_birth_year, p_gender)
  on conflict (user_id) do update
    set region_code = excluded.region_code, birth_year = excluded.birth_year, gender = excluded.gender;
  insert into public.analytics_events (user_id, event_type, payload)
  values (uid, 'beta_waitlisted', '{}'::jsonb);
  return public.beta_access_state();
end;
$$;
revoke all on function public.beta_join_waitlist(text, int, text) from public, anon;
grant execute on function public.beta_join_waitlist(text, int, text) to authenticated, service_role;

-- 실패는 예외가 아니라 {error} 로 돌려준다 — 예외로 롤백되면 시도 카운터도 사라져 무차별 대입 상한이 동작하지 않기 때문.
-- error: rate_limited | invalid_code | code_exhausted | cohort_closed | cohort_full
create or replace function public.beta_redeem_invite(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  code_norm text := upper(trim(coalesce(p_code, '')));
  rl jsonb;
  inv record;
  admitted timestamptz;
  n int;
begin
  if uid is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  select beta_admitted_at into admitted from public.users where id = uid;
  if admitted is not null then
    return public.beta_access_state();
  end if;
  -- 무차별 대입 방지: 사용자당 10회/시간 (실패도 센다)
  rl := public.rate_limit_hit('beta_invite', uid::text, 10, 3600);
  if not (rl->>'allowed')::boolean then
    return public.beta_access_state() || jsonb_build_object('error', 'rate_limited', 'retry_after_seconds', rl->'retry_after_seconds');
  end if;

  select i.code, i.max_uses, i.used_count, i.expires_at, i.active, c.id as cohort_id, c.slug, c.name, c.capacity, c.signups_open
  into inv
  from public.beta_invite_codes i
  join public.beta_cohorts c on c.id = i.cohort_id
  where i.code = code_norm
  for update of i;
  if not found or not inv.active or (inv.expires_at is not null and inv.expires_at < now()) then
    return public.beta_access_state() || jsonb_build_object('error', 'invalid_code');
  end if;
  if inv.used_count >= inv.max_uses then
    return public.beta_access_state() || jsonb_build_object('error', 'code_exhausted');
  end if;
  if not inv.signups_open then
    return public.beta_access_state() || jsonb_build_object('error', 'cohort_closed');
  end if;
  if inv.capacity is not null then
    select count(*) into n from public.users where cohort_id = inv.cohort_id;
    if n >= inv.capacity then
      return public.beta_access_state() || jsonb_build_object('error', 'cohort_full');
    end if;
  end if;

  update public.users set cohort_id = inv.cohort_id, beta_admitted_at = now() where id = uid and beta_admitted_at is null;
  update public.beta_invite_codes set used_count = used_count + 1 where code = inv.code;
  update public.beta_waitlist set admitted_at = now() where user_id = uid and admitted_at is null;
  insert into public.analytics_events (user_id, event_type, payload)
  values (uid, 'beta_admitted', jsonb_build_object('via', 'invite', 'cohort', inv.slug));
  return public.beta_access_state();
end;
$$;
revoke all on function public.beta_redeem_invite(text) from public, anon;
grant execute on function public.beta_redeem_invite(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5) 운영 RPC (service role) — 게이트 · 입장 · 대기자 입장
-- ---------------------------------------------------------------------------
create or replace function public.beta_set_gate(p_enabled boolean, p_actor text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    raise exception 'server only' using errcode = '42501';
  end if;
  insert into public.app_settings (key, value, updated_at, updated_by)
  values ('beta_gate', jsonb_build_object('enabled', coalesce(p_enabled, false)), now(), p_actor)
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by;
  perform public.admin_audit_record(p_actor, 'beta_gate_set', 'app_settings', 'beta_gate', jsonb_build_object('enabled', coalesce(p_enabled, false)));
  return jsonb_build_object('enabled', coalesce(p_enabled, false));
end;
$$;
revoke all on function public.beta_set_gate(boolean, text) from public, anon, authenticated;
grant execute on function public.beta_set_gate(boolean, text) to service_role;

-- 한 명 입장 (대기 여부와 무관). 이미 입장한 사용자는 cohort 만 바꾼다.
create or replace function public.beta_admit_user(p_user_id uuid, p_cohort_id uuid, p_actor text, p_notify boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  was_admitted timestamptz;
begin
  if auth.uid() is not null then
    raise exception 'server only' using errcode = '42501';
  end if;
  if not exists (select 1 from public.beta_cohorts where id = p_cohort_id) then
    raise exception 'cohort_not_found';
  end if;
  select beta_admitted_at into was_admitted from public.users where id = p_user_id;
  if not found then
    raise exception 'user_not_found';
  end if;
  update public.users set cohort_id = p_cohort_id, beta_admitted_at = coalesce(beta_admitted_at, now()) where id = p_user_id;
  update public.beta_waitlist set admitted_at = coalesce(admitted_at, now()) where user_id = p_user_id;
  if was_admitted is null then
    insert into public.analytics_events (user_id, event_type, payload)
    values (p_user_id, 'beta_admitted', jsonb_build_object('via', 'admin'));
    if p_notify then
      insert into public.notification_events (recipient_id, kind, dedupe_key)
      values (p_user_id, 'beta_admitted', 'beta:admitted:' || p_user_id::text)
      on conflict (dedupe_key) do nothing;
    end if;
  end if;
  perform public.admin_audit_record(p_actor, 'beta_admit_user', 'user', p_user_id::text, jsonb_build_object('cohort_id', p_cohort_id, 'first_admission', was_admitted is null));
  return jsonb_build_object('admitted', true, 'first_admission', was_admitted is null);
end;
$$;
revoke all on function public.beta_admit_user(uuid, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.beta_admit_user(uuid, uuid, text, boolean) to service_role;

-- 대기자 중 cohort 조건(지역·연령대, 선택적으로 성별)에 맞는 사람을 오래된 순으로 최대 p_limit 명 입장시킨다.
-- 정원(capacity)이 있으면 남은 자리까지만.
create or replace function public.beta_admit_waitlist(p_cohort_id uuid, p_limit int, p_gender text default null, p_actor text default 'admin')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  room int;
  target record;
  admitted_ids uuid[] := '{}';
  this_year int := extract(year from (now() at time zone 'Asia/Seoul'))::int;
begin
  if auth.uid() is not null then
    raise exception 'server only' using errcode = '42501';
  end if;
  select * into c from public.beta_cohorts where id = p_cohort_id for update;
  if not found then
    raise exception 'cohort_not_found';
  end if;
  room := greatest(0, least(coalesce(p_limit, 0), 500));
  if c.capacity is not null then
    room := least(room, greatest(0, c.capacity - (select count(*) from public.users where cohort_id = c.id)));
  end if;
  for target in
    select w.user_id
    from public.beta_waitlist w
    join public.users u on u.id = w.user_id
    where w.admitted_at is null
      and u.status = 'active'
      and u.beta_admitted_at is null
      and (cardinality(c.region_codes) = 0 or w.region_code = any (c.region_codes))
      and (c.age_min is null or this_year - w.birth_year + 1 >= c.age_min)
      and (c.age_max is null or this_year - w.birth_year + 1 <= c.age_max)
      and (p_gender is null or w.gender = p_gender)
    order by w.created_at
    limit room
    for update of w skip locked
  loop
    update public.users set cohort_id = c.id, beta_admitted_at = now() where id = target.user_id;
    update public.beta_waitlist set admitted_at = now() where user_id = target.user_id;
    insert into public.analytics_events (user_id, event_type, payload)
    values (target.user_id, 'beta_admitted', jsonb_build_object('via', 'waitlist', 'cohort', c.slug));
    insert into public.notification_events (recipient_id, kind, dedupe_key)
    values (target.user_id, 'beta_admitted', 'beta:admitted:' || target.user_id::text)
    on conflict (dedupe_key) do nothing;
    admitted_ids := array_append(admitted_ids, target.user_id);
  end loop;
  perform public.admin_audit_record(p_actor, 'beta_admit_waitlist', 'beta_cohort', c.id::text,
    jsonb_build_object('requested', p_limit, 'gender', p_gender, 'admitted', coalesce(array_length(admitted_ids, 1), 0)));
  return jsonb_build_object('admitted', coalesce(array_length(admitted_ids, 1), 0), 'user_ids', to_jsonb(admitted_ids));
end;
$$;
revoke all on function public.beta_admit_waitlist(uuid, int, text, text) from public, anon, authenticated;
grant execute on function public.beta_admit_waitlist(uuid, int, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 6) outbox kind 추가 — beta_admitted (알림 설정 스위치 없음 → 항상 발송, 본문 고정 문구)
-- ---------------------------------------------------------------------------
alter table public.notification_events drop constraint if exists notification_events_kind_check;
alter table public.notification_events add constraint notification_events_kind_check
  check (kind in ('new_message', 'mutual_meetup_interest', 'daily_recommendation', 'match_created', 'beta_admitted'));

-- ---------------------------------------------------------------------------
-- 7) 운영 뷰 (service role) — cohort 규모·전환, 대기자 분포
-- ---------------------------------------------------------------------------
create or replace view public.beta_cohort_stats as
select
  c.id as cohort_id,
  c.slug,
  c.name,
  c.signups_open,
  c.capacity,
  c.region_codes,
  c.age_min,
  c.age_max,
  count(u.id) as admitted,
  count(u.id) filter (where p.gender = 'male') as admitted_male,
  count(u.id) filter (where p.gender = 'female') as admitted_female,
  count(u.id) filter (where f.onboarded) as onboarded,
  count(u.id) filter (where f.got_recommendation) as got_recommendation,
  count(u.id) filter (where f.liked) as liked,
  count(u.id) filter (where f.matched) as matched,
  count(u.id) filter (where f.two_way) as two_way,
  count(u.id) filter (where f.sustained_7d) as sustained_7d,
  count(u.id) filter (where f.mutual_interest) as mutual_interest,
  count(u.id) filter (where f.both_confirmed) as both_confirmed,
  (select count(*) from public.beta_invite_codes i where i.cohort_id = c.id and i.active) as active_codes,
  (select coalesce(sum(i.max_uses - i.used_count), 0) from public.beta_invite_codes i where i.cohort_id = c.id and i.active and (i.expires_at is null or i.expires_at > now())) as remaining_uses
from public.beta_cohorts c
left join public.users u on u.cohort_id = c.id and not u.is_demo
left join public.profiles p on p.user_id = u.id
left join public.funnel_user_facts f on f.user_id = u.id
group by c.id;

create or replace view public.beta_waitlist_summary as
select
  w.region_code,
  w.gender,
  (floor((extract(year from (now() at time zone 'Asia/Seoul'))::int - w.birth_year + 1) / 5) * 5)::int as age_band,
  count(*) filter (where w.admitted_at is null) as waiting,
  count(*) filter (where w.admitted_at is not null) as admitted,
  min(w.created_at) filter (where w.admitted_at is null) as oldest_waiting_at
from public.beta_waitlist w
group by w.region_code, w.gender, age_band
order by waiting desc, w.region_code;

revoke all on public.beta_cohort_stats from public, anon, authenticated;
revoke all on public.beta_waitlist_summary from public, anon, authenticated;
grant select on public.beta_cohort_stats, public.beta_waitlist_summary to service_role;

comment on view public.beta_cohort_stats is 'cohort 별 입장·온보딩·추천·매치·대화·만남 전환 (#26). demo 제외';
