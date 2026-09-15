-- conversation_tests.sql
-- Issue #24 — 대화 행동 지표(고정 기준 시각) · 동시 대화 3개 제한 · 나가기 · 재매칭 방지 · 종료 후 전송 차단 · 이유 비공개 · 퍼널 뷰 갱신.
-- local_supabase_mock.sql + 전체 마이그레이션(0026 포함) 적용 후 실행한다. 실패 시 예외로 psql(ON_ERROR_STOP) 이 비정상 종료된다.
-- 시각은 모두 고정값이다 — conversation_pair_metrics(p_as_of) 로 "지금" 을 바꿔 가며 경계를 확인한다.

\set ON_ERROR_STOP on
select set_config('request.jwt.claim.sub', '', false);

-- ---------------------------------------------------------------------------
-- 픽스처 — 남 c24m..., 여 c24f... (인증 완료). T0 = 2026-09-01 09:00 KST
-- ---------------------------------------------------------------------------
do $$
declare
  ids uuid[] := array[
    'c24a0000-0000-4000-8000-000000000001', 'c24a0000-0000-4000-8000-000000000002', 'c24a0000-0000-4000-8000-000000000003',
    'c24a0000-0000-4000-8000-000000000004', 'c24a0000-0000-4000-8000-000000000005', 'c24a0000-0000-4000-8000-000000000006',
    'c24a0000-0000-4000-8000-000000000007', 'c24a0000-0000-4000-8000-000000000008',
    'c24b0000-0000-4000-8000-000000000001', 'c24b0000-0000-4000-8000-000000000002', 'c24b0000-0000-4000-8000-000000000003',
    'c24b0000-0000-4000-8000-000000000004', 'c24b0000-0000-4000-8000-000000000005', 'c24b0000-0000-4000-8000-000000000006',
    'c24b0000-0000-4000-8000-000000000007', 'c24b0000-0000-4000-8000-000000000008', 'c24b0000-0000-4000-8000-000000000009',
    'c24b0000-0000-4000-8000-000000000010'
  ];
  i int;
  g text;
begin
  for i in 1..array_length(ids, 1) loop
    insert into auth.users (id, email) values (ids[i], 'conv-' || i || '@test.dev');
    g := case when ids[i]::text like 'c24a%' then 'male' else 'female' end;
    insert into public.profiles (user_id, nickname, birth_year, gender, seeking_gender, region_code, height_cm, job_group, smoking, drinking)
    values (ids[i], '대화' || i, 1995, g, case when g = 'male' then 'female' else 'male' end, 'seoul', 170, 'it', 'none', 'none');
  end loop;
  update public.users set onboarding_completed = true, identity_verified = true, face_verified = true, age_verified = true where id = any (ids);
end;
$$;

-- 매치 + 대화방 헬퍼 (서버 컨텍스트, 고정 생성 시각)
create or replace function pg_temp.mk_match(a uuid, b uuid, t timestamptz)
returns uuid language plpgsql as $$
declare mid uuid;
begin
  insert into public.matches (user_a, user_b, created_at) values (least(a, b), greatest(a, b), t) returning id into mid;
  insert into public.conversations (match_id) values (mid);
  return mid;
end;
$$;
create or replace function pg_temp.say(mid uuid, sender uuid, t timestamptz, body text default '메시지')
returns void language plpgsql as $$
begin
  insert into public.messages (conversation_id, sender_id, content, created_at)
  select c.id, sender, body, t from public.conversations c where c.match_id = mid;
end;
$$;

-- ===========================================================================
-- 1. 지표 — 고정 시각 시나리오
-- ===========================================================================
do $$
declare
  t0 timestamptz := '2026-09-01 09:00:00+09';
  p1 uuid := 'c24a0000-0000-4000-8000-000000000001'; q1 uuid := 'c24b0000-0000-4000-8000-000000000001';
  p2 uuid := 'c24a0000-0000-4000-8000-000000000002'; q2 uuid := 'c24b0000-0000-4000-8000-000000000002';
  p3 uuid := 'c24a0000-0000-4000-8000-000000000003'; q3 uuid := 'c24b0000-0000-4000-8000-000000000003';
  m1 uuid; m2 uuid; m3 uuid;
  r record;
