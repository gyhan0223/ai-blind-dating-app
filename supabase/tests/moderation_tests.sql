-- moderation_tests.sql
-- Issue #15/#16 — rate limit · 반복 스팸 · 위험 패턴 신호(오탐 방지 포함) · 신고 사유/긴급 · 관리자 조치 감사 · 서버 전용
-- local_supabase_mock.sql + 전체 마이그레이션(0020 포함) 적용 후 실행.

\set ON_ERROR_STOP on

do $$
declare
  ua uuid := '15160000-0000-4000-8000-000000000001';
  ub uuid := '15160000-0000-4000-8000-000000000002';
  m uuid;
begin
  perform set_config('request.jwt.claim.sub', '', false);
  insert into auth.users (id, email) values (ua, 'mod-a@test.dev'), (ub, 'mod-b@test.dev');
  update public.users set onboarding_completed = true where id in (ua, ub);
  insert into public.profiles (user_id, nickname, birth_year, gender, seeking_gender, region_code, height_cm, job_group, smoking, drinking)
  values (ua, '모더가', 1994, 'male', 'female', 'seoul', 176, 'it', 'none', 'none'),
         (ub, '모더나', 1996, 'female', 'male', 'seoul', 162, 'office', 'none', 'none');
  insert into public.matches (user_a, user_b) values (least(ua, ub), greatest(ua, ub)) returning id into m;
  insert into public.conversations (match_id) values (m);
  perform set_config('test.mod_conv', id::text, false) from public.conversations where match_id = m;
  perform set_config('test.mod_match', m::text, false);
end;
$$;

-- 1) 위험 패턴 함수: 오탐 없음(정상 대화) · 각 패턴 감지
do $$
declare f text[];
begin
  if array_length(public.message_risk_flags('주말에 카페 갈래요? 이번 주 토요일 3시 어때요'), 1) is not null then raise exception 'FAIL false positive: normal invite'; end if;
  if array_length(public.message_risk_flags('저는 2010년에 대학 들어갔어요. 전화번호 대신 여기서 이야기해요'), 1) is not null then raise exception 'FAIL false positive: year/phone word'; end if;
  if array_length(public.message_risk_flags('요즘 투자한 시간이 많았어요… 아 이건 회사 얘기요'), 1) is null then null; end if; -- 투자 는 신호일 뿐 (보조 신호 허용)
  if array_length(public.message_risk_flags('점심에 도시락 싸왔어요. 라인 잘 잡힌 사진 아니에요'), 1) is not null then raise exception 'FAIL false positive: 라인 without id'; end if;
  f := public.message_risk_flags('제 번호는 010-1234-5678 이에요');
  if not ('contact_info' = any(f)) then raise exception 'FAIL phone not flagged'; end if;
  f := public.message_risk_flags('카톡 아이디 알려주세요');
  if not ('external_messenger' = any(f)) then raise exception 'FAIL kakao not flagged'; end if;
  f := public.message_risk_flags('급해서 그런데 계좌로 30만원만 송금해 줄 수 있어요?');
  if not ('money_request' = any(f)) then raise exception 'FAIL money not flagged'; end if;
  f := public.message_risk_flags('여기 들어와요 https://example.com/x');
  if not ('link' = any(f)) then raise exception 'FAIL link not flagged'; end if;
  f := public.message_risk_flags('진짜 병신같네');
  if not ('profanity' = any(f)) then raise exception 'FAIL profanity not flagged'; end if;
end;
$$;

-- 2) A 관점: 정상 전송, 반복 본문 제한, 초반 연락처 요구 신호, 신고 사유·긴급
select set_config('request.jwt.claim.sub', '15160000-0000-4000-8000-000000000001', false);
set role authenticated;
do $$
declare
  conv uuid := current_setting('test.mod_conv')::uuid;
  mid uuid := current_setting('test.mod_match')::uuid;
  r public.messages%rowtype;
  denied boolean := false;
  msg text;
  n int;
  i int;
begin
  r := public.send_message(conv, gen_random_uuid(), '안녕하세요, 반가워요');
  r := public.send_message(conv, gen_random_uuid(), '카톡 아이디 알려주시면 거기서 얘기해요');  -- 초반 연락처 요구 → 신호
  -- 같은 본문 3회까지, 4번째 거부
  r := public.send_message(conv, gen_random_uuid(), 'ㅋㅋ');
  r := public.send_message(conv, gen_random_uuid(), 'ㅋㅋ');
  r := public.send_message(conv, gen_random_uuid(), 'ㅋㅋ');
  begin
    r := public.send_message(conv, gen_random_uuid(), 'ㅋㅋ');
  exception when others then denied := true; msg := sqlerrm; end;
  if not denied or msg <> 'repeated_content' then raise exception 'FAIL repeated content not limited: %', msg; end if;
  -- 대화당 60초 20건: 지금까지 5건 → 15건 더 보내면 20, 21번째 거부 (예외는 안쪽 블록에서 받아야 앞의 insert 가 롤백되지 않는다)
  for i in 1..15 loop
    r := public.send_message(conv, gen_random_uuid(), '메시지 ' || i);
  end loop;
  denied := false;
  begin
    r := public.send_message(conv, gen_random_uuid(), '21번째');
  exception when others then denied := true; msg := sqlerrm; end;
  if not denied or msg <> 'rate_limited' then raise exception 'FAIL rate limit not applied: %', msg; end if;
  select count(*) into n from public.messages where conversation_id = conv;
  if n <> 20 then raise exception 'FAIL expected 20 stored messages, got %', n; end if;
end;
$$;
do $$
declare
  conv uuid := current_setting('test.mod_conv')::uuid;
  mid uuid := current_setting('test.mod_match')::uuid;
  n int;
  denied boolean := false;
  sev text;
