-- meetup_flow_tests.sql
-- Issue #41 — 대화 → 상호 만남 의향 → 실제 만남 확인 → 비공개 피드백 흐름의 DB 검증.
-- local_supabase_mock.sql + 전체 마이그레이션(0016 포함) 적용 후 실행한다.
-- 각 사용자 관점은 request.jwt.claim.sub + set role authenticated 로 시뮬레이션한다 (service role 만으로 검증하지 않는다).
-- 실패 시 예외로 psql(ON_ERROR_STOP) 이 비정상 종료된다.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 픽스처: P, Q (매치 + 대화방), R (제3자), S (P 와 legacy completed 매치)
-- ---------------------------------------------------------------------------
do $$
declare
  up uuid := 'f1000000-0000-4000-8000-000000000041';
  uq uuid := 'f2000000-0000-4000-8000-000000000042';
  ur uuid := 'f3000000-0000-4000-8000-000000000043';
  us uuid := 'f4000000-0000-4000-8000-000000000044';
  m_pq uuid;
  m_ps uuid;
begin
  insert into auth.users (id, email) values
    (up, 'mf-p@test.dev'), (uq, 'mf-q@test.dev'), (ur, 'mf-r@test.dev'), (us, 'mf-s@test.dev');
  update public.users set onboarding_completed = true where id in (up, uq, ur, us);
  insert into public.profiles (user_id, nickname, birth_year, gender, seeking_gender, region_code, height_cm, job_group, smoking, drinking, hobbies, public_answers)
  values
    (up, '피피', 1994, 'male', 'female', 'seoul', 176, 'it', 'none', 'sometimes', '{cafe,travel}', '{"day_off":["cafe","walk"]}'),
    (uq, '큐큐', 1996, 'female', 'male', 'seoul', 162, 'office', 'none', 'sometimes', '{cafe}', '{"day_off":["cafe","culture"],"together":["food_tour"]}'),
    (ur, '알알', 1995, 'female', 'male', 'busan', 165, 'creative', 'none', 'none', '{}', '{}'),
    (us, '에스', 1993, 'female', 'male', 'seoul', 168, 'medical', 'none', 'none', '{}', '{}');

  insert into public.matches (user_a, user_b) values (least(up, uq), greatest(up, uq)) returning id into m_ps;
  -- (변수 재사용 방지) 위 결과는 m_pq 로
  m_pq := m_ps;
  insert into public.conversations (match_id) values (m_pq);

  insert into public.matches (user_a, user_b) values (least(up, us), greatest(up, us)) returning id into m_ps;
  insert into public.conversations (match_id) values (m_ps);
  -- 0016 이전 앱이 남긴 "한쪽 완료 버튼" 값 — 서버 컨텍스트에서 세팅
  update public.matches set meetup_state = 'completed', meetup_completed_at = now() - interval '3 days' where id = m_ps;
end;
$$;

-- 편의: 매치/대화 id 를 세션 설정에 (do 블록 안에서는 psql 변수가 치환되지 않으므로 current_setting 사용)
select set_config('test.m_pq', id::text, false) from public.matches
 where user_a = least('f1000000-0000-4000-8000-000000000041'::uuid, 'f2000000-0000-4000-8000-000000000042'::uuid)
   and user_b = greatest('f1000000-0000-4000-8000-000000000041'::uuid, 'f2000000-0000-4000-8000-000000000042'::uuid);
select set_config('test.conv_pq', id::text, false) from public.conversations where match_id = current_setting('test.m_pq')::uuid;
select set_config('test.m_ps', id::text, false) from public.matches
 where user_a = least('f1000000-0000-4000-8000-000000000041'::uuid, 'f4000000-0000-4000-8000-000000000044'::uuid)
   and user_b = greatest('f1000000-0000-4000-8000-000000000041'::uuid, 'f4000000-0000-4000-8000-000000000044'::uuid);
select set_config('test.conv_ps', id::text, false) from public.conversations where match_id = current_setting('test.m_ps')::uuid;

-- ===========================================================================
-- 1. 메시지 멱등 전송 (P 관점)
-- ===========================================================================
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000041', false);
set role authenticated;

do $$
declare
  conv uuid := current_setting('test.conv_pq')::uuid;
  k1 uuid := 'c0000000-0000-4000-8000-000000000001';
  k2 uuid := 'c0000000-0000-4000-8000-000000000002';
  first_id uuid;
  second_id uuid;
  r public.messages%rowtype;
  n int;
  denied boolean;
  msg text;
  acc jsonb;
