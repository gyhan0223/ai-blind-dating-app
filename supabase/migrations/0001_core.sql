-- 0001_core.sql
-- 핵심 사용자 테이블: users / profiles / private_profiles / subscriptions
--
-- 설계 원칙
--  * profiles        : 추천 카드·매칭 상대에게 보여줄 수 있는 "공개 가능" 정보만 담는다.
--  * private_profiles: 매칭 내부용 데이터(가치관 축, 민감 응답). 본인 외에는 RLS로 완전 차단.
--  * 인증 플래그(identity/face/age_verified)와 status는 클라이언트가 직접 수정할 수 없다.

-- ---------------------------------------------------------------------------
-- 공통: updated_at 자동 갱신
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- users — 앱 수준 사용자 상태 (auth.users 1:1)
-- ---------------------------------------------------------------------------
create table public.users (
  id                   uuid primary key references auth.users (id) on delete cascade,
  email                text,
  status               text not null default 'active'
                         check (status in ('active', 'suspended', 'deleted')),
  onboarding_step      text not null default 'welcome',
  onboarding_completed boolean not null default false,
  age_verified         boolean not null default false,
  identity_verified    boolean not null default false,
  face_verified        boolean not null default false,
  is_demo              boolean not null default false,
  last_active_at       timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index users_status_idx on public.users (status);

create trigger users_touch_updated_at
  before update on public.users
  for each row execute function public.touch_updated_at();

-- 인증 플래그/상태는 서버(service role) 전용.
-- 클라이언트 JWT(auth.uid()가 존재)로는 변경 불가. Edge Function이 service key로 갱신한다.
create or replace function public.guard_user_protected_columns()
returns trigger
language plpgsql
security definer
as $$
begin
  if auth.uid() is not null then
    if new.status is distinct from old.status
       or new.age_verified is distinct from old.age_verified
       or new.identity_verified is distinct from old.identity_verified
       or new.face_verified is distinct from old.face_verified
       or new.is_demo is distinct from old.is_demo then
      raise exception 'protected user columns can only be changed by the server';
    end if;
  end if;
  return new;
end;
$$;

create trigger users_guard_protected
  before update on public.users
  for each row execute function public.guard_user_protected_columns();

-- auth 가입 시 앱 사용자 행 자동 생성
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  insert into public.subscriptions (user_id, plan, status)
  values (new.id, 'free', 'active')
  on conflict (user_id) do nothing;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- subscriptions — 수익화 구조(결제 연동 전). plan이 매칭 품질에 영향을 주어서는 안 된다.
-- ---------------------------------------------------------------------------
create table public.subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null unique references public.users (id) on delete cascade,
  plan       text not null default 'free' check (plan in ('free', 'plus')),
  status     text not null default 'active' check (status in ('active', 'canceled', 'expired')),
  started_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger subscriptions_touch_updated_at
  before update on public.subscriptions
  for each row execute function public.touch_updated_at();

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- profiles — 상대에게 공개 가능한 프로필
-- ---------------------------------------------------------------------------
create table public.profiles (
  user_id              uuid primary key references public.users (id) on delete cascade,
  nickname             text not null check (char_length(nickname) between 2 and 12),
  birth_year           int  not null check (birth_year between 1950 and 2010),
  gender               text not null check (gender in ('male', 'female')),
  seeking_gender       text not null check (seeking_gender in ('male', 'female')),
  region_code          text not null,
  height_cm            int  not null check (height_cm between 130 and 220),
  job_group            text not null,
  smoking              text not null check (smoking in ('none', 'sometimes', 'regular')),
  drinking             text not null check (drinking in ('none', 'sometimes', 'often')),
  education            text,
  religion             text,
  mbti                 text check (mbti is null or mbti ~ '^[EI][SN][TF][JP]$'),
  exercise             text check (exercise is null or exercise in ('rarely', 'sometimes', 'regular')),
  hobbies              text[] not null default '{}',
  personality_keywords text[] not null default '{}',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index profiles_gender_region_idx on public.profiles (gender, region_code);

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- private_profiles — 내부 매칭용/민감 데이터. 본인 외 접근 불가.
-- 가치관 축은 1~5 정수 스케일.
-- ---------------------------------------------------------------------------
create table public.private_profiles (
  user_id                       uuid primary key references public.users (id) on delete cascade,
  birth_date                    date,
  phone                         text,
  marriage_intent               smallint check (marriage_intent between 1 and 5),
  children_intent               smallint check (children_intent between 1 and 5),
  long_distance_ok              smallint check (long_distance_ok between 1 and 5),
  contact_frequency             smallint check (contact_frequency between 1 and 5),
  date_frequency                smallint check (date_frequency between 1 and 5),
  personal_time_need            smallint check (personal_time_need between 1 and 5),
  opposite_sex_friends_ok       smallint check (opposite_sex_friends_ok between 1 and 5),
  spending_style                smallint check (spending_style between 1 and 5),
  religion_importance           smallint check (religion_importance between 1 and 5),
  -- 민감도 높은 선택 응답(과거 연애 등). 키별 값 + 공개 여부를 분리 저장.
  sensitive_answers             jsonb not null default '{}'::jsonb,
  sensitive_visibility          jsonb not null default '{}'::jsonb,
  -- 대화 분석은 명시적 동의가 있을 때만 (향후 기능 대비 상태 저장)
  conversation_analysis_consent boolean not null default false,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now()
);

create trigger private_profiles_touch_updated_at
  before update on public.private_profiles
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.users            enable row level security;
alter table public.subscriptions    enable row level security;
alter table public.profiles         enable row level security;
alter table public.private_profiles enable row level security;

-- users: 본인 행만
create policy users_select_own on public.users
  for select using (id = auth.uid());
create policy users_update_own on public.users
  for update using (id = auth.uid()) with check (id = auth.uid());

-- subscriptions: 본인 조회만 (변경은 서버 전용)
create policy subscriptions_select_own on public.subscriptions
  for select using (user_id = auth.uid());

-- profiles: 본인 전체 권한 + "매칭된 상대"만 조회 가능.
-- 추천 카드에는 별도 스냅샷(recommendations.card)을 쓰므로 추천 단계에서는 원본 접근이 필요 없다.
-- matches 테이블은 0003에서 생성되므로 본문 검증이 지연되는 plpgsql을 사용한다.
create or replace function public.is_matched_with(other uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return exists (
    select 1 from public.matches m
    where m.status = 'active'
      and ((m.user_a = auth.uid() and m.user_b = other)
        or (m.user_b = auth.uid() and m.user_a = other))
  );
end;
$$;

create policy profiles_select_own_or_matched on public.profiles
  for select using (user_id = auth.uid() or public.is_matched_with(user_id));
create policy profiles_insert_own on public.profiles
  for insert with check (user_id = auth.uid());
create policy profiles_update_own on public.profiles
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- private_profiles: 본인만. 어떤 경우에도 타인 조회 불가.
create policy private_profiles_own on public.private_profiles
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
