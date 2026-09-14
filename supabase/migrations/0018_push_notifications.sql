-- 0018_push_notifications.sql
-- Issue #17 — Expo Push 알림: 토큰 등록 · 알림 설정 · outbox 확장 · 발송기(send-push)용 dequeue/mark RPC.
--
-- 구조
--   앱 → push_tokens (본인 행만, Expo push token) / notification_preferences (본인 행만, 종류별 on/off)
--   서버 트리거 → notification_events (0016 outbox) 에 kind 추가: daily_recommendation(하루 1건), match_created
--   send-push Edge Function(service role, cron 1분) → notification_events_dequeue → Expo Push API → notification_events_mark
--   Push payload 에는 종류·id 만 (메시지 원문·상대 닉네임·일방 의향·피드백 없음). 본문 문구는 발송기가 고정 문구로 만든다.
--
-- additive. 로그아웃·탈퇴 시 토큰은 앱(본인 delete)·delete-account(service role) 가 지운다.

-- ---------------------------------------------------------------------------
-- 1) push_tokens — 기기별 Expo push token (본인만)
-- ---------------------------------------------------------------------------
create table if not exists public.push_tokens (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.users (id) on delete cascade,
  token          text not null unique check (char_length(token) between 10 and 300),
  platform       text not null check (platform in ('ios', 'android', 'web')),
  enabled        boolean not null default true,
  disabled_reason text,
  last_seen_at   timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists push_tokens_user_idx on public.push_tokens (user_id) where enabled;

create trigger push_tokens_touch_updated_at
  before update on public.push_tokens
  for each row execute function public.touch_updated_at();

alter table public.push_tokens enable row level security;
create policy push_tokens_own on public.push_tokens
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

comment on table public.push_tokens is
  'Expo push token (#17). 본인만 등록/조회/삭제. 발송 실패(DeviceNotRegistered)면 서버가 enabled=false 로 둔다';

-- 같은 토큰을 다른 계정이 등록하면(기기 공유·재로그인) 이전 계정의 행을 넘겨받는다 — 이전 사용자에게 잘못 가지 않게
create or replace function public.push_token_register(p_token text, p_platform text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if p_platform not in ('ios', 'android', 'web') then
    raise exception 'invalid_platform' using errcode = '22023';
  end if;
  if p_token is null or char_length(p_token) < 10 or char_length(p_token) > 300 then
    raise exception 'invalid_token' using errcode = '22023';
  end if;
  insert into public.push_tokens (user_id, token, platform)
  values (uid, p_token, p_platform)
  on conflict (token) do update
    set user_id = excluded.user_id,
        platform = excluded.platform,
        enabled = true,
        disabled_reason = null,
        last_seen_at = now();
end;
$$;
revoke all on function public.push_token_register(text, text) from public, anon;
grant execute on function public.push_token_register(text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) notification_preferences — 종류별 on/off (행이 없으면 모두 on)
-- ---------------------------------------------------------------------------
create table if not exists public.notification_preferences (
  user_id                 uuid primary key references public.users (id) on delete cascade,
  new_message             boolean not null default true,
  mutual_meetup_interest  boolean not null default true,
  daily_recommendation    boolean not null default true,
  match_created           boolean not null default true,
  updated_at              timestamptz not null default now()
);

create trigger notification_preferences_touch_updated_at
  before update on public.notification_preferences
  for each row execute function public.touch_updated_at();

alter table public.notification_preferences enable row level security;
create policy notification_preferences_own on public.notification_preferences
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 3) outbox 확장 — kind 추가 · 발송 상태 컬럼
-- ---------------------------------------------------------------------------
alter table public.notification_events drop constraint if exists notification_events_kind_check;
alter table public.notification_events add constraint notification_events_kind_check
  check (kind in ('new_message', 'mutual_meetup_interest', 'daily_recommendation', 'match_created'));

alter table public.notification_events
  add column if not exists claimed_at timestamptz,
  add column if not exists attempts   int not null default 0,
  add column if not exists skipped_reason text;

comment on column public.notification_events.skipped_reason is
  '발송하지 않고 닫은 이유: no_token | pref_off | recipient_inactive | expired. delivered_at 은 함께 채워진다 (재처리 방지)';

-- 오늘의 소개 생성 → 하루 1건 (앱에서 생성했든 배치에서 생성했든 같은 dedupe_key)
create or replace function public.handle_recommendation_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'pending' then
    insert into public.notification_events (recipient_id, kind, dedupe_key)
    values (new.user_id, 'daily_recommendation', 'recommendation:' || new.user_id::text || ':' || new.for_date::text)
    on conflict (dedupe_key) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists recommendations_notify on public.recommendations;
create trigger recommendations_notify
  after insert on public.recommendations
  for each row execute function public.handle_recommendation_notification();

-- 상호 좋아요 → 매치 + 대화방 (0003) + 양쪽 outbox
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

-- ---------------------------------------------------------------------------
-- 4) 발송기용 RPC (service role 전용)
-- ---------------------------------------------------------------------------
-- 미발송 이벤트를 잠그고(skip locked — 발송기 여러 개 동시 실행 안전) 수신자 상태·설정·토큰과 함께 돌려준다.
-- 60초 넘게 claimed 된 채 남은 행(발송기 크래시)은 다시 가져온다. 5회 넘게 실패한 행은 expired 로 닫는다.
create or replace function public.notification_events_dequeue(p_limit int default 200)
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
  tokens jsonb
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
    returning e.id, e.recipient_id, e.kind, e.match_id, e.conversation_id, e.created_at, e.attempts
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
    ), '[]'::jsonb) as tokens
  from claimed c
  join public.users u on u.id = c.recipient_id
  left join public.notification_preferences p on p.user_id = c.recipient_id
  order by c.created_at;
