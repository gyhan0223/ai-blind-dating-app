-- face_liveness_tests.sql
-- Didit 라이브니스 연동(0013_face_liveness.sql) 검증 — 제약 · RLS · 상태 전이 보호 · 세션 rate limit RPC.
-- local_supabase_mock.sql + 전체 마이그레이션 적용 후 실행한다.
-- 실패 시 예외가 발생해 psql(ON_ERROR_STOP)이 비정상 종료된다.
--
-- 실제 얼굴 이미지/실사용자 데이터는 사용하지 않는다 (uuid fixture 만).

\set ON_ERROR_STOP on

-- 서버 컨텍스트 (JWT 없음)
select set_config('request.jwt.claim.sub', '', false);
reset role;

-- ---------------------------------------------------------------------------
-- 픽스처
-- ---------------------------------------------------------------------------
do $$
declare
  fa uuid := '55555555-5555-5555-5555-555555555555';
  fb uuid := '66666666-6666-6666-6666-666666666666';
begin
  insert into auth.users (id, email) values (fa, 'face-a@test.dev'), (fb, 'face-b@test.dev');
end;
$$;

-- ---------------------------------------------------------------------------
-- 1) 클라이언트는 행을 만들 수 없다 (insert 정책 제거 + 트리거)
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', false);
set role authenticated;

do $$
declare
  denied boolean := false;
  fa uuid := '55555555-5555-5555-5555-555555555555';
begin
  begin
    insert into public.face_verifications (user_id, status) values (fa, 'pending');
  exception when others then
    denied := true;
  end;
  if not denied then raise exception 'FAIL client could insert face_verifications row'; end if;

  denied := false;
  begin
    insert into public.face_verifications (user_id, status, liveness_passed) values (fa, 'approved', true);
  exception when others then
    denied := true;
  end;
  if not denied then raise exception 'FAIL client could insert approved row'; end if;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '', false);

-- ---------------------------------------------------------------------------
-- 2) 서버 생성 + 제약: provider_session_id UNIQUE, 점수 범위, approved 는 liveness_passed 필수, reference_path 범위
-- ---------------------------------------------------------------------------
do $$
declare
  fa uuid := '55555555-5555-5555-5555-555555555555';
  fb uuid := '66666666-6666-6666-6666-666666666666';
  denied boolean;
  row_id uuid;
begin
  insert into public.face_verifications (user_id, status, provider, provider_session_id, expires_at)
  values (fa, 'pending', 'didit', 'didit-sess-a-1', now() + interval '30 minutes')
  returning id into row_id;

  -- 같은 provider session id 는 다른 사용자에게도 붙일 수 없다
  denied := false;
  begin
    insert into public.face_verifications (user_id, status, provider, provider_session_id)
    values (fb, 'pending', 'didit', 'didit-sess-a-1');
  exception when unique_violation then
    denied := true;
  end;
  if not denied then raise exception 'FAIL duplicate provider_session_id allowed'; end if;

  -- 점수 범위
  denied := false;
  begin
    update public.face_verifications set liveness_score = 150 where id = row_id;
  exception when check_violation then
    denied := true;
  end;
  if not denied then raise exception 'FAIL liveness_score > 100 allowed'; end if;

  -- provider 세션 행은 liveness_passed 없이 approved 가 될 수 없다
  denied := false;
  begin
    update public.face_verifications set status = 'approved' where id = row_id;
  exception when check_violation then
    denied := true;
  end;
  if not denied then raise exception 'FAIL approved without liveness_passed allowed'; end if;

  -- reference_path 는 <user_id>/liveness/ 아래만
  denied := false;
  begin
    update public.face_verifications set reference_path = fb::text || '/liveness/reference.jpg' where id = row_id;
  exception when check_violation then
    denied := true;
  end;
  if not denied then raise exception 'FAIL reference_path outside own liveness folder allowed'; end if;

  denied := false;
  begin
    update public.face_verifications set reference_path = fa::text || '/front.jpg' where id = row_id;
  exception when check_violation then
    denied := true;
  end;
  if not denied then raise exception 'FAIL reference_path outside liveness folder allowed'; end if;

  update public.face_verifications set reference_path = fa::text || '/liveness/reference.jpg' where id = row_id;

  -- 알 수 없는 상태 값 거부
  denied := false;
  begin
    update public.face_verifications set status = 'verified' where id = row_id;
  exception when check_violation then
    denied := true;
  end;
  if not denied then raise exception 'FAIL unknown status allowed'; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) RLS: 본인 행만 조회 가능, 갱신은 불가 (정책 없음 → 0 rows, 값 불변)
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', false);
set role authenticated;

