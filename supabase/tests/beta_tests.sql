-- beta_tests.sql — Issue #26: 폐쇄 베타 cohort · 초대코드 · 대기 목록.
--   * 게이트 OFF: 모두 open. ON: 허가 없는 사용자는 invite_required, 프로필 생성·온보딩 완료 불가
--   * 대기 등록은 프로필/본인확인/얼굴 데이터를 만들지 않는다 · 본인 행만 보인다
--   * 초대코드: 잘못된/만료/소진/모집 닫힘/정원 초과 거부, 성공 시 입장 + 이벤트. 사용자당 시도 상한
--   * 운영자 입장(beta_admit_waitlist): 지역·연령·성별 조건, 정원, outbox beta_admitted 1건(dedupe)
--   * users.cohort_id / beta_admitted_at 은 사용자 변경 불가 · 운영 테이블/뷰 서버 전용 · 게이트 OFF 로 일반 공개 전환
\set ON_ERROR_STOP on
select set_config('request.jwt.claim.sub', '', false);

do $$
declare
  b1 uuid := '26260000-0000-4000-8000-000000000001';  -- 초대코드로 입장
  b2 uuid := '26260000-0000-4000-8000-000000000002';  -- 대기 → 운영자 입장
  b3 uuid := '26260000-0000-4000-8000-000000000003';  -- 대기 (조건 불일치: 부산)
  b4 uuid := '26260000-0000-4000-8000-000000000004';  -- 정원 초과 시도
  c1 uuid := '26260000-0000-4000-8000-00000000c001';
begin
  insert into auth.users (id, email) values (b1, 'beta-1@test.dev'), (b2, 'beta-2@test.dev'), (b3, 'beta-3@test.dev'), (b4, 'beta-4@test.dev');
  update public.users set identity_verified = true, face_verified = true, age_verified = true where id in (b1, b2, b3, b4);
  insert into public.beta_cohorts (id, slug, name, region_codes, age_min, age_max, capacity, signups_open)
  values (c1, 'seoul-1', '서울 1차', '{seoul}', 25, 35, 2, true);
  insert into public.beta_invite_codes (code, cohort_id, max_uses) values ('SEOUL1', c1, 1), ('EXPIRED', c1, 5);
  update public.beta_invite_codes set expires_at = now() - interval '1 day' where code = 'EXPIRED';
end;
$$;

-- ---------------------------------------------------------------------------
-- 게이트 OFF: open
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '26260000-0000-4000-8000-000000000001', false);
set role authenticated;
do $$
declare j jsonb;
begin
  j := public.beta_access_state();
  if j->>'state' <> 'open' or (j->>'gate_enabled')::boolean then raise exception 'FAIL gate off state: %', j; end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', false);

-- 게이트 ON (서버)
do $$
declare j jsonb; n int;
begin
  j := public.beta_set_gate(true, 'tester');
  if not (j->>'enabled')::boolean then raise exception 'FAIL gate not enabled'; end if;
  select count(*) into n from public.admin_audit_log where action = 'beta_gate_set';
  if n < 1 then raise exception 'FAIL gate change not audited'; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- B1: 허가 없음 → invite_required · 프로필 생성/온보딩 완료 불가 · 코드 오류들 · 성공
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '26260000-0000-4000-8000-000000000001', false);
set role authenticated;
do $$
declare
  b1 uuid := '26260000-0000-4000-8000-000000000001';
  j jsonb;
  denied boolean := false;
  msg text;
begin
  j := public.beta_access_state();
  if j->>'state' <> 'invite_required' then raise exception 'FAIL expected invite_required: %', j; end if;

  begin
    insert into public.profiles (user_id, nickname, birth_year, gender, seeking_gender, region_code, height_cm, job_group, smoking, drinking)
    values (b1, '베타일', 1994, 'male', 'female', 'seoul', 176, 'it', 'none', 'none');
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL profile created without admission'; end if;

  denied := false;
  begin
    update public.users set onboarding_completed = true where id = b1;
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL onboarding completed without admission'; end if;

  -- 사용자가 직접 입장 컬럼을 못 만진다
  denied := false;
  begin
    update public.users set beta_admitted_at = now() where id = b1;
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL user set beta_admitted_at'; end if;

  -- 잘못된 코드 / 만료 코드 — 예외가 아니라 error 필드 (시도 카운터가 남아야 한다)
  j := public.beta_redeem_invite('NOPE00');
  if j->>'error' <> 'invalid_code' or j->>'state' <> 'invite_required' then raise exception 'FAIL invalid code: %', j; end if;
  j := public.beta_redeem_invite('expired');
  if j->>'error' <> 'invalid_code' then raise exception 'FAIL expired code: %', j; end if;

  -- 성공 (소문자·공백 허용)
  j := public.beta_redeem_invite(' seoul1 ');
  if j ? 'error' or j->>'state' <> 'admitted' or j->'cohort'->>'slug' <> 'seoul-1' then raise exception 'FAIL redeem result: %', j; end if;

  -- 이제 프로필 생성 가능
  insert into public.profiles (user_id, nickname, birth_year, gender, seeking_gender, region_code, height_cm, job_group, smoking, drinking)
  values (b1, '베타일', 1994, 'male', 'female', 'seoul', 176, 'it', 'none', 'none');
  -- 두 번째 사용은 이미 입장 → 그대로 admitted (코드 소진 아님)
  j := public.beta_redeem_invite('SEOUL1');
  if j->>'state' <> 'admitted' then raise exception 'FAIL re-redeem state: %', j; end if;