begin
  r := public.send_message(conv, k1, '  안녕하세요  ');
  first_id := r.id;
  if r.content <> '안녕하세요' then raise exception 'FAIL content not trimmed: %', r.content; end if;
  if r.client_message_id <> k1 then raise exception 'FAIL client_message_id not stored'; end if;

  -- 같은 키 재시도(저장 성공 후 응답 유실) → 같은 행, 새 행 없음
  r := public.send_message(conv, k1, '안녕하세요');
  if r.id <> first_id then raise exception 'FAIL retry returned a different row'; end if;
  select count(*) into n from public.messages where conversation_id = conv;
  if n <> 1 then raise exception 'FAIL retry duplicated message: %', n; end if;

  -- 같은 키 + 다른 본문 → 덮어쓰기 거부
  denied := false;
  begin
    r := public.send_message(conv, k1, '다른 내용');
  exception when others then
    denied := true; msg := sqlerrm;
  end;
  if not denied or msg <> 'message_content_mismatch' then raise exception 'FAIL content mismatch not rejected: %', msg; end if;
  select content into msg from public.messages where id = first_id;
  if msg <> '안녕하세요' then raise exception 'FAIL content overwritten'; end if;

  -- 같은 본문을 새 키로 의도적으로 다시 작성 → 별도 메시지
  r := public.send_message(conv, k2, '안녕하세요');
  second_id := r.id;
  if second_id = first_id then raise exception 'FAIL same content new key collapsed'; end if;
  select count(*) into n from public.messages where conversation_id = conv;
  if n <> 2 then raise exception 'FAIL expected 2 messages, got %', n; end if;

  -- 키 없이 호출 불가
  denied := false;
  begin
    r := public.send_message(conv, null, '키 없음');
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL send without client_message_id allowed'; end if;

  acc := public.conversation_access(conv);
  if not (acc->>'can_chat')::boolean or acc->>'reason' <> 'ok' then raise exception 'FAIL access should be ok: %', acc; end if;

  -- 서버 관리 테이블 직접 접근 불가
  denied := false;
  begin
    select count(*) into n from public.notification_events;
    if n > 0 then denied := false; else denied := true; end if;
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL notification_events readable by client'; end if;
  denied := false;
  begin
    select count(*) into n from public.meetup_pair_summary;
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL meetup_pair_summary readable by client'; end if;
end;
$$;

reset role;

-- 서버 관점: 메트릭·이벤트·outbox 는 실제 저장 2건에만 1회씩
do $$
declare
  conv uuid := current_setting('test.conv_pq')::uuid;
  up uuid := 'f1000000-0000-4000-8000-000000000041';
  n int;
begin
  select total_messages into n from public.conversation_metrics where conversation_id = conv;
  if n <> 2 then raise exception 'FAIL metrics total_messages expected 2, got %', n; end if;
  select count(*) into n from public.analytics_events where event_type = 'message_sent' and user_id = up and payload->>'conversation_id' = conv::text;
  if n <> 2 then raise exception 'FAIL message_sent events expected 2, got %', n; end if;
  select count(*) into n from public.analytics_events where event_type = 'first_message' and payload->>'conversation_id' = conv::text;
  if n <> 1 then raise exception 'FAIL first_message events expected 1, got %', n; end if;
  select count(*) into n from public.analytics_events where event_type = 'two_way_conversation' and payload->>'conversation_id' = conv::text;
  if n <> 0 then raise exception 'FAIL two_way should not fire on one-sided chat'; end if;
  select count(*) into n from public.notification_events where kind = 'new_message' and conversation_id = conv;
  if n <> 2 then raise exception 'FAIL new_message outbox expected 2, got %', n; end if;
  select count(*) into n from public.notification_events where recipient_id = up;
  if n <> 0 then raise exception 'FAIL sender must not be notified of own message'; end if;
end;
$$;

-- ===========================================================================
-- 2. Q 가 답장 → 양방향 대화 이벤트 1회(참가자당 1행). 제3자 R 은 전송/접근 불가
-- ===========================================================================
select set_config('request.jwt.claim.sub', 'f2000000-0000-4000-8000-000000000042', false);
set role authenticated;
do $$
declare
  conv uuid := current_setting('test.conv_pq')::uuid;
  r public.messages%rowtype;
