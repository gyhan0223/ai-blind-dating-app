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

-- ---------------------------------------------------------------------------
-- 6) 0014 — 원자적 승인 RPC face_liveness_approve: 전제 조건 · 멱등 · 부분 실패 복구 · 거절 행 보호
-- ---------------------------------------------------------------------------
do $$
declare
  fa uuid := '55555555-5555-5555-5555-555555555555';
  fb uuid := '66666666-6666-6666-6666-666666666666';
  row_id uuid;
  res jsonb;
  st text;
  verified boolean;
  vat timestamptz;
  ref text := '55555555-5555-5555-5555-555555555555/liveness/reference.jpg';
begin
  update public.users set face_verified = false where id in (fa, fb);

  insert into public.face_verifications (user_id, status, provider, provider_session_id, expires_at, provider_event_at)
  values (fa, 'pending', 'didit', 'didit-sess-a-approve', now() + interval '30 minutes', now() - interval '10 minutes')
  returning id into row_id;

  -- 존재하지 않는 행 / 다른 사용자 / 다른 세션 / reference_path 없음·다른 폴더 / liveness 미통과 → 아무것도 바꾸지 않는다
  res := public.face_liveness_approve(gen_random_uuid(), fa, 'didit-sess-a-approve', ref, true);
  if res->>'reason' <> 'row_not_found' then raise exception 'FAIL approve unknown row: %', res; end if;
  res := public.face_liveness_approve(row_id, fb, 'didit-sess-a-approve', ref, true);
  if res->>'reason' <> 'user_mismatch' then raise exception 'FAIL approve user mismatch: %', res; end if;
  res := public.face_liveness_approve(row_id, fa, 'didit-sess-other', ref, true);
  if res->>'reason' <> 'session_mismatch' then raise exception 'FAIL approve session mismatch: %', res; end if;
  res := public.face_liveness_approve(row_id, fa, 'didit-sess-a-approve', null, true);
  if res->>'reason' <> 'reference_missing' then raise exception 'FAIL approve null reference: %', res; end if;
  res := public.face_liveness_approve(row_id, fa, 'didit-sess-a-approve', fb::text || '/liveness/reference.jpg', true);
  if res->>'reason' <> 'reference_missing' then raise exception 'FAIL approve foreign reference: %', res; end if;
  res := public.face_liveness_approve(row_id, fa, 'didit-sess-a-approve', ref, false);
  if res->>'reason' <> 'liveness_not_passed' then raise exception 'FAIL approve without liveness: %', res; end if;

  select fv.status, u.face_verified into st, verified
    from public.face_verifications fv join public.users u on u.id = fv.user_id where fv.id = row_id;
  if st <> 'pending' or verified then raise exception 'FAIL rejected approve attempts changed state (% / %)', st, verified; end if;

  -- 정상 승인: 행 + verified_at + users.face_verified 가 함께 바뀐다
  res := public.face_liveness_approve(row_id, fa, 'didit-sess-a-approve', ref, true, 97.5, 'active', 'Approved', now(), 'liveness_approved');
  if (res->>'ok')::boolean is not true or (res->>'changed')::boolean is not true then raise exception 'FAIL approve: %', res; end if;
  select status, verified_at, reference_path into st, vat, ref from public.face_verifications where id = row_id;
  select face_verified into verified from public.users where id = fa;
  if st <> 'approved' or vat is null or not verified or ref is null then
    raise exception 'FAIL approve did not apply atomically (% / % / %)', st, vat, verified;
  end if;
  if (select liveness_passed from public.face_verifications where id = row_id) is not true then
    raise exception 'FAIL approve did not set liveness_passed';
  end if;

  -- 멱등: 다시 호출해도 ok, changed=false
  res := public.face_liveness_approve(row_id, fa, 'didit-sess-a-approve', ref, true);
  if (res->>'ok')::boolean is not true or (res->>'changed')::boolean then raise exception 'FAIL approve not idempotent: %', res; end if;

  -- 부분 실패 복구: 행은 approved 인데 users.face_verified=false 인 비정상 상태 → 플래그만 복구
  update public.users set face_verified = false where id = fa;
  res := public.face_liveness_approve(row_id, fa, 'didit-sess-a-approve', ref, true);
  select face_verified into verified from public.users where id = fa;
  if (res->>'ok')::boolean is not true or (res->>'changed')::boolean is not true or not verified then
    raise exception 'FAIL approve did not repair users.face_verified: %', res;
  end if;

  -- 오래된 provider_event_at 로 호출해도 저장값보다 과거로 내려가지 않는다 (트리거와 충돌 없음)
  res := public.face_liveness_approve(row_id, fa, 'didit-sess-a-approve', ref, true, null, null, null, now() - interval '1 day');
  if (res->>'ok')::boolean is not true then raise exception 'FAIL approve with old event_at: %', res; end if;

  -- 거절된 행은 자동 승인으로 되살아나지 않는다
  insert into public.face_verifications (user_id, status, provider, provider_session_id, liveness_passed)
  values (fb, 'rejected', 'didit', 'didit-sess-b-rejected', true);
  res := public.face_liveness_approve(
    (select id from public.face_verifications where provider_session_id = 'didit-sess-b-rejected'),
    fb, 'didit-sess-b-rejected', fb::text || '/liveness/reference.jpg', true);
  if res->>'reason' <> 'rejected_row' then raise exception 'FAIL approve revived rejected row: %', res; end if;
  select face_verified into verified from public.users where id = fb;
  if verified then raise exception 'FAIL rejected approve set users.face_verified'; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7) 0014 — 관리자 검토 RPC: 조건 없는 승인 불가 · 승인/거절 + 감사 기록 · 클라이언트 호출 불가
