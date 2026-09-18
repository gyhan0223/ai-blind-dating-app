-- app_flow_tests.sql
-- 앱이 실제로 보내는 요청(사용자 JWT · RLS 적용)을 시드 데모 계정으로 순서대로 재현한다:
--   추천(조회·열람 기록·넘기기·수락→매치) → 대화(목록·접근·멱등 전송·읽음·지표·나가기) →
--   탈퇴/복구(delete-account Edge 가 service role 로 하는 일 그대로) → 신고·차단(트리거·비공개·재매칭 차단)
-- local_supabase_mock.sql + 전체 마이그레이션 + seed.sql 뒤, 시드 상태를 바꾸므로 run_local_check.sh 의 마지막에 실행한다.
--   지훈 A=a1000000-…0001 · 서연 B=b2000000-…0001 (시드 매치·대화) · 지우 C=b2000000-…0002 · 민준 D=a1000000-…0002

\set ON_ERROR_STOP on

create temp table ctx (k text primary key, v text); grant all on ctx to authenticated, service_role, anon;

-- ===================== 1. 추천 =====================
\echo '== [추천] 지훈(A): 오늘 pending 추천 조회 (RLS own)'
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', false); set role authenticated;
do $$ declare n int; rid uuid; begin
  select count(*), (array_agg(id))[1] into n, rid from public.recommendations where status='pending' and for_date=(now() at time zone 'Asia/Seoul')::date;
  if n <> 1 then raise exception 'FAIL A pending today = % (expected 1)', n; end if;
  insert into ctx values ('recA', rid::text);
  perform public.recommendation_mark_viewed(rid);
  perform public.recommendation_mark_viewed(rid);  -- 멱등
  raise notice 'ok: pending 1건 · mark_viewed 멱등';
end $$;
do $$ declare n int; begin
  select count(*) into n from public.recommendations where id=(select v::uuid from ctx where k='recA') and viewed_at is not null;
  if n <> 1 then raise exception 'FAIL viewed_at not set'; end if;
end $$;
\echo '== [추천] 지훈(A): 넘기기 (앱 update 그대로)'
do $$ declare n int; begin
  update public.recommendations set status='skipped', decided_at=now(), skip_reason='age', skip_reason_detail='too_old'
   where id=(select v::uuid from ctx where k='recA');
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL skip updated % rows', n; end if;
  -- 이미 skipped 인 것을 accepted 로 바꾸려는 시도는 거부돼야 한다
  begin
    update public.recommendations set status='accepted', decided_at=now() where id=(select v::uuid from ctx where k='recA');
    raise exception 'FAIL skipped→accepted allowed';
  exception when insufficient_privilege then null; end;
  raise notice 'ok: skip 저장 · 재결정 거부';
end $$;
reset role;
\echo '== [추천] 민준(D)↔지우(C) 서로 소개 → 수락 → 매치'
do $$ begin
  insert into public.recommendations (user_id, candidate_id, for_date, status, strategy, card)
  values ('a1000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000002', (now() at time zone 'Asia/Seoul')::date, 'pending', 'high_confidence', '{"nickname":"지우","age":30,"reasons":[]}'),
         ('b2000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000002', (now() at time zone 'Asia/Seoul')::date, 'pending', 'high_confidence', '{"nickname":"민준","age":31,"reasons":[]}');
end $$;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000002', false); set role authenticated;
do $$ declare j jsonb; rid uuid; begin
  select id into rid from public.recommendations where status='pending' and candidate_id='b2000000-0000-4000-8000-000000000002';
  j := public.recommendation_accept(rid);
  if j->>'result' <> 'liked' then raise exception 'FAIL D accept: %', j; end if;
  j := public.recommendation_accept(rid);  -- 재시도
  if j->>'result' <> 'liked' or (j->>'retry')::boolean is not true then raise exception 'FAIL D accept retry: %', j; end if;
  raise notice 'ok: D 수락 → liked (재시도 멱등)';
end $$;
reset role;
select set_config('request.jwt.claim.sub', 'b2000000-0000-4000-8000-000000000002', false); set role authenticated;
do $$ declare j jsonb; rid uuid; n int; begin
  select id into rid from public.recommendations where status='pending' and candidate_id='a1000000-0000-4000-8000-000000000002';
  j := public.recommendation_accept(rid);
  if j->>'result' <> 'matched' or j->>'match_id' is null then raise exception 'FAIL C accept: %', j; end if;
  insert into ctx values ('matchCD', j->>'match_id');
  select count(*) into n from public.conversations where match_id=(j->>'match_id')::uuid;
  if n <> 1 then raise exception 'FAIL conversation not created'; end if;
  insert into ctx select 'convCD', id::text from public.conversations where match_id=(j->>'match_id')::uuid;
  raise notice 'ok: C 수락 → matched · 대화방 생성';
