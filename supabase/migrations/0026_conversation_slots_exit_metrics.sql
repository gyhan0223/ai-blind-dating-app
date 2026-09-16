-- 0026_conversation_slots_exit_metrics.sql
-- Issue #24 (2026-09-15 결정) — 동시 대화 3개 제한 · 나가기(종료) · 과거 매칭 상대 재매칭 방지 · 대화 행동 지표.
--
-- 서비스의 역할은 서로 모르던 두 사람이 소개와 대화를 통해 호감을 가질 기회를 만드는 것이다. 실제 만남·관계 지속은
-- 사용자의 선택이며 성공 조건이 아니다. 이 마이그레이션은 행동을 호감 점수·성격 판정으로 바꾸지 않는다 (AI 원문 분석 없음).
-- 정책·지표 정의: docs/funnel-metrics.md · docs/meetup-flow.md · docs/matching-policy.md
--
-- additive. 기존 매치·메시지·만남·피드백 행은 삭제/재해석하지 않는다. 이미 적용된 마이그레이션은 덮어쓰지 않고
-- 여기서 함수의 최종 정의를 다시 만든다 (handle_mutual_like 0018 → 여기, handle_new_message 0016 → 여기,
-- guard_recommendation_decision 0023 → 여기, recommendation_run_claim/batch_targets 0017 → 여기, 퍼널 뷰 0022/0025 → 여기).
--
-- 이 마이그레이션이 바꾸는 것
--   1) 대화 자리: 사용자당 진행 중(matches.status='active') 매치 최대 3개 (conversation_slot_limit()).
--        매치 생성 트리거(handle_mutual_like)가 양쪽 users 행을 id 순으로 잠그고 자리를 확인한다 — 동시 수락에도 초과 없음.
--        자리 부족은 'no_slot_self' / 'no_slot_partner' 예외로 구분된다 (후보 부족·상대 거절이 아니다).
--        recommendation_accept() RPC 가 추천 수락(status)·좋아요·매치 생성을 한 트랜잭션으로 처리한다 — 자리 부족이면 아무것도 남지 않는다.
--        추천 생성(recommend.ts)은 자리가 없는 요청자에게 'slots_full' 을 돌려주고 그날은 다시 훑지 않는다(claim skip). 후보도 자리 없는 사용자는 제외.
--   2) 나가기: conversation_leave(match, reason?) — 매치 행 잠금 → status='closed', closed_at/closed_by/close_kind='left'. 반복·양쪽 동시 호출은 한 번만 처리.
--        종료 이유는 conversation_exits 에 본인만 읽을 수 있게 저장한다 (matches 행·Realtime payload 에 없음). 응답 없이 종료 가능.
--        종료된 대화의 메시지 insert 는 트리거가 매치 행 잠금 뒤 status 를 다시 확인해 거부한다 (종료와 전송이 동시여도).
--   3) 재매칭 방지: 한 번 매칭된 쌍(상태 무관)은 다시 좋아요/매치할 수 없다 (already_matched). closed/blocked → active 재전이는 어떤 경로에서도 거부.
--        추천 엔진은 이미 matchedUserIds(상태 무관)를 제외한다 (#40).
--   4) 추천 실제 확인: recommendations.viewed_at + recommendation_mark_viewed() (멱등). 과거 행은 클라이언트 이벤트가 있을 때만 복원, 없으면 null.
--   5) 대화 행동 지표: conversation_pair_metrics(p_as_of) — 서버 저장 메시지·매치·종료 시각만으로 계산 (기준 시각 고정 가능, 같은 시각은 id 로 정렬).
--        첫 연락(1시간 경계)·상대 첫 답장·연속 발신 응답 대기·방향별 최장 대기·진행 중 대기·24시간 중단/재개·종료 단계. 뷰 conversation_pair_facts / conversation_cohorts.
--   6) 퍼널 뷰 재작성: sustained_7d 를 핵심 퍼널에서 제외 (뷰 컬럼 제거 — 의존 뷰를 명시 순서로 drop 후 재생성, CASCADE 없음). 매치 쌍 집계도 demo 제외.
--        추천 생성 / 실제 확인 / 수락 구분. cohort 관찰 일수 표기.

-- ---------------------------------------------------------------------------
-- 0) 상수 · 헬퍼
-- ---------------------------------------------------------------------------
create or replace function public.conversation_slot_limit()
returns int
language sql
immutable
as $$ select 3 $$;

comment on function public.conversation_slot_limit() is '사용자당 진행 중(active) 매치 최대 개수 (#24). 메시지가 없어도 매치 생성 시점부터 한 자리';