begin
  -- 신고: 새 사유 + 긴급. 위협은 신고자 표시와 무관하게 urgent
  insert into public.reports (reporter_id, reported_id, match_id, reason, severity) values ('15160000-0000-4000-8000-000000000001', '15160000-0000-4000-8000-000000000002', mid, 'scam_money', 'urgent');
  insert into public.reports (reporter_id, reported_id, match_id, reason) values ('15160000-0000-4000-8000-000000000001', '15160000-0000-4000-8000-000000000002', mid, 'threat');
  select severity into sev from public.reports where reporter_id = '15160000-0000-4000-8000-000000000001' and reason = 'threat';
  if sev <> 'urgent' then raise exception 'FAIL threat not urgent'; end if;
  -- 일반 사유를 urgent 로 올릴 수 없다 (정책)
  begin
    insert into public.reports (reporter_id, reported_id, reason, severity) values ('15160000-0000-4000-8000-000000000001', '15160000-0000-4000-8000-000000000002', 'spam', 'urgent');
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL spam marked urgent by reporter'; end if;
  -- 신호 테이블·감사 테이블은 클라이언트가 볼 수 없다
  denied := false;
  begin
    select count(*) into n from public.moderation_signals;
    if n = 0 then denied := true; end if;
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client can read moderation_signals'; end if;
  denied := false;
  begin
    perform public.admin_moderate_user('15160000-0000-4000-8000-000000000002', 'ban', 'x', null, 'me', null);
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client could moderate'; end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', false);

-- 3) 서버 관점: 신호 기록(원문 없음), 관리자 조치·감사·기간 정지 해제
do $$
declare
  ua uuid := '15160000-0000-4000-8000-000000000001';
  ub uuid := '15160000-0000-4000-8000-000000000002';
  conv uuid := current_setting('test.mod_conv')::uuid;
  n int;
  j jsonb;
  rid uuid;
  st text;
begin
  select count(*) into n from public.moderation_signals where user_id = ua and 'early_contact_request' = any(flags) and 'external_messenger' = any(flags);
  if n <> 1 then raise exception 'FAIL early contact signal expected 1, got %', n; end if;
  select count(*) into n from public.moderation_signals where user_id = ua;
  if n <> 1 then raise exception 'FAIL normal messages produced signals: %', n; end if;
  if exists (select 1 from information_schema.columns where table_name = 'moderation_signals' and column_name = 'content') then
    raise exception 'FAIL signals must not store content';
  end if;

  select id into rid from public.reports where reporter_id = ua and reason = 'scam_money';
  -- 경고 → 상태 불변, 감사 1건, 신고 actioned
  j := public.admin_moderate_user(ub, 'warn', '금전 요구 경고', rid, 'ops', null);
  if j->>'status' <> 'active' then raise exception 'FAIL warn changed status'; end if;
  select status, action_taken into st, j from (select status, to_jsonb(action_taken) as action_taken from public.reports where id = rid) s;
  if st <> 'actioned' or j <> to_jsonb('warned'::text) then raise exception 'FAIL report not updated by warn: % %', st, j; end if;
  -- 7일 정지 → status suspended + until, 만료 후 자동 해제 + 감사
  j := public.admin_moderate_user(ub, 'suspend', '반복 신고', null, 'ops', 7);
  if j->>'status' <> 'suspended' or j->>'suspended_until' is null then raise exception 'FAIL suspend: %', j; end if;
  update public.users set suspended_until = now() - interval '1 minute' where id = ub;
  if public.moderation_lift_expired_suspensions() <> 1 then raise exception 'FAIL lift count'; end if;
  select status into st from public.users where id = ub;
  if st <> 'active' then raise exception 'FAIL not lifted: %', st; end if;
  select count(*) into n from public.moderation_actions where user_id = ub and actor = 'system' and action = 'unsuspend';
  if n <> 1 then raise exception 'FAIL lift audit missing'; end if;
  -- 영구 차단 → banned + identity 동기화 트리거 경로 + 매치 종료
  j := public.admin_moderate_user(ub, 'ban', '사기', null, 'ops', null);
  select status into st from public.users where id = ub;
  if st <> 'banned' then raise exception 'FAIL ban'; end if;
  select status into st from public.matches where id = current_setting('test.mod_match')::uuid;
  if st <> 'closed' then raise exception 'FAIL match not closed on ban'; end if;
  select count(*) into n from public.moderation_actions where user_id = ub;
  if n <> 4 then raise exception 'FAIL audit rows expected 4 (warn,suspend,unsuspend,ban), got %', n; end if;
  -- 요약 뷰
  select sanctions into n from public.moderation_user_summary where user_id = ub;
  if n <> 3 then raise exception 'FAIL summary sanctions expected 3, got %', n; end if;
  -- 기각
  select id into rid from public.reports where reporter_id = ua and reason = 'threat';
  j := public.admin_moderate_user(ub, 'dismiss', '근거 없음', rid, 'ops', null);
  select status into st from public.reports where id = rid;
  if st <> 'dismissed' then raise exception 'FAIL dismiss'; end if;
end;
$$;

-- 4) 차단(banned)된 사용자는 메시지를 보낼 수 없다 (RLS can_chat_in)
select set_config('request.jwt.claim.sub', '15160000-0000-4000-8000-000000000002', false);
set role authenticated;
do $$
declare r public.messages%rowtype; denied boolean := false;
begin
  begin
    r := public.send_message(current_setting('test.mod_conv')::uuid, gen_random_uuid(), '차단 후');
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL banned user could send'; end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', false);

select 'MODERATION TESTS PASSED' as result;