begin
  r := public.send_message(conv, 'c0000000-0000-4000-8000-000000000011', '반가워요');
  r := public.send_message(conv, 'c0000000-0000-4000-8000-000000000011', '반가워요');
end;
$$;
reset role;

do $$
declare
  conv uuid := current_setting('test.conv_pq')::uuid;
  n int;
begin
  select count(*) into n from public.analytics_events where event_type = 'two_way_conversation' and payload->>'conversation_id' = conv::text;
  if n <> 2 then raise exception 'FAIL two_way_conversation expected 2 rows (one per participant), got %', n; end if;
  select messages_a + messages_b into n from public.conversation_metrics where conversation_id = conv;
  if n <> 3 then raise exception 'FAIL metrics after reply expected 3, got %', n; end if;
end;
$$;

select set_config('request.jwt.claim.sub', 'f3000000-0000-4000-8000-000000000043', false);
set role authenticated;
do $$
declare
  conv uuid := current_setting('test.conv_pq')::uuid;
  mid uuid := current_setting('test.m_pq')::uuid;
  up uuid := 'f1000000-0000-4000-8000-000000000041';
  uq uuid := 'f2000000-0000-4000-8000-000000000042';
  r public.messages%rowtype;
  denied boolean := false;
  n int;
  j jsonb;
begin
  begin
    r := public.send_message(conv, 'c0000000-0000-4000-8000-000000000021', '끼어들기');
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL third party could send'; end if;
  select count(*) into n from public.messages where conversation_id = conv;
  if n <> 0 then raise exception 'FAIL third party can read messages'; end if;
  j := public.conversation_access(conv);
  if (j->>'can_chat')::boolean then raise exception 'FAIL third party access'; end if;
  -- SECURITY DEFINER 헬퍼 직접 호출로 타인 상태 조회 불가
  if public.meetup_mutual_yes(mid) then raise exception 'FAIL meetup_mutual_yes leaked to third party'; end if;
  if public.is_blocked_pair(up, uq) then raise exception 'FAIL is_blocked_pair answered for third party'; end if;
  denied := false;
  begin
    j := public.meetup_set_intent(mid, 'yes', '{}', null);
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL third party could set intent'; end if;
  denied := false;
  begin
    j := public.meetup_report_outcome(mid, 'met', null);
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL third party could report outcome'; end if;
end;
$$;
reset role;

-- ===========================================================================
-- 3. 만남 의향: P 만 yes → Q 는 알 수 없다. 직접 테이블/매치 변경 불가. 재시도는 이벤트 중복 없음
-- ===========================================================================
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000041', false);
set role authenticated;
do $$
declare
  mid uuid := current_setting('test.m_pq')::uuid;
  j jsonb;
  denied boolean;
  n int;
  st text;
begin
  j := public.meetup_set_intent(mid, 'yes', array['this_weekend'], 'seoul');
  if (j->>'mutual_yes')::boolean then raise exception 'FAIL one-sided yes reported as mutual'; end if;
  if j->>'meetup_state' <> 'none' then raise exception 'FAIL state after one yes: %', j; end if;
  -- 같은 요청 재시도
  j := public.meetup_set_intent(mid, 'yes', array['this_weekend'], 'seoul');

  -- 직접 insert/update 불가
  denied := false;
  begin
    insert into public.meetup_intentions (match_id, user_id, intent) values (mid, 'f1000000-0000-4000-8000-000000000041', 'yes');
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL direct intent insert allowed'; end if;
  update public.meetup_intentions set intent = 'not_yet' where match_id = mid;
  select intent into st from public.meetup_intentions where match_id = mid and user_id = 'f1000000-0000-4000-8000-000000000041';
  if st <> 'yes' then raise exception 'FAIL direct intent update took effect'; end if;

  -- 공통 매치 상태 직접 조작 불가 (정책 없음 → 0행)
  update public.matches set meetup_state = 'mutual_interest' where id = mid;
  update public.matches set meetup_state = 'met_confirmed', meetup_confirmed_at = now() where id = mid;
  update public.matches set meetup_state = 'completed', meetup_completed_at = now() where id = mid;
  select meetup_state into st from public.matches where id = mid;
  if st <> 'none' then raise exception 'FAIL client changed meetup_state to %', st; end if;
  select count(*) into n from public.matches where id = mid and meetup_confirmed_at is not null;
  if n <> 0 then raise exception 'FAIL client set meetup_confirmed_at'; end if;
end;
$$;
reset role;

do $$
declare
  mid uuid := current_setting('test.m_pq')::uuid;
  n int;
