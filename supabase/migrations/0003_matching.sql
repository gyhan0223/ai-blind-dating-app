-- 0003_matching.sql
-- 추천 / 좋아요 / 매치 / 대화방
--
--  * recommendations 는 Edge Function(service role)만 생성한다.
--    카드에 보여줄 내용은 서버가 만든 스냅샷(card jsonb)으로 전달 —
--    클라이언트가 상대 profiles/private_profiles 원본에 접근할 필요가 없다.
--  * 원시 점수(score_*)는 저장하되 클라이언트에 노출하지 않는 것이 원칙 (UI에서 사용 금지).
--  * likes 는 "받은 사람"이 볼 수 없다 (한쪽만 좋아요한 사실은 비공개).
--  * 상호 좋아요가 되면 트리거가 matches + conversations 를 생성한다.

-- ---------------------------------------------------------------------------
-- recommendations — 오늘의 소개
-- ---------------------------------------------------------------------------
create table public.recommendations (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users (id) on delete cascade,
  candidate_id  uuid not null references public.users (id) on delete cascade,
  for_date      date not null default (now() at time zone 'Asia/Seoul')::date,
  -- 탐색 정책: exploit / explore / diversity 확장을 위한 필드
  strategy      text not null default 'high_confidence'
                  check (strategy in ('high_confidence', 'exploration', 'fallback')),
  score_total   numeric(6, 4),
  score_a_to_b  numeric(6, 4),
  score_b_to_a  numeric(6, 4),
  dimensions    jsonb,
  -- 카드 스냅샷: 닉네임/나이/지역/키/직업/키워드/설명 문구/인증 배지
  card          jsonb not null default '{}'::jsonb,
  status        text not null default 'pending'
                  check (status in ('pending', 'accepted', 'skipped', 'expired')),
  decided_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (user_id <> candidate_id),
  unique (user_id, candidate_id)
);

create index recommendations_user_date_idx on public.recommendations (user_id, for_date desc);

create trigger recommendations_touch_updated_at
  before update on public.recommendations
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- likes — "알아가고 싶어요"
-- ---------------------------------------------------------------------------
create table public.likes (
  id                uuid primary key default gen_random_uuid(),
  from_user_id      uuid not null references public.users (id) on delete cascade,
  to_user_id        uuid not null references public.users (id) on delete cascade,
  recommendation_id uuid references public.recommendations (id) on delete set null,
  created_at        timestamptz not null default now(),
  check (from_user_id <> to_user_id),
  unique (from_user_id, to_user_id)
);

create index likes_to_user_idx on public.likes (to_user_id);

-- ---------------------------------------------------------------------------
-- matches — 상호 호감 (user_a < user_b 로 정규화)
-- ---------------------------------------------------------------------------
create table public.matches (
  id                  uuid primary key default gen_random_uuid(),
  user_a              uuid not null references public.users (id) on delete cascade,
  user_b              uuid not null references public.users (id) on delete cascade,
  status              text not null default 'active'
                        check (status in ('active', 'closed', 'blocked')),
  meetup_state        text not null default 'none'
                        check (meetup_state in ('none', 'mutual_interest', 'scheduled', 'completed')),
  meetup_completed_at timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (user_a < user_b),
  unique (user_a, user_b)
);

create index matches_user_a_idx on public.matches (user_a);
create index matches_user_b_idx on public.matches (user_b);

create trigger matches_touch_updated_at
  before update on public.matches
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- conversations — 매치당 1개 대화방
-- ---------------------------------------------------------------------------
create table public.conversations (
  id              uuid primary key default gen_random_uuid(),
  match_id        uuid not null unique references public.matches (id) on delete cascade,
  -- AI Icebreaker (규칙 기반 → 추후 LLM 교체). 최초 진입 시 서버가 채운다.
  icebreaker      jsonb,
  last_message_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger conversations_touch_updated_at
  before update on public.conversations
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 헬퍼: 매치 참가자 여부
-- ---------------------------------------------------------------------------
create or replace function public.is_match_participant(mid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.matches m
    where m.id = mid and auth.uid() in (m.user_a, m.user_b)
  );
$$;

create or replace function public.conversation_participant(cid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.conversations c
    join public.matches m on m.id = c.match_id
    where c.id = cid and auth.uid() in (m.user_a, m.user_b)
  );
$$;

-- ---------------------------------------------------------------------------
-- 상호 좋아요 → 매치 + 대화방 생성
-- ---------------------------------------------------------------------------
create or replace function public.handle_mutual_like()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  m_id uuid;
begin
  if exists (
    select 1 from public.likes
    where from_user_id = new.to_user_id and to_user_id = new.from_user_id
  ) then
    insert into public.matches (user_a, user_b)
    values (least(new.from_user_id, new.to_user_id),
            greatest(new.from_user_id, new.to_user_id))
    on conflict (user_a, user_b) do nothing
    returning id into m_id;

    if m_id is not null then
      insert into public.conversations (match_id) values (m_id);
      insert into public.analytics_events (user_id, event_type, payload)
      values
        (new.from_user_id, 'match_created', jsonb_build_object('match_id', m_id)),
        (new.to_user_id,   'match_created', jsonb_build_object('match_id', m_id));
    end if;
  end if;
  return new;
end;
$$;

create trigger likes_handle_mutual
  after insert on public.likes
  for each row execute function public.handle_mutual_like();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.recommendations enable row level security;
alter table public.likes           enable row level security;
alter table public.matches         enable row level security;
alter table public.conversations   enable row level security;

-- 추천: 받은 본인만 조회. 상태 변경(수락/건너뜀)만 본인이 가능. 생성은 서버 전용.
create policy recommendations_select_own on public.recommendations
  for select using (user_id = auth.uid());
create policy recommendations_decide_own on public.recommendations
  for update using (user_id = auth.uid())
  with check (user_id = auth.uid() and status in ('accepted', 'skipped'));

-- 좋아요: 보낸 본인만 조회/생성. 받은 사람은 볼 수 없다.
-- 생성은 나에게 온 추천의 상대에게만 가능 (임의 사용자에게 좋아요 불가).
create policy likes_select_sent on public.likes
  for select using (from_user_id = auth.uid());
create policy likes_insert_from_recommendation on public.likes
  for insert with check (
    from_user_id = auth.uid()
    and exists (
      select 1 from public.recommendations r
      where r.user_id = auth.uid() and r.candidate_id = to_user_id
    )
  );

-- 매치/대화방: 참가자만
create policy matches_select_participant on public.matches
  for select using (auth.uid() in (user_a, user_b));
create policy conversations_select_participant on public.conversations
  for select using (public.is_match_participant(match_id));
