-- profile_edit_tests.sql — Issue #25: 온보딩 후 프로필·선호·Dealbreaker·가치관 수정.
--   * 온보딩 완료 사용자는 닉네임·지역 등은 바꾸지만 성별·출생연도는 못 바꾼다. 본인확인 결과와 다른 출생연도는 온보딩 중에도 거부
--   * preferences_save: 허용 키만 · appearance_importance 거부 · Dealbreaker 전체 동기화 · 잘못된 종류가 섞이면 아무것도 저장되지 않음
--   * 변경 이벤트: profile_updated / values_updated / preferences_updated 에 컬럼 이름만 (값 없음)
--   * 남의 행은 못 만진다 (RLS)
\set ON_ERROR_STOP on
select set_config('request.jwt.claim.sub', '', false);

do $$
declare
  e1 uuid := '25250000-0000-4000-8000-000000000001';  -- 온보딩 완료
  e2 uuid := '25250000-0000-4000-8000-000000000002';  -- 온보딩 중 (프로필 단계)
begin
  insert into auth.users (id, email) values (e1, 'edit-1@test.dev'), (e2, 'edit-2@test.dev');
  update public.users set onboarding_completed = true, identity_verified = true, face_verified = true, age_verified = true where id = e1;
  update public.users set identity_verified = true, face_verified = true, age_verified = true, onboarding_step = 'profile' where id = e2;
  insert into public.user_identities (user_id, identity_key_hash, identity_verified_at, birth_date, gender, adult_verified_at)
  values (e1, 'hash-edit-1', now(), '1994-05-05', 'male', now()),
         (e2, 'hash-edit-2', now(), '1996-01-01', 'female', now());
  insert into public.profiles (user_id, nickname, birth_year, gender, seeking_gender, region_code, height_cm, job_group, smoking, drinking)
  values (e1, '수정일', 1994, 'male', 'female', 'seoul', 176, 'it', 'none', 'none');
  insert into public.private_profiles (user_id, marriage_intent, children_intent) values (e1, 3, 3);
  insert into public.preference_settings (user_id, age_min, age_max, regions) values (e1, 25, 35, '{seoul}');
  insert into public.dealbreakers (user_id, kind, value) values (e1, 'smoking', '{"allow": false}'), (e1, 'regions', '{"codes": ["seoul"]}');
end;
$$;

-- ---------------------------------------------------------------------------
-- E2 (온보딩 중): 본인확인과 다른 출생연도/성별로 프로필을 만들 수 없다
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '25250000-0000-4000-8000-000000000002', false);
set role authenticated;
do $$
declare
  e2 uuid := '25250000-0000-4000-8000-000000000002';
  denied boolean := false;
  n int;
begin
  begin
    insert into public.profiles (user_id, nickname, birth_year, gender, seeking_gender, region_code, height_cm, job_group, smoking, drinking)
    values (e2, '수정이', 1990, 'female', 'male', 'busan', 162, 'office', 'none', 'none');
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL birth_year mismatch accepted'; end if;
  denied := false;
  begin
    insert into public.profiles (user_id, nickname, birth_year, gender, seeking_gender, region_code, height_cm, job_group, smoking, drinking)
    values (e2, '수정이', 1996, 'male', 'female', 'busan', 162, 'office', 'none', 'none');
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL gender mismatch accepted'; end if;
  -- 일치하면 저장된다
  insert into public.profiles (user_id, nickname, birth_year, gender, seeking_gender, region_code, height_cm, job_group, smoking, drinking)
  values (e2, '수정이', 1996, 'female', 'male', 'busan', 162, 'office', 'none', 'none');
  -- 온보딩 중 저장은 이벤트를 남기지 않는다 (analytics 는 조회 불가 → 아래 서버 단계에서 확인)
  update public.profiles set nickname = '수정이2' where user_id = e2;
end;
$$;
reset role;

-- ---------------------------------------------------------------------------
-- E1 (온보딩 완료): 수정 가능/불가 · preferences_save
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '25250000-0000-4000-8000-000000000001', false);
set role authenticated;
do $$
declare
  e1 uuid := '25250000-0000-4000-8000-000000000001';
  e2 uuid := '25250000-0000-4000-8000-000000000002';
  denied boolean := false;
  j jsonb;
  r record;
  n int;
