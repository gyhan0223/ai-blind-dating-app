-- 0027_recommendation_observability.sql
-- Issue #23 — 추천 결과·전략 관측 보완 · 운영자용 후보 규모 통계.
--
-- 목적
--   초기 사용자 풀이 작아 추천이 만들어지지 않을 때, 운영자가 "왜 안 만들어졌는지" 와 "후보가 몇 명이었는지" 를
--   실제 추천 실행 기록으로 확인할 수 있게 한다. 필수 조건을 완화하거나 새 필터·외모·LLM 을 추가하지 않는다.
--   추천 엔진의 판정을 여기서 복제하지 않는다 — 엔진이 실행 중 관측한 값을 recommendation_runs 에 기록하고 그것을 집계한다.
--
-- additive. 이미 적용된 마이그레이션은 덮어쓰지 않고 함수의 최종 정의를 여기서 다시 만든다
-- (recommendation_run_finish 0017 → 여기(시그니처 확장으로 drop 후 재생성), recommendation_run_claim 0026 → 여기).
-- 기존 recommendations · matches · messages 행은 바꾸지 않는다.
--
-- 이 마이그레이션이 바꾸는 것
--   1) recommendation_runs 확장: eligible_count(적격 후보 수, null = 미측정) · recommendation_id(이 실행이 저장한 추천) ·
--      strategy / basis(저장된 추천 행에서 복사) · error_stage(조회 실패 단계). 실행 결과(result)와 요청 상태(claim skip/busy)는 다르다 —
--      skip/busy 는 행을 만들지도 바꾸지도 않으므로 같은 대기 결과를 다시 조회해도 횟수가 늘지 않는다.
--   2) 전략 분석 이벤트: recommendations insert 트리거가 analytics_events.recommendation_created 를 같은 트랜잭션에서 1건 기록한다.
--      payload->>'recommendation_id' 부분 unique 인덱스로 같은 추천에 두 번 기록될 수 없다 (앱·배치 중첩, 재시도 무관).
--      과거 행은 저장된 strategy 를 그대로 복원한다 (source='backfill_0027'). dimensions.basis 가 없는 예전 행은 basis null(미측정).
--   3) recommendation_run_claim: exhausted skip 응답에 cap_reached 를 함께 돌려준다 (앱이 "탐색 상한" 과 "적격 후보 없음" 을 구분).
--   4) 운영 통계 함수 (service role 전용): recommendation_pool_stats(최근 N일 — 사용자별 최근 실행 기준) ·
--      recommendation_run_stats(최근 N일 — 기간 내 실행·생성 건수). 성별·지역·연령대(5세 구간, beta_waitlist_summary 와 같은 계산) + 전체 행.
--      demo 계정은 요청자에서 제외한다. 후보 수는 사용자별 관측치라 합계를 내지 않고 중앙값·최소·최대만 낸다.
--
-- strategy(high_confidence / exploration / fallback)는 DB check·analytics 호환용 내부 라벨이다. 매칭 정확도·궁합을 뜻하지 않으며
-- fallback 도 양방향 필수 조건을 통과한 후보 중에서만 나온다 (recommend.ts — ranked 에는 eligible 후보만 들어간다).

-- ---------------------------------------------------------------------------
-- 1) recommendation_runs — 관측 컬럼
-- ---------------------------------------------------------------------------
alter table public.recommendation_runs
  add column if not exists eligible_count    int check (eligible_count is null or eligible_count >= 0),
  add column if not exists recommendation_id uuid references public.recommendations (id) on delete set null,
  add column if not exists strategy          text check (strategy is null or strategy in ('high_confidence', 'exploration', 'fallback')),
  add column if not exists basis             text check (basis is null or basis in ('scored', 'conditions_only')),
  add column if not exists error_stage       text;

comment on column public.recommendation_runs.eligible_count is
  '이 실행에서 양방향 필수 조건·계정/안전 필터·추천/좋아요/매치 이력·상대 대화 자리를 모두 통과한 후보 수 (선택된 상대 포함). null = 미측정 (0027 이전 기록, 훑지 않고 끝난 실행: 저장된 추천 반환·slots_full·조회 실패). cap_reached 면 훑은 범위 안의 수(하한)이지 전체 규모가 아니다';