-- 진행 중 매치 수 — 서버 전용 (클라이언트는 자기 matches 조회로 센다)
create or replace function public.conversation_active_count(p_user uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int from public.matches m where m.status = 'active' and p_user in (m.user_a, m.user_b);
$$;
revoke all on function public.conversation_active_count(uuid) from public, anon, authenticated;
grant execute on function public.conversation_active_count(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 1) matches — 종료 사실 (시각·주체·종류). 이유는 여기 없다 (conversation_exits, 본인만)
-- ---------------------------------------------------------------------------
alter table public.matches
  add column if not exists closed_at  timestamptz,
  add column if not exists closed_by  uuid references public.users (id) on delete set null,
  add column if not exists close_kind text check (close_kind is null or close_kind in ('left', 'blocked', 'account', 'admin', 'unknown'));

comment on column public.matches.closed_at is '종료 시각 (0026 이후). 그 전에 닫힌 행은 null — 시각을 지어내지 않는다 (측정 시작 전)';
comment on column public.matches.closed_by is '나가기(left)로 종료한 사용자. 차단·계정·운영 종료는 null (누가 차단했는지 드러내지 않는다)';
comment on column public.matches.close_kind is 'left(나가기) | blocked(차단) | account(탈퇴/익명화) | admin(운영 제재) | unknown(0026 이전 종료)';

create index if not exists matches_active_user_a_idx on public.matches (user_a) where status = 'active';
create index if not exists matches_active_user_b_idx on public.matches (user_b) where status = 'active';

-- 과거 종료 행: 종류만 복원 가능한 범위에서 (blocked 는 확실, closed 는 unknown). closed_at 은 채우지 않는다
update public.matches set close_kind = 'blocked' where status = 'blocked' and close_kind is null;
update public.matches set close_kind = 'unknown' where status = 'closed' and close_kind is null;

-- 생명주기 가드 (모든 역할): 종료 시 closed_at/close_kind 를 채우고, closed/blocked → active 재전이는 거부한다
create or replace function public.guard_match_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  st_a text;
  st_b text;
begin
  if old.status in ('closed', 'blocked') and new.status = 'active' then
    raise exception 'match_reopen_forbidden' using errcode = 'P0001';
  end if;
  if old.status = 'active' and new.status in ('closed', 'blocked') then
    new.closed_at := coalesce(new.closed_at, now());
    if new.close_kind is null then
      if new.status = 'blocked' then
        new.close_kind := 'blocked';
      else
        -- 계정 경로 추정: 참가자의 계정 상태로만 (ban 은 admin, 탈퇴/익명화는 account, 그 외 unknown)
        select ua.status, ub.status into st_a, st_b
        from public.users ua, public.users ub where ua.id = new.user_a and ub.id = new.user_b;
        new.close_kind := case
          when 'banned' in (st_a, st_b) then 'admin'
          when 'deleted' in (st_a, st_b) then 'account'
          else 'unknown' end;
      end if;
    end if;
    if new.close_kind <> 'left' then
      new.closed_by := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists matches_guard_lifecycle on public.matches;
create trigger matches_guard_lifecycle
  before update on public.matches
  for each row execute function public.guard_match_lifecycle();

-- 최종 사용자 컨텍스트의 직접 update 는 0016 이후 정책이 없어 0행이다. 가드에 종료 컬럼도 포함해 둔다 (정책이 생겨도 서버 관리 컬럼)
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
    if new.status is distinct from old.status
       or new.closed_at is distinct from old.closed_at
       or new.closed_by is distinct from old.closed_by
       or new.close_kind is distinct from old.close_kind then
      raise exception 'match lifecycle is server-managed (use conversation_leave)';
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
-- 2) 종료 이유 — 선택 응답, 본인만 조회. 상대·Realtime·matches 행에 노출되지 않는다
-- ---------------------------------------------------------------------------
create table if not exists public.conversation_exits (
  match_id   uuid not null references public.matches (id) on delete cascade,
  user_id    uuid not null references public.users (id) on delete cascade,
  reason     text check (reason is null or reason in ('no_reply', 'not_a_fit', 'moved_elsewhere', 'after_meetup', 'other')),
  created_at timestamptz not null default now(),
  primary key (match_id, user_id)
);

comment on table public.conversation_exits is
  '나가기 이유 (#24). 선택 응답(null = 응답하지 않음). 본인만 조회. 상대에게 비공개이며 제재·호감 판단에 쓰지 않는다. no_reply=답장이 없어요 · not_a_fit=대화가 잘 맞지 않아요 · moved_elsewhere=이미 다른 연락수단으로 연락하고 있어요 · after_meetup=만남 이후 종료하고 싶어요 · other=기타';

alter table public.conversation_exits enable row level security;
drop policy if exists conversation_exits_select_own on public.conversation_exits;
create policy conversation_exits_select_own on public.conversation_exits
  for select using (user_id = auth.uid());

-- 나가기 RPC — 참가자만. 매치 행 잠금으로 반복·양쪽 동시 요청을 한 번만 처리한다.
-- 계정 상태와 무관하게 허용한다 (나가기는 안전한 동작). 신고·차단·만남 결과·피드백 경로는 그대로 남는다.
create or replace function public.conversation_leave(p_match_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  m   public.matches%rowtype;
begin
  if uid is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if p_reason is not null and p_reason not in ('no_reply', 'not_a_fit', 'moved_elsewhere', 'after_meetup', 'other') then
    raise exception 'invalid_reason' using errcode = '22023';
  end if;

  select * into m from public.matches where id = p_match_id and uid in (user_a, user_b) for update;
  if not found then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if m.status <> 'active' then
    -- 이미 종료됨 (같은 사용자의 재시도 · 상대가 먼저 나감 · 차단). 상태는 바꾸지 않고, 본인 이유만 기록한다
    if p_reason is not null then
      insert into public.conversation_exits (match_id, user_id, reason) values (p_match_id, uid, p_reason)
      on conflict (match_id, user_id) do update set reason = coalesce(public.conversation_exits.reason, excluded.reason);
    end if;
    return jsonb_build_object(
      'already_closed', true, 'status', m.status, 'closed_at', m.closed_at, 'closed_by', m.closed_by, 'close_kind', m.close_kind);
  end if;

  update public.matches
  set status = 'closed', closed_at = now(), closed_by = uid, close_kind = 'left'
  where id = p_match_id;

  insert into public.conversation_exits (match_id, user_id, reason) values (p_match_id, uid, p_reason)
  on conflict (match_id, user_id) do update set reason = coalesce(excluded.reason, public.conversation_exits.reason);

  -- 서버 사실 이벤트 (이유 없음 — 이유는 conversation_exits 에만)
  insert into public.analytics_events (user_id, event_type, payload)
  values (uid, 'conversation_left', jsonb_build_object('match_id', p_match_id));

  select * into m from public.matches where id = p_match_id;
  return jsonb_build_object(
    'already_closed', false, 'status', m.status, 'closed_at', m.closed_at, 'closed_by', m.closed_by, 'close_kind', m.close_kind);
end;
$$;

revoke all on function public.conversation_leave(uuid, text) from public, anon;
grant execute on function public.conversation_leave(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) 종료된 대화에는 메시지가 저장되지 않는다 — 트리거가 매치 행을 잠근 뒤 status 를 다시 확인한다 (종료·전송 경쟁 포함).
--    handle_new_message 최종 정의 (0016 본문 + 잠금/검사). RLS(can_chat_in) 는 그대로 첫 방어선이다.
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
  was_first   boolean;
  resumed     boolean := false;
  new_a       int;
  new_b       int;
  became_two_way boolean;
  recipient   uuid;
begin
  -- 매치 행 잠금: 동시에 진행 중인 conversation_leave/차단이 커밋된 뒤의 상태를 본다
  select mt.* into m
  from public.matches mt
  join public.conversations c on c.match_id = mt.id
  where c.id = new.conversation_id
  for update of mt;
  if not found then
    raise exception 'conversation_not_found' using errcode = 'P0002';
  end if;
  if m.status <> 'active' then
    raise exception 'conversation_closed' using errcode = 'P0001';
  end if;

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

  recipient := case when new.sender_id = m.user_a then m.user_b else m.user_a end;
  insert into public.notification_events (recipient_id, kind, match_id, conversation_id, dedupe_key)
  values (recipient, 'new_message', m.id, new.conversation_id, 'message:' || new.id::text)
  on conflict (dedupe_key) do nothing;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) 매치 생성 — 자리 확인 + 재매칭 방지. handle_mutual_like 최종 정의 (0018 본문 + 잠금/검사)
