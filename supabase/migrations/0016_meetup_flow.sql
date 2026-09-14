-- 0016_meetup_flow.sql
-- Issue #41 — 사진 없는 대화 → 상호 만남 의향 → 실제 만남 확인 → 비공개 피드백 핵심 흐름.
-- 상태 모델·데이터 의미·배포 순서: docs/meetup-flow.md
--
-- additive migration — 기존 대화·매치·의향·피드백 행은 삭제/재해석하지 않는다.
--
-- 이 마이그레이션이 바꾸는 것
--   1) 채팅 멱등 전송: messages.client_message_id + unique + send_message() RPC.
--        같은 (대화, 발신자, client_message_id) 는 한 번만 저장되고, 재시도는 저장된 행을 그대로 돌려준다.
--        같은 식별자에 다른 본문을 보내면 덮어쓰지 않고 거부한다. 메트릭·이벤트는 실제 insert 에만 한 번 반영된다.
--   2) 서버 사실 기반 분석 이벤트: 메시지 최초 저장·양방향 대화 시작·재개, 의향 변경·상호 관심 성립/철회,
--        본인 만남 결과 응답·양측 확인·피드백 제출을 트리거/RPC 가 기록한다 (클라이언트 track 은 사용하지 않는다).
--   3) 알림 outbox(notification_events): 새 메시지·상호 만남 관심을 중복 없이 기록한다. Push 발송(#17) 은 미구현 —
--        연결 계약만 제공한다. 메시지 원문·일방 의향·피드백은 넣지 않는다.
--   4) 만남 의향은 meetup_set_intent() RPC 로만 쓴다 (직접 insert/update 정책 제거). 상호 yes 전이는 매치 행 잠금으로 한 번만.
--        상호 성립 후 한쪽이 바꾸면 meetup_state='interest_withdrawn' — 현재 상태와 RLS(상대 날짜·지역 비공개)가 일치한다.
--   5) 실제 만남 확인은 사용자별 meetup_outcomes 에 따로 저장하고 서버가 집계한다.
--        양측 모두 '만났음' 일 때만 meetup_state='met_confirmed'. 기존 'completed' 행은 "한쪽이 완료 버튼을 누른 과거 값(미검증)"
--        의미를 그대로 보존하며 자동 승격하지 않는다.
--   6) 피드백은 meetup_submit_feedback() RPC 로만 쓴다. 전체 만족도·재만남 의향·다음 소개 이용 의향·아쉬웠던 점(선택형)을
--        받고, 미응답(null)/모르겠음('not_sure')/부정('no') 을 구분한다. 기존 컬럼·행은 보존한다.
--   7) 클라이언트가 matches 를 직접 update 하는 정책(0008)을 제거한다. meetup_* 컬럼은 서버 관리 컬럼이다.
--   8) SECURITY DEFINER 헬퍼(is_blocked_pair, meetup_mutual_yes)가 참가자 아닌 호출자에게 상태를 알려주지 않게 한다.
--   9) Realtime: matches 를 publication 에 추가 (차단·상호 관심·양측 확인 상태를 열린 화면이 반영). RLS 가 그대로 적용된다.

-- ---------------------------------------------------------------------------
-- 0) 컨텍스트 헬퍼 — "최종 사용자 JWT 로 들어온 직접 요청" 인지
--    SECURITY DEFINER RPC/트리거 안에서는 current_user 가 함수 소유자(postgres)라 false 가 된다.
--    (서비스 role 은 auth.uid() 가 null 이라 false)
-- ---------------------------------------------------------------------------
create or replace function public.is_end_user_request()
returns boolean
language sql
stable
set search_path = public
as $$
  select auth.uid() is not null and current_user in ('anon', 'authenticated');
$$;

-- ---------------------------------------------------------------------------
-- 1) 헬퍼 강화 — 참가자가 아닌 호출자에게는 상태를 알려주지 않는다
-- ---------------------------------------------------------------------------
create or replace function public.is_blocked_pair(a uuid, b uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- 제3자(JWT 가 있고 당사자가 아님)는 두 사람의 차단 관계를 조회할 수 없다 — 항상 false
  if auth.uid() is not null and auth.uid() not in (a, b) then
    return false;
  end if;
  return exists (
    select 1 from public.blocks
    where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a)
  );
end;
$$;

