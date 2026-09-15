-- 0023_security_hardening.sql
-- Issue #27 — 남용 방지 원시 기능 · 관리자 감사 로그 · 클라이언트 쓰기 범위 축소.
--
--   1) rate_limit_hit(scope, key, limit, window)  — 서버(service role) 와 SECURITY DEFINER 트리거만 호출하는 고정 창 카운터.
--        Edge Function(verify-identity·icebreaker·delete-account·daily-recommendation) 과 DB 트리거(신고·분석 이벤트)가 같은 원시 기능을 쓴다.
--        RPC 오류 시 호출자는 fail-closed(거부) 로 처리한다 (send-sms 의 sms_otp_rate_limit_check 와 같은 원칙).
--   2) admin_audit_log — 관리자 웹의 모든 변경 조치(로그인·정지·신고 처리·얼굴 검토·삭제·베타 설정)를 실행자/시각/대상과 함께 남긴다.
--        moderation_actions(0020)·face_verification_reviews(0014) 의 도메인별 기록을 대체하지 않고, 그 위에 "누가 무엇을 눌렀나" 를 한 곳에 모은다.
--   3) recommendations — 클라이언트는 status(pending→accepted/skipped) 와 skip_reason 만 바꿀 수 있다 (점수·카드·전략 수정 차단).
--   4) reports / analytics_events — 사용자별 insert 상한 (신고 10건/일, 이벤트 300건/시간). 초과 시 거부.
--
-- 검증: supabase/tests/security_tests.sql (public 전 테이블 RLS 켜짐 · SECURITY DEFINER 함수 allowlist · 뷰 비공개 · 서버 전용 테이블 · 위 가드).

-- ---------------------------------------------------------------------------
-- 1) rate limit 원시 기능
-- ---------------------------------------------------------------------------
create table if not exists public.rate_limit_counters (
  scope        text not null,
  key          text not null,
  window_start timestamptz not null,
  count        int not null default 0,
  primary key (scope, key, window_start)
);

alter table public.rate_limit_counters enable row level security;
revoke all on public.rate_limit_counters from public, anon, authenticated;
grant all on public.rate_limit_counters to service_role;

comment on table public.rate_limit_counters is '고정 창 남용 방지 카운터 (#27). 서버·트리거 전용. rate_limit_prune 으로 정리';

-- 창(p_window_seconds) 안에서 (scope, key) 호출 수를 세고 상한 초과 여부를 돌려준다.
-- 호출 자체가 카운트를 올린다 (허용된 요청만 세지 않는다 — 거부된 시도도 창을 소모해 연타를 막는다).
create or replace function public.rate_limit_hit(p_scope text, p_key text, p_limit int, p_window_seconds int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ws timestamptz;
  n int;
  retry int;
begin
  if p_scope is null or p_key is null or p_limit is null or p_limit < 1 or p_window_seconds is null or p_window_seconds < 1 then
    raise exception 'invalid rate limit arguments';
  end if;
  ws := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.rate_limit_counters as c (scope, key, window_start, count)
  values (p_scope, p_key, ws, 1)
  on conflict (scope, key, window_start) do update set count = c.count + 1
  returning c.count into n;
  retry := greatest(1, ceil(extract(epoch from (ws + make_interval(secs => p_window_seconds) - now())))::int);
  return jsonb_build_object('allowed', n <= p_limit, 'count', n, 'limit', p_limit, 'retry_after_seconds', case when n <= p_limit then 0 else retry end);
end;
$$;

revoke all on function public.rate_limit_hit(text, text, int, int) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, text, int, int) to service_role;

create or replace function public.rate_limit_prune(p_keep interval default interval '2 days')
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  delete from public.rate_limit_counters where window_start < now() - p_keep;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.rate_limit_prune(interval) from public, anon, authenticated;
grant execute on function public.rate_limit_prune(interval) to service_role;