-- ---------------------------------------------------------------------------
create or replace function public.handle_mutual_like()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  m_id uuid;
  lo   uuid := least(new.from_user_id, new.to_user_id);
  hi   uuid := greatest(new.from_user_id, new.to_user_id);
  lim  int  := public.conversation_slot_limit();
  existing_status text;
begin
  select status into existing_status from public.matches where user_a = lo and user_b = hi;
  if existing_status is not null then
    -- 한 번 매칭됐다가 종료된 쌍은 이유와 무관하게 다시 매칭하지 않는다 (좋아요 자체를 거부)
    if existing_status <> 'active' then
      raise exception 'already_matched' using errcode = 'P0001';
    end if;
    -- 이미 진행 중인 매치 (같은 문장의 양방향 insert · 재시도): 새로 만들 것이 없다
    return new;
  end if;

  -- 좋아요를 보내는 쪽은 자리가 있어야 한다 (3개가 차면 이미 발급된 소개도 수락할 수 없다)
  perform 1 from public.users where id = new.from_user_id for update;
  if public.conversation_active_count(new.from_user_id) >= lim then
    raise exception 'no_slot_self' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.likes
    where from_user_id = new.to_user_id and to_user_id = new.from_user_id
  ) then
    -- 양쪽 users 행을 id 순으로 잠근다 (동시 수락 직렬화 · 데드락 방지). 위에서 from 을 이미 잠갔으면 재잠금은 무해
    perform 1 from public.users where id = lo for update;
    perform 1 from public.users where id = hi for update;
    if public.conversation_active_count(new.from_user_id) >= lim then
      raise exception 'no_slot_self' using errcode = 'P0001';
    end if;
    if public.conversation_active_count(new.to_user_id) >= lim then
      raise exception 'no_slot_partner' using errcode = 'P0001';
    end if;

    insert into public.matches (user_a, user_b)
    values (lo, hi)
    on conflict (user_a, user_b) do nothing
    returning id into m_id;

    if m_id is not null then
      insert into public.conversations (match_id) values (m_id);
      insert into public.analytics_events (user_id, event_type, payload)
      values
        (new.from_user_id, 'match_created', jsonb_build_object('match_id', m_id)),
        (new.to_user_id,   'match_created', jsonb_build_object('match_id', m_id));
      insert into public.notification_events (recipient_id, kind, match_id, dedupe_key)
      values
        (new.from_user_id, 'match_created', m_id, 'match:' || m_id::text || ':created:' || new.from_user_id::text),
        (new.to_user_id,   'match_created', m_id, 'match:' || m_id::text || ':created:' || new.to_user_id::text)
      on conflict (dedupe_key) do nothing;
    end if;
  end if;
  return new;
end;
$$;

-- 추천 상태 가드 최종 정의 (0023 + 자리 확인): 최종 사용자가 직접 accepted 로 바꿀 때도 자리가 없으면 거부한다 (예전 앱 경로)
create or replace function public.guard_recommendation_decision()
returns trigger
language plpgsql
as $$
declare
  changed text[];