end $$;
reset role;

-- ===================== 2. 대화 =====================
\echo '== [대화] 민준(D): 목록·접근·전송(멱등)·읽음·나가기'
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000002', false); set role authenticated;
do $$ declare conv uuid := (select v::uuid from ctx where k='convCD'); m public.messages; m2 public.messages; j jsonb; n int; nick text; begin
  -- 목록: 참여 매치 + 대화방 + 상대 프로필(닉네임)
  select count(*) into n from public.matches mt join public.conversations c on c.match_id=mt.id where mt.id=(select v::uuid from ctx where k='matchCD');
  if n <> 1 then raise exception 'FAIL match/conv not visible in list'; end if;
  select nickname into nick from public.profiles where user_id='b2000000-0000-4000-8000-000000000002';
  if nick is distinct from '지우' then raise exception 'FAIL partner nickname hidden: %', nick; end if;
  j := public.conversation_access(conv);
  if (j->>'can_chat')::boolean is not true then raise exception 'FAIL access: %', j; end if;
  m := public.send_message(conv, 'aaaaaaaa-0000-4000-8000-000000000001', '안녕하세요, 반가워요!');
  m2 := public.send_message(conv, 'aaaaaaaa-0000-4000-8000-000000000001', '안녕하세요, 반가워요!');
  if m.id <> m2.id then raise exception 'FAIL idempotent resend'; end if;
  begin
    perform public.send_message(conv, 'aaaaaaaa-0000-4000-8000-000000000001', '다른 내용');
    raise exception 'FAIL mismatch accepted';
  exception when others then if sqlerrm not like '%message_content_mismatch%' then raise; end if; end;
  select count(*) into n from public.messages where conversation_id=conv;
  if n <> 1 then raise exception 'FAIL message count %', n; end if;
  raise notice 'ok: 접근 ok · 전송 1건 · 같은 키 재전송 동일 행 · 내용 불일치 거부';
end $$;
reset role;
select set_config('request.jwt.claim.sub', 'b2000000-0000-4000-8000-000000000002', false); set role authenticated;
do $$ declare conv uuid := (select v::uuid from ctx where k='convCD'); n int; t int; begin
  select count(*) into n from public.messages where conversation_id=conv and sender_id <> 'b2000000-0000-4000-8000-000000000002' and read_at is null;
  if n <> 1 then raise exception 'FAIL unread count %', n; end if;
  update public.messages set read_at=now() where conversation_id=conv and sender_id <> 'b2000000-0000-4000-8000-000000000002' and read_at is null;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL mark read rows %', n; end if;
  select total_messages into t from public.conversation_metrics where conversation_id=conv;
  if t is distinct from 1 then raise exception 'FAIL metrics total_messages %', t; end if;
  perform public.send_message(conv, 'bbbbbbbb-0000-4000-8000-000000000001', '저도 반가워요 :)');
  raise notice 'ok: C 안 읽음 1 → 읽음 처리 · metrics 1 · 답장';
end $$;
reset role;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000002', false); set role authenticated;
do $$ declare conv uuid := (select v::uuid from ctx where k='convCD'); mid uuid := (select v::uuid from ctx where k='matchCD'); j jsonb; begin
  j := public.conversation_leave(mid, 'not_a_fit');
  if (j->>'already_closed')::boolean or j->>'close_kind' <> 'left' then raise exception 'FAIL leave: %', j; end if;
  j := public.conversation_access(conv);
  if j->>'reason' <> 'ended' then raise exception 'FAIL access after leave: %', j; end if;
  begin
    perform public.send_message(conv, 'cccccccc-0000-4000-8000-000000000001', '종료 후 전송');
    raise exception 'FAIL send after leave allowed';
  exception when others then
    if sqlerrm not like '%row-level security%' and sqlstate <> '42501' then raise exception 'FAIL unexpected send error: % %', sqlstate, sqlerrm; end if;
  end;
  raise notice 'ok: 나가기 → ended · 종료 후 전송 차단(blocked 로 분류됨)';
