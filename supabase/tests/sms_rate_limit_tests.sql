-- sms_rate_limit_tests.sql
-- SMS OTP 전화번호별 쿨다운/시간당 상한(0012_sms_otp_rate_limit.sql) 검증.
-- local_supabase_mock.sql + 전체 마이그레이션 적용 후 실행한다.
-- 실패 시 예외가 발생해 psql(ON_ERROR_STOP)이 비정상 종료된다.

\set ON_ERROR_STOP on

do $$
declare
  h1 text := 'test-phone-hash-0000000000000000000000000001';
  h2 text := 'test-phone-hash-0000000000000000000000000002';
  res jsonb;
  n int;
  t timestamptz;
  caught boolean := false;
begin
  -- Test 1: 첫 요청은 허용, 행 생성 (count 1)
  res := public.sms_otp_rate_limit_check(h1, 60, 5);
  if (res->>'allowed')::boolean is not true or res->>'reason' <> 'ok' then
    raise exception 'FAIL first request should be allowed: %', res;
  end if;
  select window_count into n from public.sms_otp_send_log where phone_hash = h1;
  if n <> 1 then raise exception 'FAIL window_count after first send: %', n; end if;

  -- Test 2: 60초 안의 재요청은 거부 (cooldown), retry_after 1~60
  select last_sent_at into t from public.sms_otp_send_log where phone_hash = h1;
  res := public.sms_otp_rate_limit_check(h1, 60, 5);
  if (res->>'allowed')::boolean is not false or res->>'reason' <> 'cooldown' then
    raise exception 'FAIL immediate resend should be blocked: %', res;
  end if;
  if (res->>'retry_after_seconds')::int not between 1 and 60 then
    raise exception 'FAIL retry_after out of range: %', res;
  end if;
  -- 거부된 요청은 last_sent_at / count 를 바꾸지 않는다 (쿨다운 연장 없음)
  if (select last_sent_at from public.sms_otp_send_log where phone_hash = h1) <> t then
    raise exception 'FAIL blocked request must not touch last_sent_at';
  end if;
  if (select window_count from public.sms_otp_send_log where phone_hash = h1) <> 1 then
    raise exception 'FAIL blocked request must not increment window_count';
  end if;

  -- Test 3: 다른 번호는 영향 없음
  res := public.sms_otp_rate_limit_check(h2, 60, 5);
  if (res->>'allowed')::boolean is not true then
    raise exception 'FAIL other phone should be allowed: %', res;
  end if;

  -- Test 4: 쿨다운이 지나면 허용, count 2
  update public.sms_otp_send_log set last_sent_at = now() - interval '61 seconds' where phone_hash = h1;
  res := public.sms_otp_rate_limit_check(h1, 60, 5);
  if (res->>'allowed')::boolean is not true then
    raise exception 'FAIL resend after cooldown should be allowed: %', res;
  end if;
  if (select window_count from public.sms_otp_send_log where phone_hash = h1) <> 2 then
    raise exception 'FAIL window_count after second send';
  end if;

  -- Test 5: 1시간 창 안에서 상한(5) 도달 → hourly_limit 거부 (쿨다운은 지났어도)
  update public.sms_otp_send_log
     set window_count = 5, last_sent_at = now() - interval '5 minutes'
   where phone_hash = h1;
  res := public.sms_otp_rate_limit_check(h1, 60, 5);
  if (res->>'allowed')::boolean is not false or res->>'reason' <> 'hourly_limit' then
    raise exception 'FAIL hourly limit should block: %', res;
  end if;
  if (res->>'retry_after_seconds')::int not between 1 and 3600 then
    raise exception 'FAIL hourly retry_after out of range: %', res;
  end if;

  -- Test 6: 창이 만료되면(1시간 경과) 새 창으로 리셋 → 허용, count 1
  update public.sms_otp_send_log
     set window_started_at = now() - interval '61 minutes', last_sent_at = now() - interval '5 minutes'
   where phone_hash = h1;
  res := public.sms_otp_rate_limit_check(h1, 60, 5);
  if (res->>'allowed')::boolean is not true then
    raise exception 'FAIL new window should be allowed: %', res;
  end if;
  if (select window_count from public.sms_otp_send_log where phone_hash = h1) <> 1 then
    raise exception 'FAIL window_count should reset to 1 in new window';
  end if;

  -- Test 7: 짧은/빈 해시는 거부 (원문 전화번호 저장 방지 가드)
  begin
    perform public.sms_otp_rate_limit_check('01012345678', 60, 5);
  exception when others then
    caught := true;
  end;
  if not caught then raise exception 'FAIL short hash must be rejected'; end if;

  -- Test 8: prune — 오래된 행만 삭제
  update public.sms_otp_send_log set last_sent_at = now() - interval '3 days' where phone_hash = h2;
  n := public.sms_otp_send_log_prune(interval '2 days');
  if n <> 1 then raise exception 'FAIL prune should delete exactly 1 row, got %', n; end if;
  if exists (select 1 from public.sms_otp_send_log where phone_hash = h2) then
    raise exception 'FAIL pruned row still exists';
  end if;
  if not exists (select 1 from public.sms_otp_send_log where phone_hash = h1) then
    raise exception 'FAIL recent row must survive prune';
  end if;

  -- 정리
  delete from public.sms_otp_send_log where phone_hash in (h1, h2);
end;
$$;

-- Test 9: 클라이언트 역할(anon/authenticated)은 테이블도 함수도 접근 불가
do $$
declare
  caught boolean;
begin
  set local role anon;
  caught := false;
  begin
    perform count(*) from public.sms_otp_send_log;
  exception when insufficient_privilege then
    caught := true;
  end;
  if not caught then raise exception 'FAIL anon must not read sms_otp_send_log'; end if;

  caught := false;
  begin
    perform public.sms_otp_rate_limit_check('test-phone-hash-0000000000000000000000000009', 60, 5);
  exception when insufficient_privilege then
    caught := true;
  end;
  if not caught then raise exception 'FAIL anon must not execute sms_otp_rate_limit_check'; end if;

  set local role authenticated;
  caught := false;
  begin
    perform public.sms_otp_rate_limit_check('test-phone-hash-0000000000000000000000000009', 60, 5);
  exception when insufficient_privilege then
    caught := true;
  end;
  if not caught then raise exception 'FAIL authenticated must not execute sms_otp_rate_limit_check'; end if;
  reset role;
end;
$$;

select 'SMS RATE LIMIT TESTS PASSED' as result;