do $$
declare
  n int;
  st text;
begin
  select count(*) into n from public.face_verifications where provider_session_id = 'didit-sess-a-1';
  if n <> 1 then raise exception 'FAIL owner cannot read own face_verifications row'; end if;

  -- 클라이언트가 자기 행을 approved 로 바꾸려는 시도 → 아무 행도 갱신되지 않는다
  begin
    update public.face_verifications
       set status = 'approved', liveness_passed = true
     where provider_session_id = 'didit-sess-a-1';
  exception when others then
    null; -- 트리거가 거부해도 정상
  end;
  select status into st from public.face_verifications where provider_session_id = 'didit-sess-a-1';
  if st <> 'pending' then raise exception 'FAIL client changed status to %', st; end if;

  -- 삭제도 불가
  begin
    delete from public.face_verifications where provider_session_id = 'didit-sess-a-1';
  exception when others then
    null;
  end;
  select count(*) into n from public.face_verifications where provider_session_id = 'didit-sess-a-1';
  if n <> 1 then raise exception 'FAIL client deleted face_verifications row'; end if;

  -- RPC 는 클라이언트가 호출할 수 없다
  begin
    perform public.face_liveness_begin_session('55555555-5555-5555-5555-555555555555'::uuid);
    raise exception 'FAIL client could call face_liveness_begin_session';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

reset role;

-- 다른 사용자(B) 관점: A 의 행이 보이지 않는다
select set_config('request.jwt.claim.sub', '66666666-6666-6666-6666-666666666666', false);
set role authenticated;

do $$
declare
  n int;
begin
  select count(*) into n from public.face_verifications;
  if n <> 0 then raise exception 'FAIL other user face_verifications leaked (%)', n; end if;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '', false);

-- ---------------------------------------------------------------------------
-- 4) 상태 전이 보호 (service role 갱신)
-- ---------------------------------------------------------------------------
do $$
declare
  fa uuid := '55555555-5555-5555-5555-555555555555';
  row_id uuid;
  denied boolean;
  vat timestamptz;
  t1 timestamptz := now() - interval '10 minutes';
  t2 timestamptz := now() - interval '5 minutes';