create or replace function public.meetup_mutual_yes(mid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select (
      auth.uid() is null
      or exists (select 1 from public.matches m where m.id = mid and auth.uid() in (m.user_a, m.user_b))
    )
    and (select count(*) from public.meetup_intentions where match_id = mid and intent = 'yes') = 2;
$$;

-- 활성 매치 참가자이며, 양쪽 계정 모두 active 이고, 차단되지 않았는지 (메시지 insert 정책이 사용)
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
    join public.users ua on ua.id = m.user_a
    join public.users ub on ub.id = m.user_b
    where c.id = cid
      and m.status = 'active'
      and ua.status = 'active'
      and ub.status = 'active'
      and auth.uid() in (m.user_a, m.user_b)
      and not public.is_blocked_pair(m.user_a, m.user_b)
  );
$$;

-- 열린 대화 화면이 "지금 보낼 수 있는지" 와 이유(거친 분류만)를 알 수 있게 한다.
-- reason: ok | forbidden | ended(종료/차단) | self_restricted(본인 비활성) | unavailable(상대 비활성)
create or replace function public.conversation_access(cid uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  r record;
begin
  if auth.uid() is null then
    return jsonb_build_object('can_chat', false, 'reason', 'forbidden');
  end if;
  select m.id as match_id, m.status, m.user_a, m.user_b, ua.status as status_a, ub.status as status_b
    into r
  from public.conversations c
  join public.matches m on m.id = c.match_id
  join public.users ua on ua.id = m.user_a
  join public.users ub on ub.id = m.user_b
  where c.id = cid and auth.uid() in (m.user_a, m.user_b);
  if not found then
    return jsonb_build_object('can_chat', false, 'reason', 'forbidden');
  end if;
  if r.status <> 'active' or public.is_blocked_pair(r.user_a, r.user_b) then
    return jsonb_build_object('can_chat', false, 'reason', 'ended');
  end if;
  if (case when auth.uid() = r.user_a then r.status_a else r.status_b end) <> 'active' then
    return jsonb_build_object('can_chat', false, 'reason', 'self_restricted');
  end if;
  if (case when auth.uid() = r.user_a then r.status_b else r.status_a end) <> 'active' then
    return jsonb_build_object('can_chat', false, 'reason', 'unavailable');
  end if;
  return jsonb_build_object('can_chat', true, 'reason', 'ok');
end;
$$;

-- ---------------------------------------------------------------------------
-- 2) 알림 outbox — 서버 전용 (RLS 정책 없음). Push 파이프라인(#17)이 delivered_at 을 채운다.
--    payload 에 메시지 원문·일방 의향·피드백을 넣지 않는다. dedupe_key 로 같은 사실은 한 번만 기록된다.
-- ---------------------------------------------------------------------------
create table if not exists public.notification_events (
  id              bigint generated always as identity primary key,
  recipient_id    uuid not null references public.users (id) on delete cascade,
  kind            text not null check (kind in ('new_message', 'mutual_meetup_interest')),
  match_id        uuid references public.matches (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete cascade,
  dedupe_key      text not null unique,
  created_at      timestamptz not null default now(),
  delivered_at    timestamptz,
  delivery_error  text
);

create index if not exists notification_events_pending_idx
  on public.notification_events (created_at) where delivered_at is null;
create index if not exists notification_events_recipient_idx
  on public.notification_events (recipient_id, created_at desc);

alter table public.notification_events enable row level security;
revoke all on public.notification_events from anon, authenticated;

comment on table public.notification_events is
  '알림 outbox (#41/#17). 서버 전용. kind=new_message 는 메시지 id 기준 1건, mutual_meetup_interest 는 매치·수신자당 1건. 원문/일방 의향/피드백 없음';

-- ---------------------------------------------------------------------------
-- 3) 메시지 멱등 전송
-- ---------------------------------------------------------------------------
alter table public.messages
  add column if not exists client_message_id uuid;

comment on column public.messages.client_message_id is
  '클라이언트가 작성 시 1회 발급하는 재시도 식별자. (conversation_id, sender_id) 안에서 unique. 0016 이전 행은 null';

create unique index if not exists messages_client_message_id_uidx
  on public.messages (conversation_id, sender_id, client_message_id)
  where client_message_id is not null;

-- cursor 페이지네이션용 (created_at 동률은 id 로 보조 정렬)
create index if not exists messages_conversation_cursor_idx
  on public.messages (conversation_id, created_at desc, id desc);

-- 전송 RPC — SECURITY INVOKER: 기존 RLS(sender=auth.uid(), can_chat_in) 가 그대로 적용된다.
--   * 같은 식별자 재시도 → 저장된 행 반환 (저장 성공 후 응답 유실 복구). 차단 이후의 재시도도 저장된 행은 돌려준다.
--   * 같은 식별자 + 다른 본문 → 'message_content_mismatch' 거부 (덮어쓰기 없음)
--   * 같은 본문을 새 식별자로 다시 쓰면 별도 메시지다 (본문·시간으로 중복 제거하지 않는다)
create or replace function public.send_message(
  p_conversation_id uuid,
  p_client_message_id uuid,
  p_content text
)
returns public.messages
language plpgsql
security invoker
set search_path = public
as $$
declare
  uid       uuid := auth.uid();
  v_content text := btrim(coalesce(p_content, ''));
  existing  public.messages%rowtype;
  inserted  public.messages%rowtype;
begin
  if uid is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if p_conversation_id is null or p_client_message_id is null then
    raise exception 'client_message_id_required' using errcode = '22023';
  end if;
  if char_length(v_content) < 1 or char_length(v_content) > 2000 then
    raise exception 'invalid_content' using errcode = '22023';
  end if;

  select * into existing from public.messages
  where conversation_id = p_conversation_id and sender_id = uid and client_message_id = p_client_message_id;
  if found then
    if existing.content <> v_content then
      raise exception 'message_content_mismatch' using errcode = 'P0001';
    end if;
    return existing;
  end if;

  begin
    insert into public.messages (conversation_id, sender_id, content, client_message_id)
    values (p_conversation_id, uid, v_content, p_client_message_id)
    returning * into inserted;
    return inserted;
  exception when unique_violation then
    -- 동시 재시도: 다른 요청이 먼저 저장했다 → 그 행을 돌려준다
    select * into existing from public.messages
    where conversation_id = p_conversation_id and sender_id = uid and client_message_id = p_client_message_id;
    if not found then
      raise;
    end if;
    if existing.content <> v_content then
      raise exception 'message_content_mismatch' using errcode = 'P0001';
    end if;
    return existing;
  end;
end;
$$;

revoke all on function public.send_message(uuid, uuid, text) from public, anon;
grant execute on function public.send_message(uuid, uuid, text) to authenticated, service_role;

-- 메시지 insert 트리거 v2 — 메트릭(기존) + 서버 사실 기반 분석 이벤트 + 알림 outbox.
-- 실제 insert 된 행에만 실행되므로 재시도로 중복 집계되지 않는다.
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
  was_first   boolean;
  resumed     boolean := false;
  new_a       int;
  new_b       int;
  became_two_way boolean;
  recipient   uuid;
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

  was_first := met.first_message_at is null;
  new_a := met.messages_a + (case when new.sender_id = m.user_a then 1 else 0 end);
  new_b := met.messages_b + (case when new.sender_id = m.user_b then 1 else 0 end);
  became_two_way := (met.messages_a = 0 or met.messages_b = 0) and new_a > 0 and new_b > 0;

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
    resumed := true;
  end if;

  update public.conversation_metrics set
    total_messages    = met.total_messages + 1,
    messages_a        = new_a,
    messages_b        = new_b,
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

  -- 분석 이벤트 (서버 사실 기준 — 원문 없음)
  insert into public.analytics_events (user_id, event_type, payload)
  values (new.sender_id, 'message_sent',
          jsonb_build_object('conversation_id', new.conversation_id, 'match_id', m.id));
  if was_first then
    insert into public.analytics_events (user_id, event_type, payload)
    values (new.sender_id, 'first_message',
            jsonb_build_object('conversation_id', new.conversation_id, 'match_id', m.id));
  end if;
  if became_two_way then
    insert into public.analytics_events (user_id, event_type, payload)
    values
      (m.user_a, 'two_way_conversation', jsonb_build_object('conversation_id', new.conversation_id, 'match_id', m.id)),
      (m.user_b, 'two_way_conversation', jsonb_build_object('conversation_id', new.conversation_id, 'match_id', m.id));
  end if;
  if resumed then
    insert into public.analytics_events (user_id, event_type, payload)
    values (new.sender_id, 'conversation_resumed',
            jsonb_build_object('conversation_id', new.conversation_id, 'match_id', m.id));
  end if;

  -- 알림 outbox: 상대에게 "새 메시지" (메시지당 1건, 원문 없음)
  recipient := case when new.sender_id = m.user_a then m.user_b else m.user_a end;
  insert into public.notification_events (recipient_id, kind, match_id, conversation_id, dedupe_key)
  values (recipient, 'new_message', m.id, new.conversation_id, 'message:' || new.id::text)
  on conflict (dedupe_key) do nothing;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) matches — 서버 관리 만남 상태 컬럼