comment on column public.recommendation_runs.recommendation_id is '이 실행이 새로 저장한 추천 (없으면 null — 저장된 추천을 돌려줬거나 후보 없음)';
comment on column public.recommendation_runs.strategy is 'recommendation_id 행의 strategy 복사본 — 호환용 내부 라벨 (정확도·궁합 아님)';
comment on column public.recommendation_runs.basis is 'recommendation_id 행의 dimensions.basis 복사본 (scored / conditions_only). null = 미측정';
comment on column public.recommendation_runs.error_stage is 'lookup_failed / error 로 끝난 실행의 실패 단계 (recommend.ts stage 문자열). 비공개 데이터 없음';

create index if not exists recommendation_runs_user_date_idx on public.recommendation_runs (user_id, for_date desc);

-- ---------------------------------------------------------------------------
-- 2) recommendation_run_finish — 관측값을 함께 기록 (시그니처 확장: 옛 5인자 함수는 drop — 기본값으로 5인자 호출도 그대로 동작)
-- ---------------------------------------------------------------------------
drop function if exists public.recommendation_run_finish(uuid, date, text, int, boolean);

create function public.recommendation_run_finish(
  p_user_id uuid,
  p_for_date date,
  p_result text,
  p_scanned int default 0,
  p_cap_reached boolean default false,
  p_eligible int default null,
  p_recommendation_id uuid default null,
  p_error_stage text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  rec_strategy text;
  rec_basis    text;
  rec_id       uuid;
begin
  if auth.uid() is not null then
    raise exception 'server only' using errcode = '42501';
  end if;
  -- 전략·basis 는 호출자 주장이 아니라 실제 저장된 추천 행에서 읽는다 (같은 사용자 행이어야 한다)
  if p_recommendation_id is not null then
    select r.id, r.strategy, r.dimensions->>'basis' into rec_id, rec_strategy, rec_basis
    from public.recommendations r
    where r.id = p_recommendation_id and r.user_id = p_user_id;
  end if;
  update public.recommendation_runs
  set status = case when p_result in ('lookup_failed', 'error') then 'failed' else 'done' end,
      result = p_result,
      scanned = coalesce(p_scanned, 0),
      cap_reached = coalesce(p_cap_reached, false),
      -- 훑은 실행(ok/exhausted)만 측정값을 갖는다. 그 외 결과는 미측정(null)
      eligible_count = case when p_result in ('ok', 'exhausted') then p_eligible else null end,
      recommendation_id = rec_id,
      strategy = case when rec_strategy in ('high_confidence', 'exploration', 'fallback') then rec_strategy else null end,
      basis = case when rec_basis in ('scored', 'conditions_only') then rec_basis else null end,
      error_stage = case when p_result in ('lookup_failed', 'error') then left(p_error_stage, 64) else null end,
      finished_at = now()
  where user_id = p_user_id and for_date = p_for_date;
end;
$$;

revoke all on function public.recommendation_run_finish(uuid, date, text, int, boolean, int, uuid, text) from public, anon, authenticated;
grant execute on function public.recommendation_run_finish(uuid, date, text, int, boolean, int, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3) recommendation_run_claim — exhausted skip 응답에 cap_reached 포함 (0026 정의와 그 외 동일)
-- ---------------------------------------------------------------------------
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
    -- 재시도 주기 안의 재요청: 다시 훑지 않고 같은 답 + 상한 도달 여부 (앱이 "전체 후보 없음" 으로 단정하지 않게)
    return jsonb_build_object('claim', 'skip', 'result', 'exhausted', 'finished_at', r.finished_at,
                              'cap_reached', coalesce(r.cap_reached, false), 'eligible_count', r.eligible_count);
  end if;

  update public.recommendation_runs
  set status = 'running', result = null, attempts = attempts + 1,
      lease_until = now() + make_interval(secs => p_lease_seconds), started_at = now(), finished_at = null
  where user_id = p_user_id and for_date = p_for_date;
  return jsonb_build_object('claim', 'claimed', 'retry', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) 전략 분석 이벤트 — 저장된 추천 행 기준 1회 (서버 트리거 + DB unique)
-- ---------------------------------------------------------------------------
create unique index if not exists analytics_events_recommendation_created_uidx
  on public.analytics_events ((payload->>'recommendation_id'))
  where event_type = 'recommendation_created';

create or replace function public.handle_recommendation_created_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 같은 트랜잭션: 추천 행이 커밋되면 이벤트도 함께 커밋된다 (행은 있는데 이벤트만 없는 상태가 생기지 않는다).
  -- payload 에는 식별자·라벨·날짜만 — 카드·점수·비공개 응답·얼굴 데이터 없음.
  insert into public.analytics_events (user_id, event_type, payload)
  values (new.user_id, 'recommendation_created', jsonb_build_object(
    'recommendation_id', new.id,
    'candidate_id', new.candidate_id,
    'strategy', new.strategy,
    'basis', new.dimensions->>'basis',
    'for_date', new.for_date,
    'source', 'server'))
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists recommendations_created_event on public.recommendations;
create trigger recommendations_created_event
  after insert on public.recommendations
  for each row execute function public.handle_recommendation_created_event();

-- 과거 행 복원: 저장된 strategy 는 사실이므로 그대로 옮긴다 (추정 없음). basis 가 없는 예전 행(0015 이전)은 null = 미측정.
insert into public.analytics_events (user_id, event_type, payload, created_at)
select r.user_id, 'recommendation_created',
       jsonb_build_object('recommendation_id', r.id, 'candidate_id', r.candidate_id, 'strategy', r.strategy,
                          'basis', r.dimensions->>'basis', 'for_date', r.for_date, 'source', 'backfill_0027'),
       r.created_at
from public.recommendations r
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 5) 운영 통계 — 세그먼트(성별·지역·연령대) + 전체 행. service role 전용.
--    연령대: beta_waitlist_summary 와 같은 5세 구간 계산 (KST 올해 − 출생연도 + 1).
--    요청자(demo 제외)의 프로필 기준이다. 후보 쪽 demo 여부는 엔진 정책(seed 의 demo 는 production 에 두지 않는다)을 따른다 —
--    demo_eligible_accounts 로 demo 계정이 추천 풀에 남아 있는지 확인한다.
-- ---------------------------------------------------------------------------
create or replace function public.recommendation_age_band(p_birth_year int)
returns int
language sql
stable
as $$
  select case when p_birth_year is null then null
              else (floor((extract(year from (now() at time zone 'Asia/Seoul'))::int - p_birth_year + 1) / 5) * 5)::int end;