begin
  -- 쌍 1: P1 13:00 → P1 15:00(연속) → Q1 18:00 답장 → P1 18:10. 이후 침묵
  m1 := pg_temp.mk_match(p1, q1, t0);
  perform pg_temp.say(m1, p1, t0 + interval '30 minutes');          -- 09:30 첫 연락 (1시간 이내)
  perform pg_temp.say(m1, p1, t0 + interval '2 hours 30 minutes');  -- 11:30 연속 발신 — 대기 시작은 09:30 그대로
  perform pg_temp.say(m1, q1, t0 + interval '5 hours 30 minutes');  -- 14:30 답장 → P1 대기 5시간
  perform pg_temp.say(m1, p1, t0 + interval '5 hours 40 minutes');  -- 14:40 → Q1 대기 10분
  perform set_config('test.m1', m1::text, false);

  -- 쌍 2: 메시지 없음 (관찰 중 → 미시작 경계)
  m2 := pg_temp.mk_match(p2, q2, t0);
  perform set_config('test.m2', m2::text, false);

  -- 쌍 3: 정확히 1시간 뒤 첫 메시지, 정확히 24시간 뒤 답장 (경계)
  m3 := pg_temp.mk_match(p3, q3, t0);
  perform pg_temp.say(m3, q3, t0 + interval '1 hour');
  perform pg_temp.say(m3, p3, t0 + interval '25 hours');
  perform set_config('test.m3', m3::text, false);

  -- 쌍 1 @ 14:41 — 답장 완료 직후
  select * into r from public.conversation_pair_metrics(t0 + interval '5 hours 41 minutes') where match_id = m1;
  if r.first_contact_class <> 'within_1h' or r.first_contact_seconds <> 1800 then raise exception 'FAIL m1 first contact: % %', r.first_contact_class, r.first_contact_seconds; end if;
  if r.first_sender_id <> p1 or r.first_sender_gender <> 'male' then raise exception 'FAIL m1 first sender'; end if;
  if r.first_reply_status <> 'replied' or r.first_reply_wait_seconds <> 5 * 3600 then raise exception 'FAIL m1 first reply wait (consecutive sends must not reset): % %', r.first_reply_status, r.first_reply_wait_seconds; end if;
  if not r.two_way then raise exception 'FAIL m1 two_way'; end if;
  if r.max_completed_wait_seconds <> 5 * 3600 or r.max_completed_wait_male_seconds <> 5 * 3600 or r.max_completed_wait_female_seconds <> 600 then
    raise exception 'FAIL m1 completed waits: % male=% female=%', r.max_completed_wait_seconds, r.max_completed_wait_male_seconds, r.max_completed_wait_female_seconds;
  end if;
  if r.open_wait_status <> 'ongoing' or r.open_wait_by <> p1 or r.open_wait_seconds <> 60 then raise exception 'FAIL m1 open wait: % % %', r.open_wait_status, r.open_wait_by, r.open_wait_seconds; end if;
  if r.stall_24h_reached or r.stalled_now or r.resumed_after_24h_count <> 0 then raise exception 'FAIL m1 stall too early'; end if;
  if r.message_count <> 4 or r.closed then raise exception 'FAIL m1 count/closed'; end if;

  -- 쌍 1 @ 14:40 + 24h 정확히 — 24시간부터 "24시간 이상"
  select * into r from public.conversation_pair_metrics(t0 + interval '5 hours 40 minutes' + interval '24 hours') where match_id = m1;
  if not r.stall_24h_reached or not r.stalled_now or r.silence_seconds <> 86400 then raise exception 'FAIL m1 stall at exactly 24h: % % %', r.stall_24h_reached, r.stalled_now, r.silence_seconds; end if;
  if r.stall_24h_at <> t0 + interval '29 hours 40 minutes' or r.stall_started_hours_after_match <> 5.67 then raise exception 'FAIL m1 stall timestamps: % %', r.stall_24h_at, r.stall_started_hours_after_match; end if;
  if r.open_wait_seconds <> 86400 or r.open_wait_status <> 'ongoing' then raise exception 'FAIL m1 open wait 24h'; end if;

  -- 쌍 1 @ 24h - 1초 — 아직 중단 아님
  select * into r from public.conversation_pair_metrics(t0 + interval '5 hours 40 minutes' + interval '24 hours' - interval '1 second') where match_id = m1;
  if r.stall_24h_reached or r.stalled_now then raise exception 'FAIL m1 stall before 24h'; end if;

  -- 쌍 1: 30시간 뒤 Q1 재개 → 재개 1회, 시각 보존, 더 이상 중단 아님
  perform pg_temp.say(m1, q1, t0 + interval '5 hours 40 minutes' + interval '30 hours');
  select * into r from public.conversation_pair_metrics(t0 + interval '5 hours 40 minutes' + interval '30 hours' + interval '1 minute') where match_id = m1;
  if r.resumed_after_24h_count <> 1 or r.last_resumed_at <> t0 + interval '35 hours 40 minutes' then raise exception 'FAIL m1 resume: % %', r.resumed_after_24h_count, r.last_resumed_at; end if;
  if r.stalled_now or r.stall_24h_reached then raise exception 'FAIL m1 still stalled after resume'; end if;
  if r.max_completed_wait_seconds <> 30 * 3600 or r.max_completed_wait_male_seconds <> 30 * 3600 then raise exception 'FAIL m1 completed wait after resume: %', r.max_completed_wait_seconds; end if;
  if r.open_wait_by <> q1 or r.open_wait_seconds <> 60 then raise exception 'FAIL m1 open wait now by Q1'; end if;
  -- 과거 시각으로 다시 물으면 미래 메시지는 보이지 않는다 (결정적)
  select * into r from public.conversation_pair_metrics(t0 + interval '5 hours 41 minutes') where match_id = m1;
  if r.message_count <> 4 or r.resumed_after_24h_count <> 0 then raise exception 'FAIL as_of must hide future messages'; end if;

  -- 쌍 2: 59분 → observing, 정확히 60분 → not_started (관찰 부족을 실패로 세지 않는다)
  select * into r from public.conversation_pair_metrics(t0 + interval '59 minutes') where match_id = m2;
  if r.first_contact_class <> 'observing' or r.first_reply_status is not null or r.open_wait_status <> 'none' or r.stall_24h_reached then raise exception 'FAIL m2 observing: %', r.first_contact_class; end if;
  select * into r from public.conversation_pair_metrics(t0 + interval '60 minutes') where match_id = m2;
  if r.first_contact_class <> 'not_started' or r.silence_seconds is not null then raise exception 'FAIL m2 not_started: %', r.first_contact_class; end if;

  -- 쌍 3: 정확히 1시간은 "1시간 내", 정확히 24시간 대기는 24시간 이상 구간
  select * into r from public.conversation_pair_metrics(t0 + interval '26 hours') where match_id = m3;
  if r.first_contact_class <> 'within_1h' or r.first_sender_gender <> 'female' then raise exception 'FAIL m3 boundary 1h: %', r.first_contact_class; end if;
  if r.first_reply_wait_seconds <> 86400 or r.max_completed_wait_seconds <> 86400 or r.max_completed_wait_female_seconds <> 86400 then raise exception 'FAIL m3 24h wait: %', r.first_reply_wait_seconds; end if;
  -- 매치 전 시각으로 물으면 행이 없다
  select count(*) into r from public.conversation_pair_metrics(t0 - interval '1 second') where match_id = m3;
  if r.count <> 0 then raise exception 'FAIL m3 visible before matched_at'; end if;
