-- account_deletion_tests.sql
-- Issue #13/#11/#14 — 탈퇴 유예·익명화(account_purge) 검증. local_supabase_mock.sql + 전체 마이그레이션(0019 포함) 적용 후 실행.
--   * deleted_at 자동 기록, 유예 전에는 대상 아님, 유예 뒤 대상
--   * 익명화 후: 프로필·응답·설정·추천·좋아요·만남 응답·알림·얼굴 행 없음, 상대에게 저장된 카드 비움,
--     메시지는 자리표시 문구로 남고 상대는 여전히 대화를 볼 수 있음, identity 는 해시·차단 플래그만, 계정 플래그 초기화
--   * active 계정은 익명화 거부, 클라이언트 JWT 로 호출 불가, 삭제 요청 테이블 서버 전용

\set ON_ERROR_STOP on

do $$
declare
  ud uuid := 'de1e0000-0000-4000-8000-000000000001';  -- 탈퇴할 사용자
  up uuid := 'de1e0000-0000-4000-8000-000000000002';  -- 상대
  m uuid;
  conv uuid;
  today date := (now() at time zone 'Asia/Seoul')::date;
begin
  perform set_config('request.jwt.claim.sub', '', false);
  insert into auth.users (id, email) values (ud, 'del-d@test.dev'), (up, 'del-p@test.dev');
  update public.users set onboarding_completed = true, identity_verified = true, face_verified = true, age_verified = true where id in (ud, up);
  insert into public.profiles (user_id, nickname, birth_year, gender, seeking_gender, region_code, height_cm, job_group, smoking, drinking)
  values (ud, '탈퇴자', 1994, 'male', 'female', 'seoul', 176, 'it', 'none', 'none'),
         (up, '상대방', 1996, 'female', 'male', 'seoul', 162, 'office', 'none', 'none');
  insert into public.private_profiles (user_id, marriage_intent, phone) values (ud, 4, '01099998888');
  insert into public.preference_settings (user_id) values (ud);
  insert into public.user_identities (user_id, identity_key_hash, identity_verified_at, birth_date, gender, adult_verified_at)
  values (ud, 'hash-del-d', now(), '1994-01-01', 'male', now());
  insert into public.face_verifications (user_id, status, provider, provider_session_id, liveness_passed, reference_path)
  values (ud, 'approved', 'didit', 'sess-del-d', true, ud || '/liveness/reference.jpg');
  insert into public.push_tokens (user_id, token, platform) values (ud, 'ExponentPushToken[deldeldeld]', 'ios');
  insert into public.recommendations (user_id, candidate_id, for_date, status, card) values
    (ud, up, today - 1, 'accepted', '{"nickname":"상대방"}'),
    (up, ud, today - 1, 'accepted', '{"nickname":"탈퇴자","age":32}');
  insert into public.likes (from_user_id, to_user_id) values (ud, up);
  insert into public.likes (from_user_id, to_user_id) values (up, ud);  -- 매치 생성
  select id into m from public.matches where user_a = least(ud, up) and user_b = greatest(ud, up);
  select id into conv from public.conversations where match_id = m;
  insert into public.messages (conversation_id, sender_id, content, client_message_id) values
    (conv, ud, '내 개인정보가 담긴 메시지', 'c0000000-0000-4000-8000-0000000000d1'),
    (conv, up, '상대의 메시지', null);
  insert into public.meetup_intentions (match_id, user_id, intent) values (m, ud, 'yes'), (m, up, 'yes');
  insert into public.meetup_outcomes (match_id, user_id, outcome) values (m, ud, 'met'), (m, up, 'met');
  insert into public.meetup_feedback (match_id, user_id, met_again_intent, form_version) values (m, ud, 'yes', 2);
  insert into public.analytics_events (user_id, event_type) values (ud, 'signup_started');
  insert into public.reports (reporter_id, reported_id, match_id, reason, detail) values (up, ud, m, 'spam', '증거 텍스트');
