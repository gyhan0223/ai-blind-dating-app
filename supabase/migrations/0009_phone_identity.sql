-- 0009_phone_identity.sql
-- 전화번호 로그인 + 본인확인 identity 기반 1인 1계정 구조.
--
-- 설계 원칙
--   phone number != permanent user identity
--   전화번호      = 로그인 수단 (변경/재사용될 수 있음)
--   identityKey   = 본인확인(DI 등) 결과 → 실제 사람 식별 수단
--   1 identityKey = 1 active account  (UNIQUE constraint 가 최종 방어선)
--
--  * user_identities: 서버(service role) 전용. RLS 정책 없음 → 클라이언트 접근 완전 차단.
--  * identity_key_hash 는 Edge Function 이 서버 HMAC(IDENTITY_HASH_SECRET)으로 만든 값만 저장.
--    raw identityKey / DI 는 어디에도 저장·로그하지 않는다.
--  * users.status 에 'banned' 추가 — banned identity 는 전화번호를 바꿔도 재가입 불가.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- users: 현재 로그인 전화번호(E.164) + banned 상태
-- ---------------------------------------------------------------------------
alter table public.users add column if not exists phone text unique;
alter table public.users add column if not exists phone_verified_at timestamptz;

alter table public.users drop constraint if exists users_status_check;
alter table public.users add constraint users_status_check
  check (status in ('active', 'suspended', 'banned', 'deleted'));

-- GoTrue 는 phone 을 '+' 없이 저장한다 → 앱 DB 에는 항상 E.164 로 통일
create or replace function public.to_e164(p text)
returns text
language sql
immutable
as $$
  select case
    when p is null or p = '' then null
    when left(p, 1) = '+' then p
    else '+' || p
  end;
$$;

-- auth 가입 시 전화번호도 복사 (Phone Auth 가입은 email 이 null 일 수 있다)
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
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

-- 전화번호 변경(계정 복구 등)이 auth.users 에 반영되면 앱 users 에도 동기화
create or replace function public.handle_auth_user_phone_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.phone is distinct from old.phone then
    update public.users
      set phone = public.to_e164(new.phone),
          phone_verified_at = case when new.phone is not null then now() end
      where id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_phone_updated on auth.users;
create trigger on_auth_user_phone_updated
  after update on auth.users
  for each row execute function public.handle_auth_user_phone_change();

-- ---------------------------------------------------------------------------
-- user_identities — 본인확인 결과 (민감 · 서버 전용)
--
--  * identity_key_hash UNIQUE 가 1인 1계정 보장의 핵심 (동시 가입 race 의 최종 방어)
--  * user_id 는 계정 삭제 시 set null 로 남는다 → identity 보존 정책(중복가입 방지) 지원
--  * banned 는 계정 row 가 사라져도 유지되는 차단 플래그
-- ---------------------------------------------------------------------------
create table public.user_identities (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid unique references public.users (id) on delete set null,
  identity_key_hash    text not null unique,
  identity_verified_at timestamptz,
  birth_date           date,
  gender               text check (gender is null or gender in ('male', 'female')),
  adult_verified_at    timestamptz,
  banned               boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create trigger user_identities_touch_updated_at
  before update on public.user_identities
  for each row execute function public.touch_updated_at();

-- RLS: 정책을 하나도 만들지 않는다 → 클라이언트(anon/authenticated)는 어떤 행도 접근 불가.
-- Edge Function(service role)만 읽고 쓴다. 추천/프로필 API 어디에도 노출되지 않는다.
alter table public.user_identities enable row level security;

-- users.status 가 banned 로 바뀌면 identity 에도 영구 차단 플래그를 동기화한다.
-- (계정을 삭제하고 재가입해 우회하는 것을 막는다)
create or replace function public.sync_identity_ban()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'banned' and old.status is distinct from 'banned' then
    update public.user_identities set banned = true where user_id = new.id;
  elsif old.status = 'banned' and new.status = 'active' then
    update public.user_identities set banned = false where user_id = new.id;
  end if;
  return new;
end;
$$;

create trigger users_sync_identity_ban
  after update on public.users
  for each row execute function public.sync_identity_ban();

-- ---------------------------------------------------------------------------
-- device_events — 기기 신호 로그 (abuse detection 보조)
--
-- 기기 ID 는 계정 identity 가 아니다. "1 device = 1 account" 정책은 만들지 않는다
-- (폰 교체/분실/중고기기 등 정상 시나리오). MVP 에서는 단순 logging.
-- 기록은 Edge Function(service role) 전용, 클라이언트 접근 불가.
-- ---------------------------------------------------------------------------
create table public.device_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.users (id) on delete set null,
  device_hash text,
  event_type  text not null check (event_type in (
    'signup_attempt', 'signup_success', 'login', 'otp_request',
    'verification_failure', 'duplicate_identity_attempt',
    'banned_identity_attempt', 'account_recovery', 'account_deletion'
  )),
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index device_events_user_idx on public.device_events (user_id, created_at);
create index device_events_device_idx on public.device_events (device_hash, created_at);

alter table public.device_events enable row level security; -- 정책 없음 = 서버 전용