end;
$$;

-- ===========================================================================
-- 2. 종료 — 조기 종료 / 첫 답장 전 종료(이유 비공개) / 0026 이전 종료(시각 미상)
-- ===========================================================================
do $$
declare
  t0 timestamptz := '2026-09-01 09:00:00+09';
  p4 uuid := 'c24a0000-0000-4000-8000-000000000004'; q4 uuid := 'c24b0000-0000-4000-8000-000000000004';
  p5 uuid := 'c24a0000-0000-4000-8000-000000000005'; q5 uuid := 'c24b0000-0000-4000-8000-000000000005';
  p6 uuid := 'c24a0000-0000-4000-8000-000000000006'; q6 uuid := 'c24b0000-0000-4000-8000-000000000006';
  m4 uuid; m5 uuid; m6 uuid;
begin
  m4 := pg_temp.mk_match(p4, q4, t0);
  m5 := pg_temp.mk_match(p5, q5, t0);
  perform pg_temp.say(m5, p5, t0 + interval '10 minutes');
  m6 := pg_temp.mk_match(p6, q6, t0);
  perform pg_temp.say(m6, p6, t0 + interval '10 minutes');
  perform pg_temp.say(m6, q6, t0 + interval '20 minutes');
  perform set_config('test.m4', m4::text, false);
  perform set_config('test.m5', m5::text, false);
  perform set_config('test.m6', m6::text, false);
end;
$$;

-- P4 가 30분 만에 나감 (이유 없이). 클라이언트 컨텍스트
select set_config('request.jwt.claim.sub', 'c24a0000-0000-4000-8000-000000000004', false);
set role authenticated;
do $$
declare j jsonb; mid uuid := current_setting('test.m4')::uuid; denied boolean := false;
begin
  -- 잘못된 이유는 거부
  begin
    j := public.conversation_leave(mid, 'bored');
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL invalid exit reason accepted'; end if;
  j := public.conversation_leave(mid, null);
  if (j->>'already_closed')::boolean or j->>'status' <> 'closed' or j->>'close_kind' <> 'left' or (j->>'closed_by')::uuid <> 'c24a0000-0000-4000-8000-000000000004' then
    raise exception 'FAIL leave result: %', j;
  end if;
end;
$$;
reset role;
-- Q5 가 3시간 뒤 '답장이 없어요' 로 나감
select set_config('request.jwt.claim.sub', 'c24b0000-0000-4000-8000-000000000005', false);
set role authenticated;
select public.conversation_leave(current_setting('test.m5')::uuid, 'no_reply') as q5_leave \gset
reset role;
select set_config('request.jwt.claim.sub', '', false);

-- 서버: 종료 시각을 고정값으로 맞추고(테스트 결정성), m6 은 0026 이전 종료처럼 시각 미상으로 만든다
update public.matches set closed_at = '2026-09-01 09:30:00+09' where id = current_setting('test.m4')::uuid;
update public.matches set closed_at = '2026-09-01 12:00:00+09' where id = current_setting('test.m5')::uuid;
update public.matches set status = 'closed' where id = current_setting('test.m6')::uuid;
update public.matches set closed_at = null, close_kind = 'unknown' where id = current_setting('test.m6')::uuid;

do $$
declare
  t0 timestamptz := '2026-09-01 09:00:00+09';
  r record;
  n int;
  q5 uuid := 'c24b0000-0000-4000-8000-000000000005';