-- ---------------------------------------------------------------------------
do $$
declare
  fb uuid := '66666666-6666-6666-6666-666666666666';
  row_id uuid;
  res jsonb;
  st text;
  verified boolean;
  n int;
  refb text := '66666666-6666-6666-6666-666666666666/liveness/reference.jpg';
begin
  update public.users set face_verified = false where id = fb;

  -- 중복 얼굴 의심 in_review 행 (liveness_passed=true, reference_path 없음)
  insert into public.face_verifications
    (user_id, status, provider, provider_session_id, liveness_passed, provider_reason, provider_event_at)
  values (fb, 'in_review', 'didit', 'didit-sess-b-review', true, 'face_search_match', now() - interval '5 minutes')
  returning id into row_id;

  res := public.face_liveness_admin_review(row_id, 'approve', 'ops', null, null);
  if res->>'reason' <> 'reference_missing' then raise exception 'FAIL admin approve without reference: %', res; end if;
  res := public.face_liveness_admin_review(row_id, 'approve', '', null, refb);
  if res->>'reason' <> 'invalid_args' then raise exception 'FAIL admin approve without actor: %', res; end if;
  res := public.face_liveness_admin_review(row_id, 'ban', 'ops', null, refb);
  if res->>'reason' <> 'invalid_args' then raise exception 'FAIL admin unknown action: %', res; end if;

  -- liveness_passed=false 인 in_review(decision_incomplete) 행은 reference 가 있어도 승인 불가
  -- (liveness_passed 는 트리거가 true → false 를 막으므로 별도 행으로 검증한다)
  insert into public.face_verifications
    (user_id, status, provider, provider_session_id, liveness_passed, provider_reason, provider_event_at)
  values (fb, 'in_review', 'didit', 'didit-sess-b-incomplete', false, 'decision_incomplete', now() - interval '4 minutes');
  res := public.face_liveness_admin_review(
    (select id from public.face_verifications where provider_session_id = 'didit-sess-b-incomplete'),
    'approve', 'ops', null, refb);
  if res->>'reason' <> 'liveness_not_passed' then raise exception 'FAIL admin approve without liveness: %', res; end if;
  if (select status from public.face_verifications where provider_session_id = 'didit-sess-b-incomplete') <> 'in_review' then
    raise exception 'FAIL refused admin approve changed incomplete row';
  end if;

  select count(*) into n from public.face_verification_reviews where user_id = fb;
  if n <> 0 then raise exception 'FAIL refused admin actions wrote audit rows (%)', n; end if;

  -- 승인 → approved + users.face_verified + 감사 기록 (한 트랜잭션)
  res := public.face_liveness_admin_review(row_id, 'approve', 'ops-kim', '쌍둥이 확인', refb, 91.2, 'active', 'In Review');
  if (res->>'ok')::boolean is not true or res->>'status' <> 'approved' then raise exception 'FAIL admin approve: %', res; end if;
  select status into st from public.face_verifications where id = row_id;
  select face_verified into verified from public.users where id = fb;
  if st <> 'approved' or not verified then raise exception 'FAIL admin approve state (% / %)', st, verified; end if;
  if (select provider_reason from public.face_verifications where id = row_id) <> 'admin_approved' then
    raise exception 'FAIL admin approve reason';
  end if;
  select count(*) into n from public.face_verification_reviews
   where face_verification_id = row_id and action = 'approve' and actor = 'ops-kim'
     and previous_status = 'in_review' and new_status = 'approved' and note = '쌍둥이 확인';
  if n <> 1 then raise exception 'FAIL admin approve audit missing'; end if;

  -- 이미 approved 인 행은 관리자 승인/거절 대상이 아니다
  res := public.face_liveness_admin_review(row_id, 'approve', 'ops', null, refb);
  if res->>'reason' <> 'invalid_state' then raise exception 'FAIL admin approve twice: %', res; end if;
  res := public.face_liveness_admin_review(row_id, 'reject', 'ops', null);
  if res->>'reason' <> 'invalid_state' then raise exception 'FAIL admin reject approved row: %', res; end if;
  select status into st from public.face_verifications where id = row_id;
  if st <> 'approved' then raise exception 'FAIL admin reject changed approved row'; end if;

  -- 거절: 새 in_review 행 → rejected, 사용자 플래그 false (다른 approved 행이 없을 때), 감사 기록
  update public.users set face_verified = false where id = fb;
  -- 테스트 정리: approved 행은 운영 override 로만 되돌릴 수 있다 (다음 거절 검증에서 "다른 approved 행 없음" 조건을 만들기 위해)
  perform set_config('app.face_verification_override', 'on', true);
  update public.face_verifications set status = 'rejected', provider_reason = 'test_cleanup' where id = row_id;
  perform set_config('app.face_verification_override', '', true);

  insert into public.face_verifications
    (user_id, status, provider, provider_session_id, liveness_passed, provider_reason, provider_event_at)
  values (fb, 'in_review', 'didit', 'didit-sess-b-review-2', true, 'face_search_match', now() - interval '2 minutes')
  returning id into row_id;
  update public.users set face_verified = true where id = fb; -- 비정상 플래그가 있어도 거절 시 false 로 정리된다
  res := public.face_liveness_admin_review(row_id, 'reject', 'ops-lee', null);
  if (res->>'ok')::boolean is not true or res->>'status' <> 'rejected' then raise exception 'FAIL admin reject: %', res; end if;
  select status into st from public.face_verifications where id = row_id;
  select face_verified into verified from public.users where id = fb;
  if st <> 'rejected' or verified then raise exception 'FAIL admin reject state (% / %)', st, verified; end if;
  if (select provider_reason from public.face_verifications where id = row_id) <> 'admin_rejected' then
    raise exception 'FAIL admin reject reason';
  end if;
  select count(*) into n from public.face_verification_reviews
   where face_verification_id = row_id and action = 'reject' and actor = 'ops-lee' and previous_status = 'in_review';
  if n <> 1 then raise exception 'FAIL admin reject audit missing'; end if;

  -- 거절된 행은 이후 자동 승인 RPC 로도 되살아나지 않는다
  res := public.face_liveness_approve(row_id, fb, 'didit-sess-b-review-2', refb, true);
  if res->>'reason' <> 'rejected_row' then raise exception 'FAIL approve after admin reject: %', res; end if;

  -- 비정상 데이터 점검 함수: approved 인데 플래그 없음 / reference 없음 행이 보인다
  insert into public.face_verifications
    (user_id, status, provider, provider_session_id, liveness_passed, provider_event_at)
  values (fb, 'in_review', 'didit', 'didit-sess-b-incons', true, now())
  returning id into row_id;
  res := public.face_liveness_approve(row_id, fb, 'didit-sess-b-incons', refb, true);
  if (res->>'ok')::boolean is not true then raise exception 'FAIL setup inconsistent: %', res; end if;
  update public.users set face_verified = false where id = fb;
  select count(*) into n from public.face_liveness_inconsistent_rows() where face_verification_id = row_id;
  if n <> 1 then raise exception 'FAIL inconsistent row not listed'; end if;
  res := public.face_liveness_approve(row_id, fb, 'didit-sess-b-incons', refb, true);
  select count(*) into n from public.face_liveness_inconsistent_rows() where face_verification_id = row_id;
  if n <> 0 then raise exception 'FAIL inconsistent row still listed after repair'; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8) 0014 — 웹훅 event_id 테이블 · 감사 테이블 · RPC 는 클라이언트(authenticated/anon)가 접근할 수 없다
