-- admin_accounts_tests.sql (#27)
-- 관리자 계정·역할·세션 RPC 검증 (0033).
--   1) 관리자 계정(app_metadata.bonsim_admin=true)은 public.users 행을 만들지 않는다 · 앱 사용자는 관리자가 될 수 없다
--   2) bootstrap 은 활성 owner 가 없을 때만
--   3) 멤버 관리는 활성 owner 만 · viewer 는 거부 · 마지막 활성 owner 강등/비활성화 거부
--   4) 세션: MFA 뒤 발급 → check 가 역할을 DB 에서 읽음 · 비활성화/강등/취소가 기존 세션에 즉시 반영 · 만료
--   5) 구 로그인 게이트: MFA 완료 멤버가 생기면 닫힌다
--   6) 서버 전용: authenticated 는 테이블도 RPC 도 사용할 수 없다
--   7) (0035) GoTrue createUser 순서(insert → app_metadata update)에서도 관리자 계정에 앱 사용자 행이 남지 않고 관리자 추가가 된다 · 프로필 있는 앱 사용자는 보존 + 거부
\set ON_ERROR_STOP on

do $$
declare
  o1 uuid := 'ad000000-0000-4000-8000-000000000001';
  o2 uuid := 'ad000000-0000-4000-8000-000000000002';
  v1 uuid := 'ad000000-0000-4000-8000-000000000003';
  app uuid := 'ad000000-0000-4000-8000-000000000009';
  r jsonb; sid uuid; sid2 uuid; n int;
