-- push_tests.sql
-- Issue #17 — push_tokens / notification_preferences RLS, outbox 확장 트리거, 발송기 RPC 서버 전용·dequeue 잠금.
-- local_supabase_mock.sql + 전체 마이그레이션(0018 포함) 적용 후 실행한다.

\set ON_ERROR_STOP on

do $$
declare
  ua uuid := 'a1700000-0000-4000-8000-000000000001';
  ub uuid := 'a1700000-0000-4000-8000-000000000002';
  uc uuid := 'a1700000-0000-4000-8000-000000000003';
begin
  insert into auth.users (id, email) values (ua, 'push-a@test.dev'), (ub, 'push-b@test.dev'), (uc, 'push-c@test.dev');
  update public.users set onboarding_completed = true, identity_verified = true, face_verified = true, age_verified = true where id in (ua, ub, uc);
  insert into public.profiles (user_id, nickname, birth_year, gender, seeking_gender, region_code, height_cm, job_group, smoking, drinking)
  values (ua, '푸시가', 1994, 'male', 'female', 'seoul', 176, 'it', 'none', 'none'),
         (ub, '푸시나', 1996, 'female', 'male', 'seoul', 162, 'office', 'none', 'none'),
         (uc, '푸시다', 1995, 'female', 'male', 'seoul', 165, 'creative', 'none', 'none');
  perform set_config('request.jwt.claim.sub', '', false);
end;
$$;

-- 1) A 관점: 토큰 등록(RPC)·본인 행만 조회·설정 upsert. B 의 토큰은 보이지 않는다
select set_config('request.jwt.claim.sub', 'a1700000-0000-4000-8000-000000000001', false);
set role authenticated;
do $$
declare
  n int;
  denied boolean := false;
begin
  perform public.push_token_register('ExponentPushToken[aaaaaaaaaa]', 'ios');
  perform public.push_token_register('ExponentPushToken[aaaaaaaaaa]', 'ios');  -- 재등록 멱등
  select count(*) into n from public.push_tokens;
  if n <> 1 then raise exception 'FAIL own token rows expected 1, got %', n; end if;
  begin
    perform public.push_token_register('short', 'ios');
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL short token accepted'; end if;
  -- 타인 명의 토큰 insert 불가
  denied := false;
  begin
    insert into public.push_tokens (user_id, token, platform) values ('a1700000-0000-4000-8000-000000000002', 'ExponentPushToken[spoof00000]', 'ios');
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL token insert for other user allowed'; end if;
  insert into public.notification_preferences (user_id, new_message) values ('a1700000-0000-4000-8000-000000000001', false)
  on conflict (user_id) do update set new_message = excluded.new_message;
  select count(*) into n from public.notification_preferences;
  if n <> 1 then raise exception 'FAIL prefs rows expected 1'; end if;
  -- 발송기 RPC 는 클라이언트가 호출 불가
  denied := false;
  begin
    perform * from public.notification_events_dequeue(10);
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client could dequeue'; end if;
  denied := false;
  begin
    perform public.notification_events_mark(array[]::bigint[], array[]::bigint[], null, array[]::bigint[], null);
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client could mark'; end if;
  denied := false;
  begin
    perform public.push_tokens_disable(array['ExponentPushToken[aaaaaaaaaa]'], 'x');
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client could disable tokens'; end if;
end;
$$;
reset role;

-- 2) B 가 같은 토큰을 등록(기기 재로그인) → 행이 B 로 넘어간다. A 는 더 이상 보지 못한다
select set_config('request.jwt.claim.sub', 'a1700000-0000-4000-8000-000000000002', false);
set role authenticated;
select public.push_token_register('ExponentPushToken[aaaaaaaaaa]', 'android');
do $$
declare n int; begin
  select count(*) into n from public.push_tokens where token = 'ExponentPushToken[aaaaaaaaaa]';
  if n <> 1 then raise exception 'FAIL token not transferred to B'; end if;
end; $$;
reset role;
select set_config('request.jwt.claim.sub', 'a1700000-0000-4000-8000-000000000001', false);
set role authenticated;
do $$
declare n int; begin
  select count(*) into n from public.push_tokens;
  if n <> 0 then raise exception 'FAIL A still sees transferred token'; end if;
end; $$;
reset role;
select set_config('request.jwt.claim.sub', '', false);

