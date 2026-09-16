-- admin_login_guard_tests.sql
-- Issue #27 — DB 공유 관리자 로그인 제한 (0031).
--   * check 는 카운트를 바꾸지 않는다 · failure 5회째 잠금(15분) · 잠금 중 failure 는 카운트 유지 · 만료 뒤 새 창 · success 초기화
--   * 인자 검증 · prune · 클라이언트 JWT/anon 은 테이블·RPC 접근 불가 (제한 조회·초기화 불가)
\set ON_ERROR_STOP on
select set_config('request.jwt.claim.sub', '', false);
reset role;

do $$
declare
  k text := 'ip:test-key-0123456789abcdef';
  r jsonb;
  i int;
  n int;
begin
  r := public.admin_login_guard(k, 'check', 5, 900);
  if (r->>'locked')::boolean or (r->>'failures')::int <> 0 then raise exception 'FAIL initial check: %', r; end if;
  select count(*) into n from public.admin_login_locks where key = k; if n <> 0 then raise exception 'FAIL check created a row'; end if;

  for i in 1..4 loop
    r := public.admin_login_guard(k, 'failure', 5, 900);
    if (r->>'locked')::boolean or (r->>'failures')::int <> i then raise exception 'FAIL failure %: %', i, r; end if;
  end loop;
  r := public.admin_login_guard(k, 'check', 5, 900);
  if (r->>'locked')::boolean or (r->>'failures')::int <> 4 then raise exception 'FAIL check after 4: %', r; end if;
  r := public.admin_login_guard(k, 'failure', 5, 900);
  if (r->>'locked')::boolean is not true or (r->>'locked_seconds')::int <> 900 then raise exception 'FAIL 5th failure should lock: %', r; end if;
  r := public.admin_login_guard(k, 'check', 5, 900);
  if (r->>'locked')::boolean is not true or (r->>'locked_seconds')::int < 1 or (r->>'locked_seconds')::int > 900 then raise exception 'FAIL locked check: %', r; end if;
  -- 잠금 중 실패: 잠금 유지, 카운트 안 오름
  r := public.admin_login_guard(k, 'failure', 5, 900);
  if (r->>'locked')::boolean is not true then raise exception 'FAIL failure during lock: %', r; end if;
  select failures into n from public.admin_login_locks where key = k; if n <> 0 then raise exception 'FAIL failures changed during lock'; end if;
  -- 잠금 만료 → 해제, 다음 실패는 1회부터
  update public.admin_login_locks set locked_until = now() - interval '1 second' where key = k;
  r := public.admin_login_guard(k, 'check', 5, 900);
  if (r->>'locked')::boolean then raise exception 'FAIL still locked after expiry: %', r; end if;
  r := public.admin_login_guard(k, 'failure', 5, 900);
  if (r->>'locked')::boolean or (r->>'failures')::int <> 1 then raise exception 'FAIL failure after expiry: %', r; end if;
  -- success → 초기화 (행 삭제)
  r := public.admin_login_guard(k, 'success', 5, 900);
  if (r->>'locked')::boolean then raise exception 'FAIL success result: %', r; end if;
  select count(*) into n from public.admin_login_locks where key = k; if n <> 0 then raise exception 'FAIL success did not reset'; end if;
  -- 다른 키는 독립
  r := public.admin_login_guard('ip:other-key-0123456789', 'failure', 5, 900);
  r := public.admin_login_guard(k, 'check', 5, 900);
  if (r->>'failures')::int <> 0 then raise exception 'FAIL keys not independent'; end if;
  -- 인자 검증
  begin
    r := public.admin_login_guard('short', 'check', 5, 900);
    raise exception 'FAIL short key accepted';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  begin
    r := public.admin_login_guard(k, 'reset', 5, 900);
    raise exception 'FAIL unknown event accepted';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  -- prune: 오래된 미잠금 행만
  update public.admin_login_locks set updated_at = now() - interval '2 days' where key = 'ip:other-key-0123456789';
  n := public.admin_login_locks_prune(interval '1 day');
  if n <> 1 then raise exception 'FAIL prune count %', n; end if;
end;
$$;

-- 클라이언트 접근 차단
select set_config('request.jwt.claim.sub', '27270000-0000-4000-8000-000000000001', false);
set role authenticated;
do $$
declare r jsonb; n int; denied boolean := false;
begin
  begin r := public.admin_login_guard('ip:client-attempt-0123456789', 'success', 5, 900); exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client could call admin_login_guard'; end if;
  denied := false;
  begin select count(*) into n from public.admin_login_locks; if n >= 0 then denied := false; end if; exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client could read admin_login_locks'; end if;
end;
$$;
reset role;
set role anon;
do $$
declare r jsonb; denied boolean := false;
begin
  begin r := public.admin_login_guard('ip:anon-attempt-0123456789', 'check', 5, 900); exception when others then denied := true; end;
  if not denied then raise exception 'FAIL anon could call admin_login_guard'; end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', false);

select 'ADMIN LOGIN GUARD TESTS PASSED' as result;