begin
  select id into row_id from public.face_verifications where provider_session_id = 'didit-sess-a-1';

  -- in_review 로 갔다가 (t1) 승인 (t2)
  update public.face_verifications
     set status = 'in_review', provider_status = 'In Review', provider_event_at = t1
   where id = row_id;

  update public.face_verifications
     set status = 'approved', liveness_passed = true, liveness_score = 97.5,
         provider_status = 'Approved', provider_event_at = t2
   where id = row_id;

  select verified_at into vat from public.face_verifications where id = row_id;
  if vat is null then raise exception 'FAIL verified_at not set on approval'; end if;

  -- 오래된 이벤트(t1)로 rejected 되돌리기 → 거부
  denied := false;
  begin
    update public.face_verifications
       set status = 'rejected', provider_status = 'Declined', provider_event_at = t1
     where id = row_id;
  exception when others then
    denied := true;
  end;
  if not denied then raise exception 'FAIL stale event reverted approval'; end if;

  -- 최신 이벤트라도 approved → pending/rejected/in_review 는 거부
  denied := false;
  begin
    update public.face_verifications set status = 'pending', provider_event_at = now() where id = row_id;
  exception when others then
    denied := true;
  end;
  if not denied then raise exception 'FAIL approved reverted to pending'; end if;

  denied := false;
  begin
    update public.face_verifications set status = 'rejected', provider_event_at = now() where id = row_id;
  exception when others then
    denied := true;
  end;
  if not denied then raise exception 'FAIL approved reverted to rejected'; end if;

  -- liveness_passed 해제 / verified_at 제거 / session id 변경 거부
  denied := false;
  begin
    update public.face_verifications set liveness_passed = false where id = row_id;
  exception when others then
    denied := true;
  end;
  if not denied then raise exception 'FAIL liveness_passed cleared'; end if;

  denied := false;
  begin
    update public.face_verifications set verified_at = null where id = row_id;
  exception when others then
    denied := true;
  end;
  if not denied then raise exception 'FAIL verified_at cleared'; end if;

  denied := false;
  begin
    update public.face_verifications set provider_session_id = 'didit-sess-a-2' where id = row_id;
  exception when others then
    denied := true;
  end;
  if not denied then raise exception 'FAIL provider_session_id changed after attach'; end if;

  -- 같은 이벤트 재전송(같은 provider_event_at)은 값이 같으면 허용 (멱등)
  update public.face_verifications
     set status = 'approved', provider_status = 'Approved', provider_event_at = t2
   where id = row_id;

  -- pending 행에서 오래된 이벤트도 거부 (approved 가 아니어도 out-of-order 보호)
  insert into public.face_verifications (user_id, status, provider, provider_session_id, provider_event_at)
  values (fa, 'pending', 'didit', 'didit-sess-a-order', t2);
  denied := false;
  begin
    update public.face_verifications
       set status = 'in_review', provider_event_at = t1
     where provider_session_id = 'didit-sess-a-order';
  exception when others then
    denied := true;
  end;
  if not denied then raise exception 'FAIL stale event applied to pending row'; end if;

  -- 운영 override 로만 되돌릴 수 있다
  perform set_config('app.face_verification_override', 'on', true);
  update public.face_verifications set status = 'rejected', provider_reason = 'admin_revoked' where id = row_id;
  perform set_config('app.face_verification_override', '', true);
  -- 테스트 정리: 다시 approved 로 (rejected → approved 는 허용)
  update public.face_verifications set status = 'approved', provider_event_at = now() where id = row_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) 세션 생성 RPC — 재사용 / rate limit / already_verified
-- ---------------------------------------------------------------------------
do $$
declare
  fb uuid := '66666666-6666-6666-6666-666666666666';
  res jsonb;
  first_id uuid;
  n int;
  i int;
