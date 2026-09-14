-- 0017_recommendation_runs.sql
-- Issue #22 (하루 1명 추천 스케줄러 · 멱등성) · #23 (후보 부족 정책 · 재추천 주기)
--
-- 문제
--   같은 사용자의 동시 요청(앱 두 번 열기, 배치 + 앱)이 각각 "오늘 추천 없음" 을 보고 서로 다른 후보 2건을 저장할 수 있었다.
--   unique(user_id, candidate_id) 는 같은 후보 중복만 막는다. 후보가 없을 때는 앱을 열 때마다 최대 500명을 다시 훑었다.
--
-- 해결 (additive)
--   recommendation_runs — (user_id, for_date) 당 한 행. 서버(service role)만 쓴다.
--     * recommendation_run_claim(): 행 잠금으로 "오늘 이 사용자의 추천 생성" 을 한 프로세스만 맡게 한다 (lease 로 크래시 복구).
--     * recommendation_run_finish(): 결과(ok/exhausted/…)·평가 수·상한 도달 여부를 기록한다.
--     * exhausted 로 끝난 뒤 retry_after 안의 재요청은 후보를 다시 훑지 않고 'skip' 을 돌려준다 (#23 재시도 주기).
--   for_date 는 KST 날짜다 (호출자가 계산 — daily-recommendation/index.ts seoulToday()).
--   재추천 주기(스킵/만료 후보 30일)는 코어(recommend.ts RECOMMENDATION_COOLDOWN_DAYS)에서 적용한다 — docs/matching-policy.md 10절.

-- ---------------------------------------------------------------------------
-- 0) 재추천을 허용하는 unique 규칙 (#23)
--    0003 의 unique(user_id, candidate_id) 는 같은 쌍을 평생 한 번만 허용해 30일 뒤 재추천이 불가능했다.
--    → (user_id, candidate_id, for_date) unique + 같은 쌍의 pending 은 하나만 (partial unique).
--    기존 행은 그대로 (같은 쌍 행이 이미 여러 개인 경우는 없다 — 옛 제약이 막고 있었다).
-- ---------------------------------------------------------------------------
alter table public.recommendations drop constraint if exists recommendations_user_id_candidate_id_key;
create unique index if not exists recommendations_user_candidate_date_uidx
  on public.recommendations (user_id, candidate_id, for_date);
create unique index if not exists recommendations_user_candidate_pending_uidx
  on public.recommendations (user_id, candidate_id) where status = 'pending';

create table if not exists public.recommendation_runs (
  user_id      uuid not null references public.users (id) on delete cascade,
  for_date     date not null,
  status       text not null check (status in ('running', 'done', 'failed')),
  result       text check (result is null or result in ('ok', 'exhausted', 'not_ready', 'not_verified', 'profile_missing', 'lookup_failed', 'error')),
  scanned      int not null default 0,
  cap_reached  boolean not null default false,
  attempts     int not null default 1,
  lease_until  timestamptz not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  primary key (user_id, for_date)
);

create index if not exists recommendation_runs_date_idx on public.recommendation_runs (for_date, status);

alter table public.recommendation_runs enable row level security;
revoke all on public.recommendation_runs from anon, authenticated;

comment on table public.recommendation_runs is
  '하루 1명 추천 생성 실행 기록 (#22). (user_id, for_date) 당 1행 — claim 으로 동시 실행을 직렬화한다. 서버 전용';

-- 실행권 획득. 반환: {claim: claimed | busy | skip, result?}
--   claimed : 이 호출자가 생성한다 (lease_seconds 안에 finish 를 불러야 한다. 안 부르면 lease 만료 후 다른 호출자가 다시 맡는다)
--   busy    : 다른 프로세스가 생성 중 (lease 유효). 호출자는 잠시 기다렸다가 저장된 오늘 추천을 읽는다
--   skip    : 최근(retry_after_seconds 안)에 exhausted 로 끝났다 — 다시 훑지 않는다. ok 로 끝난 날은 저장된 추천을 읽으면 되므로 claimed 를 돌려주지 않고 skip(result=ok)
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

  -- 행이 없으면 만들고 바로 실행권을 갖는다 (동시 insert 는 PK 충돌 → returning 없음 → 아래 select for update 로 수렴)
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
    -- lease 만료: 이전 실행이 죽었다 → 다시 맡는다
    update public.recommendation_runs
    set attempts = attempts + 1, lease_until = now() + make_interval(secs => p_lease_seconds), started_at = now()
    where user_id = p_user_id and for_date = p_for_date;
    return jsonb_build_object('claim', 'claimed', 'reclaimed', true);
  end if;

  if r.status = 'done' and r.result = 'ok' then
    return jsonb_build_object('claim', 'skip', 'result', 'ok');
  end if;
  if r.status = 'done' and r.result = 'exhausted'
     and r.finished_at is not null and r.finished_at > now() - make_interval(secs => p_retry_after_seconds) then
    return jsonb_build_object('claim', 'skip', 'result', 'exhausted', 'finished_at', r.finished_at);
  end if;

  -- failed / 오래된 exhausted / not_ready 등 → 다시 시도
  update public.recommendation_runs
  set status = 'running', result = null, attempts = attempts + 1,
      lease_until = now() + make_interval(secs => p_lease_seconds), started_at = now(), finished_at = null
  where user_id = p_user_id and for_date = p_for_date;
  return jsonb_build_object('claim', 'claimed', 'retry', true);
end;
$$;

create or replace function public.recommendation_run_finish(
  p_user_id uuid,
  p_for_date date,
  p_result text,
  p_scanned int default 0,
  p_cap_reached boolean default false
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
  update public.recommendation_runs
  set status = case when p_result in ('lookup_failed', 'error') then 'failed' else 'done' end,
      result = p_result,
      scanned = coalesce(p_scanned, 0),
      cap_reached = coalesce(p_cap_reached, false),
      finished_at = now()
  where user_id = p_user_id and for_date = p_for_date;
end;
$$;

revoke all on function public.recommendation_run_claim(uuid, date, int, int) from public, anon, authenticated;
revoke all on function public.recommendation_run_finish(uuid, date, text, int, boolean) from public, anon, authenticated;
grant execute on function public.recommendation_run_claim(uuid, date, int, int) to service_role;
grant execute on function public.recommendation_run_finish(uuid, date, text, int, boolean) to service_role;

-- 배치(daily-recommendation-batch)가 "오늘 아직 추천이 없고 자격이 있는 사용자" 를 페이지로 읽을 때 쓰는 조회
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
    and not exists (
      select 1 from public.recommendations r
      where r.user_id = u.id and r.for_date = p_for_date and r.status <> 'expired')
    and not exists (
      select 1 from public.recommendation_runs x
      where x.user_id = u.id and x.for_date = p_for_date
        and (x.status = 'running' and x.lease_until > now()
             or x.status = 'done' and x.result = 'ok'
             or x.status = 'done' and x.result = 'exhausted' and x.finished_at > now() - interval '1 hour'))
  order by u.id
  limit greatest(1, least(p_limit, 500));
$$;

revoke all on function public.recommendation_batch_targets(date, uuid, int) from public, anon, authenticated;
grant execute on function public.recommendation_batch_targets(date, uuid, int) to service_role;

-- 오래된 실행 기록 정리 (선택 — pg_cron 등으로 주기 실행)
create or replace function public.recommendation_runs_prune(p_keep interval default interval '30 days')
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  delete from public.recommendation_runs where for_date < (now() at time zone 'Asia/Seoul')::date - p_keep;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.recommendation_runs_prune(interval) from public, anon, authenticated;
grant execute on function public.recommendation_runs_prune(interval) to service_role;
