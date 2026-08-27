-- rls_tests.sql
-- RLS / 개인정보 보호 검증.
-- local_supabase_mock.sql + 전체 마이그레이션 적용 후 실행한다.
-- 실패 시 예외가 발생해 psql(ON_ERROR_STOP)이 비정상 종료된다.

-- ---------------------------------------------------------------------------
-- 픽스처
-- ---------------------------------------------------------------------------
\set ON_ERROR_STOP on

do $$
declare
  ua uuid := '11111111-1111-1111-1111-111111111111';
  ub uuid := '22222222-2222-2222-2222-222222222222';
  uc uuid := '33333333-3333-3333-3333-333333333333';
  ud uuid := '44444444-4444-4444-4444-444444444444';
  m_ab uuid;
  conv_ab uuid;
begin
  insert into auth.users (id, email) values
    (ua, 'rls-a@test.dev'), (ub, 'rls-b@test.dev'), (uc, 'rls-c@test.dev'), (ud, 'rls-d@test.dev');

  update public.users set onboarding_completed = true where id in (ua, ub, uc, ud);

  insert into public.profiles (user_id, nickname, birth_year, gender, seeking_gender, region_code, height_cm, job_group, smoking, drinking)
  values
    (ua, '가나다', 1994, 'male', 'female', 'seoul', 176, 'it', 'none', 'sometimes'),
    (ub, '라마바', 1996, 'female', 'male', 'seoul', 162, 'office', 'none', 'sometimes'),
    (uc, '사아자', 1995, 'female', 'male', 'busan', 165, 'creative', 'none', 'none'),
    (ud, '차카타', 1993, 'female', 'male', 'seoul', 168, 'medical', 'none', 'none');

  insert into public.private_profiles (user_id, marriage_intent, phone) values
    (ua, 4, '01011111111'), (ub, 4, '01022222222'), (uc, 3, '01033333333');

  insert into public.face_verifications (user_id, status, front_path, left_path, right_path)
  values (ub, 'approved', ub || '/front.jpg', ub || '/left.jpg', ub || '/right.jpg');

  -- A-B 매치 + 대화
  insert into public.matches (user_a, user_b) values (least(ua, ub), greatest(ua, ub)) returning id into m_ab;
  insert into public.conversations (match_id) values (m_ab) returning id into conv_ab;
  insert into public.messages (conversation_id, sender_id, content) values (conv_ab, ua, '안녕하세요');
  insert into public.messages (conversation_id, sender_id, content) values (conv_ab, ub, '반가워요');

  -- A 에게 C 추천
  insert into public.recommendations (user_id, candidate_id, card) values (ua, uc, '{"nickname":"사아자"}');

  -- B 의 신고 (A 대상)
  insert into public.reports (reporter_id, reported_id, reason) values (ub, ua, 'spam');

  -- B 의 만남 의사 (yes) — A 는 아직 없음
  insert into public.meetup_intentions (match_id, user_id, intent, preferred_region)
  values (m_ab, ub, 'yes', 'seoul');

  -- B 의 행동 이벤트
  insert into public.analytics_events (user_id, event_type) values (ub, 'message_sent');
end;
$$;

-- ---------------------------------------------------------------------------
-- A(11111111...) 관점 검증
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
set role authenticated;

do $$
declare
  n int;
  ua uuid := '11111111-1111-1111-1111-111111111111';
  ub uuid := '22222222-2222-2222-2222-222222222222';
  uc uuid := '33333333-3333-3333-3333-333333333333';
  ud uuid := '44444444-4444-4444-4444-444444444444';
  conv uuid;
  denied boolean;