begin
  select count(*) into n from public.analytics_events where event_type = 'meetup_intent_set' and payload->>'match_id' = mid::text;
  if n <> 1 then raise exception 'FAIL meetup_intent_set expected 1 (retry must not duplicate), got %', n; end if;
  select count(*) into n from public.notification_events where kind = 'mutual_meetup_interest' and match_id = mid;
  if n <> 0 then raise exception 'FAIL one-sided yes produced notification'; end if;
end;
$$;

-- Q 관점: P 의 의향·날짜·지역이 보이지 않는다
select set_config('request.jwt.claim.sub', 'f2000000-0000-4000-8000-000000000042', false);
set role authenticated;
do $$
declare
  mid uuid := current_setting('test.m_pq')::uuid;
  n int;
  st text;
begin
  select count(*) into n from public.meetup_intentions where match_id = mid;
  if n <> 0 then raise exception 'FAIL partner one-sided intent visible (%)', n; end if;
  if public.meetup_mutual_yes(mid) then raise exception 'FAIL mutual reported before both yes'; end if;
  select meetup_state into st from public.matches where id = mid;
  if st <> 'none' then raise exception 'FAIL match state leaks one-sided intent'; end if;
end;
$$;

-- ===========================================================================
-- 4. Q 도 yes → 상호 관심 1회 성립 (이벤트·outbox 참가자당 1행). 재제출해도 중복 없음
-- ===========================================================================
do $$
declare
  mid uuid := current_setting('test.m_pq')::uuid;
  j jsonb;
  n int;
begin
  j := public.meetup_set_intent(mid, 'yes', array['next_weekend'], 'seoul');
  if not (j->>'mutual_yes')::boolean or j->>'meetup_state' <> 'mutual_interest' then
    raise exception 'FAIL mutual not established: %', j;
  end if;
  j := public.meetup_set_intent(mid, 'yes', array['next_weekend'], 'seoul');
  -- 이제 상대 행이 보인다 (둘 다 yes 인 현재)
  select count(*) into n from public.meetup_intentions where match_id = mid;
  if n <> 2 then raise exception 'FAIL mutual yes should reveal both rows, got %', n; end if;
end;
$$;
reset role;

do $$
declare
  mid uuid := current_setting('test.m_pq')::uuid;
  n int;
  ts timestamptz;
begin
  select count(*) into n from public.analytics_events where event_type = 'meetup_mutual_interest' and payload->>'match_id' = mid::text;
  if n <> 2 then raise exception 'FAIL meetup_mutual_interest expected 2 rows (one per participant), got %', n; end if;
  select count(*) into n from public.notification_events where kind = 'mutual_meetup_interest' and match_id = mid;
  if n <> 2 then raise exception 'FAIL mutual outbox expected 2, got %', n; end if;
  select mutual_interest_at into ts from public.matches where id = mid;
  if ts is null then raise exception 'FAIL mutual_interest_at not set'; end if;
end;
$$;

-- ===========================================================================
-- 5. 철회: Q 가 not_yet → interest_withdrawn. 상대 날짜·지역 다시 비공개. 과거 기록(mutual_interest_at) 유지
-- ===========================================================================
select set_config('request.jwt.claim.sub', 'f2000000-0000-4000-8000-000000000042', false);
set role authenticated;
do $$
declare
  mid uuid := current_setting('test.m_pq')::uuid;
  j jsonb;
begin
  j := public.meetup_set_intent(mid, 'not_yet', '{}', null);
  if j->>'meetup_state' <> 'interest_withdrawn' then raise exception 'FAIL withdraw state: %', j; end if;
end;
$$;
reset role;

select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000041', false);
set role authenticated;
do $$
declare
  mid uuid := current_setting('test.m_pq')::uuid;
  n int;
  st text;
begin
  select count(*) into n from public.meetup_intentions where match_id = mid;
  if n <> 1 then raise exception 'FAIL after withdrawal partner row still visible (%)', n; end if;
  select count(*) into n from public.meetup_intentions where match_id = mid and user_id <> 'f1000000-0000-4000-8000-000000000041';
  if n <> 0 then raise exception 'FAIL partner dates/region exposed after withdrawal'; end if;
  select meetup_state into st from public.matches where id = mid;
  if st <> 'interest_withdrawn' then raise exception 'FAIL state after withdrawal: %', st; end if;
  if public.meetup_mutual_yes(mid) then raise exception 'FAIL mutual still true after withdrawal'; end if;
