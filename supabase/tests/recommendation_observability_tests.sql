-- recommendation_observability_tests.sql
-- Issue #23 — 추천 결과·전략 관측 · 운영자용 후보 규모 통계 (0027). local_supabase_mock.sql + 전체 마이그레이션(0027 포함) 적용 후 실행한다.
--   1) recommendations insert → analytics_events.recommendation_created 정확히 1건 (같은 트랜잭션, 저장 행 기준) · 같은 추천 id 로 두 번 기록 불가 (DB unique)
--   2) recommendation_run_finish: 적격 후보 수·저장 추천 id → strategy/basis 는 저장 행에서 복사 · 훑지 않은 결과는 미측정 · 실패 단계 · 옛 5인자 호출 호환
--   3) recommendation_run_claim: exhausted skip 응답에 cap_reached / eligible_count · skip/busy 는 실행 기록을 늘리지 않는다
--   4) recommendation_pool_stats: 사용자별 최근 실행 분류 (후보 있음/0명/상한/자리/실패/미측정) · demo 제외 · 기간 · 중앙값(합계 아님) · 전체 행
--   5) recommendation_run_stats: 기간 내 실행 결과·생성·전략·basis 건수 · demo 제외
--   6) 일반 사용자(authenticated) 는 통계·finish 를 호출할 수 없다

\set ON_ERROR_STOP on
select set_config('request.jwt.claim.sub', '', false);

-- ---------------------------------------------------------------------------
-- 픽스처 — 격리된 지역 코드 'obs_test' (다른 테스트 데이터와 세그먼트가 섞이지 않게)
--   O1  male  1994  최근 실행 exhausted, eligible 0, 상한 미도달  → zero_candidates
--   O2  male  1994  최근 실행 exhausted, eligible 0, 상한 도달    → cap_reached
--   O3  female 1990 최근 실행 ok, eligible 5, 추천 생성          → with_candidates (+ 생성·전략 집계)
--   O4  male  1994  최근 실행 lookup_failed                       → failed (0명이 아니다)
--   O5  male  1994  실행 없음                                     → unmeasured
--   O6  male  1994  demo                                          → 추천 대상에서 제외, demo_eligible_accounts 에만
--   O7  female 1990 최근 실행 slots_full                          → latest_slots_full
--   O8  male  1994  최근 실행 ok, eligible null (0027 이전 형태)   → unmeasured
--   O9  male  1994  10일 전 실행 ok, eligible 3 (7일 창 밖)        → unmeasured(7일) / with_candidates(30일)
--   O10 male  1994  진행 중 매치 3개 (실행 없음)                    → slots_full_now, unmeasured
--   O11 male  1994  최근 실행 ok, eligible 4                       → with_candidates (male 세그먼트 중앙값: {0,4} → 2)
--   O12 male  1994  인증 미완료                                    → 추천 대상 아님 (어디에도 없음)
-- ---------------------------------------------------------------------------
do $$
declare
  ids uuid[] := array[
    '0b230000-0000-4000-8000-000000000001', '0b230000-0000-4000-8000-000000000002', '0b230000-0000-4000-8000-000000000003',
    '0b230000-0000-4000-8000-000000000004', '0b230000-0000-4000-8000-000000000005', '0b230000-0000-4000-8000-000000000006',
    '0b230000-0000-4000-8000-000000000007', '0b230000-0000-4000-8000-000000000008', '0b230000-0000-4000-8000-000000000009',
    '0b230000-0000-4000-8000-000000000010', '0b230000-0000-4000-8000-000000000011', '0b230000-0000-4000-8000-000000000012'
  ];
  partners uuid[] := array['0b230000-0000-4000-8000-0000000000a1', '0b230000-0000-4000-8000-0000000000a2', '0b230000-0000-4000-8000-0000000000a3'];
  i int;
  g text;
  birth int;