begin
  -- m4: 조기 종료 (1시간 전, 메시지 없음)
  select * into r from public.conversation_pair_metrics(t0 + interval '2 days') where match_id = current_setting('test.m4')::uuid;
  if r.first_contact_class <> 'closed_early' or r.close_stage <> 'before_first_message' or r.close_kind <> 'left' or not r.close_time_known then
    raise exception 'FAIL m4 early close: % % %', r.first_contact_class, r.close_stage, r.close_kind;
  end if;
  if r.close_hours_after_match <> 0.5 or r.exit_reason is not null or r.observed_seconds <> 1800 then raise exception 'FAIL m4 close details: % % %', r.close_hours_after_match, r.exit_reason, r.observed_seconds; end if;
  -- 종료 전 시각으로 물으면 아직 활성 (observing 은 1시간 미만)
  select * into r from public.conversation_pair_metrics(t0 + interval '20 minutes') where match_id = current_setting('test.m4')::uuid;
  if r.closed or r.first_contact_class <> 'observing' then raise exception 'FAIL m4 as_of before close: % %', r.closed, r.first_contact_class; end if;

  -- m5: 첫 답장 전 종료, 대기는 종료 시점에서 멈춘다 (종료를 답장으로 세지 않는다)
  select * into r from public.conversation_pair_metrics(t0 + interval '2 days') where match_id = current_setting('test.m5')::uuid;
  if r.first_reply_status <> 'no_reply_closed' or r.first_reply_wait_seconds <> 170 * 60 then raise exception 'FAIL m5 reply status/wait: % %', r.first_reply_status, r.first_reply_wait_seconds; end if;
  if r.open_wait_status <> 'ended_by_close' or r.open_wait_seconds <> 170 * 60 or r.max_completed_wait_seconds is not null then raise exception 'FAIL m5 open wait: % %', r.open_wait_status, r.open_wait_seconds; end if;
  if r.close_stage <> 'before_first_reply' or r.closed_by <> q5 or r.exit_reason <> 'no_reply' or r.close_hours_after_match <> 3 then raise exception 'FAIL m5 close: % % %', r.close_stage, r.closed_by, r.exit_reason; end if;
  if r.stalled_now or r.stall_24h_reached or r.first_contact_class <> 'within_1h' then raise exception 'FAIL m5 stall must not apply after close'; end if;

  -- m6: 0026 이전 종료 — 시각 미상, 지속시간은 null, 단계는 메시지로 판단
  select * into r from public.conversation_pair_metrics(t0 + interval '2 days') where match_id = current_setting('test.m6')::uuid;
  if not r.closed or r.close_time_known or r.closed_at is not null or r.close_kind <> 'unknown' then raise exception 'FAIL m6 legacy close: % % %', r.closed, r.close_time_known, r.close_kind; end if;
  if r.close_hours_after_match is not null or r.open_wait_seconds is not null or r.silence_seconds is not null or r.observed_seconds is not null then raise exception 'FAIL m6 legacy durations must be null'; end if;
  if r.close_stage <> 'after_two_way' or r.first_contact_class <> 'within_1h' or r.first_reply_wait_seconds <> 600 then raise exception 'FAIL m6 legacy stage: % %', r.close_stage, r.first_reply_wait_seconds; end if;

  -- 나가기 이벤트는 각 1회, 이유는 이벤트에 없다
  select count(*) into n from public.analytics_events where event_type = 'conversation_left' and payload ? 'reason';
  if n <> 0 then raise exception 'FAIL exit reason leaked into analytics'; end if;
  -- matches 행(=Realtime payload) 에 이유 컬럼이 없다
  select count(*) into n from information_schema.columns where table_schema = 'public' and table_name = 'matches' and column_name ilike '%reason%';
  if n <> 0 then raise exception 'FAIL matches carries a reason column'; end if;
  -- cohort 집계
  select * into r from public.conversation_cohorts where cohort_week = date_trunc('week', (t0 at time zone 'Asia/Seoul'))::date;
  if r.matched < 6 or r.closed_early <> 1 or r.close_before_first_reply <> 1 or r.exit_no_reply <> 1 or r.exit_unanswered <> 1 or r.closed_unknown <> 1 then
    raise exception 'FAIL conversation_cohorts: matched=% early=% bfr=% no_reply=% unanswered=% unknown=%', r.matched, r.closed_early, r.close_before_first_reply, r.exit_no_reply, r.exit_unanswered, r.closed_unknown;
  end if;
end;
$$;

-- P5 관점: 상대(Q5)의 종료 이유는 보이지 않고, 종료 주체·시각은 보인다. 종료된 대화에 전송 불가, 신고는 가능
select set_config('request.jwt.claim.sub', 'c24a0000-0000-4000-8000-000000000005', false);
set role authenticated;
do $$
declare
  mid uuid := current_setting('test.m5')::uuid;
  n int; r record; j jsonb; denied boolean := false; msg text;
  conv uuid;