end $$;
reset role;
select set_config('request.jwt.claim.sub', 'b2000000-0000-4000-8000-000000000002', false); set role authenticated;
do $$ declare mid uuid := (select v::uuid from ctx where k='matchCD'); j jsonb; n int; nick text; begin
  j := public.conversation_leave(mid, null);
  if (j->>'already_closed')::boolean is not true then raise exception 'FAIL C leave after close: %', j; end if;
  -- 상대 이유는 비공개
  select count(*) into n from public.conversation_exits where match_id=mid;  -- RLS 로 0 이어야
  if n <> 0 then raise exception 'FAIL exit reasons visible to client: %', n; end if;
  -- 종료된 대화의 메시지는 여전히 열람 가능
  select count(*) into n from public.messages where conversation_id=(select v::uuid from ctx where k='convCD');
  if n <> 2 then raise exception 'FAIL closed conv messages %', n; end if;
  select nickname into nick from public.profiles where user_id='a1000000-0000-4000-8000-000000000002';
  raise notice 'ok: 상대 나가기 → already_closed · 이유 비공개 · 이전 메시지 열람 가능 · 종료 상대 닉네임=%', coalesce(nick, '(숨김→"종료된 대화 상대")');
end $$;
reset role;

-- ===================== 3. 탈퇴 / 복구 =====================
\echo '== [탈퇴] 서연(B) 탈퇴 (delete-account Edge 가 service role 로 하는 일 그대로)'
select set_config('request.jwt.claim.sub', 'b2000000-0000-4000-8000-000000000001', false); set role authenticated;
do $$ begin
  begin
    update public.users set status='deleted' where id='b2000000-0000-4000-8000-000000000001';
    raise exception 'FAIL client could set status';
  exception when others then if sqlerrm not like '%server%' then raise; end if; end;
  raise notice 'ok: 클라이언트는 status 를 직접 못 바꿈';
end $$;
reset role;
select set_config('request.jwt.claim.sub', '', false); set role service_role;
do $$ declare n int; begin
  update public.users set status='deleted' where id='b2000000-0000-4000-8000-000000000001';
  delete from public.push_tokens where user_id='b2000000-0000-4000-8000-000000000001';
  update public.recommendations set status='expired' where user_id='b2000000-0000-4000-8000-000000000001' and status='pending';
  select count(*) into n from public.users where id='b2000000-0000-4000-8000-000000000001' and status='deleted' and deleted_at is not null;
  if n <> 1 then raise exception 'FAIL deleted_at'; end if;
  raise notice 'ok: status=deleted · deleted_at 기록';
end $$;
reset role;
select set_config('request.jwt.claim.sub', 'b2000000-0000-4000-8000-000000000001', false); set role authenticated;
do $$ declare st text; j jsonb; conv uuid; begin
  select status into st from public.users where id='b2000000-0000-4000-8000-000000000001';
  if st <> 'deleted' then raise exception 'FAIL self status %', st; end if;  -- 앱: /auth/suspended 로 이동
  select c.id into conv from public.conversations c join public.matches m on m.id=c.match_id where 'b2000000-0000-4000-8000-000000000001' in (m.user_a, m.user_b) and m.status='active';
  j := public.conversation_access(conv);
  if j->>'reason' <> 'self_restricted' then raise exception 'FAIL deleted self access: %', j; end if;
  raise notice 'ok: 탈퇴자 본인 → self_restricted';
end $$;
reset role;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', false); set role authenticated;
do $$ declare j jsonb; conv uuid; begin
  select c.id into conv from public.conversations c join public.matches m on m.id=c.match_id where 'a1000000-0000-4000-8000-000000000001' in (m.user_a, m.user_b) and m.status='active';
  insert into ctx values ('convAB', conv::text);
  j := public.conversation_access(conv);
  if j->>'reason' <> 'unavailable' then raise exception 'FAIL partner of deleted: %', j; end if;
  begin
    perform public.send_message(conv, 'dddddddd-0000-4000-8000-000000000001', '탈퇴한 상대에게');
    raise exception 'FAIL send to deleted allowed';
  exception when others then if sqlstate <> '42501' then raise; end if; end;
  raise notice 'ok: 상대(A) → unavailable · 전송 차단';
end $$;
reset role;
\echo '== [복구] 서연(B) 30일 안 복구 (reactivate)'
select set_config('request.jwt.claim.sub', '', false); set role service_role;
do $$ declare n int; begin
  update public.users set status='active' where id='b2000000-0000-4000-8000-000000000001';
  select count(*) into n from public.users where id='b2000000-0000-4000-8000-000000000001' and status='active' and deleted_at is null;
  if n <> 1 then raise exception 'FAIL reactivate'; end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', false); set role authenticated;
do $$ declare j jsonb; begin
  j := public.conversation_access((select v::uuid from ctx where k='convAB'));
  if (j->>'can_chat')::boolean is not true then raise exception 'FAIL access after reactivate: %', j; end if;
  raise notice 'ok: 복구 후 대화 재개 가능';
end $$;
reset role;

