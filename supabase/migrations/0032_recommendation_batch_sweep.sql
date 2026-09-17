-- 0032_recommendation_batch_sweep.sql
-- Issue #22 (후보 부족 사용자 서버 재확인) · #17 (소개 저장 → 알림 발송 시점 재확인) · #23 (대기 정책)
--
-- 문제
--   1) 배치(daily-recommendation-batch)는 KST 09:00~09:45 에만 돌도록 예시돼 있어, 후보 부족(exhausted)으로 끝난 사용자를
--      1시간 뒤에 다시 확인하려면 사용자가 앱을 열어야 했다. 하루 전체 15분 간격으로 돌리면 대상 조회가 하루 96번 실행된다.
--   2) 배치는 한 호출에 max_users 명만 처리하고 next_after 를 돌려줄 뿐, 다음 호출은 항상 id 처음부터 시작했다.
--      대상이 한 묶음보다 많으면 앞쪽(id 작은) 사용자의 1시간 재시도가 매번 앞자리를 차지해 뒤쪽 사용자가 밀린다.
--      failed(조회 실패) 로 끝난 실행은 간격 없이 매 호출 다시 대상이 되어 같은 사용자에게 반복 실패가 쌓였다.
--   3) 소개가 outbox 에 들어간 뒤 발송 전에 만료(expired)·상대 제재·차단이 생겨도 발송기는 알 수 없었다.
--
-- 해결 (additive — 기존 추천·실행 기록·알림 행은 바꾸지 않는다)
--   1) recommendation_batch_targets: failed(및 not_ready 류) 실행에도 재시도 간격(기본 15분)을 둔다. exhausted 간격은 그대로 1시간.
--      시그니처에 두 간격 인자가 추가돼 옛 3인자 함수는 drop 후 재생성 (3인자 호출은 기본값으로 그대로 동작).
--   2) recommendation_batch_cursor: 배치 sweep 의 진행 위치(after)를 KST 날짜와 함께 서버에 저장한다 (단일 행).
--      - claim 은 lease 로 동시 sweep 을 막는다 (cron 이 겹쳐도 한 번에 한 sweep). 실행이 죽으면 lease 만료 후 다음 호출이 이어간다.
--      - 한 호출은 페이지마다 after 를 저장하므로 중간에 끊겨도 다음 호출이 그 자리부터 계속한다. 끝까지 훑으면 after=null(다음은 처음부터).
--      - 날짜가 바뀌면 처음부터 다시 시작한다 (for_date 가 다르면 after 무시).
--   3) notification_events.recommendation_id: 소개 알림이 가리키는 추천 행. 트리거가 같은 날 두 번째 pending 추천(첫 추천이 발송 전에
--      만료된 경우)으로 아직 발송되지 않은 이벤트의 참조를 옮긴다 (발송된 뒤에는 바꾸지 않는다 — 하루 1건 유지).
--      notification_events_dequeue 가 recommendation_valid(추천이 아직 pending 이고 상대가 active·인증·차단 없음)를 함께 돌려주고,
--      발송기(pushCore)는 false 면 발송하지 않고 skipped_reason='recommendation_invalid' 로 닫는다. 0032 이전 이벤트(참조 없음)는 null → 기존대로 발송.
--   알림 생성 시점은 그대로 "추천 행 insert(pending)" 뿐이다 — 신규 가입·후보 발견·후보 부족 재확인은 알림을 만들지 않는다.

-- ---------------------------------------------------------------------------
-- 1) 배치 대상 — 실패 재시도 간격 추가 (0026 정의 + 인자 2개)
-- ---------------------------------------------------------------------------
drop function if exists public.recommendation_batch_targets(date, uuid, int);

create function public.recommendation_batch_targets(
  p_for_date date,
  p_after uuid default null,
  p_limit int default 200,
  p_exhausted_retry_after_seconds int default 3600,
  p_failed_retry_after_seconds int default 900
)
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
             -- 후보 부족: 재탐색 간격(기본 1시간) 안에는 다시 훑지 않는다 (#23). 간격이 지나면 다시 대상 — 그날 소개를 받은 것으로 치지 않는다
             or x.status = 'done' and x.result = 'exhausted'
                and x.finished_at > now() - make_interval(secs => greatest(0, coalesce(p_exhausted_retry_after_seconds, 3600)))
             -- 조회 실패·처리 오류·자격 없음 결과: 배치는 재시도 간격(기본 15분)을 둔다 (앱의 직접 요청은 claim 이 바로 다시 맡는다)
             or (x.status = 'failed' or x.status = 'done' and x.result in ('not_ready', 'not_verified', 'profile_missing'))
                and x.finished_at > now() - make_interval(secs => greatest(0, coalesce(p_failed_retry_after_seconds, 900)))))
  order by u.id
  limit greatest(1, least(p_limit, 500));