end;
$$;
reset role;

-- Q 다시 yes → 복구. 최초 성립 이벤트/알림은 늘지 않고 restored 이벤트만
select set_config('request.jwt.claim.sub', 'f2000000-0000-4000-8000-000000000042', false);
set role authenticated;
select public.meetup_set_intent(current_setting('test.m_pq')::uuid, 'yes', array['next_weekend'], 'seoul') as restored \gset
reset role;
do $$
declare
  mid uuid := current_setting('test.m_pq')::uuid;
  n int;
  st text;
begin
  select meetup_state into st from public.matches where id = mid;
  if st <> 'mutual_interest' then raise exception 'FAIL restore state: %', st; end if;
  select count(*) into n from public.analytics_events where event_type = 'meetup_mutual_interest' and payload->>'match_id' = mid::text;
  if n <> 2 then raise exception 'FAIL first-time mutual event duplicated on restore: %', n; end if;
  select count(*) into n from public.analytics_events where event_type = 'meetup_mutual_interest_restored' and payload->>'match_id' = mid::text;
  if n <> 2 then raise exception 'FAIL restored event expected 2, got %', n; end if;
  select count(*) into n from public.analytics_events where event_type = 'meetup_mutual_interest_withdrawn' and payload->>'match_id' = mid::text;
  if n <> 1 then raise exception 'FAIL withdrawn event expected 1, got %', n; end if;
  select count(*) into n from public.notification_events where kind = 'mutual_meetup_interest' and match_id = mid;
  if n <> 2 then raise exception 'FAIL mutual outbox duplicated on restore: %', n; end if;
end;
$$;

-- ===========================================================================
-- 6. 실제 만남 확인: P 만 met → 공통 완료 아님. Q 는 P 의 응답을 볼 수 없다. 피드백은 본인 met 응답 후에만
-- ===========================================================================
select set_config('request.jwt.claim.sub', 'f2000000-0000-4000-8000-000000000042', false);
set role authenticated;
do $$
declare
  mid uuid := current_setting('test.m_pq')::uuid;
  j jsonb;
  denied boolean := false;
  msg text;
begin
  -- 본인 met 응답 전 피드백 불가
  begin
    j := public.meetup_submit_feedback(mid, 4, 'yes', 'yes', '{}');
  exception when others then denied := true; msg := sqlerrm; end;
  if not denied or msg <> 'outcome_required' then raise exception 'FAIL feedback allowed before outcome: %', msg; end if;
end;
$$;
reset role;

select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000041', false);
set role authenticated;
do $$
declare
  mid uuid := current_setting('test.m_pq')::uuid;
  j jsonb;
  denied boolean := false;
  n int;
begin
  begin
    insert into public.meetup_outcomes (match_id, user_id, outcome) values (mid, 'f1000000-0000-4000-8000-000000000041', 'met');
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL direct outcome insert allowed'; end if;

  j := public.meetup_report_outcome(mid, 'met', null);
  if (j->>'both_confirmed')::boolean then raise exception 'FAIL one-sided met became both_confirmed'; end if;
  if j->>'meetup_state' <> 'mutual_interest' then raise exception 'FAIL state after one-sided met: %', j; end if;
  -- 재시도
  j := public.meetup_report_outcome(mid, 'met', null);
  select count(*) into n from public.meetup_outcomes where match_id = mid;
  if n <> 1 then raise exception 'FAIL P sees other rows or duplicated: %', n; end if;
end;
$$;
reset role;

do $$
declare
  mid uuid := current_setting('test.m_pq')::uuid;
  n int;
  c text;
begin
  select count(*) into n from public.analytics_events where event_type = 'meetup_outcome_reported' and user_id = 'f1000000-0000-4000-8000-000000000041' and payload->>'match_id' = mid::text;
  if n <> 1 then raise exception 'FAIL outcome_reported retry duplicated: %', n; end if;
  select confirmation into c from public.meetup_pair_summary where match_id = mid;
  if c <> 'one_side_met' then raise exception 'FAIL summary expected one_side_met, got %', c; end if;
end;
$$;

-- Q 관점: P 의 응답이 보이지 않는다. not_met 은 사유 필수. no_show 진술은 상태를 바꾸지 않는다
select set_config('request.jwt.claim.sub', 'f2000000-0000-4000-8000-000000000042', false);
set role authenticated;
do $$
declare
  mid uuid := current_setting('test.m_pq')::uuid;
  j jsonb;
  n int;
  denied boolean := false;
  st text;