$$;
revoke all on function public.recommendation_age_band(int) from public, anon, authenticated;
grant execute on function public.recommendation_age_band(int) to service_role;

-- 5a) 사용자별 "최근 실행" 기준 (최근 p_window_days 일, 오늘 포함). 실행 중(running)인 행은 결과가 없으므로 보지 않는다.
--     분류 (사용자 수):
--       with_candidates : 최근 실행 eligible_count ≥ 1 (전체 탐색 완료)
--       zero_candidates : 최근 실행 eligible_count = 0 이고 상한 미도달 → "탐색을 끝냈지만 적격 후보 없음"
--       cap_reached     : 최근 실행이 탐색 상한에 걸려 전체 규모를 모른다 (eligible_count 는 하한)
--       slots_full      : 최근 실행이 진행 중 대화 3개로 중단
--       failed          : 최근 실행이 조회·처리 오류 (0명으로 세지 않는다)
--       unmeasured      : 기간 내 끝난 실행 없음 · 0027 이전 기록 · 훑지 않고 끝난 실행(저장된 추천 반환) · not_ready 류
--     eligible_median/min/max 는 with/zero 사용자들의 관측치다 (사용자마다 겹치는 후보라 합계는 내지 않는다).
create or replace function public.recommendation_pool_stats(p_window_days int default 7)
returns table (
  is_total boolean,
  gender text,
  region_code text,
  age_band int,
  eligible_users int,
  slots_full_now_users int,
  measured_users int,
  with_candidates_users int,
  zero_candidates_users int,
  cap_reached_users int,
  latest_slots_full_users int,
  latest_failed_users int,
  unmeasured_users int,
  eligible_median numeric,
  eligible_min int,
  eligible_max int,
  demo_eligible_accounts int,
  window_days int,
  measured_at timestamptz
)
language sql
stable
set search_path = public
as $$
  with params as (
    select greatest(1, least(coalesce(p_window_days, 7), 90)) as days,
           (now() at time zone 'Asia/Seoul')::date as today
  ),
  base as (
    select u.id as user_id, p.gender, p.region_code, public.recommendation_age_band(p.birth_year) as age_band,
           public.conversation_active_count(u.id) >= public.conversation_slot_limit() as slots_full_now
    from public.users u
    join public.profiles p on p.user_id = u.id
    where u.status = 'active' and u.onboarding_completed and u.identity_verified and u.face_verified and u.age_verified
      and not u.is_demo
  ),
  latest as (
    select distinct on (r.user_id) r.user_id, r.status, r.result, r.eligible_count, r.cap_reached
    from public.recommendation_runs r, params
    where r.status in ('done', 'failed') and r.for_date > params.today - params.days
    order by r.user_id, r.for_date desc, r.finished_at desc nulls last
  ),
  joined as (
    select b.gender, b.region_code, b.age_band, b.slots_full_now, l.eligible_count,
      case
        when l.user_id is null then 'unmeasured'
        when l.status = 'failed' then 'failed'
        when l.result = 'slots_full' then 'slots_full'
        when l.result in ('ok', 'exhausted') and l.eligible_count is null then 'unmeasured'
        when l.result in ('ok', 'exhausted') and l.cap_reached then 'cap_reached'
        when l.result in ('ok', 'exhausted') and l.eligible_count >= 1 then 'with_candidates'
        when l.result in ('ok', 'exhausted') then 'zero_candidates'
        else 'unmeasured'
      end as klass
    from base b
    left join latest l on l.user_id = b.user_id
  ),
  demo as (
    select count(*)::int as n
    from public.users u
    where u.is_demo and u.status = 'active' and u.onboarding_completed and u.identity_verified and u.face_verified and u.age_verified
  )
  select
    grouping(j.gender, j.region_code, j.age_band) = 7 as is_total,
    j.gender, j.region_code, j.age_band,
    count(*)::int as eligible_users,
    count(*) filter (where j.slots_full_now)::int as slots_full_now_users,
    count(*) filter (where j.klass in ('with_candidates', 'zero_candidates', 'cap_reached'))::int as measured_users,
    count(*) filter (where j.klass = 'with_candidates')::int as with_candidates_users,
    count(*) filter (where j.klass = 'zero_candidates')::int as zero_candidates_users,
    count(*) filter (where j.klass = 'cap_reached')::int as cap_reached_users,
    count(*) filter (where j.klass = 'slots_full')::int as latest_slots_full_users,
    count(*) filter (where j.klass = 'failed')::int as latest_failed_users,
    count(*) filter (where j.klass = 'unmeasured')::int as unmeasured_users,
    percentile_cont(0.5) within group (order by j.eligible_count) filter (where j.klass in ('with_candidates', 'zero_candidates')) as eligible_median,
    min(j.eligible_count) filter (where j.klass in ('with_candidates', 'zero_candidates')) as eligible_min,
    max(j.eligible_count) filter (where j.klass in ('with_candidates', 'zero_candidates')) as eligible_max,
    (select n from demo) as demo_eligible_accounts,
    (select days from params) as window_days,
    now() as measured_at
  from joined j
  group by grouping sets ((j.gender, j.region_code, j.age_band), ())
  order by 1 desc, j.gender, j.region_code, j.age_band;