exception when others then
  raise;
end;
$$;

-- 1) 탈퇴 → deleted_at 자동, 유예 전엔 대상 아님
do $$
declare
  ud uuid := 'de1e0000-0000-4000-8000-000000000001';
  n int;
  j jsonb;
  denied boolean := false;
begin
  -- active 계정은 익명화 거부
  begin
    j := public.account_purge(ud);
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL purge of active account allowed'; end if;

  update public.users set status = 'deleted' where id = ud;
  select count(*) into n from public.users where id = ud and deleted_at is not null;
  if n <> 1 then raise exception 'FAIL deleted_at not set by trigger'; end if;
  select count(*) into n from public.account_purge_candidates(interval '30 days', 100) c where c.user_id = ud;
  if n <> 0 then raise exception 'FAIL candidate before grace'; end if;
  update public.users set deleted_at = now() - interval '31 days' where id = ud;
  select count(*) into n from public.account_purge_candidates(interval '30 days', 100) c where c.user_id = ud;
  if n <> 1 then raise exception 'FAIL candidate after grace'; end if;
  -- 복구하면 deleted_at 이 지워진다
  update public.users set status = 'active' where id = ud;
  select count(*) into n from public.users where id = ud and deleted_at is null;
  if n <> 1 then raise exception 'FAIL deleted_at not cleared on reactivate'; end if;
  update public.users set status = 'deleted' where id = ud;
  update public.users set deleted_at = now() - interval '31 days' where id = ud;
end;
$$;

-- 2) 얼굴 자산 목록 → 익명화 실행 → 결과 검증
do $$
declare
  ud uuid := 'de1e0000-0000-4000-8000-000000000001';
  up uuid := 'de1e0000-0000-4000-8000-000000000002';
  j jsonb;
  n int;
  t text;
  r record;
begin
  select count(*) into n from public.account_face_assets(ud) a where a.provider_session_id = 'sess-del-d';
  if n <> 1 then raise exception 'FAIL face assets listing'; end if;

  j := public.account_purge(ud);
  if (j->>'profiles')::int <> 1 or (j->>'messages_redacted')::int <> 1 or (j->>'face_verifications')::int <> 1 then
    raise exception 'FAIL purge summary: %', j;
  end if;

  select count(*) into n from public.profiles where user_id = ud; if n <> 0 then raise exception 'FAIL profile remains'; end if;
  select count(*) into n from public.private_profiles where user_id = ud; if n <> 0 then raise exception 'FAIL private profile remains'; end if;
  select count(*) into n from public.preference_settings where user_id = ud; if n <> 0 then raise exception 'FAIL prefs remain'; end if;
  select count(*) into n from public.push_tokens where user_id = ud; if n <> 0 then raise exception 'FAIL push token remains'; end if;
  select count(*) into n from public.face_verifications where user_id = ud; if n <> 0 then raise exception 'FAIL face row remains'; end if;
  select count(*) into n from public.likes where from_user_id = ud or to_user_id = ud; if n <> 0 then raise exception 'FAIL likes remain'; end if;
  select count(*) into n from public.recommendations where user_id = ud; if n <> 0 then raise exception 'FAIL own recommendations remain'; end if;
  select card::text into t from public.recommendations where user_id = up and candidate_id = ud;
  if t <> '{}' then raise exception 'FAIL card at partner not scrubbed: %', t; end if;
  select count(*) into n from public.meetup_intentions where user_id = ud; if n <> 0 then raise exception 'FAIL intent remains'; end if;
  select count(*) into n from public.meetup_outcomes where user_id = ud; if n <> 0 then raise exception 'FAIL outcome remains'; end if;
  select count(*) into n from public.meetup_feedback where user_id = ud; if n <> 0 then raise exception 'FAIL feedback remains'; end if;
  -- 상대의 응답·집계 상태는 남는다
  select count(*) into n from public.meetup_outcomes where user_id = up; if n <> 1 then raise exception 'FAIL partner outcome lost'; end if;

  -- 메시지: 행은 남고 본문은 자리표시. 상대 메시지는 그대로
  select content into t from public.messages where sender_id = ud;
  if t <> '(탈퇴한 사용자의 메시지입니다)' then raise exception 'FAIL message not redacted: %', t; end if;
  select content into t from public.messages where sender_id = up;
  if t <> '상대의 메시지' then raise exception 'FAIL partner message altered'; end if;
  select count(*) into n from public.messages where sender_id = ud and client_message_id is not null;
  if n <> 0 then raise exception 'FAIL client_message_id remains'; end if;

  -- 매치는 닫힘, 신고는 증거로 보존
  select status into t from public.matches where user_a = least(ud, up) and user_b = greatest(ud, up);
  if t <> 'closed' then raise exception 'FAIL match not closed: %', t; end if;
  select count(*) into n from public.reports where reported_id = ud and detail = '증거 텍스트';
  if n <> 1 then raise exception 'FAIL report evidence lost'; end if;

  -- identity: 해시·연결 유지, 생년월일·성별 제거
  select * into r from public.user_identities where user_id = ud;
  if r.identity_key_hash <> 'hash-del-d' or r.birth_date is not null or r.gender is not null or r.identity_verified_at is not null then
    raise exception 'FAIL identity not anonymized correctly';
  end if;
  -- 행동 로그 연결 해제
  select count(*) into n from public.analytics_events where user_id = ud; if n <> 0 then raise exception 'FAIL analytics still linked'; end if;

  -- 계정 스켈레톤
  select * into r from public.users where id = ud;
  if r.email is not null or r.onboarding_completed or r.identity_verified or r.face_verified or r.age_verified or r.purged_at is null or r.status <> 'deleted' then
    raise exception 'FAIL user skeleton not reset';
  end if;
  -- 이미 익명화된 계정은 대상에서 빠진다
  select count(*) into n from public.account_purge_candidates(interval '30 days', 100) c where c.user_id = ud;
  if n <> 0 then raise exception 'FAIL purged user still a candidate'; end if;
  -- 두 번 실행해도 안전
  j := public.account_purge(ud);
