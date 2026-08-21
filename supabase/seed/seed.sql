-- seed.sql — 개발/테스트용 시드 데이터
--
--  * 데모 사용자 12명 (남 6 / 여 6), is_demo = true
--  * 대표 테스트 계정:
--      demo-m1@bonsim.dev (지훈) / demo-f1@bonsim.dev (서연)
--      비밀번호: bonsim-dev-password  (실제 Supabase 에 시드했을 때)
--  * 상호 좋아요 트리거를 통해 지훈-서연 매치 + 대화방 + 메시지 생성
--  * 지훈에게 오늘의 추천 1건(pending) 제공
--  * 실배포 전 is_demo 사용자 제거 필수

do $$
declare
  demo record;
  has_password_column boolean;
  q record;
  uid uuid;
  v int;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'auth' and table_name = 'users' and column_name = 'encrypted_password'
  ) into has_password_column;

  for demo in
    select * from (values
      ('a1000000-0000-4000-8000-000000000001'::uuid, 'demo-m1@bonsim.dev', '지훈', 1993, 'male',   'female', 'seoul',    178, 'it',           'none',      'sometimes', ARRAY['travel','sports'],  ARRAY['calm','honest'],      4, 3, 4, 3, 4),
      ('a1000000-0000-4000-8000-000000000002'::uuid, 'demo-m2@bonsim.dev', '민준', 1995, 'male',   'female', 'seoul',    172, 'finance',      'none',      'often',     ARRAY['games','movies'],   ARRAY['humorous','positive'], 3, 4, 3, 3, 3),
      ('a1000000-0000-4000-8000-000000000003'::uuid, 'demo-m3@bonsim.dev', '서준', 1991, 'male',   'female', 'gyeonggi', 181, 'professional', 'sometimes', 'sometimes', ARRAY['hiking','reading'], ARRAY['careful','reliable'], 2, 4, 5, 3, 4),
      ('a1000000-0000-4000-8000-000000000004'::uuid, 'demo-m4@bonsim.dev', '도윤', 1996, 'male',   'female', 'busan',    175, 'creative',     'none',      'none',      ARRAY['music','art'],      ARRAY['curious','detailed'], 4, 4, 3, 2, 3),
      ('a1000000-0000-4000-8000-000000000005'::uuid, 'demo-m5@bonsim.dev', '건우', 1994, 'male',   'female', 'seoul',    169, 'public',       'regular',   'often',     ARRAY['sports','games'],   ARRAY['energetic'],          3, 3, 3, 4, 3),
      ('a1000000-0000-4000-8000-000000000006'::uuid, 'demo-m6@bonsim.dev', '현우', 1992, 'male',   'female', 'incheon',  183, 'medical',      'none',      'sometimes', ARRAY['travel','cooking'], ARRAY['thoughtful','calm'],  4, 4, 4, 4, 4),
      ('b2000000-0000-4000-8000-000000000001'::uuid, 'demo-f1@bonsim.dev', '서연', 1995, 'female', 'male',   'seoul',    163, 'creative',     'none',      'sometimes', ARRAY['travel','cafe'],    ARRAY['positive','curious'], 4, 4, 4, 3, 4),
      ('b2000000-0000-4000-8000-000000000002'::uuid, 'demo-f2@bonsim.dev', '지우', 1996, 'female', 'male',   'seoul',    158, 'education',    'none',      'none',      ARRAY['reading','pets'],   ARRAY['calm','detailed'],    3, 4, 4, 3, 3),
      ('b2000000-0000-4000-8000-000000000003'::uuid, 'demo-f3@bonsim.dev', '하은', 1993, 'female', 'male',   'gyeonggi', 167, 'office',       'none',      'sometimes', ARRAY['movies','music'],   ARRAY['humorous'],           3, 3, 3, 3, 3),
      ('b2000000-0000-4000-8000-000000000004'::uuid, 'demo-f4@bonsim.dev', '수아', 1997, 'female', 'male',   'busan',    161, 'medical',      'none',      'sometimes', ARRAY['sports','travel'],  ARRAY['energetic','honest'], 4, 3, 3, 4, 3),
      ('b2000000-0000-4000-8000-000000000005'::uuid, 'demo-f5@bonsim.dev', '예은', 1994, 'female', 'male',   'seoul',    165, 'it',           'sometimes', 'often',     ARRAY['games','cafe'],     ARRAY['curious','positive'], 3, 4, 3, 3, 3),
      ('b2000000-0000-4000-8000-000000000006'::uuid, 'demo-f6@bonsim.dev', '민서', 1992, 'female', 'male',   'incheon',  159, 'self_employed','none',      'none',      ARRAY['cooking','art'],    ARRAY['thoughtful','careful'], 5, 4, 4, 3, 4)
    ) as t(id, email, nickname, birth_year, gender, seeking, region, height, job, smoking, drinking, hobbies, keywords,
           marriage, contact, datefreq, personal, spending)
  loop
    -- auth 사용자 (실제 Supabase 면 비밀번호 로그인 가능하게)
    if has_password_column then
      execute format($ins$
        insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                                email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                                created_at, updated_at, confirmation_token, recovery_token,
                                email_change, email_change_token_new)
        values ('00000000-0000-0000-0000-000000000000', %L, 'authenticated', 'authenticated', %L,
                crypt('bonsim-dev-password', gen_salt('bf')), now(),
                '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '')
        on conflict (id) do nothing
      $ins$, demo.id, demo.email);
      if exists (select 1 from information_schema.tables
                 where table_schema = 'auth' and table_name = 'identities') then
        execute format($ins$
          insert into auth.identities (id, user_id, provider_id, identity_data, provider,
                                       last_sign_in_at, created_at, updated_at)
          values (gen_random_uuid(), %L, %L,
                  jsonb_build_object('sub', %L::text, 'email', %L, 'email_verified', true),
                  'email', now(), now(), now())
          on conflict do nothing
        $ins$, demo.id, demo.id, demo.id, demo.email);
      end if;
    else
      insert into auth.users (id, email) values (demo.id, demo.email)
      on conflict (id) do nothing;
    end if;

    -- 트리거가 만들지 못했을 수 있는 환경 대비
    insert into public.users (id, email) values (demo.id, demo.email) on conflict (id) do nothing;
    insert into public.subscriptions (user_id) values (demo.id) on conflict (user_id) do nothing;

    update public.users set
      status = 'active',
      onboarding_step = 'done',
      onboarding_completed = true,
      age_verified = true,
      identity_verified = true,
      face_verified = true,
      is_demo = true
    where id = demo.id;

    insert into public.profiles (user_id, nickname, birth_year, gender, seeking_gender, region_code,
                                 height_cm, job_group, smoking, drinking, hobbies, personality_keywords)
    values (demo.id, demo.nickname, demo.birth_year, demo.gender, demo.seeking, demo.region,
            demo.height, demo.job, demo.smoking, demo.drinking, demo.hobbies, demo.keywords)
    on conflict (user_id) do nothing;

    insert into public.private_profiles (user_id, marriage_intent, children_intent, long_distance_ok,
                                         contact_frequency, date_frequency, personal_time_need,
                                         opposite_sex_friends_ok, spending_style, religion_importance)
    values (demo.id, demo.marriage, 3, 2, demo.contact, demo.datefreq, demo.personal, 3, demo.spending, 1)
    on conflict (user_id) do nothing;

    insert into public.preference_settings (user_id, age_min, age_max, regions, smoking_pref,
                                            appearance_importance, personality_importance,
                                            values_importance, lifestyle_importance, relationship_importance)
    values (demo.id, 25, 38, ARRAY[demo.region], 'any', 3, 4, 4, 3, 3)
    on conflict (user_id) do nothing;

    -- 설문 응답: 결정적 의사난수 (1~5)
    for q in select id from public.questionnaire_questions loop
      v := 1 + abs(hashtext(demo.id::text || q.id)) % 5;
      insert into public.questionnaire_responses (user_id, question_id, value)
      values (demo.id, q.id, v)
      on conflict (user_id, question_id) do nothing;
    end loop;

    -- 외모 취향 이벤트 3건
    insert into public.appearance_preference_events (user_id, option_a, option_b, selected) values
      (demo.id, 'ft01', 'ft02', case when abs(hashtext(demo.id::text || '1')) % 2 = 0 then 'ft01' else 'ft02' end),
      (demo.id, 'ft03', 'ft08', case when abs(hashtext(demo.id::text || '2')) % 2 = 0 then 'ft03' else 'ft08' end),
      (demo.id, 'ft07', 'ft12', case when abs(hashtext(demo.id::text || '3')) % 2 = 0 then 'ft07' else 'ft12' end);

    -- 승인된 얼굴 인증 (모의 특징 벡터)
    insert into public.face_verifications (user_id, status, front_path, left_path, right_path,
                                           liveness_passed, provider, feature_vector)
    values (demo.id, 'approved',
            demo.id || '/front.jpg', demo.id || '/left.jpg', demo.id || '/right.jpg',
            true, 'mock',
            jsonb_build_array(
              (abs(hashtext(demo.id::text || 'soft')) % 100)::numeric / 100,
              (abs(hashtext(demo.id::text || 'warm')) % 100)::numeric / 100,
              (abs(hashtext(demo.id::text || 'bold')) % 100)::numeric / 100,
              (abs(hashtext(demo.id::text || 'play')) % 100)::numeric / 100));
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 지훈(m1) ↔ 서연(f1): 서로에게 추천 → 상호 좋아요 → (트리거) 매치 + 대화방
-- ---------------------------------------------------------------------------
do $$
declare
  m1 uuid := 'a1000000-0000-4000-8000-000000000001';
  f1 uuid := 'b2000000-0000-4000-8000-000000000001';
  f2 uuid := 'b2000000-0000-4000-8000-000000000002';
  conv uuid;