end;
$$;
reset role;

-- 코드 소진 확인 (서버)
select set_config('request.jwt.claim.sub', '', false);
do $$
declare r record;
begin
  select used_count, max_uses into r from public.beta_invite_codes where code = 'SEOUL1';
  if r.used_count <> 1 then raise exception 'FAIL used_count %', r.used_count; end if;
  -- 운영 테이블/뷰는 사용자에게 안 보인다 (security_tests 가 전수 검사) — 여기서는 통계 뷰가 돈다
  perform * from public.beta_cohort_stats;
end;
$$;

-- ---------------------------------------------------------------------------
-- B4: 소진된 코드 → code_exhausted · 시도 상한
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '26260000-0000-4000-8000-000000000004', false);
set role authenticated;
do $$
declare j jsonb; i int; limited boolean := false;
begin
  j := public.beta_redeem_invite('SEOUL1');
  if j->>'error' <> 'code_exhausted' then raise exception 'FAIL exhausted code: %', j; end if;
  -- 10회 시도 후 rate_limited (실패 시도도 센다)
  for i in 1..12 loop
    j := public.beta_redeem_invite('WRONG' || i);
    if j->>'error' = 'rate_limited' then limited := true; end if;
  end loop;
  if not limited then raise exception 'FAIL invite attempts not rate limited'; end if;
end;
$$;
reset role;

-- ---------------------------------------------------------------------------
-- B2/B3: 대기 등록 — 최소 정보만, 본인 행만
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '26260000-0000-4000-8000-000000000002', false);
set role authenticated;
do $$
declare j jsonb; n int;
begin
  j := public.beta_join_waitlist('seoul', 1995, 'female');
  if j->>'state' <> 'waitlisted' or j->>'waitlisted_at' is null then raise exception 'FAIL waitlist state: %', j; end if;
  -- 다시 등록하면 갱신 (행 1개)
  j := public.beta_join_waitlist('Seoul ', 1995, 'female');
  select count(*) into n from public.beta_waitlist;
  if n <> 1 then raise exception 'FAIL waitlist rows visible: %', n; end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '26260000-0000-4000-8000-000000000003', false);
set role authenticated;
do $$
declare j jsonb; n int;
begin
  j := public.beta_join_waitlist('busan', 1995, 'male');
  select count(*) into n from public.beta_waitlist;
  if n <> 1 then raise exception 'FAIL sees other waitlist rows: %', n; end if;
  -- 대기자가 직접 행을 고칠 수 없다 (정책 없음 → 0행)
  update public.beta_waitlist set admitted_at = now() where user_id = '26260000-0000-4000-8000-000000000003';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL waitlist row updated by user'; end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', false);

do $$
declare n int;
begin
  -- 대기 등록은 프로필·본인확인·얼굴 데이터를 만들지 않는다
  select count(*) into n from public.profiles where user_id in ('26260000-0000-4000-8000-000000000002', '26260000-0000-4000-8000-000000000003');
  if n <> 0 then raise exception 'FAIL waitlist created profiles'; end if;
  select count(*) into n from public.face_verifications where user_id in ('26260000-0000-4000-8000-000000000002', '26260000-0000-4000-8000-000000000003');
  if n <> 0 then raise exception 'FAIL waitlist created face rows'; end if;
  select count(*) into n from public.beta_waitlist_summary where region_code = 'seoul' and gender = 'female' and waiting = 1;
  if n <> 1 then raise exception 'FAIL waitlist summary'; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 운영자 입장: 서울 cohort 정원 2 (b1 입장 → 남은 1). 부산(b3)은 조건 불일치 → b2 만 입장