begin
  select count(*) into n from public.conversation_exits where match_id = mid;
  if n <> 0 then raise exception 'FAIL partner exit reason visible'; end if;
  select status, closed_by, close_kind, closed_at into r from public.matches where id = mid;
  if r.status <> 'closed' or r.closed_by <> 'c24b0000-0000-4000-8000-000000000005' or r.close_kind <> 'left' or r.closed_at is null then raise exception 'FAIL partner sees close facts: %', r; end if;
  select id into conv from public.conversations where match_id = mid;
  j := public.conversation_access(conv);
  if (j->>'can_chat')::boolean or j->>'reason' <> 'ended' then raise exception 'FAIL access after partner left: %', j; end if;
  begin
    perform public.send_message(conv, 'c0000000-0000-4000-8000-0000000024a1', '종료 후');
  exception when others then denied := true; msg := sqlerrm; end;
  if not denied then raise exception 'FAIL message sent after close'; end if;
  -- 이전 메시지는 볼 수 있다
  select count(*) into n from public.messages where conversation_id = conv;
  if n <> 1 then raise exception 'FAIL history hidden after close: %', n; end if;
  -- 신고 경로 유지
  insert into public.reports (reporter_id, reported_id, match_id, reason) values ('c24a0000-0000-4000-8000-000000000005', 'c24b0000-0000-4000-8000-000000000005', mid, 'other');
  -- 내 나가기 재호출: 상태 불변, 내 이유만 기록
  j := public.conversation_leave(mid, 'not_a_fit');
  if not (j->>'already_closed')::boolean or (j->>'closed_by')::uuid <> 'c24b0000-0000-4000-8000-000000000005' then raise exception 'FAIL leave on closed match changed owner: %', j; end if;
  select count(*) into n from public.conversation_exits where match_id = mid and user_id = 'c24a0000-0000-4000-8000-000000000005' and reason = 'not_a_fit';
  if n <> 1 then raise exception 'FAIL own late exit reason not recorded'; end if;
  -- 매치 직접 재활성화 불가 (정책 없음 → 0행)
  update public.matches set status = 'active' where id = mid;
  select status into r from public.matches where id = mid;
  if r.status <> 'active' and r.status <> 'closed' then raise exception 'FAIL'; end if;
  if r.status = 'active' then raise exception 'FAIL client reopened match'; end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', false);

do $$
declare mid uuid := current_setting('test.m5')::uuid; n int; denied boolean := false; msg text; conv uuid;
begin
  -- 나가기 이벤트는 종료 1회만 (재호출·상대 호출은 이벤트 없음)
  select count(*) into n from public.analytics_events where event_type = 'conversation_left' and payload->>'match_id' = mid::text;
  if n <> 1 then raise exception 'FAIL conversation_left events expected 1, got %', n; end if;
  -- 서버 역할이라도 closed → active 재전이는 거부
  begin
    update public.matches set status = 'active' where id = mid;
  exception when others then denied := true; msg := sqlerrm; end;
  if not denied or msg <> 'match_reopen_forbidden' then raise exception 'FAIL server reopened closed match: %', msg; end if;
  -- 서버 역할의 직접 insert 도 종료된 대화에는 저장되지 않는다 (트리거)
  select id into conv from public.conversations where match_id = mid;
  denied := false;
  begin
    insert into public.messages (conversation_id, sender_id, content) values (conv, 'c24a0000-0000-4000-8000-000000000005', '서버 직접');
  exception when others then denied := true; msg := sqlerrm; end;
  if not denied or msg <> 'conversation_closed' then raise exception 'FAIL direct insert into closed conversation: %', msg; end if;
  select count(*) into n from public.messages where conversation_id = conv;
  if n <> 1 then raise exception 'FAIL closed conversation gained messages'; end if;
end;
$$;

-- ===========================================================================
-- 3. 동시 대화 3개 제한 — 수락 RPC · 직접 경로 · 상대 자리 · 나가기로 재개 · 재매칭 차단
-- ===========================================================================
do $$
declare
  s  uuid := 'c24a0000-0000-4000-8000-000000000007';   -- 남 S
  f1 uuid := 'c24b0000-0000-4000-8000-000000000007';
  f2 uuid := 'c24b0000-0000-4000-8000-000000000008';
  f3 uuid := 'c24b0000-0000-4000-8000-000000000009';
  f4 uuid := 'c24b0000-0000-4000-8000-000000000010';
  today date := (now() at time zone 'Asia/Seoul')::date;
  n int;
  rid uuid;