begin
  -- 성별·출생연도 잠금
  begin
    update public.profiles set birth_year = 1995 where user_id = e1;
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL birth_year changed after onboarding'; end if;
  denied := false;
  begin
    update public.profiles set gender = 'female' where user_id = e1;
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL gender changed after onboarding'; end if;
  denied := false;
  begin
    update public.profiles set user_id = e2 where user_id = e1;
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL profile owner changed'; end if;

  -- 일반 항목은 수정된다
  update public.profiles set nickname = '수정완료', region_code = 'busan', hobbies = '{coffee}' where user_id = e1;
  select nickname, region_code into r from public.profiles where user_id = e1;
  if r.nickname <> '수정완료' or r.region_code <> 'busan' then raise exception 'FAIL profile edit not applied'; end if;

  -- 남의 프로필은 못 바꾼다 (RLS: 0행)
  update public.profiles set nickname = '해킹' where user_id = e2;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL edited another user''s profile'; end if;

  -- 가치관 재응답 (upsert)
  insert into public.private_profiles (user_id, marriage_intent, children_intent, sensitive_answers, sensitive_visibility)
  values (e1, 5, 4, '{"past_relationships": "few"}', '{"past_relationships": false}')
  on conflict (user_id) do update set marriage_intent = excluded.marriage_intent, children_intent = excluded.children_intent,
    sensitive_answers = excluded.sensitive_answers, sensitive_visibility = excluded.sensitive_visibility;
  select marriage_intent into r from public.private_profiles where user_id = e1;
  if r.marriage_intent <> 5 then raise exception 'FAIL values edit not applied'; end if;

  -- preferences_save: 허용 키 외 거부
  denied := false;
  begin
    j := public.preferences_save('{"appearance_importance": 5}'::jsonb, '[]'::jsonb);
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL appearance_importance accepted'; end if;
  denied := false;
  begin
    j := public.preferences_save('{"user_id": "00000000-0000-0000-0000-000000000000", "age_min": 20}'::jsonb, '[]'::jsonb);
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL user_id key accepted'; end if;

  -- 잘못된 dealbreaker 종류가 섞이면 설정도 저장되지 않는다 (원자성)
  denied := false;
  begin
    j := public.preferences_save('{"age_min": 30, "age_max": 40}'::jsonb, '[{"kind": "smoking", "value": {"allow": false}}, {"kind": "appearance", "value": {}}]'::jsonb);
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL invalid dealbreaker kind accepted'; end if;
  select age_min, age_max into r from public.preference_settings where user_id = e1;
  if r.age_min <> 25 or r.age_max <> 35 then raise exception 'FAIL partial save leaked: % %', r.age_min, r.age_max; end if;

  -- 제약 위반(age_min > age_max)도 통째로 거부
  denied := false;
  begin
    j := public.preferences_save('{"age_min": 40, "age_max": 30}'::jsonb, '[]'::jsonb);
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL age range violation accepted'; end if;
  select count(*) into n from public.dealbreakers where user_id = e1;
  if n <> 2 then raise exception 'FAIL dealbreakers changed by failed save: %', n; end if;

  -- 정상 저장: 일부 키만 넘기면 나머지는 유지, dealbreaker 는 전체 목록으로 동기화 (regions 제거, marriage 추가)
  j := public.preferences_save('{"age_min": 28, "smoking_pref": "prefer_non", "personality_importance": 5}'::jsonb,
                               '[{"kind": "smoking", "value": {"allow": false}}, {"kind": "marriage_intent", "value": {"min": 2}}]'::jsonb);
  if not (j->>'saved')::boolean then raise exception 'FAIL save result %', j; end if;
  select * into r from public.preference_settings where user_id = e1;
  if r.age_min <> 28 or r.age_max <> 35 or r.smoking_pref <> 'prefer_non' or r.personality_importance <> 5 or r.regions <> '{seoul}' or r.appearance_importance <> 3 then
    raise exception 'FAIL merged settings: % % % % %', r.age_min, r.age_max, r.smoking_pref, r.personality_importance, r.regions;
  end if;
  select string_agg(kind, ',' order by kind) into r from public.dealbreakers where user_id = e1;
  if r.string_agg <> 'marriage_intent,smoking' then raise exception 'FAIL dealbreakers not synced: %', r.string_agg; end if;

  -- 빈 배열이면 모두 제거
  j := public.preferences_save('{}'::jsonb, '[]'::jsonb);
  select count(*) into n from public.dealbreakers where user_id = e1;
  if n <> 0 then raise exception 'FAIL dealbreakers not cleared'; end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', false);

-- ---------------------------------------------------------------------------
-- 이벤트 확인 (서버) — 컬럼 이름만, 값 없음
-- ---------------------------------------------------------------------------
do $$
declare
  e1 uuid := '25250000-0000-4000-8000-000000000001';
  e2 uuid := '25250000-0000-4000-8000-000000000002';
  n int;
  p jsonb;
  r record;
begin
  select count(*) into n from public.analytics_events where user_id = e2 and event_type in ('profile_updated', 'values_updated', 'preferences_updated');
  if n <> 0 then raise exception 'FAIL onboarding-stage edit produced edit events'; end if;

  select payload into p from public.analytics_events where user_id = e1 and event_type = 'profile_updated' order by created_at desc limit 1;
  if p is null then raise exception 'FAIL profile_updated missing'; end if;
  if p->'fields' <> '["hobbies", "nickname", "region_code"]'::jsonb then raise exception 'FAIL profile_updated fields: %', p; end if;
  if p::text like '%수정완료%' or p::text like '%busan%' then raise exception 'FAIL profile_updated leaked values'; end if;

  select payload into p from public.analytics_events where user_id = e1 and event_type = 'values_updated' order by created_at desc limit 1;
  if p is null or not (p->'fields' ? 'marriage_intent') then raise exception 'FAIL values_updated: %', p; end if;
  if p::text like '%few%' then raise exception 'FAIL values_updated leaked sensitive answer'; end if;

  select count(*) into n from public.analytics_events where user_id = e1 and event_type = 'preferences_updated';
  if n <> 2 then raise exception 'FAIL preferences_updated count %, expected 2 (successful saves only)', n; end if;
  select payload into p from public.analytics_events where user_id = e1 and event_type = 'preferences_updated' order by created_at limit 1;
  if p->'settings' <> '["age_min", "personality_importance", "smoking_pref"]'::jsonb or p->'dealbreakers' <> '["smoking", "marriage_intent"]'::jsonb then
    raise exception 'FAIL preferences_updated payload: %', p;
  end if;

  -- 서버(관리자)는 여전히 성별·출생연도를 고칠 수 있다 (정정 절차)
  update public.profiles set birth_year = 1994 where user_id = e1;
end;
$$;

select 'PROFILE EDIT TESTS PASSED' as result;