-- ---------------------------------------------------------------------------
insert into public.face_webhook_events (event_id, provider_session_id, webhook_type, provider_status, outcome)
values ('evt-test-1', 'didit-sess-a-approve', 'status.updated', 'Approved', 'ok:approved');
insert into public.face_webhook_events (event_id, provider_session_id, webhook_type, provider_status, outcome)
values ('evt-test-1', 'didit-sess-a-approve', 'status.updated', 'Approved', 'ok:approved')
on conflict (event_id) do nothing;

do $$
declare n int;
begin
  select count(*) into n from public.face_webhook_events where event_id = 'evt-test-1';
  if n <> 1 then raise exception 'FAIL event_id not unique (%)', n; end if;
  update public.face_webhook_events set received_at = now() - interval '10 days' where event_id = 'evt-test-1';
  n := public.face_liveness_prune_webhook_events(interval '7 days');
  if n < 1 then raise exception 'FAIL prune did not remove old events'; end if;
end;
$$;

select set_config('request.jwt.claim.sub', '66666666-6666-6666-6666-666666666666', false);
set role authenticated;

do $$
declare
  denied boolean;
  n int;
begin
  begin
    select count(*) into n from public.face_webhook_events;
    if n <> 0 then raise exception 'FAIL client can read face_webhook_events (%)', n; end if;
  exception when insufficient_privilege then
    null;
  end;
  begin
    select count(*) into n from public.face_verification_reviews;
    if n <> 0 then raise exception 'FAIL client can read face_verification_reviews (%)', n; end if;
  exception when insufficient_privilege then
    null;
  end;

  denied := false;
  begin
    insert into public.face_webhook_events (event_id, outcome) values ('evt-client', 'x');
  exception when others then
    denied := true;
  end;
  if not denied then raise exception 'FAIL client could insert face_webhook_events'; end if;

  denied := false;
  begin
    perform public.face_liveness_approve(gen_random_uuid(), '66666666-6666-6666-6666-666666666666'::uuid, 'x', 'y', true);
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then raise exception 'FAIL client could call face_liveness_approve'; end if;

  denied := false;
  begin
    perform public.face_liveness_admin_review(gen_random_uuid(), 'approve', 'me', null);
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then raise exception 'FAIL client could call face_liveness_admin_review'; end if;

  denied := false;
  begin
    perform public.face_liveness_inconsistent_rows();
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then raise exception 'FAIL client could call face_liveness_inconsistent_rows'; end if;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '', false);

-- anon 도 동일
set role anon;
do $$
declare denied boolean := false;
begin
  begin
    perform public.face_liveness_approve(gen_random_uuid(), gen_random_uuid(), 'x', 'y', true);
  exception when insufficient_privilege then
    denied := true;
  end;
  if not denied then raise exception 'FAIL anon could call face_liveness_approve'; end if;
end;
$$;
reset role;

select 'FACE LIVENESS TESTS PASSED' as result;
