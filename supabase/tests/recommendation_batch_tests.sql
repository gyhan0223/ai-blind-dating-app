-- recommendation_batch_tests.sql
-- Issue #22 / #17 / #23 (0034_recommendation_batch_sweep — 구 0032) — 배치 대상의 재시도 간격 · sweep 커서(claim/lease/save/날짜 변경) · 소개 알림의 발송 시점 재확인.
-- local_supabase_mock.sql + 전체 마이그레이션(0034 포함) 적용 후 실행한다. 시간은 finished_at/lease_until 을 직접 옮겨 제어한다 (실제 대기 없음).

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1) 배치 대상 — exhausted 1시간 · failed/not_ready 류 15분 · 인자로 조정 가능 · 오늘 추천/진행 중/ok/slots_full 제외
-- ---------------------------------------------------------------------------
do $$
declare
  ua uuid := 'b3200000-0000-4000-8000-000000000001';
  ub uuid := 'b3200000-0000-4000-8000-000000000002';
  uc uuid := 'b3200000-0000-4000-8000-000000000003';
  ud uuid := 'b3200000-0000-4000-8000-000000000004';
  today date := (now() at time zone 'Asia/Seoul')::date;
  n int;
  j jsonb;
begin
  insert into auth.users (id, email) values (ua, 'batch-a@test.dev'), (ub, 'batch-b@test.dev'), (uc, 'batch-c@test.dev'), (ud, 'batch-d@test.dev');
  update public.users set onboarding_completed = true, identity_verified = true, face_verified = true, age_verified = true where id in (ua, ub, uc, ud);
  perform set_config('request.jwt.claim.sub', '', false);

  -- 실행 기록이 없으면 모두 대상 (id 순)
  select count(*) into n from public.recommendation_batch_targets(today, null, 100) t where t.user_id in (ua, ub, uc, ud);
  if n <> 4 then raise exception 'FAIL fresh users should all be targets, got %', n; end if;

  -- A: 방금 exhausted → 제외. 59분 전 → 제외. 61분 전 → 대상 (후보 없음은 그날 소개를 받은 것이 아니다)
  j := public.recommendation_run_claim(ua, today);
  perform public.recommendation_run_finish(ua, today, 'exhausted', 3, false, 0, null, null);
  select count(*) into n from public.recommendation_batch_targets(today, null, 100) t where t.user_id = ua;
  if n <> 0 then raise exception 'FAIL exhausted just now should be excluded'; end if;
  update public.recommendation_runs set finished_at = now() - interval '59 minutes' where user_id = ua and for_date = today;
  select count(*) into n from public.recommendation_batch_targets(today, null, 100) t where t.user_id = ua;
  if n <> 0 then raise exception 'FAIL exhausted 59 min ago should be excluded'; end if;
  update public.recommendation_runs set finished_at = now() - interval '61 minutes' where user_id = ua and for_date = today;
  select count(*) into n from public.recommendation_batch_targets(today, null, 100) t where t.user_id = ua;
  if n <> 1 then raise exception 'FAIL exhausted 61 min ago should be a target again'; end if;
  -- 간격 인자: 2시간으로 넓히면 다시 제외, 0 이면 바로 대상
  select count(*) into n from public.recommendation_batch_targets(today, null, 100, 7200, 900) t where t.user_id = ua;
  if n <> 0 then raise exception 'FAIL custom exhausted interval (2h) should exclude'; end if;
  select count(*) into n from public.recommendation_batch_targets(today, null, 100, 0, 900) t where t.user_id = ua;
  if n <> 1 then raise exception 'FAIL exhausted interval 0 should include'; end if;

  -- B: 방금 failed(lookup_failed) → 15분 안에는 제외 (반복 실패가 매 호출 앞자리를 차지하지 않는다). 16분 전 → 대상
  j := public.recommendation_run_claim(ub, today);
  perform public.recommendation_run_finish(ub, today, 'lookup_failed', 0, false, null, null, 'candidates');
  select count(*) into n from public.recommendation_batch_targets(today, null, 100) t where t.user_id = ub;
  if n <> 0 then raise exception 'FAIL failed just now should be excluded for the retry interval'; end if;
  update public.recommendation_runs set finished_at = now() - interval '16 minutes' where user_id = ub and for_date = today;
  select count(*) into n from public.recommendation_batch_targets(today, null, 100) t where t.user_id = ub;
  if n <> 1 then raise exception 'FAIL failed 16 min ago should be a target'; end if;
  -- 앱의 직접 요청은 실패 뒤 바로 다시 맡는다 (claim 은 간격을 두지 않는다 — 기존 정책)
  update public.recommendation_runs set finished_at = now() where user_id = ub and for_date = today;
  j := public.recommendation_run_claim(ub, today);
  if j->>'claim' <> 'claimed' then raise exception 'FAIL app claim after failed should be claimed immediately: %', j; end if;
  perform public.recommendation_run_finish(ub, today, 'profile_missing', 0, false);
  select count(*) into n from public.recommendation_batch_targets(today, null, 100) t where t.user_id = ub;
  if n <> 0 then raise exception 'FAIL profile_missing just now should be excluded like failed'; end if;

  -- C: ok → 그날 제외. D: slots_full → 그날 제외 (#24 — 다음 날 재개)
  j := public.recommendation_run_claim(uc, today);
  perform public.recommendation_run_finish(uc, today, 'ok', 5, false);
  j := public.recommendation_run_claim(ud, today);
  perform public.recommendation_run_finish(ud, today, 'slots_full', 0, false);
  update public.recommendation_runs set finished_at = now() - interval '5 hours' where user_id in (uc, ud) and for_date = today;
  select count(*) into n from public.recommendation_batch_targets(today, null, 100) t where t.user_id in (uc, ud);
  if n <> 0 then raise exception 'FAIL ok/slots_full should stay excluded for the day, got %', n; end if;
  -- 진행 중(lease 유효) 제외, lease 만료 → 대상
  update public.recommendation_runs set status = 'running', result = null, finished_at = null, lease_until = now() + interval '60 seconds' where user_id = uc and for_date = today;
  select count(*) into n from public.recommendation_batch_targets(today, null, 100) t where t.user_id = uc;
  if n <> 0 then raise exception 'FAIL running with valid lease should be excluded'; end if;
  update public.recommendation_runs set lease_until = now() - interval '1 second' where user_id = uc and for_date = today;
  select count(*) into n from public.recommendation_batch_targets(today, null, 100) t where t.user_id = uc;
  if n <> 1 then raise exception 'FAIL running with expired lease should be a target'; end if;
  -- 커서: p_after 이후만, id 순
  --   B: profile_missing 직후 제외 · C: lease 만료 running → 대상 · D: slots_full → 제외 ⇒ 1명(C)
  select count(*) into n from public.recommendation_batch_targets(today, ua, 100) t where t.user_id in (ua, ub, uc, ud);
  if n <> 1 then raise exception 'FAIL after=A should give only C, got %', n; end if;
  select count(*) into n from public.recommendation_batch_targets(today, ud, 100) t where t.user_id in (ua, ub, uc, ud);
  if n <> 0 then raise exception 'FAIL after=D (last id) should give none'; end if;
  -- 다른 날짜(내일)에는 오늘 기록이 영향을 주지 않는다 (KST 날짜별 독립)
  select count(*) into n from public.recommendation_batch_targets(today + 1, null, 100) t where t.user_id in (ua, ub, uc, ud);
  if n <> 4 then raise exception 'FAIL tomorrow should include all four, got %', n; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2) sweep 커서 — claim/lease/save/완료/날짜 변경