-- ---------------------------------------------------------------------------
alter table public.matches
  add column if not exists mutual_interest_at  timestamptz,
  add column if not exists meetup_confirmed_at timestamptz;

comment on column public.matches.meetup_state is
  'none | mutual_interest(현재 둘 다 yes) | interest_withdrawn(상호 성립 후 한쪽이 바꿈) | scheduled(과거 값, 앱 미사용) | completed(0016 이전: 한쪽이 완료 버튼 — 미검증 과거 값) | met_confirmed(양측이 각자 "만났음" 응답)';
comment on column public.matches.mutual_interest_at is
  '처음 상호 yes 가 성립한 시각 (과거 사실 — 이후 철회돼도 유지). 0016 이전 mutual_interest 행은 null';
comment on column public.matches.meetup_confirmed_at is
  '양측 모두 "만났음" 응답이 처음 갖춰진 시각';
comment on column public.matches.meetup_completed_at is
  '0016 이전 한쪽의 완료 버튼 시각 (미검증 과거 값). 새 앱은 쓰지 않는다';

alter table public.matches drop constraint if exists matches_meetup_state_check;
alter table public.matches add constraint matches_meetup_state_check
  check (meetup_state in ('none', 'mutual_interest', 'interest_withdrawn', 'scheduled', 'completed', 'met_confirmed'));