$$;

revoke all on function public.recommendation_batch_targets(date, uuid, int, int, int) from public, anon, authenticated;
grant execute on function public.recommendation_batch_targets(date, uuid, int, int, int) to service_role;

comment on function public.recommendation_batch_targets(date, uuid, int, int, int) is
  '배치 대상 (#22): 자격 있고 오늘(KST) 추천이 없고 진행 중 실행이 없는 사용자 — exhausted 는 p_exhausted_retry_after_seconds(기본 1시간), failed/not_ready 류는 p_failed_retry_after_seconds(기본 15분) 안이면 제외. id 순, p_after 커서. 서버 전용';

-- ---------------------------------------------------------------------------
-- 2) 배치 sweep 커서 — 단일 행, 서버 전용
-- ---------------------------------------------------------------------------
create table if not exists public.recommendation_batch_cursor (
  singleton   boolean primary key default true check (singleton),
  for_date    date,
  after       uuid,
  lease_until timestamptz,
  sweeps      int not null default 0,
  updated_at  timestamptz not null default now()
);

alter table public.recommendation_batch_cursor enable row level security;
revoke all on public.recommendation_batch_cursor from anon, authenticated;

comment on table public.recommendation_batch_cursor is
  '하루 1명 추천 배치 sweep 진행 위치 (#22). 단일 행. for_date(KST)·after(마지막으로 처리한 user_id, null=처음부터)·lease_until(진행 중 sweep). 서버 전용';
comment on column public.recommendation_batch_cursor.sweeps is '끝까지 훑은 sweep 수 (관측용 — for_date 가 바뀌면 그대로 누적)';

-- sweep 시작. 반환: {claimed: true, after: uuid|null} 또는 {claimed: false, busy: true, lease_until}
--   날짜(p_for_date)가 저장된 for_date 와 다르면 after 를 null 로 초기화한다 (새 날은 처음부터).
create or replace function public.recommendation_batch_cursor_claim(p_for_date date, p_lease_seconds int default 180)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.recommendation_batch_cursor%rowtype;
begin
  if auth.uid() is not null then
    raise exception 'server only' using errcode = '42501';
  end if;
  if p_for_date is null then
    raise exception 'invalid_args' using errcode = '22023';
  end if;

  insert into public.recommendation_batch_cursor (singleton) values (true) on conflict (singleton) do nothing;
  select * into c from public.recommendation_batch_cursor where singleton for update;

  if c.lease_until is not null and c.lease_until > now() then
    return jsonb_build_object('claimed', false, 'busy', true, 'lease_until', c.lease_until);
  end if;

  if c.for_date is distinct from p_for_date then
    c.after := null;
  end if;

  update public.recommendation_batch_cursor
  set for_date = p_for_date,
      after = c.after,
      lease_until = now() + make_interval(secs => greatest(1, coalesce(p_lease_seconds, 180))),
      updated_at = now()
  where singleton;

  return jsonb_build_object('claimed', true, 'after', c.after);
end;
$$;

-- 진행 저장. p_next_after = 다음 호출이 이어갈 위치 (null = 끝까지 훑었다 → 다음은 처음부터, sweeps+1).
--   p_release=true 면 lease 를 놓는다 (호출 종료). false 면 lease 를 연장한다 (페이지 사이).
--   저장된 for_date 와 다른 날짜로 호출되면(호출 중 날짜가 바뀜) after 는 바꾸지 않고 lease 만 처리한다.
create or replace function public.recommendation_batch_cursor_save(
  p_for_date date,
  p_next_after uuid,
  p_release boolean default true,
  p_lease_seconds int default 180
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    raise exception 'server only' using errcode = '42501';
  end if;
  update public.recommendation_batch_cursor
  set after = case when for_date = p_for_date then p_next_after else after end,
      sweeps = sweeps + (case when for_date = p_for_date and p_next_after is null then 1 else 0 end),
      lease_until = case when p_release then null else now() + make_interval(secs => greatest(1, coalesce(p_lease_seconds, 180))) end,
      updated_at = now()
  where singleton;
end;
$$;

revoke all on function public.recommendation_batch_cursor_claim(date, int) from public, anon, authenticated;
revoke all on function public.recommendation_batch_cursor_save(date, uuid, boolean, int) from public, anon, authenticated;
grant execute on function public.recommendation_batch_cursor_claim(date, int) to service_role;
grant execute on function public.recommendation_batch_cursor_save(date, uuid, boolean, int) to service_role;

-- ---------------------------------------------------------------------------
-- 3) 소개 알림 — 이벤트가 가리키는 추천 행 · 발송 시점 재확인
-- ---------------------------------------------------------------------------
alter table public.notification_events
  add column if not exists recommendation_id uuid references public.recommendations (id) on delete set null;