begin
  -- 상호 좋아요로 매치 3개 (자리 확인 통과)
  insert into public.likes (from_user_id, to_user_id) values (f1, s), (s, f1), (f2, s), (s, f2), (f3, s), (s, f3);
  if public.conversation_active_count(s) <> 3 then raise exception 'FAIL S should have 3 active'; end if;
  -- F4 가 S 를 먼저 좋아함 (F4 는 자리 있음, S 는 상대 — 매치 생성 아님)
  insert into public.recommendations (user_id, candidate_id, for_date, card) values (f4, s, today, '{}');
  insert into public.likes (from_user_id, to_user_id) values (f4, s);
  -- S 에게 F4 추천 (pending)
  insert into public.recommendations (user_id, candidate_id, for_date, card) values (s, f4, today, '{}') returning id into rid;
  perform set_config('test.rec_s_f4', rid::text, false);
  -- 배치 대상에서 자리 없는 S 제외
  select count(*) into n from public.recommendation_batch_targets(today + 1, null, 100) t where t.user_id = s;
  if n <> 0 then raise exception 'FAIL batch targets include a full user'; end if;
  select count(*) into n from public.conversation_slot_usage u where u.user_id = s and u.active_matches = 3 and u.slot_limit = 3;
  if n <> 1 then raise exception 'FAIL slot usage view'; end if;
  select count(*) into n from public.conversation_slot_overflow;
  if n <> 0 then raise exception 'FAIL overflow view should be empty'; end if;
end;
$$;

-- S 관점: 자리가 없으면 수락은 아무것도 남기지 않는다 (RPC 와 직접 경로 모두)
select set_config('request.jwt.claim.sub', 'c24a0000-0000-4000-8000-000000000007', false);
set role authenticated;
do $$
declare
  s uuid := 'c24a0000-0000-4000-8000-000000000007'; f4 uuid := 'c24b0000-0000-4000-8000-000000000010';
  rid uuid := current_setting('test.rec_s_f4')::uuid;
  j jsonb; n int; st text; denied boolean := false; msg text;
begin
  j := public.recommendation_accept(rid);
  if j->>'result' <> 'no_slot_self' then raise exception 'FAIL accept when full: %', j; end if;
  select status into st from public.recommendations where id = rid;
  if st <> 'pending' then raise exception 'FAIL recommendation changed despite no slot: %', st; end if;
  select count(*) into n from public.likes where from_user_id = s and to_user_id = f4;
  if n <> 0 then raise exception 'FAIL like recorded despite no slot'; end if;
  -- 예전 앱 경로(직접 update) 도 거부
  begin
    update public.recommendations set status = 'accepted', decided_at = now() where id = rid;
  exception when others then denied := true; msg := sqlerrm; end;
  if not denied or msg <> 'no_slot_self' then raise exception 'FAIL direct accept when full: %', msg; end if;
  denied := false;
  begin
    insert into public.likes (from_user_id, to_user_id, recommendation_id) values (s, f4, rid);
  exception when others then denied := true; msg := sqlerrm; end;
  if not denied or msg <> 'no_slot_self' then raise exception 'FAIL direct like when full: %', msg; end if;
  -- 열람 기록: 멱등, 본인만
  j := public.recommendation_mark_viewed(rid);
  if j->>'viewed_at' is null then raise exception 'FAIL mark viewed'; end if;
  perform pg_sleep(0.01);
  if (public.recommendation_mark_viewed(rid))->>'viewed_at' <> j->>'viewed_at' then raise exception 'FAIL mark viewed not idempotent'; end if;
  denied := false;
  begin
    update public.recommendations set viewed_at = now() - interval '1 day' where id = rid;
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client set viewed_at directly'; end if;
  -- 내 대화 3개가 보인다 (개수는 내 것만)
  select count(*) into n from public.matches where status = 'active';
  if n <> 3 then raise exception 'FAIL own active matches: %', n; end if;
end;
$$;
reset role;

-- 타인의 추천은 열람 기록 불가
select set_config('request.jwt.claim.sub', 'c24b0000-0000-4000-8000-000000000010', false);
set role authenticated;
do $$
declare denied boolean := false; j jsonb;
begin
  begin
    j := public.recommendation_mark_viewed(current_setting('test.rec_s_f4')::uuid);
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL viewed other user recommendation'; end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', false);

-- 서버: 오늘 실행 기록이 slots_full 이면 그날은 skip (재훑기 없음)
do $$
declare s uuid := 'c24a0000-0000-4000-8000-000000000007'; today date := (now() at time zone 'Asia/Seoul')::date; j jsonb;
begin
  j := public.recommendation_run_claim(s, today + 2);
  if j->>'claim' <> 'claimed' then raise exception 'FAIL claim'; end if;
  perform public.recommendation_run_finish(s, today + 2, 'slots_full', 0, false);
  j := public.recommendation_run_claim(s, today + 2);
  if j->>'claim' <> 'skip' or j->>'result' <> 'slots_full' then raise exception 'FAIL claim after slots_full: %', j; end if;
end;
$$;

-- S 가 F1 과의 대화에서 나감 → 자리 1개 → 같은 추천 수락 가능 → 매치 (F4 의 좋아요와 상호)
select set_config('request.jwt.claim.sub', 'c24a0000-0000-4000-8000-000000000007', false);
set role authenticated;
do $$
declare
  s uuid := 'c24a0000-0000-4000-8000-000000000007'; f1 uuid := 'c24b0000-0000-4000-8000-000000000007'; f4 uuid := 'c24b0000-0000-4000-8000-000000000010';
  mid uuid; j jsonb; n int;