begin
  select count(*) into n from public.meetup_outcomes where match_id = mid;
  if n <> 0 then raise exception 'FAIL partner outcome visible'; end if;
  begin
    j := public.meetup_report_outcome(mid, 'not_met', null);
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL not_met without reason allowed'; end if;
  j := public.meetup_report_outcome(mid, 'not_met', 'no_show');
  if (j->>'both_confirmed')::boolean then raise exception 'FAIL not_met made both_confirmed'; end if;
  select meetup_state into st from public.matches where id = mid;
  if st <> 'mutual_interest' then raise exception 'FAIL no_show changed shared state to %', st; end if;
end;
$$;
reset role;

do $$
declare
  mid uuid := current_setting('test.m_pq')::uuid;
  c text;
  ns boolean;
begin
  select confirmation, no_show_claimed into c, ns from public.meetup_pair_summary where match_id = mid;
  if c <> 'mismatch' or not ns then raise exception 'FAIL summary expected mismatch + no_show_claimed, got % %', c, ns; end if;
end;
$$;

-- ===========================================================================
-- 7. Q 도 met 으로 정정 → 양측 확인 (met_confirmed) 1회. 피드백 제출·중복·수정 이벤트 구분
-- ===========================================================================
select set_config('request.jwt.claim.sub', 'f2000000-0000-4000-8000-000000000042', false);
set role authenticated;
do $$
declare
  mid uuid := current_setting('test.m_pq')::uuid;
  j jsonb;
  denied boolean := false;
  n int;
begin
  j := public.meetup_report_outcome(mid, 'met', null);
  if not (j->>'both_confirmed')::boolean or j->>'meetup_state' <> 'met_confirmed' then
    raise exception 'FAIL both met not confirmed: %', j;
  end if;

  -- 피드백: 직접 insert 불가, 빈 제출 불가, RPC 로만
  begin
    insert into public.meetup_feedback (match_id, user_id, met_again_intent) values (mid, 'f2000000-0000-4000-8000-000000000042', 'yes');
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL direct feedback insert allowed'; end if;
  denied := false;
  begin
    j := public.meetup_submit_feedback(mid, null, null, null, '{}');
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL empty feedback accepted'; end if;
  denied := false;
  begin
    j := public.meetup_submit_feedback(mid, 4, 'maybe', null, '{}');
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL invalid met_again value accepted'; end if;

  j := public.meetup_submit_feedback(mid, 4, 'not_sure', 'no', array['conversation', 'conversation']);
  j := public.meetup_submit_feedback(mid, 4, 'not_sure', 'no', array['conversation']);  -- 같은 내용 재제출
  select count(*) into n from public.meetup_feedback where match_id = mid;
  if n <> 1 then raise exception 'FAIL feedback rows visible/duplicated: %', n; end if;
  j := public.meetup_submit_feedback(mid, 5, 'yes', 'not_sure', '{}');  -- 실제 수정
end;
$$;
reset role;

do $$
declare
  mid uuid := current_setting('test.m_pq')::uuid;
  uq uuid := 'f2000000-0000-4000-8000-000000000042';
  n int;
  f record;
  st text;
  ts timestamptz;
begin
  select meetup_state, meetup_confirmed_at into st, ts from public.matches where id = mid;
  if st <> 'met_confirmed' or ts is null then raise exception 'FAIL met_confirmed/meetup_confirmed_at: % %', st, ts; end if;
  select count(*) into n from public.analytics_events where event_type = 'meetup_confirmed_both' and payload->>'match_id' = mid::text;
  if n <> 2 then raise exception 'FAIL meetup_confirmed_both expected 2, got %', n; end if;
  select count(*) into n from public.analytics_events where event_type = 'meetup_outcome_reported' and user_id = uq and payload->>'match_id' = mid::text;
  if n <> 2 then raise exception 'FAIL Q outcome_reported expected 2 (not_met → met), got %', n; end if;
  select count(*) into n from public.analytics_events where event_type = 'meetup_feedback_submitted' and user_id = uq;
  if n <> 1 then raise exception 'FAIL feedback_submitted expected 1, got %', n; end if;
  select count(*) into n from public.analytics_events where event_type = 'meetup_feedback_changed' and user_id = uq;
  if n <> 1 then raise exception 'FAIL feedback_changed expected 1 (identical resubmit must not count), got %', n; end if;
  select * into f from public.meetup_feedback where match_id = mid and user_id = uq;
  if f.overall_satisfaction <> 5 or f.met_again_intent <> 'yes' or f.next_intro_intent <> 'not_sure' or f.concerns <> '{}'::text[] or f.form_version <> 2 then
    raise exception 'FAIL feedback values not stored: % % % %', f.overall_satisfaction, f.met_again_intent, f.next_intro_intent, f.concerns;
  end if;
  -- 미응답(null)과 부정(no) 구분: 외모 점수는 더 이상 받지 않는다
  if f.appearance_attraction is not null then raise exception 'FAIL appearance score should stay null'; end if;