begin
  insert into public.recommendations (user_id, candidate_id, for_date, strategy, status, card) values
    (m1, f1, current_date - 1, 'high_confidence', 'accepted',
     '{"nickname":"서연","age":31,"region_code":"seoul","height_cm":163,"job_group":"creative","smoking":"none","drinking":"sometimes","hobbies":["travel","cafe"],"personality_keywords":["positive","curious"],"identity_verified":true,"face_verified":true,"reasons":["생활 패턴이 비슷해요","공통 관심사가 있어요"]}'),
    (f1, m1, current_date - 1, 'high_confidence', 'accepted',
     '{"nickname":"지훈","age":33,"region_code":"seoul","height_cm":178,"job_group":"it","smoking":"none","drinking":"sometimes","hobbies":["travel","sports"],"personality_keywords":["calm","honest"],"identity_verified":true,"face_verified":true,"reasons":["연애에서 중요하게 생각하는 부분이 비슷해요","공통 관심사가 있어요"]}')
  on conflict (user_id, candidate_id) do nothing;

  -- 상호 좋아요 → handle_mutual_like 트리거가 매치/대화방/이벤트 생성
  insert into public.likes (from_user_id, to_user_id) values (f1, m1) on conflict do nothing;
  insert into public.likes (from_user_id, to_user_id) values (m1, f1) on conflict do nothing;

  select c.id into conv
  from public.conversations c
  join public.matches m on m.id = c.match_id
  where m.user_a = least(m1, f1) and m.user_b = greatest(m1, f1);

  if conv is not null and not exists (select 1 from public.messages where conversation_id = conv) then
    insert into public.messages (conversation_id, sender_id, content, created_at) values
      (conv, f1, '안녕하세요! 여행 좋아하신다고 해서 반가웠어요 :)', now() - interval '2 hours'),
      (conv, m1, '안녕하세요, 서연님! 저도 프로필 보고 꼭 이야기해보고 싶었어요.', now() - interval '110 minutes'),
      (conv, f1, '최근에 다녀온 여행지 중에 어디가 제일 좋았어요?', now() - interval '100 minutes'),
      (conv, m1, '작년 가을에 갔던 교토요. 서연님은요?', now() - interval '90 minutes');
  end if;

  -- 지훈에게 오늘의 추천 1건 (pending) — 홈 화면 바로 확인용
  insert into public.recommendations (user_id, candidate_id, for_date, strategy, status, card) values
    (m1, f2, current_date, 'high_confidence', 'pending',
     '{"nickname":"지우","age":30,"region_code":"seoul","height_cm":158,"job_group":"education","smoking":"none","drinking":"none","hobbies":["reading","pets"],"personality_keywords":["calm","detailed"],"identity_verified":true,"face_verified":true,"reasons":["성격의 결이 잘 맞아요","가까운 지역에 살고 있어요"]}')
  on conflict (user_id, candidate_id) do nothing;
end;
$$;

select 'SEED COMPLETE' as result;