begin
  select id into mid from public.matches where user_a = least(s, f1) and user_b = greatest(s, f1);
  j := public.conversation_leave(mid, 'moved_elsewhere');
  if (j->>'already_closed')::boolean then raise exception 'FAIL leave'; end if;
  j := public.recommendation_accept(current_setting('test.rec_s_f4')::uuid);
  if j->>'result' <> 'matched' or j->>'match_id' is null then raise exception 'FAIL accept after freeing a slot: %', j; end if;
  -- 재시도는 같은 결과
  j := public.recommendation_accept(current_setting('test.rec_s_f4')::uuid);
  if j->>'result' <> 'matched' or not (j->>'retry')::boolean then raise exception 'FAIL accept retry: %', j; end if;
  select count(*) into n from public.matches where status = 'active';
  if n <> 3 then raise exception 'FAIL active after re-fill: %', n; end if;
  select count(*) into n from public.matches where user_a = least(s, f4) and user_b = greatest(s, f4);
  if n <> 1 then raise exception 'FAIL duplicate match rows'; end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', false);

-- 재매칭 차단: 종료된 F1 과 다시 좋아요/매치 불가 (어느 쪽이 시도해도), 추천 이력과 무관
do $$
declare
  s uuid := 'c24a0000-0000-4000-8000-000000000007'; f1 uuid := 'c24b0000-0000-4000-8000-000000000007';
  denied boolean := false; msg text; n int;
begin
  delete from public.likes where (from_user_id = s and to_user_id = f1) or (from_user_id = f1 and to_user_id = s);  -- 익명화(likes 삭제) 뒤 재가입 상황 재현
  begin
    insert into public.likes (from_user_id, to_user_id) values (f1, s);
  exception when others then denied := true; msg := sqlerrm; end;
  if not denied or msg <> 'already_matched' then raise exception 'FAIL re-like after closed match: %', msg; end if;
  denied := false;
  begin
    insert into public.likes (from_user_id, to_user_id) values (s, f1);
  exception when others then denied := true; msg := sqlerrm; end;
  if not denied then raise exception 'FAIL re-like (other direction) after closed match'; end if;
  select count(*) into n from public.matches where user_a = least(s, f1) and user_b = greatest(s, f1);
  if n <> 1 then raise exception 'FAIL match rows for closed pair: %', n; end if;
  select count(*) into n from public.likes where (from_user_id = s and to_user_id = f1) or (from_user_id = f1 and to_user_id = s);
  if n <> 0 then raise exception 'FAIL like rows recorded for matched pair'; end if;
end;
$$;

-- 상대 자리 부족: G(여) 3개 → H(남) 가 G 를 수락하면 no_slot_partner, H 의 추천·좋아요 불변, "거절" 아님
do $$
declare
  g  uuid := 'c24b0000-0000-4000-8000-000000000008';   -- F2: S 와 매치 1개 있음
  h  uuid := 'c24a0000-0000-4000-8000-000000000008';
  x1 uuid := 'c24a0000-0000-4000-8000-000000000001';
  x2 uuid := 'c24a0000-0000-4000-8000-000000000002';
  today date := (now() at time zone 'Asia/Seoul')::date;
  rid uuid;
begin
  -- G 가 H 를 먼저 좋아했었다 (아직 자리가 있을 때)
  insert into public.recommendations (user_id, candidate_id, for_date, card) values (g, h, today - 1, '{}');
  insert into public.likes (from_user_id, to_user_id) values (g, h);
  -- 그 뒤 G 가 2개 더 채운다 (X1, X2 — 각각 1개 활성)
  insert into public.likes (from_user_id, to_user_id) values (g, x1), (x1, g), (g, x2), (x2, g);
  if public.conversation_active_count(g) <> 3 then raise exception 'FAIL G should be full'; end if;
  insert into public.recommendations (user_id, candidate_id, for_date, card) values (h, g, today, '{}') returning id into rid;
  perform set_config('test.rec_h_g', rid::text, false);
end;
$$;
select set_config('request.jwt.claim.sub', 'c24a0000-0000-4000-8000-000000000008', false);
set role authenticated;
do $$
declare j jsonb; st text; n int; h uuid := 'c24a0000-0000-4000-8000-000000000008'; g uuid := 'c24b0000-0000-4000-8000-000000000008';
begin
  j := public.recommendation_accept(current_setting('test.rec_h_g')::uuid);
  if j->>'result' <> 'no_slot_partner' then raise exception 'FAIL partner full: %', j; end if;
  select status into st from public.recommendations where id = current_setting('test.rec_h_g')::uuid;
  if st <> 'pending' then raise exception 'FAIL recommendation not pending after partner_full: %', st; end if;
  select count(*) into n from public.likes where from_user_id = h and to_user_id = g;
  if n <> 0 then raise exception 'FAIL like left behind after partner_full'; end if;
  select count(*) into n from public.matches where user_a = least(h, g) and user_b = greatest(h, g);
  if n <> 0 then raise exception 'FAIL match created despite partner full'; end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', false);

