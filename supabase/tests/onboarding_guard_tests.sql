-- onboarding_guard_tests.sql
-- Issue #39 — 외모 데이터 없는 온보딩 완료 + 인증 전 완료 차단 + 공개 자기소개 컬럼 제약 검증.
-- local_supabase_mock.sql + 전체 마이그레이션(0015 포함) 적용 후 실행한다.
-- 실패 시 예외가 발생해 psql(ON_ERROR_STOP)이 비정상 종료된다.
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 픽스처 (서버/superuser 컨텍스트 — auth.uid() 는 null)
--   ux: 본인확인 O · 얼굴 인증 X  → 온보딩 완료 불가
--   uy: 본인확인 O · 얼굴 인증 O  → 외모 응답/벡터 없이 온보딩 완료 가능
-- ---------------------------------------------------------------------------
do $$
declare
  ux uuid := '39390000-0000-4000-8000-000000000001';
  uy uuid := '39390000-0000-4000-8000-000000000002';
begin
  insert into auth.users (id, email) values (ux, 'guard-x@test.dev'), (uy, 'guard-y@test.dev');

  update public.users set identity_verified = true, age_verified = true, face_verified = false,
                          onboarding_step = 'face' where id = ux;
  update public.users set identity_verified = true, age_verified = true, face_verified = true,
                          onboarding_step = 'preferences' where id = uy;

  insert into public.profiles (user_id, nickname, birth_year, gender, seeking_gender, region_code, height_cm, job_group, smoking, drinking)
  values
    (ux, '가드엑스', 1994, 'male', 'female', 'seoul', 176, 'it', 'none', 'sometimes'),
    (uy, '가드와이', 1996, 'female', 'male', 'seoul', 162, 'office', 'none', 'sometimes');
end;
$$;

-- ---------------------------------------------------------------------------
-- X(얼굴 인증 미완료) 관점: 클라이언트가 onboarding_completed=true 로 못 바꾼다
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '39390000-0000-4000-8000-000000000001', false);
set role authenticated;

do $$
declare
  ux uuid := '39390000-0000-4000-8000-000000000001';
  denied boolean;
  completed boolean;
begin
  denied := false;
  begin
    update public.users set onboarding_completed = true, onboarding_step = 'done' where id = ux;
  exception when others then
    denied := true;
  end;
  if not denied then raise exception 'FAIL onboarding completed without face verification'; end if;

  select onboarding_completed into completed from public.users where id = ux;
  if completed then raise exception 'FAIL onboarding_completed persisted despite guard'; end if;

  -- 단계 저장(완료가 아닌 진행 상태)은 허용된다
  update public.users set onboarding_step = 'intro' where id = ux;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- Y(인증 완료) 관점: 외모 취향 응답·얼굴 벡터 없이 온보딩 완료 + 공개 자기소개 저장/제약
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '39390000-0000-4000-8000-000000000002', false);
set role authenticated;

do $$
declare
  uy uuid := '39390000-0000-4000-8000-000000000002';
  n int;
  denied boolean;
  completed boolean;
begin
  -- 전제: 외모 데이터가 전혀 없다
  select count(*) into n from public.appearance_preference_events where user_id = uy;
  if n <> 0 then raise exception 'FAIL fixture: appearance events should be empty'; end if;
  select count(*) into n from public.face_verifications where user_id = uy and feature_vector is not null;
  if n <> 0 then raise exception 'FAIL fixture: feature_vector should be absent'; end if;

  -- 공개 소개 저장 (선택지 코드 — 문자열 또는 배열). intro 는 MVP 에서 쓰지 않는다 (null)
  update public.profiles
     set relationship_goal = 'serious',
         public_answers = '{"day_off":["rest_home","cafe"],"together":["food_tour"],"important":"honest_talk"}'::jsonb
   where user_id = uy;

  -- 외모 데이터 없이 온보딩 완료 가능
  update public.users set onboarding_completed = true, onboarding_step = 'done' where id = uy;
  select onboarding_completed into completed from public.users where id = uy;
  if not completed then raise exception 'FAIL onboarding_completed not saved for verified user'; end if;

  -- 제약: 빈 자기소개
  denied := false;
  begin
    update public.profiles set intro = '' where user_id = uy;
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL empty intro accepted'; end if;

  -- 제약: 300자 초과
  denied := false;
  begin
    update public.profiles set intro = repeat('가', 301) where user_id = uy;
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL 301-char intro accepted'; end if;

  -- 제약: 알 수 없는 연애 목적
  denied := false;
  begin
    update public.profiles set relationship_goal = 'whatever' where user_id = uy;
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL unknown relationship_goal accepted'; end if;

  -- 제약: 답변이 객체가 아님
  denied := false;
  begin
    update public.profiles set public_answers = '["x"]'::jsonb where user_id = uy;
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL non-object public_answers accepted'; end if;

  -- 제약: 문자열/배열이 아닌 답변 값
  denied := false;
  begin
    update public.profiles set public_answers = '{"day_off": 3}'::jsonb where user_id = uy;
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL non-string answer accepted'; end if;

  -- 제약: 배열 안에 문자열이 아닌 값
  denied := false;
  begin
    update public.profiles set public_answers = '{"day_off": ["cafe", 1]}'::jsonb where user_id = uy;
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL non-string array element accepted'; end if;

  -- 제약: 배열 4개 초과 / 빈 배열
  denied := false;
  begin
    update public.profiles set public_answers = '{"day_off": ["a","b","c","d"]}'::jsonb where user_id = uy;
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL 4-element answer array accepted'; end if;
  denied := false;
  begin
    update public.profiles set public_answers = '{"day_off": []}'::jsonb where user_id = uy;
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL empty answer array accepted'; end if;

  -- 제약: 40자 초과 코드 (자유 텍스트를 코드 자리에 넣는 것 방지)
  denied := false;
  begin
    update public.profiles set public_answers = jsonb_build_object('day_off', repeat('가', 41)) where user_id = uy;
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL 41-char answer accepted'; end if;

  -- 제약: 항목 수 초과 (9개)
  denied := false;
  begin
    update public.profiles set public_answers =
      '{"a":"1","b":"2","c":"3","d":"4","e":"5","f":"6","g":"7","h":"8","i":"9"}'::jsonb
     where user_id = uy;
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL 9 public answers accepted'; end if;

  -- 인증 플래그 자가 수정은 여전히 차단 (0001 가드 유지)
  denied := false;
  begin
    update public.users set face_verified = false where id = uy;
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL face_verified changed by client'; end if;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 서버(service role / auth.uid() null) 컨텍스트에서는 가드가 적용되지 않는다 (seed·운영 도구 호환)
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '', false);

do $$
declare
  ux uuid := '39390000-0000-4000-8000-000000000001';
  completed boolean;
begin
  update public.users set onboarding_completed = true where id = ux;
  select onboarding_completed into completed from public.users where id = ux;
  if not completed then raise exception 'FAIL server context blocked by onboarding guard'; end if;
  -- 원복 (다른 테스트 영향 방지)
  update public.users set onboarding_completed = false where id = ux;
end;
$$;

select 'onboarding guard tests passed' as result;