begin
  insert into auth.users (id, email, raw_app_meta_data) values
    (o1, 'owner1@admin.test', '{"bonsim_admin":"true"}'),
    (o2, 'owner2@admin.test', '{"bonsim_admin":"true"}'),
    (v1, 'viewer1@admin.test', '{"bonsim_admin":"true"}');
  insert into auth.users (id, phone, phone_confirmed_at) values (app, '821000009301', now());

  -- 1) 관리자 계정은 앱 사용자 행이 없다
  select count(*) into n from public.users where id in (o1, o2, v1);
  if n <> 0 then raise exception 'FAIL admin auth users must not create public.users rows (%)', n; end if;
  if not exists (select 1 from public.users where id = app) then raise exception 'FAIL app user row missing'; end if;

  -- 5) 아직 멤버가 없으면 구 로그인 허용
  if not public.admin_legacy_login_allowed() then raise exception 'FAIL legacy login should be allowed before any MFA member'; end if;

  -- 2) bootstrap
  r := public.admin_member_bootstrap(o1, '첫 운영자');
  if (r->>'ok')::boolean is not true then raise exception 'FAIL bootstrap: %', r; end if;
  r := public.admin_member_bootstrap(o2, '두번째');
  if r->>'reason' is distinct from 'owner_exists' then raise exception 'FAIL bootstrap must refuse when an owner exists: %', r; end if;
  r := public.admin_member_bootstrap('ad000000-0000-4000-8000-0000000000ff', 'x');
  if r->>'reason' is distinct from 'auth_user_not_found' then raise exception 'FAIL bootstrap unknown user: %', r; end if;

  -- 3) 멤버 추가는 owner 만 · 앱 사용자 거부
  r := public.admin_member_add(v1, o2, '두번째', 'owner');
  if r->>'reason' is distinct from 'forbidden' then raise exception 'FAIL non-member cannot add: %', r; end if;
  r := public.admin_member_add(o1, app, '앱사용자', 'viewer');
  if r->>'reason' is distinct from 'app_user_not_allowed' then raise exception 'FAIL app user must not become admin: %', r; end if;
  r := public.admin_member_add(o1, v1, '열람자', 'viewer');
  if (r->>'ok')::boolean is not true then raise exception 'FAIL add viewer: %', r; end if;
  r := public.admin_member_add(v1, o2, '두번째', 'owner');
  if r->>'reason' is distinct from 'forbidden' then raise exception 'FAIL viewer cannot add members: %', r; end if;
  r := public.admin_member_set_role(v1, v1, 'owner');
  if r->>'reason' is distinct from 'forbidden' then raise exception 'FAIL viewer cannot promote self: %', r; end if;
  r := public.admin_member_add(o1, v1, '열람자', 'viewer');
  if r->>'reason' is distinct from 'already_member' then raise exception 'FAIL duplicate add: %', r; end if;

  -- 마지막 활성 owner 보호
  r := public.admin_member_set_role(o1, o1, 'viewer');
  if r->>'reason' is distinct from 'last_owner' then raise exception 'FAIL last owner demote must be refused: %', r; end if;
  r := public.admin_member_set_status(o1, o1, 'disabled');
  if r->>'reason' is distinct from 'last_owner' then raise exception 'FAIL last owner disable must be refused: %', r; end if;
  -- owner 가 둘이면 하나는 강등 가능
  r := public.admin_member_add(o1, o2, '두번째', 'owner');
  if (r->>'ok')::boolean is not true then raise exception 'FAIL add owner2: %', r; end if;
  r := public.admin_member_set_role(o1, o2, 'viewer');
  if (r->>'changed')::boolean is not true then raise exception 'FAIL demote owner2: %', r; end if;
  r := public.admin_member_set_role(o1, o1, 'viewer');
  if r->>'reason' is distinct from 'last_owner' then raise exception 'FAIL o1 is last owner again: %', r; end if;
  r := public.admin_member_set_role(o1, o2, 'owner');
  if (r->>'changed')::boolean is not true then raise exception 'FAIL promote owner2 back: %', r; end if;

  -- 4) 세션
  r := public.admin_session_issue(v1, 3600);
  if (r->>'ok')::boolean is not true or r->>'role' <> 'viewer' then raise exception 'FAIL issue viewer session: %', r; end if;
  sid := (r->>'session_id')::uuid;
  if not exists (select 1 from public.admin_members where user_id = v1 and mfa_verified_at is not null) then
    raise exception 'FAIL session issue must record mfa_verified_at';
  end if;
  -- 5) MFA 완료 멤버가 생겼으니 구 로그인 닫힘
  if public.admin_legacy_login_allowed() then raise exception 'FAIL legacy login must close after first MFA login'; end if;

  r := public.admin_session_check(sid);
  if (r->>'ok')::boolean is not true or r->>'role' <> 'viewer' or r->>'user_id' <> v1::text then raise exception 'FAIL check: %', r; end if;
  -- 역할은 DB 에서: 승격하면 같은 세션이 owner 로 보인다 (쿠키 변경 없음)
  perform public.admin_member_set_role(o1, v1, 'owner');
  r := public.admin_session_check(sid);
  if r->>'role' <> 'owner' then raise exception 'FAIL role must come from DB per request: %', r; end if;
  perform public.admin_member_set_role(o1, v1, 'viewer');
  r := public.admin_session_check(sid);
  if r->>'role' <> 'viewer' then raise exception 'FAIL demotion must reflect on existing session: %', r; end if;
  -- 비활성화 → 기존 세션 거부
  r := public.admin_member_set_status(o1, v1, 'disabled');
  if (r->>'ok')::boolean is not true then raise exception 'FAIL disable viewer: %', r; end if;
  r := public.admin_session_check(sid);
  if (r->>'ok')::boolean is not false or r->>'reason' not in ('revoked', 'member_inactive') then raise exception 'FAIL disabled member session must be refused: %', r; end if;
  r := public.admin_session_issue(v1, 3600);
  if r->>'reason' is distinct from 'not_active' then raise exception 'FAIL disabled member cannot get a session: %', r; end if;
  -- 재활성화해도 이전 세션은 여전히 취소 상태 (revoked_at)
  perform public.admin_member_set_status(o1, v1, 'active');
  r := public.admin_session_check(sid);
  if (r->>'ok')::boolean is not false then raise exception 'FAIL old session must stay revoked after re-enable: %', r; end if;
  -- 세션 취소 (본인) → 이전 발급분만 무효, 이후 발급분은 유효
  r := public.admin_session_issue(v1, 3600); sid := (r->>'session_id')::uuid;
  perform pg_sleep(0.01);
  r := public.admin_member_revoke_sessions(v1, v1, 'self');
  if (r->>'ok')::boolean is not true then raise exception 'FAIL self revoke: %', r; end if;
  if (public.admin_session_check(sid)->>'ok')::boolean then raise exception 'FAIL revoked session accepted'; end if;
  perform pg_sleep(0.01);
  r := public.admin_session_issue(v1, 3600); sid2 := (r->>'session_id')::uuid;
  if not (public.admin_session_check(sid2)->>'ok')::boolean then raise exception 'FAIL session issued after revoke must be valid'; end if;
  -- viewer 는 남의 세션을 취소할 수 없다
  r := public.admin_member_revoke_sessions(v1, o1, 'x');
  if r->>'reason' is distinct from 'forbidden' then raise exception 'FAIL viewer revoking others: %', r; end if;
  -- 단일 세션 로그아웃 · 만료
  if not public.admin_session_revoke(sid2) then raise exception 'FAIL session revoke'; end if;
  if public.admin_session_revoke(sid2) then raise exception 'FAIL double revoke should be false'; end if;
  r := public.admin_session_issue(v1, 60); sid := (r->>'session_id')::uuid;
  update public.admin_sessions set expires_at = now() - interval '1 second' where id = sid;
  if public.admin_session_check(sid)->>'reason' is distinct from 'expired' then raise exception 'FAIL expired session'; end if;
  if (public.admin_session_check('ad000000-0000-4000-8000-0000000000aa')->>'reason') is distinct from 'not_found' then raise exception 'FAIL unknown session'; end if;
  -- 잘못된 TTL 거부
  begin
    perform public.admin_session_issue(v1, 999999);
    raise exception 'FAIL ttl bound';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if;
  end;

  -- 감사 기록의 actor 는 uuid (표시 이름은 detail)
  select count(*) into n from public.admin_audit_log where actor = o1::text and action in ('admin_member_add', 'admin_member_role', 'admin_member_status');
  if n < 5 then raise exception 'FAIL audit rows keyed by actor uuid: %', n; end if;

  -- prune
  update public.admin_sessions set revoked_at = now() - interval '8 days' where id = sid2;
  select public.admin_sessions_prune() into n;
  if n < 1 then raise exception 'FAIL prune'; end if;

  -- 정리 (cascade)
  delete from auth.users where id in (o1, o2, v1, app);
  select count(*) into n from public.admin_members;
  if n <> 0 then raise exception 'FAIL cascade'; end if;
  raise notice 'admin accounts fixture tests passed';