-- 클라이언트 직접 update 정책 제거 — 만남 상태는 RPC/트리거만 바꾼다
drop policy if exists matches_update_participant on public.matches;

create or replace function public.guard_match_update()
returns trigger
language plpgsql
as $$
begin
  if public.is_end_user_request() then
    if new.user_a is distinct from old.user_a
       or new.user_b is distinct from old.user_b
       or new.created_at is distinct from old.created_at then
      raise exception 'immutable match columns';
    end if;
    if new.status is distinct from old.status and new.status <> 'closed' then
      raise exception 'participants can only close a match';
    end if;
    if new.meetup_state is distinct from old.meetup_state
       or new.meetup_completed_at is distinct from old.meetup_completed_at
       or new.meetup_confirmed_at is distinct from old.meetup_confirmed_at
       or new.mutual_interest_at is distinct from old.mutual_interest_at then
      raise exception 'meetup columns are server-managed';
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) 만남 의향 — RPC 전용 쓰기, 상호 전이는 매치 행 잠금으로 한 번만
-- ---------------------------------------------------------------------------
drop policy if exists meetup_intentions_own on public.meetup_intentions;
create policy meetup_intentions_select_own on public.meetup_intentions
  for select using (user_id = auth.uid());
-- meetup_intentions_select_mutual (0005) 는 유지: 둘 다 yes 인 "현재" 에만 상대 행이 보인다

create or replace function public.handle_meetup_intent()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  m      public.matches%rowtype;
  mutual boolean;
begin
  -- 매치 행 잠금: 양측 동시 제출을 직렬화해 상호 전이·이벤트가 한 번만 생기게 한다
  select * into m from public.matches where id = new.match_id for update;

  if tg_op = 'INSERT' or new.intent is distinct from old.intent then
    insert into public.analytics_events (user_id, event_type, payload)
    values (new.user_id, 'meetup_intent_set',
            jsonb_build_object('match_id', new.match_id, 'intent', new.intent));
  end if;

  mutual := (select count(*) from public.meetup_intentions where match_id = new.match_id and intent = 'yes') = 2;

  if mutual and m.meetup_state in ('none', 'interest_withdrawn') then
    update public.matches
    set meetup_state = 'mutual_interest',
        mutual_interest_at = coalesce(mutual_interest_at, now())
    where id = new.match_id;

    if m.mutual_interest_at is null then
      insert into public.analytics_events (user_id, event_type, payload)
      values
        (m.user_a, 'meetup_mutual_interest', jsonb_build_object('match_id', m.id)),
        (m.user_b, 'meetup_mutual_interest', jsonb_build_object('match_id', m.id));
      insert into public.notification_events (recipient_id, kind, match_id, dedupe_key)
      values
        (m.user_a, 'mutual_meetup_interest', m.id, 'match:' || m.id::text || ':mutual:' || m.user_a::text),
        (m.user_b, 'mutual_meetup_interest', m.id, 'match:' || m.id::text || ':mutual:' || m.user_b::text)
      on conflict (dedupe_key) do nothing;
    else
      insert into public.analytics_events (user_id, event_type, payload)
      values
        (m.user_a, 'meetup_mutual_interest_restored', jsonb_build_object('match_id', m.id)),
        (m.user_b, 'meetup_mutual_interest_restored', jsonb_build_object('match_id', m.id));
    end if;
  elsif not mutual and m.meetup_state in ('mutual_interest', 'scheduled') then
    update public.matches set meetup_state = 'interest_withdrawn' where id = new.match_id;
    insert into public.analytics_events (user_id, event_type, payload)
    values (new.user_id, 'meetup_mutual_interest_withdrawn', jsonb_build_object('match_id', m.id));
  end if;
  return new;
