-- 0004_chat.sql
-- 채팅: messages / conversation_metrics
--
--  * 텍스트 전용 (MVP 원칙 — 이미지 전송 없음)
--  * 메시지는 대화 참가자 외에는 절대 조회 불가
--  * conversation_metrics 는 트리거로 집계되어 향후 MatchingEngine 의
--    ConversationSignals 입력이 된다 (대화 원문 분석 아님)

-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------
create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id       uuid not null references public.users (id) on delete cascade,
  content         text not null check (char_length(content) between 1 and 2000),
  created_at      timestamptz not null default now(),
  read_at         timestamptz
);

create index messages_conversation_idx on public.messages (conversation_id, created_at);
create index messages_unread_idx on public.messages (conversation_id) where read_at is null;

-- ---------------------------------------------------------------------------
-- conversation_metrics — 대화 행동 신호 (원문이 아닌 메타데이터만)
-- ---------------------------------------------------------------------------
create table public.conversation_metrics (
  conversation_id      uuid primary key references public.conversations (id) on delete cascade,
  total_messages       int not null default 0,
  messages_a           int not null default 0,  -- match.user_a 기준
  messages_b           int not null default 0,
  first_message_at     timestamptz,
  last_message_at      timestamptz,
  last_sender_id       uuid,
  last_message_date    date,
  active_days          int not null default 0,
  -- 평균 응답시간 계산용 누적값
  response_seconds_a   bigint not null default 0,
  response_count_a     int not null default 0,
  response_seconds_b   bigint not null default 0,
  response_count_b     int not null default 0,
  -- 6시간 이상 침묵 후 다시 대화를 시작한 횟수 / 마지막 재개자
  resumed_count        int not null default 0,
  last_resumed_by      uuid,
  updated_at           timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 메시지 insert 시 메트릭 갱신
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  m           public.matches%rowtype;
  met         public.conversation_metrics%rowtype;
  gap_seconds bigint;
  msg_date    date := (new.created_at at time zone 'Asia/Seoul')::date;
begin
  select mt.* into m
  from public.matches mt
  join public.conversations c on c.match_id = mt.id
  where c.id = new.conversation_id;

  insert into public.conversation_metrics (conversation_id)
  values (new.conversation_id)
  on conflict (conversation_id) do nothing;

  select * into met from public.conversation_metrics
  where conversation_id = new.conversation_id
  for update;

  -- 응답 시간: 발신자가 바뀐 경우에만 집계
  if met.last_message_at is not null and met.last_sender_id is distinct from new.sender_id then
    gap_seconds := extract(epoch from (new.created_at - met.last_message_at))::bigint;
    if new.sender_id = m.user_a then
      met.response_seconds_a := met.response_seconds_a + gap_seconds;
      met.response_count_a := met.response_count_a + 1;
    else
      met.response_seconds_b := met.response_seconds_b + gap_seconds;
      met.response_count_b := met.response_count_b + 1;
    end if;
  end if;

  -- 6시간 이상 침묵 후 재개
  if met.last_message_at is not null
     and new.created_at - met.last_message_at > interval '6 hours' then
    met.resumed_count := met.resumed_count + 1;
    met.last_resumed_by := new.sender_id;
  end if;

  update public.conversation_metrics set
    total_messages    = met.total_messages + 1,
    messages_a        = met.messages_a + (case when new.sender_id = m.user_a then 1 else 0 end),
    messages_b        = met.messages_b + (case when new.sender_id = m.user_b then 1 else 0 end),
    first_message_at  = coalesce(met.first_message_at, new.created_at),
    last_message_at   = new.created_at,
    last_sender_id    = new.sender_id,
    last_message_date = msg_date,
    active_days       = met.active_days
                        + (case when met.last_message_date is distinct from msg_date then 1 else 0 end),
    response_seconds_a = met.response_seconds_a,
    response_count_a   = met.response_count_a,
    response_seconds_b = met.response_seconds_b,
    response_count_b   = met.response_count_b,
    resumed_count      = met.resumed_count,
    last_resumed_by    = met.last_resumed_by,
    updated_at         = now()
  where conversation_id = new.conversation_id;

  update public.conversations
  set last_message_at = new.created_at
  where id = new.conversation_id;

  return new;
end;
$$;

create trigger messages_update_metrics
  after insert on public.messages
  for each row execute function public.handle_new_message();

-- ---------------------------------------------------------------------------
-- 읽음 표시: 수신자만, read_at 만 변경 가능
-- ---------------------------------------------------------------------------
create or replace function public.guard_message_update()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is not null then
    if new.content is distinct from old.content
       or new.sender_id is distinct from old.sender_id
       or new.conversation_id is distinct from old.conversation_id
       or new.created_at is distinct from old.created_at then
      raise exception 'only read_at can be updated';
    end if;
    if old.sender_id = auth.uid() then
      raise exception 'sender cannot mark own message as read';
    end if;
  end if;
  return new;
end;
$$;

create trigger messages_guard_update
  before update on public.messages
  for each row execute function public.guard_message_update();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.messages             enable row level security;
alter table public.conversation_metrics enable row level security;

-- 차단 여부 (양방향)
create or replace function public.is_blocked_pair(a uuid, b uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return exists (
    select 1 from public.blocks
    where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a)
  );
end;
$$;

-- 활성 매치의 참가자이며 차단되지 않았는지
create or replace function public.can_chat_in(cid uuid)
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
    join public.users u on u.id = auth.uid()
    where c.id = cid
      and m.status = 'active'
      and u.status = 'active'
      and auth.uid() in (m.user_a, m.user_b)
      and not public.is_blocked_pair(m.user_a, m.user_b)
  );
$$;

create policy messages_select_participant on public.messages
  for select using (public.conversation_participant(conversation_id));
create policy messages_insert_participant on public.messages
  for insert with check (
    sender_id = auth.uid() and public.can_chat_in(conversation_id)
  );
create policy messages_mark_read on public.messages
  for update using (public.conversation_participant(conversation_id))
  with check (public.conversation_participant(conversation_id));

create policy conversation_metrics_select_participant on public.conversation_metrics
  for select using (public.conversation_participant(conversation_id));

-- ---------------------------------------------------------------------------
-- Realtime (실제 Supabase 환경에서만 publication 존재)
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.messages;
  end if;
end;
$$;