begin
  -- users: 본인 행만
  select count(*) into n from public.users;
  if n <> 1 then raise exception 'FAIL users visibility: expected 1, got %', n; end if;

  -- private_profiles: 본인만 (타인 전화번호/가치관 차단)
  select count(*) into n from public.private_profiles where user_id <> ua;
  if n <> 0 then raise exception 'FAIL private_profiles leaked'; end if;

  -- face_verifications: 타인 얼굴 데이터 완전 차단
  select count(*) into n from public.face_verifications;
  if n <> 0 then raise exception 'FAIL face_verifications leaked'; end if;

  -- profiles: 본인 + 매칭 상대(B)만. 미매칭 C/D 는 안 보임
  select count(*) into n from public.profiles;
  if n <> 2 then raise exception 'FAIL profiles visibility: expected 2(self+matched), got %', n; end if;
  select count(*) into n from public.profiles where user_id in (uc, ud);
  if n <> 0 then raise exception 'FAIL unmatched profile leaked'; end if;

  -- reports: 남의 신고 안 보임 (B 가 A 를 신고했어도 A 는 모른다)
  select count(*) into n from public.reports;
  if n <> 0 then raise exception 'FAIL reports leaked'; end if;

  -- analytics_events: 조회 자체 불가
  select count(*) into n from public.analytics_events;
  if n <> 0 then raise exception 'FAIL analytics_events readable'; end if;

  -- meetup_intentions: 상호 yes 전에는 상대 응답 비공개
  select count(*) into n from public.meetup_intentions;
  if n <> 0 then raise exception 'FAIL partner meetup intent leaked before mutual yes'; end if;

  -- messages: 참가한 대화는 보인다
  select count(*) into n from public.messages;
  if n <> 2 then raise exception 'FAIL own conversation messages: expected 2, got %', n; end if;

  -- 보호 컬럼: 인증 플래그 자가 수정 차단
  denied := false;
  begin
    update public.users set face_verified = true where id = ua;
  exception when others then
    denied := true;
  end;
  if not denied then raise exception 'FAIL protected user columns updatable by client'; end if;

  -- likes: 추천 없는 상대(D)에게 좋아요 불가
  denied := false;
  begin
    insert into public.likes (from_user_id, to_user_id) values (ua, ud);
  exception when others then
    denied := true;
  end;
  if not denied then raise exception 'FAIL like without recommendation allowed'; end if;

  -- likes: 추천 받은 상대(C)에게는 가능
  insert into public.likes (from_user_id, to_user_id) values (ua, uc);

  -- 타인 명의 이벤트 기록 불가
  denied := false;
  begin
    insert into public.analytics_events (user_id, event_type) values (ub, 'spoofed');
  exception when others then
    denied := true;
  end;
  if not denied then raise exception 'FAIL analytics spoofing allowed'; end if;

  -- 타인 명의 메시지 전송 불가
  select c.id into conv from public.conversations c limit 1;
  denied := false;
  begin
    insert into public.messages (conversation_id, sender_id, content) values (conv, ub, '위조');
  exception when others then
    denied := true;
  end;
  if not denied then raise exception 'FAIL message spoofing allowed'; end if;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- C(33333333...) 관점: A-B 대화에 접근 불가
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);
set role authenticated;

do $$
declare
  n int;
  conv uuid;
  denied boolean;
  uc uuid := '33333333-3333-3333-3333-333333333333';
begin
  select count(*) into n from public.messages;
  if n <> 0 then raise exception 'FAIL third party can read messages'; end if;

  select count(*) into n from public.conversations;
  if n <> 0 then raise exception 'FAIL third party can see conversations'; end if;

  select count(*) into n from public.matches;
  if n <> 0 then raise exception 'FAIL third party can see matches'; end if;

  -- C 가 A 의 좋아요를 받았지만, 받은 좋아요는 보이지 않아야 한다
  select count(*) into n from public.likes;
  if n <> 0 then raise exception 'FAIL received like visible to recipient'; end if;
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 상호 yes 이후에는 상대 만남 의사가 보인다 + 차단 시 매치 종료
-- ---------------------------------------------------------------------------
do $$
declare
  m_ab uuid;
  ua uuid := '11111111-1111-1111-1111-111111111111';
  ub uuid := '22222222-2222-2222-2222-222222222222';
begin
  select id into m_ab from public.matches
  where user_a = least(ua, ub) and user_b = greatest(ua, ub);
  insert into public.meetup_intentions (match_id, user_id, intent) values (m_ab, ua, 'yes');
end;
$$;

select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);
set role authenticated;

do $$
declare
  n int;
begin
  select count(*) into n from public.meetup_intentions;
  if n <> 2 then raise exception 'FAIL mutual yes should reveal both intents, got %', n; end if;
end;
$$;

reset role;

do $$
declare
  n int;
  st text;
  ua uuid := '11111111-1111-1111-1111-111111111111';
  ub uuid := '22222222-2222-2222-2222-222222222222';
begin
  -- 상호 yes → meetup_state 갱신 확인
  select meetup_state into st from public.matches
  where user_a = least(ua, ub) and user_b = greatest(ua, ub);
  if st <> 'mutual_interest' then raise exception 'FAIL meetup_state not updated: %', st; end if;

  -- 차단 → 매치 종료
  insert into public.blocks (blocker_id, blocked_id) values (ua, ub);
  select count(*) into n from public.matches where status = 'blocked';
  if n <> 1 then raise exception 'FAIL block did not close match'; end if;
end;
$$;

-- 차단 후 메시지 전송 불가 (참가자여도)
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
set role authenticated;

do $$
declare
  conv uuid;
  denied boolean := false;
  ub uuid := '22222222-2222-2222-2222-222222222222';
begin
  select id into conv from public.conversations limit 1;
  begin
    insert into public.messages (conversation_id, sender_id, content) values (conv, ub, '차단 후 메시지');
  exception when others then
    denied := true;
  end;
  if not denied then raise exception 'FAIL message allowed after block'; end if;
end;
$$;

reset role;

select 'ALL RLS TESTS PASSED' as result;