-- 초과 계정 조회: 서버가 임의로 4번째 매치를 넣으면(예전 데이터 가정) overflow 뷰에 잡히고 새 매치만 막힌다 — 기존 대화는 그대로
do $$
declare
  g uuid := 'c24b0000-0000-4000-8000-000000000008'; x3 uuid := 'c24a0000-0000-4000-8000-000000000003';
  n int; mid uuid;
begin
  mid := pg_temp.mk_match(g, x3, now());
  select count(*) into n from public.conversation_slot_overflow o where o.user_id = g and o.active_matches = 4;
  if n <> 1 then raise exception 'FAIL overflow view'; end if;
  select count(*) into n from public.matches where status = 'active' and g in (user_a, user_b);
  if n <> 4 then raise exception 'FAIL overflow account conversations must be untouched'; end if;
  update public.matches set status = 'closed' where id = mid;  -- 정리
end;
$$;

-- ===========================================================================
-- 4. 퍼널 뷰 갱신 — sustained_7d 없음 · demo 쌍 제외 · 생성/확인/수락 구분 · 클라이언트 비공개
-- ===========================================================================
do $$
declare n int; r record;
begin
  select count(*) into n from information_schema.columns
  where table_schema = 'public' and table_name in ('funnel_user_facts', 'funnel_pair_facts', 'funnel_user_cohorts', 'funnel_pair_cohorts', 'beta_cohort_stats')
    and column_name = 'sustained_7d';
  if n <> 0 then raise exception 'FAIL sustained_7d still exposed in funnel views'; end if;
  select count(*) into n from information_schema.columns where table_schema = 'public' and table_name = 'funnel_user_cohorts' and column_name in ('viewed_recommendation', 'accepted_recommendation', 'cohort_age_days');
  if n <> 3 then raise exception 'FAIL funnel_user_cohorts new columns'; end if;
  -- demo 쌍은 매치 쌍 집계에서 빠진다 (m6 의 한쪽을 demo 로 바꾸면 그 주 집계가 1 줄어든다)
  select matched into r from public.conversation_cohorts where cohort_week = date_trunc('week', ('2026-09-01 09:00:00+09'::timestamptz at time zone 'Asia/Seoul'))::date;
  n := r.matched;
  update public.users set is_demo = true where id = 'c24a0000-0000-4000-8000-000000000006';
  select count(*) into r from public.funnel_pair_facts p where p.match_id = current_setting('test.m6')::uuid and p.is_demo;
  if r.count <> 1 then raise exception 'FAIL demo flag on pair facts'; end if;
  select count(*) into r from public.conversation_pair_facts p where p.match_id = current_setting('test.m6')::uuid and p.is_demo;
  if r.count <> 1 then raise exception 'FAIL demo flag on conversation facts'; end if;
  select matched into r from public.conversation_cohorts where cohort_week = date_trunc('week', ('2026-09-01 09:00:00+09'::timestamptz at time zone 'Asia/Seoul'))::date;
  if r.matched <> n - 1 then raise exception 'FAIL demo pair still counted in conversation_cohorts: % → %', n, r.matched; end if;
  select matched into r from public.funnel_pair_cohorts where cohort_week = date_trunc('week', ('2026-09-01 09:00:00+09'::timestamptz at time zone 'Asia/Seoul'))::date;
  if r.matched <> n - 1 then raise exception 'FAIL demo pair still counted in funnel_pair_cohorts: % → %', n, r.matched; end if;
  update public.users set is_demo = false where id = 'c24a0000-0000-4000-8000-000000000006';
  -- 사용자 단위: 추천 받음 ≠ 실제 확인 ≠ 수락
  select got_recommendation, viewed_recommendation, accepted_recommendation into r from public.funnel_user_facts where user_id = 'c24a0000-0000-4000-8000-000000000008';
  if not r.got_recommendation or r.viewed_recommendation or r.accepted_recommendation then raise exception 'FAIL H funnel facts: %', r; end if;
  select got_recommendation, viewed_recommendation, accepted_recommendation, left_conversation into r from public.funnel_user_facts where user_id = 'c24a0000-0000-4000-8000-000000000007';
  if not (r.got_recommendation and r.viewed_recommendation and r.accepted_recommendation and r.left_conversation) then raise exception 'FAIL S funnel facts: %', r; end if;
end;
$$;

select set_config('request.jwt.claim.sub', 'c24a0000-0000-4000-8000-000000000007', false);
set role authenticated;
do $$
declare v text; denied boolean; n int;
begin
  foreach v in array array['conversation_pair_facts', 'conversation_cohorts', 'conversation_slot_usage', 'conversation_slot_overflow', 'funnel_user_cohorts'] loop
    denied := false;
    begin
      execute format('select count(*) from public.%I', v) into n;
    exception when others then denied := true; end;
    if not denied then raise exception 'FAIL client can read %', v; end if;
  end loop;
  denied := false;
  begin
    perform * from public.conversation_pair_metrics(now());
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client can call conversation_pair_metrics'; end if;
  denied := false;
  begin
    n := public.conversation_active_count('c24a0000-0000-4000-8000-000000000008');
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client can call conversation_active_count'; end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', false);

select 'CONVERSATION TESTS PASSED' as result;