comment on column public.notification_events.recommendation_id is
  'daily_recommendation 이벤트가 가리키는 추천 행 (0032). 발송 전에 같은 날 새 pending 추천이 생기면 참조를 옮긴다. 발송기는 이 행이 아직 pending 이고 상대가 유효할 때만 보낸다. 0032 이전 이벤트는 null';

comment on column public.notification_events.skipped_reason is
  '발송하지 않고 닫은 이유: no_token | pref_off | recipient_inactive | recommendation_invalid | unknown_kind(알 수 없는 종류·6시간 지난 이벤트) | expired(5회 실패). delivered_at 은 함께 채워진다 (재처리 방지)';

-- 오늘의 소개 생성 → 하루 1건 (앱·배치·재시도 어느 경로든 같은 dedupe_key). 0018 정의 + recommendation_id.
--   같은 날 두 번째 pending 행(첫 행이 발송 전에 expired 된 경우): 아직 발송되지 않은 이벤트라면 새 행을 가리키게 한다.
--   이미 발송됐으면 바꾸지 않는다 (하루 1건).
create or replace function public.handle_recommendation_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'pending' then
    insert into public.notification_events (recipient_id, kind, dedupe_key, recommendation_id)
    values (new.user_id, 'daily_recommendation', 'recommendation:' || new.user_id::text || ':' || new.for_date::text, new.id)
    on conflict (dedupe_key) do update
      set recommendation_id = excluded.recommendation_id
      where public.notification_events.delivered_at is null;
  end if;
  return new;
end;
$$;

-- dequeue — 반환 컬럼이 늘어나므로 drop 후 재생성 (0018 본문 + recommendation_valid)
drop function if exists public.notification_events_dequeue(int);

create function public.notification_events_dequeue(p_limit int default 200)
returns table (
  id bigint,
  recipient_id uuid,
  kind text,
  match_id uuid,
  conversation_id uuid,
  created_at timestamptz,
  attempts int,
  recipient_status text,
  pref_enabled boolean,
  tokens jsonb,
  recommendation_valid boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    raise exception 'server only' using errcode = '42501';
  end if;

  update public.notification_events e
  set delivered_at = now(), skipped_reason = 'expired'
  where e.delivered_at is null and e.attempts >= 5;

  return query
  with picked as (
    select e.id
    from public.notification_events e
    where e.delivered_at is null
      and (e.claimed_at is null or e.claimed_at < now() - interval '60 seconds')
    order by e.created_at
    limit greatest(1, least(p_limit, 500))
    for update skip locked
  ),
  claimed as (
    update public.notification_events e
    set claimed_at = now(), attempts = e.attempts + 1
    from picked
    where e.id = picked.id
    returning e.id, e.recipient_id, e.kind, e.match_id, e.conversation_id, e.created_at, e.attempts, e.recommendation_id
  )
  select
    c.id, c.recipient_id, c.kind, c.match_id, c.conversation_id, c.created_at, c.attempts,
    u.status as recipient_status,
    coalesce(
      case c.kind
        when 'new_message' then p.new_message
        when 'mutual_meetup_interest' then p.mutual_meetup_interest
        when 'daily_recommendation' then p.daily_recommendation
        when 'match_created' then p.match_created
      end, true) as pref_enabled,
    coalesce((
      select jsonb_agg(jsonb_build_object('token', t.token, 'platform', t.platform))
      from public.push_tokens t where t.user_id = c.recipient_id and t.enabled
    ), '[]'::jsonb) as tokens,
    -- 소개 알림: 발송 시점에 추천이 아직 pending 이고 상대가 유효(active·인증·차단 없음)한지. 참조가 없는(0032 이전) 이벤트는 null
    case
      when c.kind <> 'daily_recommendation' or c.recommendation_id is null then null
      else exists (
        select 1
        from public.recommendations r
        join public.users cu on cu.id = r.candidate_id
        where r.id = c.recommendation_id and r.user_id = c.recipient_id and r.status = 'pending'
          and cu.status = 'active' and cu.onboarding_completed and cu.identity_verified and cu.face_verified and cu.age_verified
          and not exists (
            select 1 from public.blocks b
            where (b.blocker_id = r.user_id and b.blocked_id = r.candidate_id)
               or (b.blocker_id = r.candidate_id and b.blocked_id = r.user_id)))
    end as recommendation_valid
  from claimed c
  join public.users u on u.id = c.recipient_id
  left join public.notification_preferences p on p.user_id = c.recipient_id
  order by c.created_at;
end;
$$;

revoke all on function public.notification_events_dequeue(int) from public, anon, authenticated;
grant execute on function public.notification_events_dequeue(int) to service_role;