begin
  if public.is_end_user_request() then
    select coalesce(array_agg(n.key), '{}') into changed
    from jsonb_each(to_jsonb(new)) n
    join jsonb_each(to_jsonb(old)) o on o.key = n.key
    where n.value is distinct from o.value
      and n.key not in ('status', 'skip_reason', 'skip_reason_detail', 'decided_at', 'updated_at');
    if array_length(changed, 1) is not null then
      raise exception 'recommendation columns % are server managed', changed using errcode = '42501';
    end if;
    if new.status is distinct from old.status then
      if old.status <> 'pending' or new.status not in ('accepted', 'skipped') then
        raise exception 'recommendation status can only move from pending to accepted/skipped' using errcode = '42501';
      end if;
      -- SECURITY INVOKER 트리거: 사용자 RLS 로 보이는 매치는 본인 참여 매치뿐이므로 그대로 센다 (서버 전용 함수를 호출하지 않는다)
      if new.status = 'accepted'
         and (select count(*) from public.matches m where m.status = 'active' and new.user_id in (m.user_a, m.user_b)) >= public.conversation_slot_limit() then
        raise exception 'no_slot_self' using errcode = 'P0001';
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- 수락 RPC — 추천 status·좋아요·매치 생성을 한 트랜잭션으로. 자리 부족/재매칭 차단은 예외가 아니라 result 로 돌려주고 아무것도 남기지 않는다.
--   result: matched | liked(상대 응답 대기) | no_slot_self | no_slot_partner | already_matched
create or replace function public.recommendation_accept(p_recommendation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid       uuid := auth.uid();
  r         public.recommendations%rowtype;
  my_status text;
  lo        uuid;
  hi        uuid;
  m_id      uuid;
begin
  if uid is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  select * into r from public.recommendations where id = p_recommendation_id and user_id = uid for update;
  if not found then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select status into my_status from public.users where id = uid;
  if my_status is distinct from 'active' then
    raise exception 'self_restricted' using errcode = 'P0001';
  end if;
  lo := least(uid, r.candidate_id);
  hi := greatest(uid, r.candidate_id);

  if r.status = 'accepted' then
    -- 재시도: 이미 처리됨 — 현재 매치 상태만 알려준다
    select id into m_id from public.matches where user_a = lo and user_b = hi and status = 'active';
    return jsonb_build_object('result', case when m_id is null then 'liked' else 'matched' end, 'match_id', m_id, 'retry', true);
  end if;
  if r.status <> 'pending' then
    raise exception 'not_pending' using errcode = 'P0001';
  end if;

  begin
    update public.recommendations set status = 'accepted', decided_at = now() where id = r.id;
    insert into public.likes (from_user_id, to_user_id, recommendation_id)
    values (uid, r.candidate_id, r.id)
    on conflict (from_user_id, to_user_id) do nothing;
  exception when others then
    if sqlerrm in ('no_slot_self', 'no_slot_partner', 'already_matched') then
      -- 하위 블록 롤백: 추천은 pending 으로 남고 좋아요도 없다
      return jsonb_build_object('result', sqlerrm, 'match_id', null);
    end if;
    raise;
  end;

  insert into public.analytics_events (user_id, event_type, payload)
  values (uid, 'recommendation_accepted', jsonb_build_object('recommendation_id', r.id, 'strategy', r.strategy));

  select id into m_id from public.matches where user_a = lo and user_b = hi and status = 'active';
  return jsonb_build_object('result', case when m_id is null then 'liked' else 'matched' end, 'match_id', m_id);
end;
$$;

revoke all on function public.recommendation_accept(uuid) from public, anon;
grant execute on function public.recommendation_accept(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5) 추천 실제 확인 (열람) — 서버 생성만으로 열람을 단정하지 않는다. 앱이 카드를 실제로 그린 시점에 멱등 기록
-- ---------------------------------------------------------------------------
alter table public.recommendations add column if not exists viewed_at timestamptz;
comment on column public.recommendations.viewed_at is '앱이 카드를 실제로 표시한 첫 시각 (recommendation_mark_viewed, 멱등). 0026 이전 행은 클라이언트 이벤트가 있을 때만 복원, 없으면 null(측정 시작 전)';

-- 과거 행 복원: 클라이언트 recommendation_viewed 이벤트의 최초 시각만 (없으면 null 유지 — 지어내지 않는다)
update public.recommendations r
set viewed_at = e.first_viewed
from (
  select (payload->>'recommendation_id')::uuid as rec_id, min(created_at) as first_viewed
  from public.analytics_events
  where event_type = 'recommendation_viewed'
    and payload->>'recommendation_id' ~ '^[0-9a-fA-F-]{36}$'
  group by 1
) e
where e.rec_id = r.id and r.viewed_at is null;

create or replace function public.recommendation_mark_viewed(p_recommendation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  ts  timestamptz;
begin
  if uid is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  update public.recommendations
  set viewed_at = coalesce(viewed_at, now())
  where id = p_recommendation_id and user_id = uid
  returning viewed_at into ts;
  if not found then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return jsonb_build_object('viewed_at', ts);
end;
$$;

revoke all on function public.recommendation_mark_viewed(uuid) from public, anon;
grant execute on function public.recommendation_mark_viewed(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6) 추천 실행 기록 — slots_full 결과. 그날은 다시 훑지 않는다 (자리가 생기면 다음 날 소개부터 재개 — 나가기마다 추가 소개 없음)
-- ---------------------------------------------------------------------------
alter table public.recommendation_runs drop constraint if exists recommendation_runs_result_check;
alter table public.recommendation_runs add constraint recommendation_runs_result_check
  check (result is null or result in ('ok', 'exhausted', 'slots_full', 'not_ready', 'not_verified', 'profile_missing', 'lookup_failed', 'error'));

create or replace function public.recommendation_run_claim(
  p_user_id uuid,
  p_for_date date,
  p_lease_seconds int default 90,
  p_retry_after_seconds int default 3600
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.recommendation_runs%rowtype;
  inserted_uid uuid;
begin
  if auth.uid() is not null then
    raise exception 'server only' using errcode = '42501';
  end if;
  if p_user_id is null or p_for_date is null then
    raise exception 'invalid_args' using errcode = '22023';
  end if;

  insert into public.recommendation_runs (user_id, for_date, status, lease_until)
  values (p_user_id, p_for_date, 'running', now() + make_interval(secs => p_lease_seconds))
  on conflict (user_id, for_date) do nothing
  returning user_id into inserted_uid;
  if found then
    return jsonb_build_object('claim', 'claimed');
  end if;

  select * into r from public.recommendation_runs
  where user_id = p_user_id and for_date = p_for_date
  for update;

  if r.status = 'running' then
    if r.lease_until > now() then
      return jsonb_build_object('claim', 'busy', 'lease_until', r.lease_until);
    end if;
    update public.recommendation_runs
    set attempts = attempts + 1, lease_until = now() + make_interval(secs => p_lease_seconds), started_at = now()
    where user_id = p_user_id and for_date = p_for_date;
    return jsonb_build_object('claim', 'claimed', 'reclaimed', true);
  end if;

  if r.status = 'done' and r.result = 'ok' then
    return jsonb_build_object('claim', 'skip', 'result', 'ok');
  end if;
  -- 대화 자리가 없어 그날 소개를 중단한 기록: 같은 날에는 다시 시도하지 않는다 (#24)
  if r.status = 'done' and r.result = 'slots_full' then
    return jsonb_build_object('claim', 'skip', 'result', 'slots_full', 'finished_at', r.finished_at);
  end if;
  if r.status = 'done' and r.result = 'exhausted'
     and r.finished_at is not null and r.finished_at > now() - make_interval(secs => p_retry_after_seconds) then
    return jsonb_build_object('claim', 'skip', 'result', 'exhausted', 'finished_at', r.finished_at);
  end if;

  update public.recommendation_runs
  set status = 'running', result = null, attempts = attempts + 1,
      lease_until = now() + make_interval(secs => p_lease_seconds), started_at = now(), finished_at = null
  where user_id = p_user_id and for_date = p_for_date;
  return jsonb_build_object('claim', 'claimed', 'retry', true);
end;
$$;

create or replace function public.recommendation_batch_targets(p_for_date date, p_after uuid default null, p_limit int default 200)
returns table (user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select u.id
  from public.users u
  where u.status = 'active' and u.onboarding_completed and u.identity_verified and u.face_verified and u.age_verified
    and (p_after is null or u.id > p_after)
    and public.conversation_active_count(u.id) < public.conversation_slot_limit()
    and not exists (
      select 1 from public.recommendations r
      where r.user_id = u.id and r.for_date = p_for_date and r.status <> 'expired')
    and not exists (
      select 1 from public.recommendation_runs x
      where x.user_id = u.id and x.for_date = p_for_date
        and (x.status = 'running' and x.lease_until > now()
             or x.status = 'done' and x.result in ('ok', 'slots_full')
             or x.status = 'done' and x.result = 'exhausted' and x.finished_at > now() - interval '1 hour'))
  order by u.id
  limit greatest(1, least(p_limit, 500));
$$;

-- 서버(Edge)가 요청자·후보의 자리를 조회하는 뷰 (service role 전용)
create or replace view public.conversation_slot_usage as
select
  u.id as user_id,
  public.conversation_active_count(u.id) as active_matches,
  public.conversation_slot_limit() as slot_limit
from public.users u;
revoke all on public.conversation_slot_usage from public, anon, authenticated;
grant select on public.conversation_slot_usage to service_role;

-- 이미 3개를 초과한 계정 조회 (배포 전환용 — 기존 대화를 임의로 종료하지 않는다. 초과 계정은 새 매치만 막힌다)
create or replace view public.conversation_slot_overflow as
select s.user_id, s.active_matches, s.slot_limit
from public.conversation_slot_usage s
where s.active_matches > s.slot_limit;
revoke all on public.conversation_slot_overflow from public, anon, authenticated;
grant select on public.conversation_slot_overflow to service_role;

-- ---------------------------------------------------------------------------
-- 7) 대화 행동 지표 — 서버 저장 사용자 메시지·매치·종료 시각만으로 계산. 기준 시각 p_as_of 를 고정하면 결과가 결정적이다.
--    시스템 안내·시작 질문은 messages 에 없다 (자동 발송하지 않으므로). 같은 시각 메시지는 id 로 정렬한다.
--    무응답·중단·종료를 비호감·회피·실패로 해석하지 않는다 — 분류 라벨은 관찰 상태다.
-- ---------------------------------------------------------------------------
create or replace function public.conversation_pair_metrics(p_as_of timestamptz default now())
returns table (
  match_id uuid,
  matched_at timestamptz,
  cohort_week date,
  status text,
  meetup_state text,
  user_a uuid,
  user_b uuid,
  gender_a text,
  gender_b text,
  is_demo boolean,
  -- 종료 (as_of 시점 기준)
  closed boolean,
  closed_at timestamptz,
  close_time_known boolean,
  closed_by uuid,
  close_kind text,
  exit_reason text,
  close_stage text,
  close_hours_after_match numeric,
  -- 관찰
  observed_until timestamptz,
  observed_seconds bigint,
  -- 첫 연락
  message_count int,
  first_message_at timestamptz,
  first_sender_id uuid,
  first_sender_gender text,
  first_contact_seconds bigint,
  first_contact_class text,
  -- 상대 첫 답장
  first_reply_at timestamptz,
  first_reply_wait_seconds bigint,
  first_reply_status text,
  two_way boolean,
  -- 응답 대기 (연속 발신은 첫 미응답 메시지부터)
  max_completed_wait_seconds bigint,
  max_completed_wait_a_seconds bigint,
  max_completed_wait_b_seconds bigint,
  max_completed_wait_male_seconds bigint,
  max_completed_wait_female_seconds bigint,
  open_wait_seconds bigint,
  open_wait_by uuid,
  open_wait_by_gender text,
  open_wait_status text,
  -- 24시간 중단 · 재개
  last_message_at timestamptz,
  silence_seconds bigint,
  stall_24h_reached boolean,
  stall_24h_at timestamptz,
  stall_started_hours_after_match numeric,
  stalled_now boolean,
  resumed_after_24h_count int,
  last_resumed_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
with m as (
  select
    mt.id, mt.created_at, mt.status, mt.meetup_state, mt.user_a, mt.user_b, mt.closed_by, mt.close_kind,
    -- as_of 시점에 종료돼 있었는지. 0026 이전 종료 행(closed_at null)은 시각을 모르므로 "종료됨·시각 미상" 으로 둔다
    (mt.status <> 'active' and (mt.closed_at is null or mt.closed_at <= p_as_of)) as closed,
    case when mt.status <> 'active' and mt.closed_at is not null and mt.closed_at <= p_as_of then mt.closed_at end as closed_at,
    case
      when mt.status <> 'active' and mt.closed_at is not null and mt.closed_at <= p_as_of then mt.closed_at
      when mt.status <> 'active' and mt.closed_at is null then null   -- 시각 미상: 관찰 종료 시각 없음
      else p_as_of
    end as observed_until,
    (ua.is_demo or ub.is_demo) as is_demo,
    pa.gender as gender_a,
    pb.gender as gender_b
  from public.matches mt
  join public.users ua on ua.id = mt.user_a
  join public.users ub on ub.id = mt.user_b
  left join public.profiles pa on pa.user_id = mt.user_a
  left join public.profiles pb on pb.user_id = mt.user_b
  where mt.created_at <= p_as_of
),
msgs as (
  select
    c.match_id, g.id, g.sender_id, g.created_at,
    lag(g.sender_id) over w as prev_sender,
    lag(g.created_at) over w as prev_at
  from public.messages g
  join public.conversations c on c.id = g.conversation_id
  join m on m.id = c.match_id
  where g.created_at <= coalesce(m.observed_until, p_as_of)
  window w as (partition by c.match_id order by g.created_at, g.id)
),
agg as (
  select
    x.match_id,
    count(*)::int as message_count,
    min(x.created_at) as first_message_at,
    (array_agg(x.sender_id order by x.created_at, x.id))[1] as first_sender_id,
    max(x.created_at) as last_message_at,
    count(*) filter (where x.prev_at is not null and x.created_at - x.prev_at >= interval '24 hours')::int as resumed_after_24h_count,
    max(x.created_at) filter (where x.prev_at is not null and x.created_at - x.prev_at >= interval '24 hours') as last_resumed_at
  from msgs x
  group by x.match_id
),
reply as (
  select x.match_id, min(x.created_at) as first_reply_at
  from msgs x join agg a on a.match_id = x.match_id
  where x.sender_id <> a.first_sender_id
  group by x.match_id
),
runs as (
  -- 발신자가 바뀌는 첫 메시지 = 응답 대기 시작. 다음 run 의 시작 = 상대의 답장
  select
    x.match_id, x.sender_id, x.created_at as run_start_at,
    lead(x.created_at) over (partition by x.match_id order by x.created_at, x.id) as reply_at
  from msgs x
  where x.prev_sender is null or x.prev_sender <> x.sender_id
),
waits as (
  select
    r.match_id,
    max(extract(epoch from (r.reply_at - r.run_start_at)))::bigint as max_completed_wait_seconds,
    max(extract(epoch from (r.reply_at - r.run_start_at))) filter (where r.sender_id = m.user_a)::bigint as max_completed_wait_a_seconds,
    max(extract(epoch from (r.reply_at - r.run_start_at))) filter (where r.sender_id = m.user_b)::bigint as max_completed_wait_b_seconds,
    max(extract(epoch from (r.reply_at - r.run_start_at))) filter (where (case when r.sender_id = m.user_a then m.gender_a else m.gender_b end) = 'male')::bigint as max_completed_wait_male_seconds,
    max(extract(epoch from (r.reply_at - r.run_start_at))) filter (where (case when r.sender_id = m.user_a then m.gender_a else m.gender_b end) = 'female')::bigint as max_completed_wait_female_seconds
  from runs r join m on m.id = r.match_id
  where r.reply_at is not null
  group by r.match_id
),
open_run as (
  select distinct on (r.match_id) r.match_id, r.sender_id, r.run_start_at
  from runs r
  where r.reply_at is null
  order by r.match_id, r.run_start_at desc
)
select
  m.id as match_id,
  m.created_at as matched_at,
  date_trunc('week', (m.created_at at time zone 'Asia/Seoul'))::date as cohort_week,
  m.status,
  m.meetup_state,
  m.user_a, m.user_b, m.gender_a, m.gender_b, m.is_demo,
  m.closed,
  m.closed_at,
  (not m.closed or m.closed_at is not null) as close_time_known,
  case when m.closed then m.closed_by end as closed_by,
  case when m.closed then m.close_kind end as close_kind,
  case when m.closed and m.close_kind = 'left' then (select e.reason from public.conversation_exits e where e.match_id = m.id and e.user_id = m.closed_by) end as exit_reason,
  case
    when not m.closed then null
    when a.first_message_at is null then 'before_first_message'
    when rp.first_reply_at is null then 'before_first_reply'
    else 'after_two_way' end as close_stage,
  case when m.closed and m.closed_at is not null then round(extract(epoch from (m.closed_at - m.created_at)) / 3600.0, 2) end as close_hours_after_match,
  m.observed_until,
  case when m.observed_until is not null then extract(epoch from (m.observed_until - m.created_at))::bigint end as observed_seconds,
  coalesce(a.message_count, 0) as message_count,
  a.first_message_at,
  a.first_sender_id,
  case when a.first_sender_id = m.user_a then m.gender_a when a.first_sender_id = m.user_b then m.gender_b end as first_sender_gender,
  case when a.first_message_at is not null then extract(epoch from (a.first_message_at - m.created_at))::bigint end as first_contact_seconds,
  case
    when a.first_message_at is not null then
      case when a.first_message_at - m.created_at <= interval '1 hour' then 'within_1h' else 'after_1h' end
    when m.closed and m.closed_at is not null and m.closed_at - m.created_at < interval '1 hour' then 'closed_early'
    when m.closed then 'not_started'
    when p_as_of - m.created_at < interval '1 hour' then 'observing'
    else 'not_started' end as first_contact_class,
  rp.first_reply_at,
  case
    when a.first_message_at is null then null
    when rp.first_reply_at is not null then extract(epoch from (rp.first_reply_at - a.first_message_at))::bigint
    when m.observed_until is not null then extract(epoch from (m.observed_until - a.first_message_at))::bigint
    else null end as first_reply_wait_seconds,
  case
    when a.first_message_at is null then null
    when rp.first_reply_at is not null then 'replied'
    when m.closed then 'no_reply_closed'
    else 'waiting' end as first_reply_status,
  (rp.first_reply_at is not null) as two_way,
  w.max_completed_wait_seconds,
  w.max_completed_wait_a_seconds,
  w.max_completed_wait_b_seconds,
  w.max_completed_wait_male_seconds,
  w.max_completed_wait_female_seconds,
  case when o.match_id is not null and m.observed_until is not null then extract(epoch from (m.observed_until - o.run_start_at))::bigint end as open_wait_seconds,
  o.sender_id as open_wait_by,
  case when o.sender_id = m.user_a then m.gender_a when o.sender_id = m.user_b then m.gender_b end as open_wait_by_gender,
  case when o.match_id is null then 'none' when m.closed then 'ended_by_close' else 'ongoing' end as open_wait_status,
  a.last_message_at,
  case when a.last_message_at is not null and m.observed_until is not null then extract(epoch from (m.observed_until - a.last_message_at))::bigint end as silence_seconds,
  (a.last_message_at is not null and m.observed_until is not null and m.observed_until - a.last_message_at >= interval '24 hours') as stall_24h_reached,
  case when a.last_message_at is not null and m.observed_until is not null and m.observed_until - a.last_message_at >= interval '24 hours'
       then a.last_message_at + interval '24 hours' end as stall_24h_at,
  case when a.last_message_at is not null then round(extract(epoch from (a.last_message_at - m.created_at)) / 3600.0, 2) end as stall_started_hours_after_match,
  (not m.closed and a.last_message_at is not null and p_as_of - a.last_message_at >= interval '24 hours') as stalled_now,
  coalesce(a.resumed_after_24h_count, 0) as resumed_after_24h_count,
  a.last_resumed_at
from m
left join agg a on a.match_id = m.id
left join reply rp on rp.match_id = m.id
left join waits w on w.match_id = m.id
left join open_run o on o.match_id = m.id;
$$;

revoke all on function public.conversation_pair_metrics(timestamptz) from public, anon, authenticated;
grant execute on function public.conversation_pair_metrics(timestamptz) to service_role;

comment on function public.conversation_pair_metrics(timestamptz) is
  '매치 쌍 대화 행동 지표 (#24). p_as_of 를 고정하면 결정적. 24시간 이상은 화면에서 "24시간 이상" 으로 통일하되 원본 초는 보존. 서버 전용';

-- ---------------------------------------------------------------------------
-- 8) 퍼널 뷰 재작성 — sustained_7d 제거(뷰 컬럼 삭제는 create or replace 로 불가하므로 의존 순서대로 drop 후 재생성. CASCADE 없음)
-- ---------------------------------------------------------------------------
drop view if exists public.beta_cohort_stats;
drop view if exists public.funnel_user_cohorts;
drop view if exists public.funnel_pair_cohorts;
drop view if exists public.funnel_user_facts;
drop view if exists public.funnel_pair_facts;

create view public.funnel_pair_facts as
select
  m.id as match_id,
  m.created_at as matched_at,
  date_trunc('week', (m.created_at at time zone 'Asia/Seoul'))::date as cohort_week,
  m.status,
  (ua.is_demo or ub.is_demo) as is_demo,
  cm.first_message_at is not null as first_message,
  coalesce(cm.messages_a, 0) > 0 and coalesce(cm.messages_b, 0) > 0 as two_way,
  (m.mutual_interest_at is not null or m.meetup_state in ('mutual_interest', 'scheduled', 'completed', 'met_confirmed', 'interest_withdrawn')) as mutual_interest,
  exists (select 1 from public.meetup_outcomes o where o.match_id = m.id) as outcome_reported,
  exists (select 1 from public.meetup_outcomes o where o.match_id = m.id and o.outcome = 'met') as one_side_met,
  m.meetup_state = 'met_confirmed' as both_confirmed,
  m.meetup_state = 'completed' as legacy_completed,
  exists (select 1 from public.meetup_feedback f where f.match_id = m.id) as feedback_any,
  (select count(*) from public.meetup_feedback f where f.match_id = m.id) as feedback_count,
  (select count(*) from public.meetup_feedback f where f.match_id = m.id and f.met_again_intent = 'yes') as met_again_yes,
  (select count(*) from public.meetup_feedback f where f.match_id = m.id and f.met_again_intent = 'no') as met_again_no,
  (select count(*) from public.meetup_feedback f where f.match_id = m.id and f.next_intro_intent = 'yes') as next_intro_yes,
  (select count(*) from public.meetup_feedback f where f.match_id = m.id and f.next_intro_intent = 'no') as next_intro_no,
  m.status <> 'active' as closed,
  m.close_kind
from public.matches m
join public.users ua on ua.id = m.user_a
join public.users ub on ub.id = m.user_b
left join public.conversations c on c.match_id = m.id
left join public.conversation_metrics cm on cm.conversation_id = c.id;

create view public.funnel_user_facts as
select
  u.id as user_id,
  u.created_at as signed_up_at,
  date_trunc('week', (u.created_at at time zone 'Asia/Seoul'))::date as cohort_week,
  u.status,
  u.is_demo,
  u.onboarding_completed and u.identity_verified and u.face_verified as onboarded,
  exists (select 1 from public.recommendations r where r.user_id = u.id) as got_recommendation,
  exists (select 1 from public.recommendations r where r.user_id = u.id and r.viewed_at is not null) as viewed_recommendation,
  exists (select 1 from public.recommendations r where r.user_id = u.id and r.status = 'accepted') as accepted_recommendation,
  exists (select 1 from public.likes l where l.from_user_id = u.id) as liked,
  exists (select 1 from public.matches m where u.id in (m.user_a, m.user_b)) as matched,
  exists (select 1 from public.matches m join public.conversations c on c.match_id = m.id
          join public.messages msg on msg.conversation_id = c.id
          where u.id in (m.user_a, m.user_b) and msg.sender_id = u.id) as sent_message,
  exists (select 1 from public.funnel_pair_facts p join public.matches m on m.id = p.match_id
          where u.id in (m.user_a, m.user_b) and p.two_way) as two_way,
  exists (select 1 from public.funnel_pair_facts p join public.matches m on m.id = p.match_id
          where u.id in (m.user_a, m.user_b) and p.mutual_interest) as mutual_interest,
  exists (select 1 from public.meetup_outcomes o where o.user_id = u.id and o.outcome = 'met') as reported_met,
  exists (select 1 from public.matches m where u.id in (m.user_a, m.user_b) and m.meetup_state = 'met_confirmed') as both_confirmed,
  exists (select 1 from public.meetup_feedback f where f.user_id = u.id) as gave_feedback,
  exists (select 1 from public.meetup_feedback f where f.user_id = u.id and f.met_again_intent = 'yes') as met_again_yes,
  exists (select 1 from public.meetup_feedback f where f.user_id = u.id and f.next_intro_intent = 'yes') as next_intro_yes,
  exists (select 1 from public.matches m where m.closed_by = u.id and m.close_kind = 'left') as left_conversation
from public.users u;

create view public.funnel_user_cohorts as
select
  cohort_week,
  (current_date - cohort_week)::int as cohort_age_days,
  count(*) as signed_up,
  count(*) filter (where onboarded) as onboarded,
  count(*) filter (where got_recommendation) as got_recommendation,
  count(*) filter (where viewed_recommendation) as viewed_recommendation,
  count(*) filter (where accepted_recommendation) as accepted_recommendation,
  count(*) filter (where liked) as liked,
  count(*) filter (where matched) as matched,
  count(*) filter (where sent_message) as sent_message,
  count(*) filter (where two_way) as two_way,
  count(*) filter (where mutual_interest) as mutual_interest,
  count(*) filter (where reported_met) as reported_met,
  count(*) filter (where both_confirmed) as both_confirmed,
  count(*) filter (where gave_feedback) as gave_feedback,
  count(*) filter (where met_again_yes) as met_again_yes,
  count(*) filter (where next_intro_yes) as next_intro_yes,
  count(*) filter (where left_conversation) as left_conversation
from public.funnel_user_facts
where not is_demo
group by cohort_week
order by cohort_week desc;

create view public.funnel_pair_cohorts as
select
  cohort_week,
  (current_date - cohort_week)::int as cohort_age_days,
  count(*) as matched,
  count(*) filter (where first_message) as first_message,
  count(*) filter (where two_way) as two_way,
  count(*) filter (where mutual_interest) as mutual_interest,
  count(*) filter (where outcome_reported) as outcome_reported,
  count(*) filter (where one_side_met) as one_side_met,
  count(*) filter (where both_confirmed) as both_confirmed,
  count(*) filter (where legacy_completed) as legacy_completed,
  count(*) filter (where feedback_any) as feedback_any,
  count(*) filter (where met_again_yes = 2) as met_again_both_yes,
  count(*) filter (where met_again_yes >= 1) as met_again_any_yes,
  count(*) filter (where next_intro_yes >= 1) as next_intro_any_yes,
  count(*) filter (where closed) as closed
from public.funnel_pair_facts
where not is_demo
group by cohort_week
order by cohort_week desc;

-- 대화 행동 지표 뷰 (지금 시각 기준) · 매치주 cohort 집계 (demo 제외)
create view public.conversation_pair_facts as
select * from public.conversation_pair_metrics(now());

create view public.conversation_cohorts as
select
  cohort_week,
  (current_date - cohort_week)::int as cohort_age_days,
  count(*) as matched,
  count(*) filter (where first_contact_class = 'observing') as observing,
  count(*) filter (where first_contact_class = 'within_1h') as first_within_1h,
  count(*) filter (where first_contact_class = 'after_1h') as first_after_1h,
  count(*) filter (where first_contact_class = 'not_started') as not_started,
  count(*) filter (where first_contact_class = 'closed_early') as closed_early,
  count(*) filter (where first_sender_gender = 'male') as first_sender_male,
  count(*) filter (where first_sender_gender = 'female') as first_sender_female,
  count(*) filter (where first_reply_status = 'replied') as replied,
  count(*) filter (where first_reply_status = 'waiting') as reply_waiting,
  count(*) filter (where first_reply_status = 'no_reply_closed') as reply_no_reply_closed,
  count(*) filter (where two_way) as two_way,
  count(*) filter (where max_completed_wait_seconds is not null and max_completed_wait_seconds < 3600) as completed_wait_max_under_1h,
  count(*) filter (where max_completed_wait_seconds >= 3600 and max_completed_wait_seconds < 86400) as completed_wait_max_1h_to_24h,
  count(*) filter (where max_completed_wait_seconds >= 86400) as completed_wait_max_24h_plus,
  count(*) filter (where max_completed_wait_male_seconds >= 86400) as male_waited_24h_plus,
  count(*) filter (where max_completed_wait_female_seconds >= 86400) as female_waited_24h_plus,
  count(*) filter (where open_wait_status = 'ongoing' and open_wait_seconds >= 86400) as open_wait_24h_plus,
  count(*) filter (where stalled_now) as stalled_now,
  count(*) filter (where resumed_after_24h_count > 0) as resumed_after_24h,
  count(*) filter (where closed) as closed,
  count(*) filter (where close_kind = 'left') as closed_left,
  count(*) filter (where close_kind = 'blocked') as closed_blocked,
  count(*) filter (where close_kind = 'account') as closed_account,
  count(*) filter (where close_kind = 'admin') as closed_admin,
  count(*) filter (where close_kind = 'unknown') as closed_unknown,
  count(*) filter (where close_stage = 'before_first_message') as close_before_first_message,
  count(*) filter (where close_stage = 'before_first_reply') as close_before_first_reply,
  count(*) filter (where close_stage = 'after_two_way') as close_after_two_way,
  count(*) filter (where close_kind = 'left' and exit_reason = 'no_reply') as exit_no_reply,
  count(*) filter (where close_kind = 'left' and exit_reason = 'not_a_fit') as exit_not_a_fit,
  count(*) filter (where close_kind = 'left' and exit_reason = 'moved_elsewhere') as exit_moved_elsewhere,
  count(*) filter (where close_kind = 'left' and exit_reason = 'after_meetup') as exit_after_meetup,
  count(*) filter (where close_kind = 'left' and exit_reason = 'other') as exit_other,
  count(*) filter (where close_kind = 'left' and exit_reason is null) as exit_unanswered,
  count(*) filter (where meetup_state = 'met_confirmed') as met_confirmed
from public.conversation_pair_facts
where not is_demo
group by cohort_week
order by cohort_week desc;

create view public.beta_cohort_stats as
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
  count(u.id) filter (where f.viewed_recommendation) as viewed_recommendation,
  count(u.id) filter (where f.liked) as liked,
  count(u.id) filter (where f.matched) as matched,
  count(u.id) filter (where f.two_way) as two_way,
  count(u.id) filter (where f.mutual_interest) as mutual_interest,
  count(u.id) filter (where f.both_confirmed) as both_confirmed,
  (select count(*) from public.beta_invite_codes i where i.cohort_id = c.id and i.active) as active_codes,
  (select coalesce(sum(i.max_uses - i.used_count), 0) from public.beta_invite_codes i where i.cohort_id = c.id and i.active and (i.expires_at is null or i.expires_at > now())) as remaining_uses
from public.beta_cohorts c
left join public.users u on u.cohort_id = c.id and not u.is_demo
left join public.profiles p on p.user_id = u.id
left join public.funnel_user_facts f on f.user_id = u.id
group by c.id;

revoke all on public.funnel_pair_facts from public, anon, authenticated;
revoke all on public.funnel_user_facts from public, anon, authenticated;
revoke all on public.funnel_user_cohorts from public, anon, authenticated;
revoke all on public.funnel_pair_cohorts from public, anon, authenticated;
revoke all on public.conversation_pair_facts from public, anon, authenticated;
revoke all on public.conversation_cohorts from public, anon, authenticated;
revoke all on public.beta_cohort_stats from public, anon, authenticated;
grant select on public.funnel_pair_facts, public.funnel_user_facts, public.funnel_user_cohorts, public.funnel_pair_cohorts,
                public.conversation_pair_facts, public.conversation_cohorts, public.beta_cohort_stats to service_role;

comment on view public.funnel_user_cohorts is '가입주 cohort 사용자 퍼널 (#24). demo 제외. 추천 생성(got)·실제 확인(viewed)·수락(accepted) 구분. cohort_age_days 로 관찰 기간을 본다';
comment on view public.funnel_pair_cohorts is '매치 생성주 cohort 매치 쌍 퍼널 (#24). demo 쌍 제외. both_confirmed 는 양측 met 응답, legacy_completed 는 0016 이전 한쪽 완료';
comment on view public.conversation_cohorts is '매치주 cohort 대화 행동 지표 (#24). demo 쌍 제외. observing 은 매치 후 1시간 미만·미연락 (실패로 세지 않는다). 24시간 이상은 원본 초를 유지한 채 구간으로만 센다';
comment on view public.beta_cohort_stats is 'cohort 별 입장·온보딩·추천(생성/확인)·매치·양방향·상호 만남·양측 확인 (#26). demo 제외. 7일 지속 지표는 #24 로 제외';