begin
  for i in 1..array_length(ids, 1) loop
    insert into auth.users (id, email) values (ids[i], 'obs-' || i || '@test.dev');
    g := case when i in (3, 7) then 'female' else 'male' end;
    birth := case when g = 'female' then 1990 else 1994 end;
    insert into public.profiles (user_id, nickname, birth_year, gender, seeking_gender, region_code, height_cm, job_group, smoking, drinking)
    values (ids[i], '관측' || i, birth, g, case when g = 'male' then 'female' else 'male' end, 'obs_test', 170, 'it', 'none', 'none');
  end loop;
  update public.users set onboarding_completed = true, identity_verified = true, face_verified = true, age_verified = true where id = any (ids);
  update public.users set is_demo = true where id = ids[6];
  update public.users set face_verified = false where id = ids[12];
  for i in 1..3 loop
    insert into auth.users (id, email) values (partners[i], 'obs-p' || i || '@test.dev');
    insert into public.matches (user_a, user_b) values (least(ids[10], partners[i]), greatest(ids[10], partners[i]));
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1) 전략 분석 이벤트 — 저장 행 기준 1회, DB unique
-- ---------------------------------------------------------------------------
do $$
declare
  o3 uuid := '0b230000-0000-4000-8000-000000000003';
  o11 uuid := '0b230000-0000-4000-8000-000000000011';
  today date := (now() at time zone 'Asia/Seoul')::date;
  rec uuid;
  n int;
  ev record;
  denied boolean := false;
begin
  insert into public.recommendations (user_id, candidate_id, for_date, strategy, score_total, dimensions, card)
  values (o3, o11, today, 'exploration', 0.55, '{"basis":"scored","personality":0.5}', '{"nickname":"관측11","reasons":["공통 관심사가 있어요"]}')
  returning id into rec;

  select count(*) into n from public.analytics_events where event_type = 'recommendation_created' and payload->>'recommendation_id' = rec::text;
  if n <> 1 then raise exception 'FAIL recommendation_created event count % (expected 1)', n; end if;
  select * into ev from public.analytics_events where event_type = 'recommendation_created' and payload->>'recommendation_id' = rec::text;
  if ev.user_id <> o3 or ev.payload->>'strategy' <> 'exploration' or ev.payload->>'basis' <> 'scored' or ev.payload->>'source' <> 'server' then
    raise exception 'FAIL recommendation_created payload: %', ev.payload;
  end if;
  -- 카드·점수·비공개 응답은 이벤트에 복제하지 않는다
  if ev.payload ? 'card' or ev.payload ? 'score_total' or ev.payload ? 'reasons' or ev.payload::text like '%관측11%' then
    raise exception 'FAIL recommendation_created payload leaks card/score: %', ev.payload;
  end if;
  -- 같은 추천 id 로 두 번째 기록 → DB unique 위반 (앱·배치 중첩, 재시도, 수동 insert 어느 경로든)
  begin
    insert into public.analytics_events (user_id, event_type, payload)
    values (o3, 'recommendation_created', jsonb_build_object('recommendation_id', rec, 'strategy', 'fallback'));
  exception when unique_violation then denied := true; end;
  if not denied then raise exception 'FAIL duplicate recommendation_created was accepted'; end if;
  -- 0027 이전 행 복원분(backfill)은 source 로 구분되고 strategy 는 저장값 그대로
  select count(*) into n from public.analytics_events e
  join public.recommendations r on r.id::text = e.payload->>'recommendation_id'
  where e.event_type = 'recommendation_created' and e.payload->>'strategy' is distinct from r.strategy;
  if n <> 0 then raise exception 'FAIL % recommendation_created events disagree with stored strategy', n; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2) recommendation_run_finish — 관측값 기록