-- ---------------------------------------------------------------------------
do $$
declare
  today date := (now() at time zone 'Asia/Seoul')::date;
  ua uuid := 'b3200000-0000-4000-8000-000000000001';
  j jsonb;
  n int;
begin
  perform set_config('request.jwt.claim.sub', '', false);
  delete from public.recommendation_batch_cursor;

  j := public.recommendation_batch_cursor_claim(today, 180);
  if (j->>'claimed')::boolean is not true or j ? 'after' and j->>'after' is not null then raise exception 'FAIL first cursor claim: %', j; end if;
  -- lease 중 두 번째 claim → busy (cron 겹침)
  j := public.recommendation_batch_cursor_claim(today, 180);
  if (j->>'claimed')::boolean is not false or (j->>'busy')::boolean is not true then raise exception 'FAIL second claim during lease should be busy: %', j; end if;
  -- 페이지 저장(release=false) → 여전히 busy, after 갱신
  perform public.recommendation_batch_cursor_save(today, ua, false, 180);
  j := public.recommendation_batch_cursor_claim(today, 180);
  if (j->>'claimed')::boolean is not false then raise exception 'FAIL still busy after page save: %', j; end if;
  select count(*) into n from public.recommendation_batch_cursor where after = ua and for_date = today and lease_until > now();
  if n <> 1 then raise exception 'FAIL page save should keep lease and store after'; end if;
  -- 호출 종료(release=true, after 유지) → 다음 claim 은 저장된 after 를 준다
  perform public.recommendation_batch_cursor_save(today, ua, true, 180);
  j := public.recommendation_batch_cursor_claim(today, 180);
  if (j->>'claimed')::boolean is not true or (j->>'after')::uuid <> ua then raise exception 'FAIL claim should resume from saved after: %', j; end if;
  -- sweep 완료(after=null) → sweeps+1, 다음 claim 은 처음부터
  perform public.recommendation_batch_cursor_save(today, null, true, 180);
  select sweeps into n from public.recommendation_batch_cursor;
  if n <> 1 then raise exception 'FAIL sweeps should be 1, got %', n; end if;
  j := public.recommendation_batch_cursor_claim(today, 180);
  if (j->>'claimed')::boolean is not true or j->>'after' is not null then raise exception 'FAIL claim after completed sweep should start over: %', j; end if;
  perform public.recommendation_batch_cursor_save(today, ua, true, 180);
  -- lease 만료(실행이 죽음) → 다음 호출이 이어간다
  perform public.recommendation_batch_cursor_save(today, ua, false, 180);
  update public.recommendation_batch_cursor set lease_until = now() - interval '1 second';
  j := public.recommendation_batch_cursor_claim(today, 180);
  if (j->>'claimed')::boolean is not true or (j->>'after')::uuid <> ua then raise exception 'FAIL claim after lease expiry should resume: %', j; end if;
  perform public.recommendation_batch_cursor_save(today, ua, true, 180);
  -- 날짜가 바뀌면 after 초기화 (새 날은 처음부터)
  j := public.recommendation_batch_cursor_claim(today + 1, 180);
  if (j->>'claimed')::boolean is not true or j->>'after' is not null then raise exception 'FAIL new date should reset cursor: %', j; end if;
  -- 이전 날짜로 저장(호출 중 자정을 넘긴 경우): after 는 바꾸지 않고 lease 만 놓는다
  perform public.recommendation_batch_cursor_save(today, ua, true, 180);
  select count(*) into n from public.recommendation_batch_cursor where for_date = today + 1 and after is null and lease_until is null;
  if n <> 1 then raise exception 'FAIL save with stale date should only release lease'; end if;
  -- 단일 행 제약
  begin
    insert into public.recommendation_batch_cursor (singleton) values (false);
    raise exception 'FAIL cursor table should be single row';
  exception when check_violation then null; end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) 소개 알림 — 저장된 소개만 이벤트 · 하루 1건 · 발송 전 참조 이전 · 발송 시점 재확인