begin
  -- 첫 요청 → create (pending 행 생성, attempt_count 1)
  res := public.face_liveness_begin_session(fb, 'didit', 5, 10, 60);
  if res->>'action' <> 'create' then raise exception 'FAIL first begin should create: %', res; end if;
  first_id := (res->>'id')::uuid;
  select attempt_count into n from public.face_verifications where id = first_id;
  if n <> 1 then raise exception 'FAIL attempt_count expected 1 got %', n; end if;

  -- Provider 세션이 붙기 전(방금 만든 행)에는 재사용 대상이 아니다 → 새 행 (rate limit 안에서)
  res := public.face_liveness_begin_session(fb, 'didit', 5, 10, 60);
  if res->>'action' <> 'create' then raise exception 'FAIL begin without attached session should create: %', res; end if;
  -- 이전 행은 그대로 pending(2분 미경과)
  select count(*) into n from public.face_verifications where user_id = fb and status = 'pending';
  if n <> 2 then raise exception 'FAIL expected 2 pending rows got %', n; end if;

  -- Provider 세션 부착 → 유효 기간 안에는 reuse
  update public.face_verifications
     set provider_session_id = 'didit-sess-b-1', expires_at = now() + interval '30 minutes'
   where id = (res->>'id')::uuid;
  res := public.face_liveness_begin_session(fb, 'didit', 5, 10, 60);
  if res->>'action' <> 'reuse' or res->>'provider_session_id' <> 'didit-sess-b-1' then
    raise exception 'FAIL valid pending session should be reused: %', res;
  end if;

  -- 만료 임박(60초 margin 안) 이면 재사용하지 않고 새로 만든다 + 만료 행 정리
  update public.face_verifications set expires_at = now() + interval '30 seconds'
   where provider_session_id = 'didit-sess-b-1';
  res := public.face_liveness_begin_session(fb, 'didit', 5, 10, 60);
  if res->>'action' <> 'create' then raise exception 'FAIL near-expiry session should not be reused: %', res; end if;

  update public.face_verifications set expires_at = now() - interval '1 second'
   where provider_session_id = 'didit-sess-b-1';
  res := public.face_liveness_begin_session(fb, 'didit', 5, 10, 60);
  if res->>'action' <> 'create' then raise exception 'FAIL after expiry should create: %', res; end if;
  if (select status from public.face_verifications where provider_session_id = 'didit-sess-b-1') <> 'expired' then
    raise exception 'FAIL expired pending session not marked expired';
  end if;

  -- 시간당 상한: 지금까지 4행 생성 → 한 번 더 만들면 5 → 그 다음은 hourly 거부
  res := public.face_liveness_begin_session(fb, 'didit', 5, 10, 60);
  if res->>'action' <> 'create' then raise exception 'FAIL 5th session should be allowed: %', res; end if;
  res := public.face_liveness_begin_session(fb, 'didit', 5, 10, 60);
  if res->>'action' <> 'rate_limited' or res->>'reason' <> 'hourly' then
    raise exception 'FAIL 6th session within hour should be rate limited: %', res;
  end if;
  if (res->>'retry_after_seconds')::int < 1 then raise exception 'FAIL retry_after missing'; end if;
  -- 거부된 요청은 행을 만들지 않는다
  select count(*) into n from public.face_verifications where user_id = fb;
  if n <> 5 then raise exception 'FAIL rate limited request created a row (%)', n; end if;

  -- 일일 상한: 시간 창 밖으로 밀어낸 뒤 10행까지 채우면 daily 거부
  update public.face_verifications set created_at = now() - interval '2 hours' where user_id = fb;
  for i in 1..5 loop
    res := public.face_liveness_begin_session(fb, 'didit', 5, 10, 60);
    if res->>'action' <> 'create' then raise exception 'FAIL daily fill % failed: %', i, res; end if;
    update public.face_verifications set created_at = now() - interval '2 hours' where id = (res->>'id')::uuid;
  end loop;
  res := public.face_liveness_begin_session(fb, 'didit', 5, 10, 60);
  if res->>'action' <> 'rate_limited' or res->>'reason' <> 'daily' then
    raise exception 'FAIL 11th session within a day should be rate limited: %', res;
  end if;

  -- 이미 승인된 사용자는 세션을 만들지 않는다
  update public.users set face_verified = true where id = fb;
  res := public.face_liveness_begin_session(fb, 'didit', 5, 10, 60);
  if res->>'action' <> 'already_verified' then raise exception 'FAIL already verified user got %', res; end if;

  -- stale 정리 함수: 오래된 pending 행을 expired 로
  update public.users set face_verified = false where id = fb;
  insert into public.face_verifications (user_id, status, provider, provider_session_id, expires_at, created_at)
  values (fb, 'pending', 'didit', 'didit-sess-b-stale', now() + interval '1 hour', now() - interval '3 days');
  n := public.face_liveness_expire_stale(interval '1 day');
  if n < 1 then raise exception 'FAIL expire_stale did not expire old pending rows'; end if;
  if (select status from public.face_verifications where provider_session_id = 'didit-sess-b-stale') <> 'expired' then
    raise exception 'FAIL stale pending row not expired';
  end if;
end;
$$;

select 'FACE LIVENESS TESTS PASSED' as result;
