-- server_errors_tests.sql — Issue #20: 서버 오류 기록 RPC 는 service role 전용, 클라이언트는 읽기·쓰기 불가, fingerprint 로 같은 유형 묶음
\set ON_ERROR_STOP on

select set_config('request.jwt.claim.sub', '', false);
do $$
declare a bigint; b bigint; fa text; fb text; n int;
begin
  a := public.record_server_error('send-push', 'expo push http 502', 'Error', null, '{"stage":"expo_push","count":3}'::jsonb, 'development', 'abc123');
  b := public.record_server_error('send-push', 'expo push http 503', 'Error', null, '{}'::jsonb, 'development', 'abc123');
  select fingerprint into fa from public.server_errors where id = a;
  select fingerprint into fb from public.server_errors where id = b;
  if fa <> fb then raise exception 'FAIL same error type should share fingerprint'; end if;
  update public.server_errors set created_at = now() - interval '31 days' where id in (a, b);
  if public.server_errors_prune(interval '30 days') < 2 then raise exception 'FAIL prune'; end if;
  select count(*) into n from public.server_errors where id in (a, b);
  if n <> 0 then raise exception 'FAIL prune left rows'; end if;
end;
$$;

select set_config('request.jwt.claim.sub', '15160000-0000-4000-8000-000000000001', false);
set role authenticated;
do $$
declare denied boolean := false; n int; x bigint;
begin
  begin
    x := public.record_server_error('x', 'y');
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client could record server error'; end if;
  denied := false;
  begin
    select count(*) into n from public.server_errors;
    if n = 0 then denied := true; end if;
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client can read server_errors'; end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', false);

select 'SERVER ERRORS TESTS PASSED' as result;