-- ===================== 4. 차단 / 신고 =====================
\echo '== [차단] 지훈(A) → 서연(B) 신고 + 차단 (앱 insert 그대로)'
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', false); set role authenticated;
do $$ declare j jsonb; n int; mid uuid; begin
  select match_id into mid from public.conversations where id=(select v::uuid from ctx where k='convAB');
  -- 긴급 불가 사유에 urgent 는 거부 (앱은 보내지 않지만 서버도 막아야)
  begin
    insert into public.reports (reporter_id, reported_id, match_id, reason, detail, severity) values ('a1000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', mid, 'unpleasant_conversation', null, 'urgent');
    raise exception 'FAIL urgent on non-urgent reason allowed';
  exception when others then if sqlstate <> '42501' then raise; end if; end;
  insert into public.reports (reporter_id, reported_id, match_id, reason, detail, severity) values ('a1000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', mid, 'harassment', '불쾌한 메시지', 'urgent');
  insert into public.blocks (blocker_id, blocked_id) values ('a1000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001');
  begin
    insert into public.blocks (blocker_id, blocked_id) values ('a1000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001');
    raise exception 'FAIL duplicate block allowed';
  exception when unique_violation then
    if sqlerrm not like '%duplicate%' then raise exception 'FAIL dup message lacks "duplicate": %', sqlerrm; end if;
  end;
  select count(*) into n from public.matches where id=mid and status='blocked';
  if n <> 1 then raise exception 'FAIL match not blocked'; end if;
  j := public.conversation_access((select v::uuid from ctx where k='convAB'));
  if j->>'reason' <> 'ended' then raise exception 'FAIL access after block: %', j; end if;
  select count(*) into n from public.reports where reporter_id='a1000000-0000-4000-8000-000000000001';
  if n <> 1 then raise exception 'FAIL report count %', n; end if;
  raise notice 'ok: 신고 접수(urgent) · 차단 → 매치 blocked · 접근 ended · 중복 차단 메시지에 duplicate 포함';
end $$;
reset role;
select set_config('request.jwt.claim.sub', 'b2000000-0000-4000-8000-000000000001', false); set role authenticated;
do $$ declare j jsonb; n int; begin
  j := public.conversation_access((select v::uuid from ctx where k='convAB'));
  if j->>'reason' <> 'ended' then raise exception 'FAIL blocked partner access: %', j; end if;
  select count(*) into n from public.blocks;  -- 차단당한 쪽은 차단 행을 볼 수 없다
  if n <> 0 then raise exception 'FAIL blocked user sees block rows %', n; end if;
  select count(*) into n from public.reports;  -- 신고당한 쪽은 신고를 볼 수 없다
  if n <> 0 then raise exception 'FAIL reported user sees reports %', n; end if;
  begin
    perform public.send_message((select v::uuid from ctx where k='convAB'), 'eeeeeeee-0000-4000-8000-000000000001', '차단 후');
    raise exception 'FAIL send after block allowed';
  exception when others then if sqlstate <> '42501' then raise; end if; end;
  -- 차단당한 뒤 다시 좋아요/매치 시도 → already_matched (재매칭 차단)
  raise notice 'ok: 차단당한 쪽 → ended (차단 사실·신고 비공개) · 전송 차단';
end $$;
reset role;
\echo '== [차단] 차단 뒤 재소개 차단: 엔진 제외는 recommendation_db_test 가 검증. 여기서는 좋아요 재시도 → already_matched'
select set_config('request.jwt.claim.sub', '', false); set role service_role;
do $$ begin
  insert into public.recommendations (user_id, candidate_id, for_date, status, strategy, card)
  values ('b2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', (now() at time zone 'Asia/Seoul')::date + 1, 'pending', 'high_confidence', '{"nickname":"지훈"}');
end $$;
reset role;
select set_config('request.jwt.claim.sub', 'b2000000-0000-4000-8000-000000000001', false); set role authenticated;
do $$ declare j jsonb; rid uuid; begin
  select id into rid from public.recommendations where user_id='b2000000-0000-4000-8000-000000000001' and candidate_id='a1000000-0000-4000-8000-000000000001' and status='pending';
  j := public.recommendation_accept(rid);
  if j->>'match_id' is not null then raise exception 'FAIL re-match after block: %', j; end if;
  if exists (select 1 from public.matches where user_a=least('a1000000-0000-4000-8000-000000000001'::uuid,'b2000000-0000-4000-8000-000000000001'::uuid) and status='active') then raise exception 'FAIL active match recreated'; end if;
  if not public.is_blocked_pair('a1000000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000001') then raise exception 'FAIL blocked pair'; end if;
  raise notice 'ok: 차단된 쌍 재수락(%) → 새 매치 없음 · 여전히 차단 쌍', j->>'result';
end $$;
reset role;
\echo ' APP FLOW TESTS PASSED'