-- ---------------------------------------------------------------------------
do $$
declare
  o1 uuid := '0b230000-0000-4000-8000-000000000001';
  o2 uuid := '0b230000-0000-4000-8000-000000000002';
  o3 uuid := '0b230000-0000-4000-8000-000000000003';
  o4 uuid := '0b230000-0000-4000-8000-000000000004';
  o7 uuid := '0b230000-0000-4000-8000-000000000007';
  o8 uuid := '0b230000-0000-4000-8000-000000000008';
  o9 uuid := '0b230000-0000-4000-8000-000000000009';
  o11 uuid := '0b230000-0000-4000-8000-000000000011';
  today date := (now() at time zone 'Asia/Seoul')::date;
  rec uuid;
  r public.recommendation_runs%rowtype;
  j jsonb;
begin
  select id into rec from public.recommendations where user_id = o3 and for_date = today;

  -- O3: ok + eligible 5 + 저장 추천 id → strategy/basis 는 저장 행에서
  perform public.recommendation_run_claim(o3, today);
  perform public.recommendation_run_finish(o3, today, 'ok', 12, false, 5, rec, null);
  select * into r from public.recommendation_runs where user_id = o3 and for_date = today;
  if r.status <> 'done' or r.result <> 'ok' or r.eligible_count <> 5 or r.recommendation_id <> rec or r.strategy <> 'exploration' or r.basis <> 'scored' or r.error_stage is not null then
    raise exception 'FAIL finish(ok) observation: eligible=% rec=% strategy=% basis=% err=%', r.eligible_count, r.recommendation_id, r.strategy, r.basis, r.error_stage;
  end if;

  -- 다른 사용자의 추천 id 를 넘기면 기록하지 않는다 (저장 행이 그 사용자 것이어야 한다)
  perform public.recommendation_run_claim(o11, today);
  perform public.recommendation_run_finish(o11, today, 'ok', 9, false, 4, rec, null);
  select * into r from public.recommendation_runs where user_id = o11 and for_date = today;
  if r.recommendation_id is not null or r.strategy is not null or r.eligible_count <> 4 then
    raise exception 'FAIL finish with foreign recommendation id should not copy strategy: rec=% strategy=%', r.recommendation_id, r.strategy;
  end if;

  -- O1: exhausted, eligible 0, 상한 미도달 / O2: exhausted, eligible 0, 상한 도달
  perform public.recommendation_run_claim(o1, today);
  perform public.recommendation_run_finish(o1, today, 'exhausted', 7, false, 0, null, null);
  perform public.recommendation_run_claim(o2, today);
  perform public.recommendation_run_finish(o2, today, 'exhausted', 500, true, 0, null, null);
  select * into r from public.recommendation_runs where user_id = o1 and for_date = today;
  if r.eligible_count <> 0 or r.cap_reached then raise exception 'FAIL finish(exhausted complete)'; end if;
  select * into r from public.recommendation_runs where user_id = o2 and for_date = today;
  if r.eligible_count <> 0 or not r.cap_reached then raise exception 'FAIL finish(exhausted cap)'; end if;

  -- O4: lookup_failed + 단계 → failed, eligible 은 미측정(null) — 0명으로 남지 않는다
  perform public.recommendation_run_claim(o4, today);
  perform public.recommendation_run_finish(o4, today, 'lookup_failed', 0, false, 0, null, 'candidates');
  select * into r from public.recommendation_runs where user_id = o4 and for_date = today;
  if r.status <> 'failed' or r.eligible_count is not null or r.error_stage <> 'candidates' then
    raise exception 'FAIL finish(lookup_failed): status=% eligible=% stage=%', r.status, r.eligible_count, r.error_stage;
  end if;

  -- O7: slots_full — 훑지 않았으므로 eligible 은 값이 넘어와도 미측정
  perform public.recommendation_run_claim(o7, today);
  perform public.recommendation_run_finish(o7, today, 'slots_full', 0, false, 0, null, null);
  select * into r from public.recommendation_runs where user_id = o7 and for_date = today;
  if r.result <> 'slots_full' or r.eligible_count is not null then raise exception 'FAIL finish(slots_full) must leave eligible null'; end if;

  -- O8: 옛 5인자 호출(0027 이전 Edge 코드) 도 그대로 동작 — 관측값 없음 = 미측정
  perform public.recommendation_run_claim(o8, today);
  perform public.recommendation_run_finish(o8, today, 'ok', 3, false);
  select * into r from public.recommendation_runs where user_id = o8 and for_date = today;
  if r.status <> 'done' or r.result <> 'ok' or r.eligible_count is not null or r.recommendation_id is not null then
    raise exception 'FAIL 5-arg finish compatibility';
  end if;

  -- O9: 10일 전 실행 (기간 창 검증용)
  insert into public.recommendation_runs (user_id, for_date, status, result, scanned, eligible_count, lease_until, finished_at)
  values (o9, today - 10, 'done', 'ok', 5, 3, now(), now() - interval '10 days');

  -- 3) claim: 최근 exhausted 는 skip + cap_reached/eligible_count · skip 은 행을 바꾸지 않는다
  j := public.recommendation_run_claim(o2, today);
  if j->>'claim' <> 'skip' or j->>'result' <> 'exhausted' or (j->>'cap_reached')::boolean is not true or (j->>'eligible_count')::int <> 0 then
    raise exception 'FAIL claim skip(exhausted) should carry cap_reached: %', j;
  end if;
  j := public.recommendation_run_claim(o1, today);
  if (j->>'cap_reached')::boolean is not false then raise exception 'FAIL claim skip(exhausted, complete) cap_reached: %', j; end if;
  select * into r from public.recommendation_runs where user_id = o1 and for_date = today;
  if r.attempts <> 1 or r.status <> 'done' then raise exception 'FAIL skip must not change the run row (attempts=% status=%)', r.attempts, r.status; end if;
  j := public.recommendation_run_claim(o3, today);
  if j->>'claim' <> 'skip' or j->>'result' <> 'ok' then raise exception 'FAIL claim after ok: %', j; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) recommendation_pool_stats — 세그먼트 분류 · demo 제외 · 기간 · 중앙값 · 전체 행