-- ---------------------------------------------------------------------------
do $$
declare
  c1 uuid := '26260000-0000-4000-8000-00000000c001';
  b2 uuid := '26260000-0000-4000-8000-000000000002';
  b3 uuid := '26260000-0000-4000-8000-000000000003';
  j jsonb; n int; r record;
begin
  j := public.beta_admit_waitlist(c1, 10, null, 'tester');
  if (j->>'admitted')::int <> 1 then raise exception 'FAIL admitted count %', j; end if;
  select cohort_id, beta_admitted_at into r from public.users where id = b2;
  if r.cohort_id <> c1 or r.beta_admitted_at is null then raise exception 'FAIL b2 not admitted'; end if;
  select beta_admitted_at into r from public.users where id = b3;
  if r.beta_admitted_at is not null then raise exception 'FAIL b3 admitted despite region mismatch'; end if;
  select count(*) into n from public.notification_events where recipient_id = b2 and kind = 'beta_admitted';
  if n <> 1 then raise exception 'FAIL beta_admitted outbox %', n; end if;
  -- 다시 돌려도 중복 알림 없음 · 정원 가득 → 0명
  j := public.beta_admit_waitlist(c1, 10, null, 'tester');
  if (j->>'admitted')::int <> 0 then raise exception 'FAIL re-admit count %', j; end if;
  select count(*) into n from public.notification_events where recipient_id = b2 and kind = 'beta_admitted';
  if n <> 1 then raise exception 'FAIL duplicate beta_admitted outbox'; end if;
  select admitted into r from public.beta_cohort_stats where slug = 'seoul-1';
  if r.admitted <> 2 then raise exception 'FAIL cohort stats admitted %', r.admitted; end if;
end;
$$;

-- B2 는 이제 admitted, B4 가 새 코드를 쓰면 정원 초과
do $$
declare c1 uuid := '26260000-0000-4000-8000-00000000c001';
begin
  insert into public.beta_invite_codes (code, cohort_id, max_uses) values ('MORE01', c1, 5);
end;
$$;
select set_config('request.jwt.claim.sub', '26260000-0000-4000-8000-000000000002', false);
set role authenticated;
do $$
declare j jsonb;
begin
  j := public.beta_access_state();
  if j->>'state' <> 'admitted' then raise exception 'FAIL b2 state %', j; end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '26260000-0000-4000-8000-000000000003', false);
set role authenticated;
do $$
declare j jsonb;
begin
  j := public.beta_redeem_invite('MORE01');
  if j->>'error' <> 'cohort_full' then raise exception 'FAIL over-capacity: %', j; end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', false);

-- 모집 닫힘 → cohort_closed (정원을 늘려도)
do $$
declare c1 uuid := '26260000-0000-4000-8000-00000000c001';
begin
  update public.beta_cohorts set capacity = 10, signups_open = false where id = c1;
end;
$$;
select set_config('request.jwt.claim.sub', '26260000-0000-4000-8000-000000000003', false);
set role authenticated;
do $$
declare j jsonb;
begin
  j := public.beta_redeem_invite('MORE01');
  if j->>'error' <> 'cohort_closed' then raise exception 'FAIL closed cohort: %', j; end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', false);

-- ---------------------------------------------------------------------------
-- 익명화 시 대기 정보 삭제 · 게이트 OFF → 일반 공개 (b3 도 open, cohort_id 는 남는다)
-- ---------------------------------------------------------------------------
do $$
declare
  b3 uuid := '26260000-0000-4000-8000-000000000003';
  b2 uuid := '26260000-0000-4000-8000-000000000002';
  n int; j jsonb; r record;
begin
  update public.users set status = 'deleted' where id = b3;
  update public.users set purged_at = now() where id = b3;
  select count(*) into n from public.beta_waitlist where user_id = b3;
  if n <> 0 then raise exception 'FAIL waitlist not removed on purge'; end if;
  j := public.beta_set_gate(false, 'tester');
  select cohort_id into r from public.users where id = b2;
  if r.cohort_id is null then raise exception 'FAIL cohort_id lost when gate closed'; end if;
end;
$$;
select set_config('request.jwt.claim.sub', '26260000-0000-4000-8000-000000000004', false);
set role authenticated;
do $$
declare j jsonb;
begin
  j := public.beta_access_state();
  if j->>'state' <> 'open' then raise exception 'FAIL gate off should be open: %', j; end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', false);

select 'BETA TESTS PASSED' as result;
