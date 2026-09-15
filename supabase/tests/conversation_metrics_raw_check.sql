-- conversation_metrics_raw_check.sql — #24 독립 raw query 대조.
--
-- 관리자 화면·뷰(conversation_pair_facts / conversation_cohorts)가 쓰는 conversation_pair_metrics() 는 윈도 함수로 계산한다.
-- 이 파일은 같은 지표를 **원본 테이블(matches · messages · conversations · conversation_exits)에서 절차적으로(plpgsql 루프)** 다시 계산해
-- 매치별로 대조한다. 같은 뷰를 두 번 읽는 검증이 아니다. 실제 프로젝트에서도 그대로 실행할 수 있다 (읽기 전용 — 임시 함수만 만든다).
--
-- 사용 (로컬):  psql -d blind_dating_check -v as_of="'2026-09-16 09:00:00+09'" -f conversation_metrics_raw_check.sql
--      (실제):  Supabase SQL Editor 에 붙여 넣거나 psql "$DATABASE_URL" -v as_of="now()" -f ... 로 실행. 결과 표를 이슈에 기록한다.
-- as_of 를 생략하면 now() 다. 불일치가 있으면 마지막 SELECT 가 행을 돌려주고, 요약 행의 mismatches 가 0 이 아니다.
-- run_local_check.sh 는 불일치가 있으면 실패한다 (\set ON_ERROR_STOP 아래의 do 블록이 예외를 던진다).

\set ON_ERROR_STOP on
\if :{?as_of}
\else
\set as_of 'now()'
\endif

create or replace function pg_temp.raw_pair_metrics(p_as_of timestamptz)
returns table (
  match_id uuid, first_contact_class text, first_sender_id uuid, first_reply_status text, first_reply_wait_seconds bigint,
  two_way boolean, max_completed_wait_seconds bigint, open_wait_seconds bigint, open_wait_by uuid,
  stall_24h_reached boolean, stalled_now boolean, resumed_after_24h_count int, close_stage text, exit_reason text
)
language plpgsql
as $$
declare
  m record;
  g record;
  obs_end timestamptz;
  is_closed boolean;
  first_at timestamptz; first_by uuid; reply_at timestamptz;
  run_start timestamptz; run_by uuid; last_at timestamptz; prev_at timestamptz;
  max_wait bigint; resumed int; nmsg int;
begin
  for m in
    select mt.id, mt.created_at, mt.status, mt.closed_at, mt.closed_by, mt.close_kind, c.id as conv_id
    from public.matches mt left join public.conversations c on c.match_id = mt.id
    where mt.created_at <= p_as_of
  loop
    is_closed := m.status <> 'active' and (m.closed_at is null or m.closed_at <= p_as_of);
    obs_end := case when not is_closed then p_as_of when m.closed_at is not null then least(m.closed_at, p_as_of) else null end;
    first_at := null; first_by := null; reply_at := null; run_start := null; run_by := null; last_at := null; prev_at := null;
    max_wait := null; resumed := 0; nmsg := 0;
    -- 메시지를 시간·id 순으로 한 건씩 훑는다 (윈도 함수 없이)
    for g in
      select x.sender_id, x.created_at from public.messages x
      where x.conversation_id = m.conv_id and x.created_at <= coalesce(obs_end, p_as_of)
      order by x.created_at, x.id
    loop
      nmsg := nmsg + 1;
      if first_at is null then first_at := g.created_at; first_by := g.sender_id; end if;
      if reply_at is null and g.sender_id <> first_by then reply_at := g.created_at; end if;
      if prev_at is not null and g.created_at - prev_at >= interval '24 hours' then resumed := resumed + 1; end if;
      if run_by is null then
        run_start := g.created_at; run_by := g.sender_id;
      elsif g.sender_id <> run_by then
        -- 상대의 답장: 직전 run 의 대기가 끝난다
        max_wait := greatest(coalesce(max_wait, 0), extract(epoch from (g.created_at - run_start))::bigint);
        run_start := g.created_at; run_by := g.sender_id;
      end if;
      prev_at := g.created_at; last_at := g.created_at;
    end loop;

    match_id := m.id;
    first_sender_id := first_by;
    first_contact_class := case
      when first_at is not null then (case when first_at - m.created_at <= interval '1 hour' then 'within_1h' else 'after_1h' end)
      when is_closed and m.closed_at is not null and m.closed_at - m.created_at < interval '1 hour' then 'closed_early'
      when is_closed then 'not_started'
      when p_as_of - m.created_at < interval '1 hour' then 'observing'
      else 'not_started' end;
    first_reply_status := case when first_at is null then null when reply_at is not null then 'replied' when is_closed then 'no_reply_closed' else 'waiting' end;
    first_reply_wait_seconds := case
      when first_at is null then null
      when reply_at is not null then extract(epoch from (reply_at - first_at))::bigint
      when obs_end is not null then extract(epoch from (obs_end - first_at))::bigint
      else null end;
    two_way := reply_at is not null;
    max_completed_wait_seconds := max_wait;
    open_wait_seconds := case when run_start is not null and obs_end is not null then extract(epoch from (obs_end - run_start))::bigint end;
    open_wait_by := run_by;
    stall_24h_reached := last_at is not null and obs_end is not null and obs_end - last_at >= interval '24 hours';
    stalled_now := not is_closed and last_at is not null and p_as_of - last_at >= interval '24 hours';
    resumed_after_24h_count := resumed;
    close_stage := case when not is_closed then null when first_at is null then 'before_first_message' when reply_at is null then 'before_first_reply' else 'after_two_way' end;
    exit_reason := case when is_closed and m.close_kind = 'left' then (select e.reason from public.conversation_exits e where e.match_id = m.id and e.user_id = m.closed_by) end;
    return next;
  end loop;