-- ---------------------------------------------------------------------------
do $$
declare
  band_m int := public.recommendation_age_band(1994);
  band_f int := public.recommendation_age_band(1990);
  s record;
  n int;
begin
  -- male / obs_test: O1 zero · O2 cap · O4 failed · O5 unmeasured · O8 unmeasured(null) · O9 unmeasured(창 밖) · O10 unmeasured+slots_full_now · O11 with
  --   (O6 demo 제외, O12 인증 미완료 제외) → eligible_users 8
  select * into s from public.recommendation_pool_stats(7) p where p.gender = 'male' and p.region_code = 'obs_test' and p.age_band = band_m;
  if not found then raise exception 'FAIL pool stats: male segment missing'; end if;
  if s.is_total then raise exception 'FAIL segment row flagged as total'; end if;
  if s.eligible_users <> 8 then raise exception 'FAIL eligible_users % (expected 8 — demo·미인증 제외)', s.eligible_users; end if;
  if s.slots_full_now_users <> 1 then raise exception 'FAIL slots_full_now_users %', s.slots_full_now_users; end if;
  if s.with_candidates_users <> 1 or s.zero_candidates_users <> 1 or s.cap_reached_users <> 1 or s.latest_failed_users <> 1 or s.latest_slots_full_users <> 0 then
    raise exception 'FAIL pool classes: with=% zero=% cap=% failed=% slots=%', s.with_candidates_users, s.zero_candidates_users, s.cap_reached_users, s.latest_failed_users, s.latest_slots_full_users;
  end if;
  if s.measured_users <> 3 then raise exception 'FAIL measured_users % (with+zero+cap)', s.measured_users; end if;
  if s.unmeasured_users <> 4 then raise exception 'FAIL unmeasured_users % (expected 4: 실행 없음 2 · null 1 · 창 밖 1)', s.unmeasured_users; end if;
  if s.with_candidates_users + s.zero_candidates_users + s.cap_reached_users + s.latest_failed_users + s.latest_slots_full_users + s.unmeasured_users <> s.eligible_users then
    raise exception 'FAIL pool classes do not partition eligible users';
  end if;
  -- 중앙값·최소·최대는 with/zero 사용자(O11=4, O1=0)만 — 상한 도달(O2)은 하한이라 제외, 합계 열은 없다
  if s.eligible_median <> 2 or s.eligible_min <> 0 or s.eligible_max <> 4 then
    raise exception 'FAIL eligible median/min/max: % % %', s.eligible_median, s.eligible_min, s.eligible_max;
  end if;
  if s.demo_eligible_accounts < 1 then raise exception 'FAIL demo_eligible_accounts should count O6'; end if;
  if s.window_days <> 7 or s.measured_at is null then raise exception 'FAIL window/measured_at metadata'; end if;

  -- female / obs_test: O3 with(5) · O7 slots_full
  select * into s from public.recommendation_pool_stats(7) p where p.gender = 'female' and p.region_code = 'obs_test' and p.age_band = band_f;
  if s.eligible_users <> 2 or s.with_candidates_users <> 1 or s.latest_slots_full_users <> 1 or s.eligible_median <> 5 then
    raise exception 'FAIL female segment: eligible=% with=% slots=% median=%', s.eligible_users, s.with_candidates_users, s.latest_slots_full_users, s.eligible_median;
  end if;

  -- 30일 창이면 O9 가 측정된 사용자로 옮겨간다 (기간을 명시하는 이유)
  select * into s from public.recommendation_pool_stats(30) p where p.gender = 'male' and p.region_code = 'obs_test' and p.age_band = band_m;
  if s.with_candidates_users <> 2 or s.unmeasured_users <> 3 then raise exception 'FAIL 30-day window: with=% unmeasured=%', s.with_candidates_users, s.unmeasured_users; end if;

  -- 전체 행은 정확히 1개, 세그먼트 합 이상
  select count(*) into n from public.recommendation_pool_stats(7) p where p.is_total;
  if n <> 1 then raise exception 'FAIL total row count %', n; end if;
  select * into s from public.recommendation_pool_stats(7) p where p.is_total;
  if s.gender is not null or s.eligible_users < 10 then raise exception 'FAIL total row: gender=% eligible=%', s.gender, s.eligible_users; end if;
  select sum(p.eligible_users) into n from public.recommendation_pool_stats(7) p where not p.is_total;
  if n <> s.eligible_users then raise exception 'FAIL segments (%) do not sum to total (%)', n, s.eligible_users; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) recommendation_run_stats — 기간 내 실행·생성·전략 건수, demo 제외
