-- 0005_meetup_safety.sql
-- 만남 의사/피드백 + 안전(차단/신고) + 행동 데이터(analytics_events)

-- ---------------------------------------------------------------------------
-- meetup_intentions — "이 사람을 실제로 만나보고 싶나요?"
--  * 상대의 응답은 둘 다 yes 일 때만 보인다 (한쪽의 yes/not_yet 은 비공개)
-- ---------------------------------------------------------------------------
create table public.meetup_intentions (
  id               uuid primary key default gen_random_uuid(),
  match_id         uuid not null references public.matches (id) on delete cascade,
  user_id          uuid not null references public.users (id) on delete cascade,
  intent           text not null check (intent in ('yes', 'not_yet')),
  available_dates  text[] not null default '{}',
  preferred_region text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (match_id, user_id)
);

create trigger meetup_intentions_touch_updated_at
  before update on public.meetup_intentions
  for each row execute function public.touch_updated_at();

create or replace function public.meetup_mutual_yes(mid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select count(*) = 2 from public.meetup_intentions
  where match_id = mid and intent = 'yes';
$$;

-- 둘 다 yes → 매치 상태 갱신
create or replace function public.handle_meetup_intent()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.meetup_mutual_yes(new.match_id) then
    update public.matches
    set meetup_state = 'mutual_interest'
    where id = new.match_id and meetup_state = 'none';
  end if;
  return new;
end;
$$;

create trigger meetup_intentions_check_mutual
  after insert or update on public.meetup_intentions
  for each row execute function public.handle_meetup_intent();

-- ---------------------------------------------------------------------------
-- meetup_feedback — 만남 후 피드백 (MatchingEngine 학습용 데이터)
-- ---------------------------------------------------------------------------
create table public.meetup_feedback (
  id                    uuid primary key default gen_random_uuid(),
  match_id              uuid not null references public.matches (id) on delete cascade,
  user_id               uuid not null references public.users (id) on delete cascade,
  met_again_intent      text not null check (met_again_intent in ('yes', 'no')),
  appearance_attraction smallint check (appearance_attraction between 1 and 5),
  conversation_comfort  smallint check (conversation_comfort between 1 and 5),
  values_fit            smallint check (values_fit between 1 and 5),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (match_id, user_id)
);

create trigger meetup_feedback_touch_updated_at
  before update on public.meetup_feedback
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- blocks — 차단. 차단하면 매치 종료 + 서로 다시 추천되지 않음(엔진에서 제외)
-- ---------------------------------------------------------------------------
create table public.blocks (
  id         uuid primary key default gen_random_uuid(),
  blocker_id uuid not null references public.users (id) on delete cascade,
  blocked_id uuid not null references public.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  check (blocker_id <> blocked_id),
  unique (blocker_id, blocked_id)
);

create index blocks_blocked_idx on public.blocks (blocked_id);

create or replace function public.handle_block()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.matches
  set status = 'blocked'
  where status = 'active'
    and user_a = least(new.blocker_id, new.blocked_id)
    and user_b = greatest(new.blocker_id, new.blocked_id);
  return new;
end;
$$;

create trigger blocks_close_match
  after insert on public.blocks
  for each row execute function public.handle_block();

-- ---------------------------------------------------------------------------
-- reports — 신고 (관리자 확인용)
-- ---------------------------------------------------------------------------
create table public.reports (
  id          uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.users (id) on delete cascade,
  reported_id uuid not null references public.users (id) on delete cascade,
  match_id    uuid references public.matches (id) on delete set null,
  reason      text not null check (reason in (
                'unpleasant_conversation', 'sexual_remarks', 'threat',
                'impersonation', 'spam', 'other')),
  detail      text,
  status      text not null default 'pending'
                check (status in ('pending', 'reviewing', 'resolved')),
  admin_note  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (reporter_id <> reported_id)
);

create index reports_status_idx on public.reports (status, created_at desc);

create trigger reports_touch_updated_at
  before update on public.reports
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- analytics_events — 핵심 행동 이벤트 로그
--   recommendation_viewed / recommendation_accepted / recommendation_skipped /
--   match_created / chat_started / message_sent / conversation_resumed /
--   meetup_interest_yes / meetup_interest_not_yet / meetup_scheduled /
--   meetup_completed / second_date_interest_yes / second_date_interest_no ...
-- ---------------------------------------------------------------------------
create table public.analytics_events (
  id         bigint generated always as identity primary key,
  user_id    uuid references public.users (id) on delete set null,
  event_type text not null,
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index analytics_events_type_idx on public.analytics_events (event_type, created_at);
create index analytics_events_user_idx on public.analytics_events (user_id, created_at);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.meetup_intentions enable row level security;
alter table public.meetup_feedback   enable row level security;
alter table public.blocks            enable row level security;
alter table public.reports           enable row level security;
alter table public.analytics_events  enable row level security;

-- 만남 의사: 본인 행 전체 권한. 상대 행은 "둘 다 yes"일 때만 조회 가능.
create policy meetup_intentions_own on public.meetup_intentions
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.is_match_participant(match_id));
create policy meetup_intentions_select_mutual on public.meetup_intentions
  for select using (
    public.is_match_participant(match_id) and public.meetup_mutual_yes(match_id)
  );

-- 피드백: 본인만 (상대에게 절대 비공개)
create policy meetup_feedback_own on public.meetup_feedback
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.is_match_participant(match_id));

-- 차단: 차단한 본인만 조회/생성/해제
create policy blocks_own on public.blocks
  for all using (blocker_id = auth.uid()) with check (blocker_id = auth.uid());

-- 신고: 본인이 한 신고만 조회/생성. 처리(status)는 관리자(service role) 전용.
create policy reports_select_own on public.reports
  for select using (reporter_id = auth.uid());
create policy reports_insert_own on public.reports
  for insert with check (reporter_id = auth.uid() and status = 'pending');

-- 행동 이벤트: 본인 이름으로 기록만 가능, 조회는 서버/관리자 전용
create policy analytics_events_insert_own on public.analytics_events
  for insert with check (user_id = auth.uid());