-- ---------------------------------------------------------------------------
do $$
declare
  ua uuid := 'b3200000-0000-4000-8000-000000000001';
  ub uuid := 'b3200000-0000-4000-8000-000000000002';
  uc uuid := 'b3200000-0000-4000-8000-000000000003';
  today date := (now() at time zone 'Asia/Seoul')::date;
  r1 uuid;
  r2 uuid;
  r3 uuid;
  ev bigint;
  n int;
  valid boolean;
begin
  perform set_config('request.jwt.claim.sub', '', false);
  insert into public.profiles (user_id, nickname, birth_year, gender, seeking_gender, region_code, height_cm, job_group, smoking, drinking)
  values (ua, '배치가', 1994, 'male', 'female', 'seoul', 176, 'it', 'none', 'none'),
         (ub, '배치나', 1996, 'female', 'male', 'seoul', 162, 'office', 'none', 'none'),
         (uc, '배치다', 1995, 'female', 'male', 'seoul', 165, 'creative', 'none', 'none');
  insert into public.push_tokens (user_id, token, platform) values (ua, 'ExponentPushToken[batch-aaaa]', 'android');

  -- 후보 부족 실행 기록만으로는 알림이 생기지 않는다 (1절에서 A 는 exhausted 로 끝났다)
  select count(*) into n from public.notification_events where recipient_id = ua and kind = 'daily_recommendation';
  if n <> 0 then raise exception 'FAIL exhausted run must not create a notification'; end if;

  -- 소개 저장 → 이벤트 1건, recommendation_id 가 그 행을 가리킨다
  insert into public.recommendations (user_id, candidate_id, for_date, card) values (ua, ub, today, '{}') returning id into r1;
  select id into ev from public.notification_events where dedupe_key = 'recommendation:' || ua::text || ':' || today::text;
  if ev is null then raise exception 'FAIL daily_recommendation event missing'; end if;
  select count(*) into n from public.notification_events where id = ev and recommendation_id = r1;
  if n <> 1 then raise exception 'FAIL event should reference the recommendation'; end if;

  -- 발송 시점 재확인: pending·상대 유효 → true
  select d.recommendation_valid into valid from public.notification_events_dequeue(500) d where d.id = ev;
  if valid is not true then raise exception 'FAIL fresh pending recommendation should be valid'; end if;
  update public.notification_events set claimed_at = null, attempts = 0 where id = ev;

  -- 발송 전에 첫 소개가 만료되고 같은 날 새 pending 소개가 생기면 → 이벤트는 그대로 1건, 참조만 새 행으로
  update public.recommendations set status = 'expired' where id = r1;
  select d.recommendation_valid into valid from public.notification_events_dequeue(500) d where d.id = ev;
  if valid is not false then raise exception 'FAIL expired recommendation should be invalid'; end if;
  update public.notification_events set claimed_at = null, attempts = 0 where id = ev;
  insert into public.recommendations (user_id, candidate_id, for_date, card) values (ua, uc, today, '{}') returning id into r2;
  select count(*) into n from public.notification_events where recipient_id = ua and kind = 'daily_recommendation';
  if n <> 1 then raise exception 'FAIL second pending rec must not add an event (still 1 per day), got %', n; end if;
  select count(*) into n from public.notification_events where id = ev and recommendation_id = r2;
  if n <> 1 then raise exception 'FAIL undelivered event should now reference the new pending recommendation'; end if;
  select d.recommendation_valid into valid from public.notification_events_dequeue(500) d where d.id = ev;
  if valid is not true then raise exception 'FAIL new pending recommendation should be valid'; end if;
  update public.notification_events set claimed_at = null, attempts = 0 where id = ev;

  -- 상대가 제재되면 무효 → 복구하면 유효
  update public.users set status = 'suspended' where id = uc;
  select d.recommendation_valid into valid from public.notification_events_dequeue(500) d where d.id = ev;
  if valid is not false then raise exception 'FAIL suspended candidate should make it invalid'; end if;
  update public.notification_events set claimed_at = null, attempts = 0 where id = ev;
  update public.users set status = 'active' where id = uc;
  -- 차단 쌍(어느 방향이든) → 무효
  insert into public.blocks (blocker_id, blocked_id) values (uc, ua);
  select d.recommendation_valid into valid from public.notification_events_dequeue(500) d where d.id = ev;
  if valid is not false then raise exception 'FAIL blocked pair should make it invalid'; end if;
  update public.notification_events set claimed_at = null, attempts = 0 where id = ev;
  delete from public.blocks where blocker_id = uc and blocked_id = ua;
  -- 이미 확인(수락/넘김)한 소개는 다시 알리지 않는다
  update public.recommendations set status = 'skipped' where id = r2;
  select d.recommendation_valid into valid from public.notification_events_dequeue(500) d where d.id = ev;
  if valid is not false then raise exception 'FAIL skipped recommendation should be invalid for push'; end if;
  update public.notification_events set claimed_at = null, attempts = 0 where id = ev;
  update public.recommendations set status = 'pending' where id = r2;

  -- 발송된 뒤에는 같은 날 새 pending 행이 생겨도 참조를 바꾸지 않는다 (하루 1건)
  perform public.notification_events_mark(array[ev], array[]::bigint[], null, array[]::bigint[], null);
  update public.recommendations set status = 'expired' where id = r2;
  delete from public.recommendations where user_id = ua and candidate_id = ub and for_date = today; -- (user, candidate, date) unique 회피
  insert into public.recommendations (user_id, candidate_id, for_date, card) values (ua, ub, today, '{}') returning id into r3;
  select count(*) into n from public.notification_events where id = ev and recommendation_id = r2 and delivered_at is not null;
  if n <> 1 then raise exception 'FAIL delivered event must keep its reference'; end if;
  select count(*) into n from public.notification_events where recipient_id = ua and kind = 'daily_recommendation';
  if n <> 1 then raise exception 'FAIL still one event per day after delivery, got %', n; end if;

  -- 0034 이전 이벤트(참조 없음)는 null — 발송기는 기존대로 보낸다 / 다른 종류도 null
  update public.notification_events set recommendation_id = null, delivered_at = null, claimed_at = null where id = ev;
  select d.recommendation_valid into valid from public.notification_events_dequeue(500) d where d.id = ev;
  if valid is not null then raise exception 'FAIL legacy event without reference should be null'; end if;
  update public.notification_events set delivered_at = now() where id = ev;

  -- KST 날짜가 다르면 dedupe_key 가 달라 날짜별 1건 (자정 전후 실행이 섞이지 않는다)
  insert into public.recommendations (user_id, candidate_id, for_date, card) values (ua, uc, today + 1, '{}');
  select count(*) into n from public.notification_events where recipient_id = ua and kind = 'daily_recommendation';
  if n <> 2 then raise exception 'FAIL one event per KST date expected 2, got %', n; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) 서버 전용 — 사용자 JWT 로 커서 함수·테이블 접근 불가
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'b3200000-0000-4000-8000-000000000001', false);
set role authenticated;
do $$
declare
  j jsonb;
  denied boolean := false;
  n int;
begin
  begin
    j := public.recommendation_batch_cursor_claim(current_date, 180);
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client could claim batch cursor'; end if;
  denied := false;
  begin
    perform public.recommendation_batch_cursor_save(current_date, null, true, 180);
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client could save batch cursor'; end if;
  denied := false;
  begin
    select count(*) into n from public.recommendation_batch_cursor;
    if n = 0 then denied := true; end if;
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client can read batch cursor'; end if;
  denied := false;
  begin
    select count(*) into n from public.recommendation_batch_targets(current_date, null, 10, 3600, 900);
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client could call recommendation_batch_targets (5 args)'; end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', false);

select 'RECOMMENDATION BATCH TESTS PASSED' as result;