$$;

revoke all on function public.recommendation_pool_stats(int) from public, anon, authenticated;
grant execute on function public.recommendation_pool_stats(int) to service_role;

comment on function public.recommendation_pool_stats(int) is
  '운영자용 추천 풀 관측 (#23). 요청자 세그먼트별(성별·지역·연령대, 전체 행은 null) 추천 대상 사용자 수와 최근 N일 안 사용자별 최근 실행 결과 분류. 후보 수는 사용자별 관측치(중복 가능) — 합계 아님. demo 요청자 제외. service role 전용';

-- 5b) 기간 내 실행·생성 건수 (최근 p_window_days 일, 오늘 포함). 단위는 실행 행(사용자·날짜당 최종 결과)과 추천 행이다.
--     runs_exhausted_complete: 끝까지 훑었지만 적격 후보 없음 / runs_exhausted_cap: 상한 도달 / runs_failed: 조회·처리 오류.
--     생성 건수·전략·basis 는 recommendations 행(사실)에서 센다 — HTTP 요청 수가 아니다.
create or replace function public.recommendation_run_stats(p_window_days int default 7)
returns table (
  is_total boolean,
  gender text,
  region_code text,
  age_band int,
  runs int,
  runs_ok int,
  runs_exhausted_complete int,
  runs_exhausted_cap int,
  runs_slots_full int,
  runs_failed int,
  runs_other int,
  recommendations_created int,
  strategy_high_confidence int,
  strategy_exploration int,
  strategy_fallback int,
  basis_scored int,
  basis_conditions_only int,
  basis_unmeasured int,
  window_from date,
  window_to date
)
language sql
stable
set search_path = public
as $$
  with params as (
    select greatest(1, least(coalesce(p_window_days, 7), 90)) as days,
           (now() at time zone 'Asia/Seoul')::date as today
  ),
  requesters as (
    select u.id as user_id, p.gender, p.region_code, public.recommendation_age_band(p.birth_year) as age_band
    from public.users u
    join public.profiles p on p.user_id = u.id
    where not u.is_demo
  ),
  facts as (
    -- 실행 행
    select q.gender, q.region_code, q.age_band, 'run'::text as kind, r.status, r.result, r.cap_reached,
           null::text as strategy, null::text as basis
    from public.recommendation_runs r
    join requesters q on q.user_id = r.user_id, params
    where r.for_date > params.today - params.days and r.status in ('done', 'failed')
    union all
    -- 추천 행
    select q.gender, q.region_code, q.age_band, 'rec'::text, null, null, null, x.strategy, x.dimensions->>'basis'
    from public.recommendations x
    join requesters q on q.user_id = x.user_id, params
    where x.for_date > params.today - params.days
  )
  select
    grouping(f.gender, f.region_code, f.age_band) = 7 as is_total,
    f.gender, f.region_code, f.age_band,
    count(*) filter (where f.kind = 'run')::int as runs,
    count(*) filter (where f.kind = 'run' and f.result = 'ok')::int as runs_ok,
    count(*) filter (where f.kind = 'run' and f.result = 'exhausted' and not f.cap_reached)::int as runs_exhausted_complete,
    count(*) filter (where f.kind = 'run' and f.result = 'exhausted' and f.cap_reached)::int as runs_exhausted_cap,
    count(*) filter (where f.kind = 'run' and f.result = 'slots_full')::int as runs_slots_full,
    count(*) filter (where f.kind = 'run' and f.status = 'failed')::int as runs_failed,
    count(*) filter (where f.kind = 'run' and f.status = 'done' and f.result not in ('ok', 'exhausted', 'slots_full'))::int as runs_other,
    count(*) filter (where f.kind = 'rec')::int as recommendations_created,
    count(*) filter (where f.kind = 'rec' and f.strategy = 'high_confidence')::int as strategy_high_confidence,
    count(*) filter (where f.kind = 'rec' and f.strategy = 'exploration')::int as strategy_exploration,
    count(*) filter (where f.kind = 'rec' and f.strategy = 'fallback')::int as strategy_fallback,
    count(*) filter (where f.kind = 'rec' and f.basis = 'scored')::int as basis_scored,
    count(*) filter (where f.kind = 'rec' and f.basis = 'conditions_only')::int as basis_conditions_only,
    count(*) filter (where f.kind = 'rec' and (f.basis is null or f.basis not in ('scored', 'conditions_only')))::int as basis_unmeasured,
    (select today - days + 1 from params) as window_from,
    (select today from params) as window_to
  from facts f
  group by grouping sets ((f.gender, f.region_code, f.age_band), ())
  order by 1 desc, f.gender, f.region_code, f.age_band;
$$;

revoke all on function public.recommendation_run_stats(int) from public, anon, authenticated;
grant execute on function public.recommendation_run_stats(int) to service_role;

comment on function public.recommendation_run_stats(int) is
  '운영자용 추천 실행·생성 건수 (#23). 최근 N일 안 실행 행(사용자·날짜당 최종 결과)을 결과별로, 추천 행을 전략·basis 별로 센다. 요청자 세그먼트별 + 전체 행(null). demo 제외. service role 전용';