end;
$$;

-- 6) 서버 전용
select set_config('request.jwt.claim.sub', 'ad000000-0000-4000-8000-000000000009', false);
set role authenticated;
do $$
declare n int; denied boolean;
begin
  foreach n in array array[1] loop null; end loop;
  begin
    select count(*) into n from public.admin_members;
    if n <> 0 then raise exception 'FAIL admin_members visible'; end if;
  exception when insufficient_privilege then null;
  end;
  denied := false;
  begin
    insert into public.admin_members (user_id, display_name, role) values ('ad000000-0000-4000-8000-000000000009', 'me', 'owner');
  exception when others then denied := true;
  end;
  if not denied then raise exception 'FAIL client inserted admin_members'; end if;
  denied := false;
  begin
    perform public.admin_member_bootstrap('ad000000-0000-4000-8000-000000000009', 'me');
  exception when others then denied := true;
  end;
  if not denied then raise exception 'FAIL client ran admin_member_bootstrap'; end if;
  denied := false;
  begin
    perform public.admin_session_issue('ad000000-0000-4000-8000-000000000009', 3600);
  exception when others then denied := true;
  end;
  if not denied then raise exception 'FAIL client ran admin_session_issue'; end if;
  denied := false;
  begin
    perform public.admin_legacy_login_allowed();
  exception when others then denied := true;
  end;
  if not denied then raise exception 'FAIL client ran admin_legacy_login_allowed'; end if;
  raise notice 'admin accounts RLS tests passed';
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', false);

-- 7) (0035) 실제 GoTrue createUser 순서 재현: auth.users insert(표식 없음) → 같은 트랜잭션에서 raw_app_meta_data update(bonsim_admin=true)
--    → 관리자 계정에 public.users 행이 남지 않는다. 기존 앱 사용자(프로필 있음)에 표식이 붙어도 행은 지워지지 않는다.
--    이 블록은 앞 테스트가 남긴 계정(1)~5)는 끝에서 모두 지운다)이나 실행 순서에 기대지 않는다 — 필요한 활성 owner(g0)를 직접 만들고 끝에서 정리한다.
do $$
declare
  g0 uuid := 'ad000000-0000-4000-8000-000000000030'; -- 이 블록 전용 활성 owner (actor)
  g1 uuid := 'ad000000-0000-4000-8000-000000000031';
  g2 uuid := 'ad000000-0000-4000-8000-000000000032';
  r jsonb; n int;
