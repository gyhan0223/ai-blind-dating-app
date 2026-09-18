-- identity_sessions_tests.sql (#6)
-- identity_verification_sessions 가 verifyIdentityCore 의 조건부 갱신 의미를 실제 DB 에서 지키는지 검증한다.
--   1) 서버 전용 (authenticated/anon 은 행을 볼 수도 만들 수도 없다 · prune RPC 실행 불가)
--   2) 점유(claim) 조건부 갱신: 소유자·pending(또는 lease 지난 checking)·만료 전 일 때만 1행, 그 외 0행
--   3) 상태 전이 조건부 갱신 (expectStatus): 다른 상태면 0행
--   4) 계정 삭제 cascade · prune
--   5) relink 는 user_id is null 인 행만 (0행 = 경쟁 패배), user_id UNIQUE 로 한 계정에 두 identity 불가
-- local_supabase_mock.sql + 전체 마이그레이션 적용 후 실행. 실패 시 예외.

\set ON_ERROR_STOP on

do $$
declare
  u1 uuid := 'c0ffee00-0000-4000-8000-000000000001';
  u2 uuid := 'c0ffee00-0000-4000-8000-000000000002';
  sid uuid;
  sid2 uuid;
  n int;
  st text;
  idn uuid;
begin
  insert into auth.users (id, phone, phone_confirmed_at) values (u1, '821000009101', now()), (u2, '821000009102', now());

  -- 2) claim: 소유자 + pending + 만료 전 → 1행 (checking)
  insert into public.identity_verification_sessions (user_id, provider, provider_session_id, expires_at)
  values (u1, 'test', 'prov-1', now() + interval '10 minutes') returning id into sid;

  update public.identity_verification_sessions set status = 'checking', checking_since = now()
   where id = sid and user_id = u2 and expires_at > now()
     and (status = 'pending' or (status = 'checking' and checking_since < now() - interval '120 seconds'));
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL claim by another user should update 0 rows, got %', n; end if;

  update public.identity_verification_sessions set status = 'checking', checking_since = now()
   where id = sid and user_id = u1 and expires_at > now()
     and (status = 'pending' or (status = 'checking' and checking_since < now() - interval '120 seconds'));
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL owner claim should update 1 row, got %', n; end if;

  -- 같은 세션 두 번째 점유 (lease 안) → 0행
  update public.identity_verification_sessions set status = 'checking', checking_since = now()
   where id = sid and user_id = u1 and expires_at > now()
     and (status = 'pending' or (status = 'checking' and checking_since < now() - interval '120 seconds'));
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL second claim within lease should update 0 rows, got %', n; end if;

  -- lease 지난 checking → 재점유 1행
  update public.identity_verification_sessions set checking_since = now() - interval '121 seconds' where id = sid;
  update public.identity_verification_sessions set status = 'checking', checking_since = now()
   where id = sid and user_id = u1 and expires_at > now()
     and (status = 'pending' or (status = 'checking' and checking_since < now() - interval '120 seconds'));
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL stale checking should be reclaimable, got %', n; end if;

  -- 3) expectStatus 조건부 전이: checking → completed 는 1행, 다시 checking 기준으로 pending 은 0행
  update public.identity_verification_sessions set status = 'completed', outcome = 'created', consumed_at = now(), checking_since = null
   where id = sid and status = 'checking';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL checking→completed should update 1 row'; end if;
  update public.identity_verification_sessions set status = 'pending' where id = sid and status = 'checking';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL completed session must not go back to pending via checking guard'; end if;

  -- 만료된 pending 은 점유 불가
  insert into public.identity_verification_sessions (user_id, provider, provider_session_id, expires_at)
  values (u1, 'test', 'prov-2', now() - interval '1 second') returning id into sid2;
  update public.identity_verification_sessions set status = 'checking', checking_since = now()
   where id = sid2 and user_id = u1 and expires_at > now()
     and (status = 'pending' or (status = 'checking' and checking_since < now() - interval '120 seconds'));
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL expired session must not be claimable'; end if;

  -- 잘못된 status/outcome 값은 거부
  begin
    update public.identity_verification_sessions set status = 'verified' where id = sid;
    raise exception 'FAIL invalid status accepted';
  exception when check_violation then null;
  end;

  -- 5) relink: user_id is null 행만. 한 계정에 두 identity 는 UNIQUE(user_id) 가 막는다
  insert into public.user_identities (user_id, identity_key_hash) values (null, 'session-test-orphan-hash') returning id into idn;
  update public.user_identities set user_id = u1 where id = idn and user_id is null;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL relink of orphan identity should update 1 row'; end if;
  update public.user_identities set user_id = u2 where id = idn and user_id is null;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL relink of already-linked identity should update 0 rows (race loser)'; end if;
  begin
    insert into public.user_identities (user_id, identity_key_hash) values (u1, 'session-test-second-hash');
    raise exception 'FAIL one account linked to two identities';
  exception when unique_violation then null;
  end;

  -- 4) cascade: 계정 삭제 → 세션 삭제, identity 는 user_id null 로 남음
  delete from auth.users where id = u1;
  select count(*) into n from public.identity_verification_sessions where user_id = u1;
  if n <> 0 then raise exception 'FAIL sessions not removed on user delete: %', n; end if;
  select user_id::text into st from public.user_identities where id = idn;
  if st is not null then raise exception 'FAIL identity user_id should be null after user delete'; end if;

  -- prune: (만료 + keep) 지난 세션은 상태와 무관하게 삭제, 최근 세션(완료·pending)은 유지
  --   (updated_at 은 touch 트리거가 항상 now() 로 덮으므로 여기서는 expires_at 경로로 검증한다)
  insert into public.identity_verification_sessions (user_id, provider, expires_at, status)
  values (u2, 'test', now() - interval '2 days', 'completed');
  insert into public.identity_verification_sessions (user_id, provider, expires_at, status)
  values (u2, 'test', now() + interval '10 minutes', 'completed');
  insert into public.identity_verification_sessions (user_id, provider, expires_at) values (u2, 'test', now() + interval '10 minutes');
  select public.identity_verification_sessions_prune(interval '1 day') into n;
  if n <> 1 then raise exception 'FAIL prune expected 1 row, got %', n; end if;
  select count(*) into n from public.identity_verification_sessions where user_id = u2;
  if n <> 2 then raise exception 'FAIL prune removed recent sessions (left %)', n; end if;

  delete from auth.users where id = u2;
  delete from public.user_identities where identity_key_hash = 'session-test-orphan-hash';
  raise notice 'identity sessions fixture tests passed';
end;
$$;

-- 1) 서버 전용: authenticated 는 0행 / 쓰기 거부 / prune 실행 불가
select set_config('request.jwt.claim.sub', 'c0ffee00-0000-4000-8000-000000000009', false);
set role authenticated;
do $$
declare n int; denied boolean := false;
begin
  begin
    select count(*) into n from public.identity_verification_sessions;
    if n <> 0 then raise exception 'FAIL identity_verification_sessions visible to client: %', n; end if;
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.identity_verification_sessions (user_id, provider, expires_at)
    values ('c0ffee00-0000-4000-8000-000000000009', 'test', now() + interval '10 minutes');
  exception when others then denied := true;
  end;
  if not denied then raise exception 'FAIL client could insert identity_verification_sessions'; end if;
  denied := false;
  begin
    perform public.identity_verification_sessions_prune();
  exception when others then denied := true;
  end;
  if not denied then raise exception 'FAIL client could run identity_verification_sessions_prune'; end if;
  raise notice 'identity sessions RLS tests passed';
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', false);

select 'IDENTITY SESSIONS TESTS PASSED' as result;