-- 3) 트리거: 상호 좋아요 → match_created outbox 2건 / 추천 insert → daily_recommendation 하루 1건
do $$
declare
  ua uuid := 'a1700000-0000-4000-8000-000000000001';
  ub uuid := 'a1700000-0000-4000-8000-000000000002';
  n int;
  today date := (now() at time zone 'Asia/Seoul')::date;
begin
  insert into public.recommendations (user_id, candidate_id, for_date, card) values (ua, ub, today, '{}'), (ub, ua, today, '{}');
  select count(*) into n from public.notification_events where kind = 'daily_recommendation' and recipient_id in (ua, ub);
  if n <> 2 then raise exception 'FAIL daily_recommendation outbox expected 2, got %', n; end if;
  -- 같은 날 두 번째 추천 행(예: expired 후 재생성)은 알림을 다시 만들지 않는다
  insert into public.recommendations (user_id, candidate_id, for_date, card) values (ua, 'a1700000-0000-4000-8000-000000000003', today, '{}');
  select count(*) into n from public.notification_events where kind = 'daily_recommendation' and recipient_id = ua;
  if n <> 1 then raise exception 'FAIL daily_recommendation should be once per day, got %', n; end if;

  insert into public.likes (from_user_id, to_user_id) values (ua, ub);
  insert into public.likes (from_user_id, to_user_id) values (ub, ua);
  select count(*) into n from public.notification_events where kind = 'match_created' and recipient_id in (ua, ub);
  if n <> 2 then raise exception 'FAIL match_created outbox expected 2, got %', n; end if;
  select count(*) into n from public.matches where user_a = least(ua, ub) and user_b = greatest(ua, ub);
  if n <> 1 then raise exception 'FAIL match not created'; end if;
end;
$$;

-- 4) dequeue: 미발송만 잠그고 수신자 상태·설정·토큰을 함께 준다. 두 번째 dequeue 는 (60초 안) 같은 행을 주지 않는다
do $$
declare
  ua uuid := 'a1700000-0000-4000-8000-000000000001';
  ub uuid := 'a1700000-0000-4000-8000-000000000002';
  r record;
  n int;
  ids bigint[];
begin
  select count(*) into n from public.notification_events_dequeue(100) d where d.recipient_id in (ua, ub);
  if n <> 4 then raise exception 'FAIL dequeue expected 4 events, got %', n; end if;
  select count(*) into n from public.notification_events_dequeue(100) d where d.recipient_id in (ua, ub);
  if n <> 0 then raise exception 'FAIL second dequeue should return 0 (claimed), got %', n; end if;
  -- B 의 토큰이 붙어 있고, A 는 new_message 설정 off 지만 daily_recommendation 은 on
  select count(*) into n from public.notification_events where recipient_id = ub and kind = 'daily_recommendation' and claimed_at is not null;
  if n <> 1 then raise exception 'FAIL claimed_at not set'; end if;
  -- 재시도: mark failed → claimed_at 해제 → 다시 나온다. delivered → 다시 안 나온다
  select array_agg(id) into ids from public.notification_events where recipient_id in (ua, ub) and delivered_at is null;
  perform public.notification_events_mark(array[ids[1]], array[ids[2]], 'no_token', array[ids[3], ids[4]], 'boom');
  select count(*) into n from public.notification_events_dequeue(100) d where d.recipient_id in (ua, ub);
  if n <> 2 then raise exception 'FAIL after mark: expected 2 retryable, got %', n; end if;
  select count(*) into n from public.notification_events where id = ids[2] and skipped_reason = 'no_token' and delivered_at is not null;
  if n <> 1 then raise exception 'FAIL skipped not recorded'; end if;
  -- 5회 초과 실패는 expired 로 닫힌다
  update public.notification_events set attempts = 5, claimed_at = null where id = ids[3];
  select count(*) into n from public.notification_events_dequeue(100) d where d.id = ids[3];
  if n <> 0 then raise exception 'FAIL expired event still dequeued'; end if;
  select count(*) into n from public.notification_events where id = ids[3] and skipped_reason = 'expired';
  if n <> 1 then raise exception 'FAIL expired not recorded'; end if;
  -- 토큰 비활성화
  select public.push_tokens_disable(array['ExponentPushToken[aaaaaaaaaa]'], 'DeviceNotRegistered') into n;
  if n <> 1 then raise exception 'FAIL disable count %', n; end if;
  select count(*) into n from public.push_tokens where token = 'ExponentPushToken[aaaaaaaaaa]' and enabled;
  if n <> 0 then raise exception 'FAIL token still enabled'; end if;
end;
$$;

select 'PUSH TESTS PASSED' as result;