end;
$$;

-- 트리거는 0005 에서 이미 만들어져 있다 (함수 본문만 교체됨). 없으면 만든다.
drop trigger if exists meetup_intentions_check_mutual on public.meetup_intentions;
create trigger meetup_intentions_check_mutual
  after insert or update on public.meetup_intentions
  for each row execute function public.handle_meetup_intent();

create or replace function public.meetup_set_intent(
  p_match_id uuid,
  p_intent text,
  p_available_dates text[] default '{}',
  p_preferred_region text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid     uuid := auth.uid();
  m       public.matches%rowtype;
  partner uuid;
  my_status text;
  partner_status text;
  dates   text[] := coalesce(p_available_dates, '{}');
  d       text;
begin
  if uid is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if p_intent not in ('yes', 'not_yet') then
    raise exception 'invalid_intent' using errcode = '22023';
  end if;
  if array_length(dates, 1) > 8 then
    raise exception 'too_many_dates' using errcode = '22023';
  end if;
  foreach d in array dates loop
    if d is null or char_length(d) < 1 or char_length(d) > 40 then
      raise exception 'invalid_dates' using errcode = '22023';
    end if;
  end loop;
  if p_preferred_region is not null and char_length(p_preferred_region) > 40 then
    raise exception 'invalid_region' using errcode = '22023';
  end if;

  select * into m from public.matches where id = p_match_id and uid in (user_a, user_b);
  if not found then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if m.status <> 'active' then
    raise exception 'match_not_active' using errcode = 'P0001';
  end if;
  partner := case when uid = m.user_a then m.user_b else m.user_a end;
  select status into my_status from public.users where id = uid;
  select status into partner_status from public.users where id = partner;
  if my_status is distinct from 'active' then
    raise exception 'self_restricted' using errcode = 'P0001';
  end if;
  if partner_status is distinct from 'active' or public.is_blocked_pair(m.user_a, m.user_b) then
    raise exception 'partner_unavailable' using errcode = 'P0001';
  end if;

  insert into public.meetup_intentions (match_id, user_id, intent, available_dates, preferred_region)
  values (p_match_id, uid, p_intent, dates, p_preferred_region)
  on conflict (match_id, user_id) do update
    set intent = excluded.intent,
        available_dates = excluded.available_dates,
        preferred_region = excluded.preferred_region;

  select * into m from public.matches where id = p_match_id;
  return jsonb_build_object(
    'intent', p_intent,
    'meetup_state', m.meetup_state,
    'mutual_yes', m.meetup_state = 'mutual_interest'
  );
end;
$$;

revoke all on function public.meetup_set_intent(uuid, text, text[], text) from public, anon;
grant execute on function public.meetup_set_intent(uuid, text, text[], text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6) 실제 만남 결과 — 사용자별 응답, 서버 집계
-- ---------------------------------------------------------------------------
create table if not exists public.meetup_outcomes (
  id             uuid primary key default gen_random_uuid(),
  match_id       uuid not null references public.matches (id) on delete cascade,
  user_id        uuid not null references public.users (id) on delete cascade,
  outcome        text not null check (outcome in ('met', 'not_met')),
  not_met_reason text check (not_met_reason is null or not_met_reason in ('canceled', 'no_show', 'other')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (match_id, user_id),
  check ((outcome = 'met' and not_met_reason is null) or (outcome = 'not_met' and not_met_reason is not null))
);

comment on table public.meetup_outcomes is
  '사용자별 "실제로 만났나요" 응답 (#41). 본인 진술이며 객관적 판정이 아니다 — no_show 는 제재 근거가 아니라 진술. 상대에게 비공개. 양측 met 일 때만 matches.meetup_state=met_confirmed';

create trigger meetup_outcomes_touch_updated_at
  before update on public.meetup_outcomes
  for each row execute function public.touch_updated_at();

alter table public.meetup_outcomes enable row level security;
create policy meetup_outcomes_select_own on public.meetup_outcomes
  for select using (user_id = auth.uid());

create or replace function public.handle_meetup_outcome()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  m        public.matches%rowtype;
  both_met boolean;
begin
  select * into m from public.matches where id = new.match_id for update;

  if tg_op = 'INSERT'
     or new.outcome is distinct from old.outcome
     or new.not_met_reason is distinct from old.not_met_reason then
    insert into public.analytics_events (user_id, event_type, payload)
    values (new.user_id, 'meetup_outcome_reported',
            jsonb_build_object('match_id', new.match_id, 'outcome', new.outcome, 'not_met_reason', new.not_met_reason));
  end if;

  both_met := (select count(*) from public.meetup_outcomes where match_id = new.match_id and outcome = 'met') = 2;
  if both_met and m.meetup_state <> 'met_confirmed' then
    update public.matches
    set meetup_state = 'met_confirmed',
        meetup_confirmed_at = coalesce(meetup_confirmed_at, now())
    where id = new.match_id;
    if m.meetup_confirmed_at is null then
      insert into public.analytics_events (user_id, event_type, payload)
      values
        (m.user_a, 'meetup_confirmed_both', jsonb_build_object('match_id', m.id)),
        (m.user_b, 'meetup_confirmed_both', jsonb_build_object('match_id', m.id));
    end if;
  end if;
  -- 양측 확인 이후 한쪽이 응답을 바꿔도 met_confirmed(과거 사실)는 되돌리지 않는다.
  -- 현재 응답 불일치는 meetup_pair_summary 뷰의 confirmation 으로 운영이 본다.
  return new;
end;
$$;

drop trigger if exists meetup_outcomes_aggregate on public.meetup_outcomes;
create trigger meetup_outcomes_aggregate
  after insert or update on public.meetup_outcomes
  for each row execute function public.handle_meetup_outcome();

create or replace function public.meetup_report_outcome(
  p_match_id uuid,
  p_outcome text,
  p_not_met_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid       uuid := auth.uid();
  m         public.matches%rowtype;
  my_status text;
  mine      public.meetup_outcomes%rowtype;
begin
  if uid is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if p_outcome not in ('met', 'not_met') then
    raise exception 'invalid_outcome' using errcode = '22023';
  end if;
  if p_outcome = 'met' and p_not_met_reason is not null then
    raise exception 'invalid_reason' using errcode = '22023';
  end if;
  if p_outcome = 'not_met' and (p_not_met_reason is null or p_not_met_reason not in ('canceled', 'no_show', 'other')) then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  -- 매치가 종료/차단됐어도 본인의 과거 만남 결과는 기록할 수 있다 (상대 정보 접근·연락 권한은 되살리지 않는다)
  select * into m from public.matches where id = p_match_id and uid in (user_a, user_b);
  if not found then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select status into my_status from public.users where id = uid;
  if my_status is distinct from 'active' then
    raise exception 'self_restricted' using errcode = 'P0001';
  end if;
  -- 상호 관심이 한 번이라도 성립했거나(0016 이후) 과거 앱이 만남 상태를 남긴 매치만 (앱 내 예약 등록은 요구하지 않는다)
  if m.mutual_interest_at is null and m.meetup_state = 'none' then
    raise exception 'meetup_not_arranged' using errcode = 'P0001';
  end if;

  insert into public.meetup_outcomes (match_id, user_id, outcome, not_met_reason)
  values (p_match_id, uid, p_outcome, p_not_met_reason)
  on conflict (match_id, user_id) do update
    set outcome = excluded.outcome,
        not_met_reason = excluded.not_met_reason;

  select * into m from public.matches where id = p_match_id;
  select * into mine from public.meetup_outcomes where match_id = p_match_id and user_id = uid;
  return jsonb_build_object(
    'my_outcome', mine.outcome,
    'my_not_met_reason', mine.not_met_reason,
    'both_confirmed', m.meetup_state = 'met_confirmed',
    'meetup_state', m.meetup_state
  );
end;
$$;

revoke all on function public.meetup_report_outcome(uuid, text, text) from public, anon;
grant execute on function public.meetup_report_outcome(uuid, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7) 만남 후 비공개 피드백 — 선택형, 미응답/모르겠음/부정 구분, 기존 컬럼·행 보존
-- ---------------------------------------------------------------------------
alter table public.meetup_feedback
  alter column met_again_intent drop not null;
alter table public.meetup_feedback drop constraint if exists meetup_feedback_met_again_intent_check;
alter table public.meetup_feedback add constraint meetup_feedback_met_again_intent_check
  check (met_again_intent is null or met_again_intent in ('yes', 'no', 'not_sure'));

alter table public.meetup_feedback
  add column if not exists overall_satisfaction smallint
    check (overall_satisfaction is null or overall_satisfaction between 1 and 5),
  add column if not exists next_intro_intent text
    check (next_intro_intent is null or next_intro_intent in ('yes', 'no', 'not_sure')),
  add column if not exists concerns text[] not null default '{}'
    check (concerns <@ array['appearance_mismatch', 'conversation', 'goal_mismatch', 'other']::text[]),
  add column if not exists form_version smallint not null default 1;

comment on column public.meetup_feedback.met_again_intent is
  '이 상대를 다시 만나고 싶은지: yes | no | not_sure | null(미응답). 0016 이전 행은 yes/no';
comment on column public.meetup_feedback.overall_satisfaction is '전체 만남 만족도 1~5 (선택)';
comment on column public.meetup_feedback.next_intro_intent is
  '다음 소개를 이용하고 싶은지: yes | no | not_sure | null. no 는 실패가 아니다 (좋은 관계가 생겨 필요 없을 수 있음)';
comment on column public.meetup_feedback.concerns is
  '아쉬웠던 점 (선택형, 복수): appearance_mismatch | conversation | goal_mismatch | other. 추천 점수로 쓰지 않는다';
comment on column public.meetup_feedback.appearance_attraction is
  '0016 이전 앱의 외모 끌림 점수 (더 이상 수집하지 않음 — 행 보존)';
comment on column public.meetup_feedback.form_version is '1 = 0016 이전 설문, 2 = #41 설문';

drop policy if exists meetup_feedback_own on public.meetup_feedback;
create policy meetup_feedback_select_own on public.meetup_feedback
  for select using (user_id = auth.uid());

create or replace function public.handle_meetup_feedback()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.analytics_events (user_id, event_type, payload)
    values (new.user_id, 'meetup_feedback_submitted', jsonb_build_object('match_id', new.match_id));
  elsif new.met_again_intent is distinct from old.met_again_intent
     or new.overall_satisfaction is distinct from old.overall_satisfaction
     or new.next_intro_intent is distinct from old.next_intro_intent
     or new.concerns is distinct from old.concerns then
    insert into public.analytics_events (user_id, event_type, payload)
    values (new.user_id, 'meetup_feedback_changed', jsonb_build_object('match_id', new.match_id));
  end if;
  return new;
end;
$$;

drop trigger if exists meetup_feedback_events on public.meetup_feedback;
create trigger meetup_feedback_events
  after insert or update on public.meetup_feedback
  for each row execute function public.handle_meetup_feedback();

create or replace function public.meetup_submit_feedback(
  p_match_id uuid,
  p_overall_satisfaction integer default null,
  p_met_again_intent text default null,
  p_next_intro_intent text default null,
  p_concerns text[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid        uuid := auth.uid();
  m          public.matches%rowtype;
  my_status  text;
  my_outcome text;
  concerns   text[] := coalesce(p_concerns, '{}');
  c          text;
begin
  if uid is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if p_overall_satisfaction is not null and p_overall_satisfaction not between 1 and 5 then
    raise exception 'invalid_satisfaction' using errcode = '22023';
  end if;
  if p_met_again_intent is not null and p_met_again_intent not in ('yes', 'no', 'not_sure') then
    raise exception 'invalid_met_again_intent' using errcode = '22023';
  end if;
  if p_next_intro_intent is not null and p_next_intro_intent not in ('yes', 'no', 'not_sure') then
    raise exception 'invalid_next_intro_intent' using errcode = '22023';
  end if;
  foreach c in array concerns loop
    if c not in ('appearance_mismatch', 'conversation', 'goal_mismatch', 'other') then
      raise exception 'invalid_concern' using errcode = '22023';
    end if;
  end loop;
  concerns := (select coalesce(array_agg(distinct x), '{}') from unnest(concerns) x);
  if p_overall_satisfaction is null and p_met_again_intent is null and p_next_intro_intent is null
     and cardinality(concerns) = 0 then
    raise exception 'empty_feedback' using errcode = '22023';
  end if;

  -- 매치가 종료/차단됐어도 본인의 피드백은 남길 수 있다
  select * into m from public.matches where id = p_match_id and uid in (user_a, user_b);
  if not found then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select status into my_status from public.users where id = uid;
  if my_status is distinct from 'active' then
    raise exception 'self_restricted' using errcode = 'P0001';
  end if;
  -- 본인이 "만났음" 이라고 응답한 매치만. 상대의 응답을 기다리게 하지 않는다.
  select outcome into my_outcome from public.meetup_outcomes where match_id = p_match_id and user_id = uid;
  if my_outcome is distinct from 'met' then
    raise exception 'outcome_required' using errcode = 'P0001';
  end if;

  insert into public.meetup_feedback (match_id, user_id, met_again_intent, overall_satisfaction, next_intro_intent, concerns, form_version)
  values (p_match_id, uid, p_met_again_intent, p_overall_satisfaction, p_next_intro_intent, concerns, 2)
  on conflict (match_id, user_id) do update
    set met_again_intent = excluded.met_again_intent,
        overall_satisfaction = excluded.overall_satisfaction,
        next_intro_intent = excluded.next_intro_intent,
        concerns = excluded.concerns,
        form_version = 2;

  return jsonb_build_object('submitted', true);
end;
$$;

revoke all on function public.meetup_submit_feedback(uuid, integer, text, text, text[]) from public, anon;
grant execute on function public.meetup_submit_feedback(uuid, integer, text, text, text[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8) 운영/측정용 집계 뷰 — 서버(service role) 전용. 개인 응답을 사용자에게 돌려주는 경로가 아니다.
-- ---------------------------------------------------------------------------
create or replace view public.meetup_pair_summary as
select
  m.id as match_id,
  m.user_a,
  m.user_b,
  m.status,
  m.meetup_state,
  m.mutual_interest_at,
  m.meetup_confirmed_at,
  m.meetup_completed_at,
  ia.intent as intent_a,
  ib.intent as intent_b,
  oa.outcome as outcome_a,
  oa.not_met_reason as not_met_reason_a,
  ob.outcome as outcome_b,
  ob.not_met_reason as not_met_reason_b,
  case
    when oa.outcome = 'met' and ob.outcome = 'met' then 'both_met'
    when oa.outcome = 'not_met' and ob.outcome = 'not_met' then 'both_not_met'
    when oa.outcome is not null and ob.outcome is not null then 'mismatch'
    when oa.outcome = 'met' or ob.outcome = 'met' then 'one_side_met'
    when oa.outcome = 'not_met' or ob.outcome = 'not_met' then 'one_side_not_met'
    else 'unconfirmed'
  end as confirmation,
  (oa.not_met_reason = 'no_show' or ob.not_met_reason = 'no_show') as no_show_claimed,
  (m.meetup_state = 'met_confirmed' and not (oa.outcome = 'met' and ob.outcome = 'met')) as confirmation_disputed,
  (m.meetup_state = 'completed') as legacy_unverified_completed,
  (fa.id is not null) as feedback_a,
  (fb.id is not null) as feedback_b,
  fa.met_again_intent as met_again_a,
  fb.met_again_intent as met_again_b,
  fa.next_intro_intent as next_intro_a,
  fb.next_intro_intent as next_intro_b
from public.matches m
left join public.meetup_intentions ia on ia.match_id = m.id and ia.user_id = m.user_a
left join public.meetup_intentions ib on ib.match_id = m.id and ib.user_id = m.user_b
left join public.meetup_outcomes oa on oa.match_id = m.id and oa.user_id = m.user_a
left join public.meetup_outcomes ob on ob.match_id = m.id and ob.user_id = m.user_b
left join public.meetup_feedback fa on fa.match_id = m.id and fa.user_id = m.user_a
left join public.meetup_feedback fb on fb.match_id = m.id and fb.user_id = m.user_b;

revoke all on public.meetup_pair_summary from public, anon, authenticated;
grant select on public.meetup_pair_summary to service_role;

comment on view public.meetup_pair_summary is
  '매치 쌍 단위 만남 집계 (#24/#41). 서버 전용. one_side_met/both_met/mismatch/unconfirmed 와 no_show 진술을 구분한다. legacy completed 는 양측 확인으로 세지 않는다';

-- ---------------------------------------------------------------------------
-- 9) Realtime — matches 상태 변경(차단·상호 관심·양측 확인)을 열린 화면이 받는다. RLS(참가자만) 적용.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'matches'
     ) then
    alter publication supabase_realtime add table public.matches;
  end if;
end;
$$;