end;
$$;

-- 3) 상대는 여전히 대화를 볼 수 있다 (자리표시 문구), 탈퇴자 프로필은 보이지 않는다
select set_config('request.jwt.claim.sub', 'de1e0000-0000-4000-8000-000000000002', false);
set role authenticated;
do $$
declare n int; t text;
begin
  select count(*) into n from public.messages; if n <> 2 then raise exception 'FAIL partner cannot see conversation, got %', n; end if;
  select content into t from public.messages where sender_id = 'de1e0000-0000-4000-8000-000000000001';
  if t <> '(탈퇴한 사용자의 메시지입니다)' then raise exception 'FAIL partner sees original content'; end if;
  select count(*) into n from public.profiles where user_id = 'de1e0000-0000-4000-8000-000000000001';
  if n <> 0 then raise exception 'FAIL purged profile visible'; end if;
end;
$$;
reset role;

-- 4) 클라이언트 JWT 로는 익명화·대상 조회·삭제 요청 테이블 접근 불가
select set_config('request.jwt.claim.sub', 'de1e0000-0000-4000-8000-000000000002', false);
set role authenticated;
do $$
declare j jsonb; n int; denied boolean := false;
begin
  begin
    j := public.account_purge('de1e0000-0000-4000-8000-000000000002');
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client could purge'; end if;
  denied := false;
  begin
    select count(*) into n from public.account_purge_candidates(interval '1 day', 10);
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client could list candidates'; end if;
  denied := false;
  begin
    insert into public.account_deletion_requests (contact) values ('010-0000-0000');
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client could insert deletion request'; end if;
  denied := false;
  begin
    select count(*) into n from public.account_deletion_requests;
    if n = 0 then denied := true; end if;
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client can read deletion requests'; end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', false);

select 'ACCOUNT DELETION TESTS PASSED' as result;
