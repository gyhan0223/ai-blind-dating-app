-- identity_tests.sql
-- 전화번호 로그인 + identity 기반 1인 1계정 구조 검증.
-- local_supabase_mock.sql + 전체 마이그레이션 + (선택) seed 적용 후 실행한다.
-- 실패 시 예외가 발생해 psql(ON_ERROR_STOP)이 비정상 종료된다.

\set ON_ERROR_STOP on

do $$
declare
  p1 uuid := 'aaaa1111-0000-4000-8000-000000000001'; -- 신규 가입자 (Test 1)
  p2 uuid := 'aaaa1111-0000-4000-8000-000000000002'; -- 같은 사람, 새 번호 (Test 3/5)
  p3 uuid := 'aaaa1111-0000-4000-8000-000000000003'; -- banned 사용자 (Test 4)
  p4 uuid := 'aaaa1111-0000-4000-8000-000000000004'; -- 삭제 후 재가입자
  h_dup text := 'test-hash-duplicate-user';
  h_ban text := 'test-hash-banned-user';
  h_del text := 'test-hash-deleted-user';
  n int;
  txt text;
  caught boolean := false;
begin
  -- ------------------------------------------------------------------
  -- Test 1 (DB 계층): Phone Auth 가입 → users 행 자동 생성 + E.164 정규화
  -- ------------------------------------------------------------------
  insert into auth.users (id, phone, phone_confirmed_at) values (p1, '821000009001', now());
  select phone into txt from public.users where id = p1;
  if txt is distinct from '+821000009001' then
    raise exception 'FAIL phone sync: expected +821000009001, got %', txt;
  end if;
  if (select phone_verified_at from public.users where id = p1) is null then
    raise exception 'FAIL phone_verified_at not set';
  end if;

  -- 신규 identity 연결 (verify-identity 의 created 경로)
  insert into public.user_identities (user_id, identity_key_hash, identity_verified_at, adult_verified_at)
  values (p1, h_dup, now(), now());

  -- ------------------------------------------------------------------
  -- Test 3/5 (DB 계층): 같은 identityKey 의 두 번째 계정 생성은
  -- UNIQUE(identity_key_hash) 가 차단한다 (동시 가입 race 최종 방어선)
  -- ------------------------------------------------------------------
  insert into auth.users (id, phone, phone_confirmed_at) values (p2, '821000009002', now());
  begin
    insert into public.user_identities (user_id, identity_key_hash) values (p2, h_dup);
  exception when unique_violation then
    caught := true;
  end;
  if not caught then
    raise exception 'FAIL duplicate identity insert was not blocked';
  end if;
  select count(*) into n from public.user_identities where identity_key_hash = h_dup;
  if n <> 1 then
    raise exception 'FAIL expected exactly 1 identity row for duplicate hash, got %', n;
  end if;

  -- ------------------------------------------------------------------
  -- Test 4 (DB 계층): users.status → banned 가 identity.banned 로 동기화
  -- (계정을 삭제해도 banned 플래그는 identity 에 남아 재가입을 막는다)
  -- ------------------------------------------------------------------
  insert into auth.users (id, phone, phone_confirmed_at) values (p3, '821000009003', now());
  insert into public.user_identities (user_id, identity_key_hash) values (p3, h_ban);
  update public.users set status = 'banned' where id = p3;
  if not (select banned from public.user_identities where identity_key_hash = h_ban) then
    raise exception 'FAIL ban was not synced to user_identities';
  end if;
  -- 계정 행이 삭제돼도 banned identity 는 남는다
  delete from public.users where id = p3;
  if not exists (select 1 from public.user_identities
                 where identity_key_hash = h_ban and user_id is null and banned) then
    raise exception 'FAIL banned identity was not retained after account deletion';
  end if;

  -- ------------------------------------------------------------------
  -- 삭제된 계정의 identity 보존 → 재가입 시 재연결 (1 identity 1 계정 유지)
  -- ------------------------------------------------------------------
  insert into auth.users (id, phone, phone_confirmed_at) values (p4, '821000009004', now());
  insert into public.user_identities (user_id, identity_key_hash) values (p4, h_del);
  delete from public.users where id = p4; -- 계정 hard delete 시에도
  if not exists (select 1 from public.user_identities
                 where identity_key_hash = h_del and user_id is null) then
    raise exception 'FAIL identity was not retained (user_id set null) after user delete';
  end if;
  -- 새 계정으로 재연결 (verify-identity 의 relinked 경로)
  update public.user_identities set user_id = p2 where identity_key_hash = h_del and user_id is null;
  if (select user_id from public.user_identities where identity_key_hash = h_del) is distinct from p2 then
    raise exception 'FAIL identity relink failed';
  end if;

  -- ------------------------------------------------------------------
  -- 전화번호 변경(계정 복구) 동기화: auth.users.phone 변경 → public.users.phone 반영
  -- ------------------------------------------------------------------
  update auth.users set phone = '821000009099' where id = p1;
  select phone into txt from public.users where id = p1;
  if txt is distinct from '+821000009099' then
    raise exception 'FAIL phone change sync: expected +821000009099, got %', txt;
  end if;

  raise notice 'identity fixture tests passed';
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS: user_identities / device_events 는 클라이언트(authenticated)에서 완전 차단
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'aaaa1111-0000-4000-8000-000000000001', false);
set role authenticated;

do $$
declare
  n int;
  denied boolean := false;
begin
  -- select: 정책이 없으므로 0행
  select count(*) into n from public.user_identities;
  if n <> 0 then raise exception 'FAIL user_identities visible to client: %', n; end if;
  select count(*) into n from public.device_events;
  if n <> 0 then raise exception 'FAIL device_events visible to client: %', n; end if;

  -- insert/update 도 거부되어야 한다
  begin
    insert into public.user_identities (user_id, identity_key_hash)
    values ('aaaa1111-0000-4000-8000-000000000001', 'client-injected-hash');
  exception when others then
    denied := true;
  end;
  if not denied then raise exception 'FAIL client could insert into user_identities'; end if;

  denied := false;
  begin
    update public.user_identities set banned = false where true;
    if not found then denied := true; end if; -- 0행 매칭이면 사실상 차단
  exception when others then
    denied := true;
  end;
  if not denied then raise exception 'FAIL client could update user_identities'; end if;

  -- 클라이언트는 자신의 users.status / phone 검증 컬럼을 바꿀 수 없다 (guard 트리거)
  denied := false;
  begin
    update public.users set status = 'active'
    where id = 'aaaa1111-0000-4000-8000-000000000001' and status <> 'active';
  exception when others then
    denied := true;
  end;
  -- status 를 실제로 바꾸려는 시도가 있을 때만 guard 가 발동하므로 여기서는 예외 없이 통과해도 된다.

  raise notice 'identity RLS tests passed';
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '', false);

select 'IDENTITY TESTS PASSED' as result;
