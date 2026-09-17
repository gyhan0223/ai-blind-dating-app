-- recommendation_runs_tests.sql
-- Issue #22 — 추천 실행권(claim) RPC 검증. local_supabase_mock.sql + 전체 마이그레이션(0017 포함) 적용 후 실행한다.
--   * claimed / busy / skip 분기, lease 만료 후 재획득, exhausted 재시도 주기, 사용자 JWT 로는 호출 불가, 배치 대상 조회
--   * (0032) 매시간 폴링: 배치 창(p_retry_after_seconds=3000) 이 지난 exhausted 는 다시 대상·claimed, slots_full·자리 없음은 그날 대상 제외(0026 유지)

\set ON_ERROR_STOP on

do $$
declare
  ua uuid := 'e2200000-0000-4000-8000-000000000001';
  ub uuid := 'e2200000-0000-4000-8000-000000000002';
  today date := (now() at time zone 'Asia/Seoul')::date;
  j jsonb;
  n int;
  st text;
  denied boolean;
begin
  insert into auth.users (id, email) values (ua, 'runs-a@test.dev'), (ub, 'runs-b@test.dev');
  update public.users set onboarding_completed = true, identity_verified = true, face_verified = true, age_verified = true where id in (ua, ub);
  perform set_config('request.jwt.claim.sub', '', false);

  -- 1) 첫 claim → claimed
  j := public.recommendation_run_claim(ua, today);
  if j->>'claim' <> 'claimed' then raise exception 'FAIL first claim: %', j; end if;
  -- 2) lease 유효한 동안 두 번째 claim → busy
  j := public.recommendation_run_claim(ua, today);
  if j->>'claim' <> 'busy' then raise exception 'FAIL second claim should be busy: %', j; end if;
  -- 3) finish(ok) → 이후 claim 은 skip(ok) — 다시 생성하지 않는다
  perform public.recommendation_run_finish(ua, today, 'ok', 12, false);
  j := public.recommendation_run_claim(ua, today);
  if j->>'claim' <> 'skip' or j->>'result' <> 'ok' then raise exception 'FAIL claim after ok: %', j; end if;
  select count(*) into n from public.recommendation_runs where user_id = ua;
  if n <> 1 then raise exception 'FAIL runs row count %', n; end if;

  -- 4) exhausted 로 끝나면 1시간 안에는 skip(exhausted), 그 뒤엔 다시 claimed
  j := public.recommendation_run_claim(ub, today);
  perform public.recommendation_run_finish(ub, today, 'exhausted', 500, true);
  j := public.recommendation_run_claim(ub, today);
  if j->>'claim' <> 'skip' or j->>'result' <> 'exhausted' then raise exception 'FAIL claim after recent exhausted: %', j; end if;
  select cap_reached into denied from public.recommendation_runs where user_id = ub and for_date = today;
  if not denied then raise exception 'FAIL cap_reached not stored'; end if;
  update public.recommendation_runs set finished_at = now() - interval '2 hours' where user_id = ub and for_date = today;
  j := public.recommendation_run_claim(ub, today);
  if j->>'claim' <> 'claimed' or (j->>'retry')::boolean is not true then raise exception 'FAIL claim after old exhausted: %', j; end if;
  select attempts into n from public.recommendation_runs where user_id = ub and for_date = today;
  if n <> 2 then raise exception 'FAIL attempts after retry: %', n; end if;

  -- 5) lease 만료(실행이 죽음) → 다른 호출자가 다시 맡는다
  update public.recommendation_runs set lease_until = now() - interval '1 second' where user_id = ub and for_date = today;
  j := public.recommendation_run_claim(ub, today);
  if j->>'claim' <> 'claimed' or (j->>'reclaimed')::boolean is not true then raise exception 'FAIL reclaim after lease expiry: %', j; end if;

  -- 6) failed 로 끝나면 바로 다시 claimed
  perform public.recommendation_run_finish(ub, today, 'lookup_failed', 0, false);
  select status into st from public.recommendation_runs where user_id = ub and for_date = today;
  if st <> 'failed' then raise exception 'FAIL status after lookup_failed: %', st; end if;
  j := public.recommendation_run_claim(ub, today);
  if j->>'claim' <> 'claimed' then raise exception 'FAIL claim after failed: %', j; end if;
  perform public.recommendation_run_finish(ub, today, 'ok', 3, false);

  -- 7) 배치 대상: 오늘 추천이 없고 최근 실행 기록이 없는 자격자만
  --    ua: 오늘 run=ok (추천 행은 없지만 ok 로 끝남) → 제외 / ub: ok → 제외
  select count(*) into n from public.recommendation_batch_targets(today, null, 100) t where t.user_id in (ua, ub);
  if n <> 0 then raise exception 'FAIL batch targets should exclude finished users, got %', n; end if;
  delete from public.recommendation_runs where user_id = ua;
  select count(*) into n from public.recommendation_batch_targets(today, null, 100) t where t.user_id = ua;
  if n <> 1 then raise exception 'FAIL batch target should include ua without run'; end if;
  -- 오늘 추천이 있으면 제외
  insert into public.recommendations (user_id, candidate_id, for_date, card) values (ua, ub, today, '{}');
  select count(*) into n from public.recommendation_batch_targets(today, null, 100) t where t.user_id = ua;
  if n <> 0 then raise exception 'FAIL batch target should exclude user with today recommendation'; end if;
  -- 커서(p_after) 로 페이지 이어가기
  select count(*) into n from public.recommendation_batch_targets(today, 'ffffffff-ffff-4fff-8fff-ffffffffffff', 100);
  if n <> 0 then raise exception 'FAIL cursor beyond all ids should be empty'; end if;

  -- 7b) (0032, #22 매시간 폴링) 후보 없음(exhausted)은 그날 소개 완료가 아니다 — 창이 지나면 다시 대상이 된다
  delete from public.recommendations where user_id = ua;
  delete from public.recommendation_runs where user_id in (ua, ub);
  j := public.recommendation_run_claim(ua, today);
  perform public.recommendation_run_finish(ua, today, 'exhausted', 3, false);
  --   방금 끝남 → 기본 창(1시간)·배치 창(50분) 모두 제외
  select count(*) into n from public.recommendation_batch_targets(today, null, 100) t where t.user_id = ua;
  if n <> 0 then raise exception 'FAIL just-exhausted user should be excluded (default window)'; end if;
  select count(*) into n from public.recommendation_batch_targets(today, null, 100, 3000) t where t.user_id = ua;
  if n <> 0 then raise exception 'FAIL just-exhausted user should be excluded (batch window)'; end if;
  --   55분 전 끝남 (= 09:00 실행 → 10:00 cron 시점): 기본 1시간 창은 아직 제외, 배치 50분 창은 다시 대상
  update public.recommendation_runs set finished_at = now() - interval '55 minutes' where user_id = ua and for_date = today;
  select count(*) into n from public.recommendation_batch_targets(today, null, 100) t where t.user_id = ua;
  if n <> 0 then raise exception 'FAIL 55min-old exhausted should still be excluded with default 1h window'; end if;
  select count(*) into n from public.recommendation_batch_targets(today, null, 100, 3000) t where t.user_id = ua;
  if n <> 1 then raise exception 'FAIL 55min-old exhausted should be a batch target with 50min window'; end if;
  --   claim 도 같은 창으로 판정: 기본은 skip(exhausted), 배치 창(3000초)은 claimed(retry)
  j := public.recommendation_run_claim(ua, today);
  if j->>'claim' <> 'skip' or j->>'result' <> 'exhausted' then raise exception 'FAIL default claim after 55min exhausted: %', j; end if;
  j := public.recommendation_run_claim(ua, today, 90, 3000);
  if j->>'claim' <> 'claimed' or (j->>'retry')::boolean is not true then raise exception 'FAIL batch-window claim after 55min exhausted: %', j; end if;
  --   실행 중(lease 유효)이면 대상 제외 — 배치·앱이 겹쳐도 한 실행만
  select count(*) into n from public.recommendation_batch_targets(today, null, 100, 3000) t where t.user_id = ua;
  if n <> 0 then raise exception 'FAIL running user should be excluded'; end if;
  --   다시 exhausted → 행은 여전히 1개 (재확인이 실행 기록을 늘리지 않는다), 2시간 전이면 어떤 창에서도 대상
  perform public.recommendation_run_finish(ua, today, 'exhausted', 3, false);
  select count(*) into n from public.recommendation_runs where user_id = ua and for_date = today;
  if n <> 1 then raise exception 'FAIL exhausted recheck must keep one run row, got %', n; end if;
  update public.recommendation_runs set finished_at = now() - interval '2 hours' where user_id = ua and for_date = today;
  select count(*) into n from public.recommendation_batch_targets(today, null, 100) t where t.user_id = ua;
  if n <> 1 then raise exception 'FAIL 2h-old exhausted should be a target with default window'; end if;
  --   창 하한: 60초 미만·null 은 60초로 취급 (요청이 창을 0 으로 만들어 헛 반복하지 못하게)
  update public.recommendation_runs set finished_at = now() - interval '30 seconds' where user_id = ua and for_date = today;
  select count(*) into n from public.recommendation_batch_targets(today, null, 100, 0) t where t.user_id = ua;
  if n <> 0 then raise exception 'FAIL zero window must be clamped to 60s'; end if;
  select count(*) into n from public.recommendation_batch_targets(today, null, 100, null) t where t.user_id = ua;
  if n <> 0 then raise exception 'FAIL null window must fall back to default'; end if;

  -- 7c) (0026 조건 유지) 그날 slots_full(대화 3개) 로 끝난 사용자는 배치 창을 넘겨도 대상에서 뺀다 (#24 — 같은 날 재시도 없음) · 후보 부족과 구분
  j := public.recommendation_run_claim(ub, today);
  perform public.recommendation_run_finish(ub, today, 'slots_full', 0, false);
  update public.recommendation_runs set finished_at = now() - interval '3 hours' where user_id = ub and for_date = today;
  select count(*) into n from public.recommendation_batch_targets(today, null, 100, 3000) t where t.user_id = ub;
  if n <> 0 then raise exception 'FAIL slots_full user should be excluded from batch targets'; end if;
  j := public.recommendation_run_claim(ub, today, 90, 3000);
  if j->>'claim' <> 'skip' or j->>'result' <> 'slots_full' then raise exception 'FAIL claim after slots_full should skip: %', j; end if;
  --   실패(failed) 로 끝난 사용자는 바로 다시 대상 (재처리)
  update public.recommendation_runs set status = 'failed', result = 'lookup_failed' where user_id = ub and for_date = today;
  select count(*) into n from public.recommendation_batch_targets(today, null, 100, 3000) t where t.user_id = ub;
  if n <> 1 then raise exception 'FAIL failed user should be retried by batch'; end if;
  delete from public.recommendation_runs where user_id in (ua, ub);
end;
$$;

-- 8) 사용자 JWT 컨텍스트에서는 호출 불가 (권한·서버 전용 검사)
select set_config('request.jwt.claim.sub', 'e2200000-0000-4000-8000-000000000001', false);
set role authenticated;
do $$
declare
  j jsonb;
  denied boolean := false;
  n int;
begin
  begin
    j := public.recommendation_run_claim('e2200000-0000-4000-8000-000000000001', current_date);
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client could call recommendation_run_claim'; end if;
  denied := false;
  begin
    perform public.recommendation_run_finish('e2200000-0000-4000-8000-000000000001', current_date, 'ok', 0, false);
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client could call recommendation_run_finish'; end if;
  denied := false;
  begin
    select count(*) into n from public.recommendation_runs;
    if n = 0 then denied := true; end if;
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client can read recommendation_runs'; end if;
  denied := false;
  begin
    select count(*) into n from public.recommendation_batch_targets(current_date, null, 10);
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client could call recommendation_batch_targets'; end if;
  denied := false;
  begin
    select count(*) into n from public.recommendation_batch_targets(current_date, null, 10, 3000);
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client could call recommendation_batch_targets(4 args)'; end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', false);

select 'RECOMMENDATION RUNS TESTS PASSED' as result;