end;
$$;

-- P 관점: Q 의 피드백은 API 로도 읽을 수 없다
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000041', false);
set role authenticated;
do $$
declare
  mid uuid := current_setting('test.m_pq')::uuid;
  n int;
begin
  select count(*) into n from public.meetup_feedback where match_id = mid;
  if n <> 0 then raise exception 'FAIL partner feedback visible to P'; end if;
  select count(*) into n from public.meetup_outcomes where match_id = mid and user_id <> 'f1000000-0000-4000-8000-000000000041';
  if n <> 0 then raise exception 'FAIL partner outcome visible to P'; end if;
end;
$$;
reset role;

-- ===========================================================================
-- 8. legacy completed 매치: 자동 승격 없음 / 예약 등록 없이도 본인 결과 기록 가능
-- ===========================================================================
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000041', false);
set role authenticated;
select public.meetup_report_outcome(current_setting('test.m_ps')::uuid, 'met', null) as legacy_outcome \gset
reset role;
do $$
declare
  mid uuid := current_setting('test.m_ps')::uuid;
  st text;
  legacy boolean;
  c text;
begin
  select meetup_state into st from public.matches where id = mid;
  if st <> 'completed' then raise exception 'FAIL legacy completed row changed to %', st; end if;
  select legacy_unverified_completed, confirmation into legacy, c from public.meetup_pair_summary where match_id = mid;
  if not legacy or c <> 'one_side_met' then raise exception 'FAIL legacy summary: % %', legacy, c; end if;
end;
$$;

-- 상호 관심이 한 번도 없던 매치(meetup_state none)는 결과 기록 대상이 아니다 — 새 매치로 확인
do $$
declare
  up uuid := 'f1000000-0000-4000-8000-000000000041';
  ur uuid := 'f3000000-0000-4000-8000-000000000043';
  mid uuid;
begin
  insert into public.matches (user_a, user_b) values (least(up, ur), greatest(up, ur)) returning id into mid;
  insert into public.conversations (match_id) values (mid);
end;
$$;
select set_config('test.m_pr', id::text, false) from public.matches
 where user_a = least('f1000000-0000-4000-8000-000000000041'::uuid, 'f3000000-0000-4000-8000-000000000043'::uuid)
   and user_b = greatest('f1000000-0000-4000-8000-000000000041'::uuid, 'f3000000-0000-4000-8000-000000000043'::uuid);
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000041', false);
set role authenticated;
do $$
declare
  mid uuid := current_setting('test.m_pr')::uuid;
  j jsonb;
  denied boolean := false;
  msg text;
begin
  begin
    j := public.meetup_report_outcome(mid, 'met', null);
  exception when others then denied := true; msg := sqlerrm; end;
  if not denied or msg <> 'meetup_not_arranged' then raise exception 'FAIL outcome without mutual interest: %', msg; end if;
end;
$$;
reset role;

-- ===========================================================================
-- 9. 차단: 즉시 전송·의향 거부. 본인의 과거 만남 결과·피드백·신고는 가능. 대화 이력은 삭제되지 않는다
-- ===========================================================================
select set_config('request.jwt.claim.sub', 'f2000000-0000-4000-8000-000000000042', false);
set role authenticated;
insert into public.blocks (blocker_id, blocked_id) values ('f2000000-0000-4000-8000-000000000042', 'f1000000-0000-4000-8000-000000000041');
reset role;

select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000041', false);
set role authenticated;
do $$
declare
  mid uuid := current_setting('test.m_pq')::uuid;
  conv uuid := current_setting('test.conv_pq')::uuid;
  r public.messages%rowtype;
  j jsonb;
  denied boolean := false;
  n int;
  st text;