-- 사용자 JWT 컨텍스트의 SECURITY INVOKER 트리거가 쓰는 래퍼 — 키는 항상 호출자 자신(auth.uid()).
-- 클라이언트가 직접 호출해도 자기 예산만 소모한다 (남을 제한할 수 없다).
create or replace function public.rate_limit_hit_self(p_scope text, p_limit int, p_window_seconds int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  return public.rate_limit_hit(p_scope, auth.uid()::text, p_limit, p_window_seconds);
end;
$$;
revoke all on function public.rate_limit_hit_self(text, int, int) from public, anon;
grant execute on function public.rate_limit_hit_self(text, int, int) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) 관리자 감사 로그
-- ---------------------------------------------------------------------------
create table if not exists public.admin_audit_log (
  id          bigint generated always as identity primary key,
  actor       text not null check (char_length(actor) between 1 and 64),
  action      text not null check (char_length(action) between 1 and 64),
  target_type text check (target_type is null or char_length(target_type) <= 40),
  target_id   text check (target_id is null or char_length(target_id) <= 120),
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists admin_audit_log_created_idx on public.admin_audit_log (created_at desc);
create index if not exists admin_audit_log_target_idx on public.admin_audit_log (target_type, target_id);

alter table public.admin_audit_log enable row level security;
revoke all on public.admin_audit_log from public, anon, authenticated;
grant all on public.admin_audit_log to service_role;

comment on table public.admin_audit_log is '관리자 웹 조치 감사 (#27). detail 에는 개인정보(전화번호·이메일·메시지 원문)를 넣지 않는다 — id 와 결과만';

create or replace function public.admin_audit_record(
  p_actor text, p_action text, p_target_type text, p_target_id text, p_detail jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare new_id bigint;
begin
  if auth.uid() is not null then
    raise exception 'server only' using errcode = '42501';
  end if;
  insert into public.admin_audit_log (actor, action, target_type, target_id, detail)
  values (left(coalesce(nullif(trim(p_actor), ''), 'admin'), 64), left(p_action, 64), left(p_target_type, 40), left(p_target_id, 120), coalesce(p_detail, '{}'::jsonb))
  returning id into new_id;
  return new_id;
end;
$$;

revoke all on function public.admin_audit_record(text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.admin_audit_record(text, text, text, text, jsonb) to service_role;

create or replace function public.admin_audit_prune(p_keep interval default interval '365 days')
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  delete from public.admin_audit_log where created_at < now() - p_keep;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.admin_audit_prune(interval) from public, anon, authenticated;
grant execute on function public.admin_audit_prune(interval) to service_role;

-- ---------------------------------------------------------------------------
-- 3) recommendations — 클라이언트 변경 범위: status(pending → accepted|skipped) + skip_reason 만
--    (RLS with check 는 status 값만 보므로, 같은 정책 안에서 score/card/strategy/for_date 수정이 가능했다)
-- ---------------------------------------------------------------------------
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
      and n.key not in ('status', 'skip_reason', 'updated_at');
    if array_length(changed, 1) is not null then
      raise exception 'recommendation columns % are server managed', changed using errcode = '42501';
    end if;
    if new.status is distinct from old.status then
      if old.status <> 'pending' or new.status not in ('accepted', 'skipped') then
        raise exception 'recommendation status can only move from pending to accepted/skipped' using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists recommendations_guard_decision on public.recommendations;
create trigger recommendations_guard_decision
  before update on public.recommendations
  for each row execute function public.guard_recommendation_decision();

-- ---------------------------------------------------------------------------
-- 4) 사용자 insert 상한 — 신고 10건/일, 분석 이벤트 300건/시간 (클라이언트 직접 insert 만; 서버·트리거 기록은 제한 없음)
--    ※ 가드 트리거는 SECURITY INVOKER 다 — DEFINER 안에서는 current_user 가 소유자가 되어 is_end_user_request() 가 늘 false 가 된다 (0016 과 동일 원칙)
-- ---------------------------------------------------------------------------
create or replace function public.guard_report_rate()
returns trigger
language plpgsql
as $$
declare r jsonb;
begin
  if public.is_end_user_request() then
    r := public.rate_limit_hit_self('reports', 10, 86400);
    if not (r->>'allowed')::boolean then
      raise exception 'rate_limited' using errcode = '42501', detail = 'reports:daily';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists reports_guard_rate on public.reports;
create trigger reports_guard_rate
  before insert on public.reports
  for each row execute function public.guard_report_rate();

create or replace function public.guard_analytics_rate()
returns trigger
language plpgsql
as $$
declare r jsonb;
begin
  if public.is_end_user_request() then
    r := public.rate_limit_hit_self('analytics', 300, 3600);
    if not (r->>'allowed')::boolean then
      raise exception 'rate_limited' using errcode = '42501', detail = 'analytics:hourly';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists analytics_events_guard_rate on public.analytics_events;
create trigger analytics_events_guard_rate
  before insert on public.analytics_events
  for each row execute function public.guard_analytics_rate();

-- ---------------------------------------------------------------------------
-- 5) SECURITY DEFINER 헬퍼 실행 권한은 그대로 둔다 — is_blocked_pair / meetup_mutual_yes 는 0016 에서 참가자 범위로 좁혀져
--    (참가자가 아니면 항상 false) 클라이언트가 호출해도 정보가 새지 않는다. 허용 목록은 security_tests.sql 이 고정한다.
-- ---------------------------------------------------------------------------