-- ---------------------------------------------------------------------------
do $$
declare
  o3 uuid := '0b230000-0000-4000-8000-000000000003';
  o6 uuid := '0b230000-0000-4000-8000-000000000006';
  o11 uuid := '0b230000-0000-4000-8000-000000000011';
  o1 uuid := '0b230000-0000-4000-8000-000000000001';
  today date := (now() at time zone 'Asia/Seoul')::date;
  band_m int := public.recommendation_age_band(1994);
  band_f int := public.recommendation_age_band(1990);
  s record;
begin
  -- 생성 행 추가: O11 → fallback/conditions_only (오늘), O1 → basis 없는 예전 형태 (어제), demo O6 → 집계 제외
  insert into public.recommendations (user_id, candidate_id, for_date, strategy, dimensions, card) values
    (o11, o3, today, 'fallback', '{"basis":"conditions_only"}', '{}'),
    (o1, o3, today - 1, 'high_confidence', '{"personality":0.9}', '{}'),
    (o6, o3, today, 'high_confidence', '{"basis":"scored"}', '{}');

  select * into s from public.recommendation_run_stats(7) p where p.gender = 'male' and p.region_code = 'obs_test' and p.age_band = band_m;
  if not found then raise exception 'FAIL run stats: male segment missing'; end if;
  -- male 실행: O1 exhausted(complete) · O2 exhausted(cap) · O4 failed · O8 ok · O11 ok  (O9 는 창 밖, O5/O10 실행 없음)
  if s.runs <> 5 or s.runs_ok <> 2 or s.runs_exhausted_complete <> 1 or s.runs_exhausted_cap <> 1 or s.runs_failed <> 1 or s.runs_slots_full <> 0 then
    raise exception 'FAIL male run counts: runs=% ok=% exh=% cap=% failed=% slots=%', s.runs, s.runs_ok, s.runs_exhausted_complete, s.runs_exhausted_cap, s.runs_failed, s.runs_slots_full;
  end if;
  -- male 생성: O11 fallback/conditions_only · O1 high_confidence/미측정 (demo O6 제외)
  if s.recommendations_created <> 2 or s.strategy_fallback <> 1 or s.strategy_high_confidence <> 1 or s.basis_conditions_only <> 1 or s.basis_unmeasured <> 1 or s.basis_scored <> 0 then
    raise exception 'FAIL male creation counts: created=% hc=% fb=% scored=% cond=% unm=%', s.recommendations_created, s.strategy_high_confidence, s.strategy_fallback, s.basis_scored, s.basis_conditions_only, s.basis_unmeasured;
  end if;
  select * into s from public.recommendation_run_stats(7) p where p.gender = 'female' and p.region_code = 'obs_test' and p.age_band = band_f;
  if s.runs <> 2 or s.runs_ok <> 1 or s.runs_slots_full <> 1 or s.recommendations_created <> 1 or s.strategy_exploration <> 1 or s.basis_scored <> 1 then
    raise exception 'FAIL female run/creation counts: runs=% ok=% slots=% created=% expl=% scored=%', s.runs, s.runs_ok, s.runs_slots_full, s.recommendations_created, s.strategy_exploration, s.basis_scored;
  end if;
  -- 전체 행 1개, 기간 메타데이터
  select * into s from public.recommendation_run_stats(7) p where p.is_total;
  if s.window_to <> today or s.window_from <> today - 6 then raise exception 'FAIL window metadata: % ~ %', s.window_from, s.window_to; end if;
  if s.recommendations_created < 3 then raise exception 'FAIL total created %', s.recommendations_created; end if;
  -- 1일 창: 어제 생성분(O1)은 빠진다
  select * into s from public.recommendation_run_stats(1) p where p.gender = 'male' and p.region_code = 'obs_test' and p.age_band = band_m;
  if s.recommendations_created <> 1 then raise exception 'FAIL 1-day window created % (expected 1)', s.recommendations_created; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) 일반 사용자는 통계·finish 를 호출할 수 없다
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '0b230000-0000-4000-8000-000000000001', false);
set role authenticated;
do $$
declare denied boolean; n int;
begin
  denied := false;
  begin
    select count(*) into n from public.recommendation_pool_stats(7);
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client could call recommendation_pool_stats'; end if;
  denied := false;
  begin
    select count(*) into n from public.recommendation_run_stats(7);
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client could call recommendation_run_stats'; end if;
  denied := false;
  begin
    perform public.recommendation_run_finish('0b230000-0000-4000-8000-000000000001', current_date, 'ok', 0, false, 1, null, null);
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client could call recommendation_run_finish (8-arg)'; end if;
  denied := false;
  begin
    select count(*) into n from public.recommendation_runs;
    if n = 0 then denied := true; end if;
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client can read recommendation_runs'; end if;
  -- analytics_events 는 본인 이름으로 insert 만 가능 — recommendation_created 를 클라이언트가 위조해도 저장 행 기준 통계(recommendations)에는 영향이 없다
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', false);

select 'RECOMMENDATION OBSERVABILITY TESTS PASSED' as result;