begin
  -- 재실행·부분 실패 잔재로 인한 id/email/phone 충돌 방지 (auth.users cascade → public.users · profiles · admin_members)
  delete from auth.users where id in (g0, g1, g2);

  -- actor: 표식과 함께 insert 된 관리자 계정(앱 사용자 행 없음) + 직접 membership. bootstrap 은 다른 활성 owner 가 있으면 거부하므로 쓰지 않는다
  insert into auth.users (id, email, raw_app_meta_data) values (g0, 'gotrue-owner@admin.test', '{"bonsim_admin":"true"}');
  if exists (select 1 from public.users where id = g0) then raise exception 'FAIL precondition: marked owner must not have an app user row'; end if;
  insert into public.admin_members (user_id, display_name, role, status) values (g0, '0035 owner', 'owner', 'active');
  if not public.admin_actor_is_owner(g0) then raise exception 'FAIL precondition: g0 must be an active owner'; end if;

  insert into auth.users (id, email) values (g1, 'gotrue-admin@admin.test');          -- GoTrue: insert (provider 만)
  if not exists (select 1 from public.users where id = g1) then raise exception 'FAIL precondition: insert without marker creates app row'; end if;
  update auth.users set raw_app_meta_data = '{"provider":"email","providers":["email"],"bonsim_admin":"true"}' where id = g1; -- GoTrue: app_metadata update
  if exists (select 1 from public.users where id = g1) then raise exception 'FAIL 0035: admin marker applied after insert must remove the fresh app user row'; end if;
  if exists (select 1 from public.subscriptions where user_id = g1) then raise exception 'FAIL 0035: subscriptions row must cascade'; end if;
  r := public.admin_member_add(g0, g1, 'GoTrue 생성 관리자', 'viewer');
  if (r->>'ok')::boolean is not true then raise exception 'FAIL 0035: GoTrue-created admin must be addable: %', r; end if;
  if not exists (select 1 from public.admin_members where user_id = g1 and role = 'viewer' and status = 'active' and created_by = g0) then
    raise exception 'FAIL 0035: GoTrue-created admin must be an active viewer member';
  end if;

  -- 기존 앱 사용자(온보딩 진행 중, 프로필 있음)에 표식을 붙여도 데이터는 보존된다 (그리고 여전히 관리자가 될 수 없다)
  insert into auth.users (id, phone, phone_confirmed_at) values (g2, '821000009302', now());
  insert into public.profiles (user_id, nickname, birth_year, gender, seeking_gender, region_code, height_cm, job_group, smoking, drinking)
  values (g2, '앱사용자', 1995, 'male', 'female', 'seoul', 175, 'it', 'none', 'sometimes');
  update auth.users set raw_app_meta_data = '{"bonsim_admin":"true"}' where id = g2;
  if not exists (select 1 from public.users where id = g2) then raise exception 'FAIL 0035: existing app user with profile must keep its row'; end if;
  if not exists (select 1 from public.profiles where user_id = g2 and nickname = '앱사용자') then raise exception 'FAIL 0035: existing app user profile must be preserved'; end if;
  if not exists (select 1 from public.subscriptions where user_id = g2) then raise exception 'FAIL 0035: existing app user subscription must be preserved'; end if;
  r := public.admin_member_add(g0, g2, 'x', 'viewer');
  if r->>'reason' is distinct from 'app_user_not_allowed' then raise exception 'FAIL 0035: marked app user still must not become admin: %', r; end if;

  -- 정리 (cascade) — 뒤 테스트에 관리자 membership 을 남기지 않는다
  delete from auth.users where id in (g0, g1, g2);
  select count(*) into n from public.admin_members where user_id in (g0, g1, g2);
  if n <> 0 then raise exception 'FAIL 0035 cleanup: admin_members left (%)', n; end if;
  select count(*) into n from public.users where id in (g0, g1, g2);
  if n <> 0 then raise exception 'FAIL 0035 cleanup: public.users left (%)', n; end if;
  raise notice 'admin accounts 0035 (GoTrue metadata order) tests passed';
end;
$$;

select 'ADMIN ACCOUNTS TESTS PASSED' as result;