end;
$$;

-- 매치별 대조 (불일치만)
drop table if exists raw_mismatch;
create temp table raw_mismatch as
select v.match_id,
  v.first_contact_class as v_first, r.first_contact_class as r_first,
  v.first_reply_status as v_reply, r.first_reply_status as r_reply,
  v.first_reply_wait_seconds as v_reply_wait, r.first_reply_wait_seconds as r_reply_wait,
  v.max_completed_wait_seconds as v_max_wait, r.max_completed_wait_seconds as r_max_wait,
  v.open_wait_seconds as v_open, r.open_wait_seconds as r_open,
  v.stall_24h_reached as v_stall, r.stall_24h_reached as r_stall,
  v.stalled_now as v_stalled_now, r.stalled_now as r_stalled_now,
  v.resumed_after_24h_count as v_resumed, r.resumed_after_24h_count as r_resumed,
  v.close_stage as v_stage, r.close_stage as r_stage,
  v.exit_reason as v_exit, r.exit_reason as r_exit
from public.conversation_pair_metrics(:as_of) v
full join pg_temp.raw_pair_metrics(:as_of) r on r.match_id = v.match_id
where v.match_id is null or r.match_id is null
   or v.first_contact_class is distinct from r.first_contact_class
   or v.first_sender_id is distinct from r.first_sender_id
   or v.first_reply_status is distinct from r.first_reply_status
   or v.first_reply_wait_seconds is distinct from r.first_reply_wait_seconds
   or v.two_way is distinct from r.two_way
   or v.max_completed_wait_seconds is distinct from r.max_completed_wait_seconds
   or v.open_wait_seconds is distinct from r.open_wait_seconds
   or v.open_wait_by is distinct from r.open_wait_by
   or v.stall_24h_reached is distinct from r.stall_24h_reached
   or v.stalled_now is distinct from r.stalled_now
   or v.resumed_after_24h_count is distinct from r.resumed_after_24h_count
   or v.close_stage is distinct from r.close_stage
   or v.exit_reason is distinct from r.exit_reason;

-- cohort 집계도 원본에서 직접 (뷰 미사용): 매치주별 1시간 내 첫 연락 · 양방향 · 나가기 종료 — 관리자 화면의 같은 열과 대조한다
select
  date_trunc('week', (mt.created_at at time zone 'Asia/Seoul'))::date as cohort_week,
  count(*) as matched_raw,
  count(*) filter (where (select min(x.created_at) from public.messages x join public.conversations c on c.id = x.conversation_id where c.match_id = mt.id) - mt.created_at <= interval '1 hour') as first_within_1h_raw,
  count(*) filter (where (select count(distinct x.sender_id) from public.messages x join public.conversations c on c.id = x.conversation_id where c.match_id = mt.id) >= 2) as two_way_raw,
  count(*) filter (where mt.status <> 'active' and mt.close_kind = 'left') as closed_left_raw
from public.matches mt
join public.users ua on ua.id = mt.user_a
join public.users ub on ub.id = mt.user_b
where not ua.is_demo and not ub.is_demo and mt.created_at <= :as_of
group by 1
order by 1 desc
limit 26;

select (select count(*) from public.conversation_pair_metrics(:as_of)) as compared, (select count(*) from raw_mismatch) as mismatches;
select * from raw_mismatch limit 50;

do $$
declare n int;
begin
  select count(*) into n from raw_mismatch;
  if n > 0 then raise exception 'RAW CHECK FAILED: % mismatching matches (see rows above)', n; end if;
  raise notice 'RAW CHECK PASSED: view and procedural recomputation agree';
end;
$$;