end;
$$;

-- 결과 기록: delivered → delivered_at, skipped → delivered_at + skipped_reason, failed(재시도) → claimed_at 해제 + delivery_error
create or replace function public.notification_events_mark(
  p_delivered bigint[] default '{}',
  p_skipped bigint[] default '{}',
  p_skipped_reason text default null,
  p_failed bigint[] default '{}',
  p_error text default null
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
  update public.notification_events set delivered_at = now(), delivery_error = null
  where id = any(coalesce(p_delivered, '{}'));
  update public.notification_events set delivered_at = now(), skipped_reason = left(p_skipped_reason, 60)
  where id = any(coalesce(p_skipped, '{}'));
  update public.notification_events set claimed_at = null, delivery_error = left(p_error, 300)
  where id = any(coalesce(p_failed, '{}'));
end;
$$;

-- 발송 실패 토큰 비활성화 (DeviceNotRegistered 등)
create or replace function public.push_tokens_disable(p_tokens text[], p_reason text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  if auth.uid() is not null then
    raise exception 'server only' using errcode = '42501';
  end if;
  update public.push_tokens set enabled = false, disabled_reason = left(p_reason, 60)
  where token = any(coalesce(p_tokens, '{}')) and enabled;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.notification_events_dequeue(int) from public, anon, authenticated;
revoke all on function public.notification_events_mark(bigint[], bigint[], text, bigint[], text) from public, anon, authenticated;
revoke all on function public.push_tokens_disable(text[], text) from public, anon, authenticated;
grant execute on function public.notification_events_dequeue(int) to service_role;
grant execute on function public.notification_events_mark(bigint[], bigint[], text, bigint[], text) to service_role;
grant execute on function public.push_tokens_disable(text[], text) to service_role;

-- 발송 완료 이벤트 정리 (선택 — pg_cron)
create or replace function public.notification_events_prune(p_keep interval default interval '30 days')
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  delete from public.notification_events where delivered_at is not null and delivered_at < now() - p_keep;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.notification_events_prune(interval) from public, anon, authenticated;
grant execute on function public.notification_events_prune(interval) to service_role;