begin
  select status into st from public.matches where id = mid;
  if st <> 'blocked' then raise exception 'FAIL block did not close match'; end if;
  j := public.conversation_access(conv);
  if (j->>'can_chat')::boolean or j->>'reason' <> 'ended' then raise exception 'FAIL access after block: %', j; end if;

  begin
    r := public.send_message(conv, 'c0000000-0000-4000-8000-000000000031', '차단 후');
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL message allowed after block'; end if;
  -- 차단 전에 저장됐던 메시지의 재시도는 저장된 행을 돌려준다 (중복 없음)
  r := public.send_message(conv, 'c0000000-0000-4000-8000-000000000001', '안녕하세요');
  select count(*) into n from public.messages where conversation_id = conv;
  if n <> 3 then raise exception 'FAIL history changed after block: %', n; end if;

  denied := false;
  begin
    j := public.meetup_set_intent(mid, 'yes', '{}', null);
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL intent allowed after block'; end if;

  -- 본인의 과거 만남 결과·피드백은 여전히 가능 (상대 정보 접근은 아님)
  j := public.meetup_report_outcome(mid, 'met', null);
  j := public.meetup_submit_feedback(mid, 2, 'no', 'yes', array['goal_mismatch']);
  select count(*) into n from public.meetup_feedback where match_id = mid and user_id = 'f1000000-0000-4000-8000-000000000041';
  if n <> 1 then raise exception 'FAIL own feedback after block'; end if;
  -- 신고 접수 가능
  insert into public.reports (reporter_id, reported_id, match_id, reason) values ('f1000000-0000-4000-8000-000000000041', 'f2000000-0000-4000-8000-000000000042', mid, 'other');
  -- 상대 프로필은 더 이상 보이지 않는다 (active 매치 아님)
  select count(*) into n from public.profiles where user_id = 'f2000000-0000-4000-8000-000000000042';
  if n <> 0 then raise exception 'FAIL blocked partner profile still visible'; end if;
end;
$$;
reset role;

-- ===========================================================================
-- 10. 상대 정지: 열려 있던 매치라도 전송 불가 (can_chat_in 양쪽 active 검사)
-- ===========================================================================
select set_config('request.jwt.claim.sub', '', false);  -- 서버 컨텍스트 (보호 컬럼 가드는 JWT 유무로 판단)
update public.users set status = 'suspended' where id = 'f4000000-0000-4000-8000-000000000044';
select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000041', false);
set role authenticated;
do $$
declare
  conv uuid := current_setting('test.conv_ps')::uuid;
  r public.messages%rowtype;
  j jsonb;
  denied boolean := false;
begin
  j := public.conversation_access(conv);
  if (j->>'can_chat')::boolean or j->>'reason' <> 'unavailable' then raise exception 'FAIL access with suspended partner: %', j; end if;
  begin
    r := public.send_message(conv, 'c0000000-0000-4000-8000-000000000041', '정지된 상대');
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL message to suspended partner allowed'; end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', false);
update public.users set status = 'active' where id = 'f4000000-0000-4000-8000-000000000044';

-- ===========================================================================
-- 11. 페이지네이션 정렬: created_at 동률은 id 로 보조 정렬 (cursor 조건이 결정적)
-- ===========================================================================
do $$
declare
  conv uuid := current_setting('test.conv_ps')::uuid;
  up uuid := 'f1000000-0000-4000-8000-000000000041';
  t timestamptz := now();
  ids uuid[];
  page1 uuid[];
  page2 uuid[];
  cur_ts timestamptz;
  cur_id uuid;
begin
  insert into public.messages (conversation_id, sender_id, content, created_at) values
    (conv, up, 'm1', t), (conv, up, 'm2', t), (conv, up, 'm3', t), (conv, up, 'm4', t + interval '1 second');
  select array_agg(id order by created_at desc, id desc) into ids from public.messages where conversation_id = conv;
  -- 첫 페이지 2건
  select array_agg(id order by created_at desc, id desc) into page1 from (
    select id, created_at from public.messages where conversation_id = conv order by created_at desc, id desc limit 2) s;
  select created_at, id into cur_ts, cur_id from public.messages where id = page1[2];
  select array_agg(id order by created_at desc, id desc) into page2 from (
    select id, created_at from public.messages where conversation_id = conv
      and (created_at < cur_ts or (created_at = cur_ts and id < cur_id))
    order by created_at desc, id desc limit 2) s;
  if page1 || page2 <> ids[1:4] then raise exception 'FAIL cursor pagination not deterministic'; end if;
end;
$$;

select 'MEETUP FLOW TESTS PASSED' as result;
