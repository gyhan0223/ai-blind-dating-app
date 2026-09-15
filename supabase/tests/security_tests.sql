-- security_tests.sql — Issue #27: 권한·RLS 회귀 테스트.
--   1) public 스키마의 모든 테이블에 RLS 가 켜져 있다
--   2) authenticated 가 실행할 수 있는 SECURITY DEFINER 함수는 allowlist 뿐이다 (새 함수를 만들면 이 목록을 의식적으로 갱신해야 한다)
--   3) authenticated 가 읽을 수 있는 뷰가 없다 (운영 뷰는 service role 전용)
--   4) 로그인하지 않은 anon 은 어떤 테이블에서도 행을 읽지 못한다
--   5) 서버 전용 테이블은 사용자 JWT 로 접근 시 거부되거나 0행이다
--   6) recommendations: 사용자는 status(pending→accepted/skipped)·skip_reason 만 바꿀 수 있다
--   7) reports: 하루 10건 넘게 신고할 수 없다 · analytics_events 상한
--   8) rate_limit_hit / admin_audit_record 는 사용자 JWT 로 호출할 수 없다
\set ON_ERROR_STOP on
select set_config('request.jwt.claim.sub', '', false);

-- ---------------------------------------------------------------------------
-- 1) RLS 전수
-- ---------------------------------------------------------------------------
do $$
declare bad text;
begin
  select string_agg(c.relname, ', ') into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if bad is not null then raise exception 'FAIL tables without RLS: %', bad; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2) SECURITY DEFINER allowlist (트리거 함수 제외)
-- ---------------------------------------------------------------------------
do $$
declare
  allowed text[] := array[
    'beta_access_allowed_self()',
    'beta_access_state()',
    'beta_join_waitlist(p_region_code text, p_birth_year integer, p_gender text)',
    'beta_redeem_invite(p_code text)',
    'can_chat_in(cid uuid)',
    'conversation_access(cid uuid)',
    'conversation_leave(p_match_id uuid, p_reason text)',
    'conversation_participant(cid uuid)',
    'is_blocked_pair(a uuid, b uuid)',
    'is_match_participant(mid uuid)',
    'identity_facts_self()',
    'is_matched_with(other uuid)',
    'meetup_mutual_yes(mid uuid)',
    'meetup_report_outcome(p_match_id uuid, p_outcome text, p_not_met_reason text)',
    'meetup_set_intent(p_match_id uuid, p_intent text, p_available_dates text[], p_preferred_region text)',
    'meetup_submit_feedback(p_match_id uuid, p_overall_satisfaction integer, p_met_again_intent text, p_next_intro_intent text, p_concerns text[])',
    'push_token_register(p_token text, p_platform text)',
    'rate_limit_hit_self(p_scope text, p_limit integer, p_window_seconds integer)',
    'recommendation_accept(p_recommendation_id uuid)',
    'recommendation_mark_viewed(p_recommendation_id uuid)'
  ];
  extra text;
begin
  select string_agg(sig, ', ') into extra from (
    select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef and p.prorettype <> 'trigger'::regtype
      and has_function_privilege('authenticated', p.oid, 'execute')
  ) s where not (sig = any (allowed));
  if extra is not null then raise exception 'FAIL SECURITY DEFINER functions executable by authenticated outside allowlist: %', extra; end if;
  -- anon 은 어떤 SECURITY DEFINER 함수도 실행할 수 없다 (RLS 정책 헬퍼 제외)
  select string_agg(sig, ', ') into extra from (
    select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef and p.prorettype <> 'trigger'::regtype
      and has_function_privilege('anon', p.oid, 'execute')
      and p.proname not in ('can_chat_in', 'conversation_participant', 'is_blocked_pair', 'is_match_participant', 'is_matched_with', 'meetup_mutual_yes', 'conversation_access')
  ) s;
  if extra is not null then raise exception 'FAIL SECURITY DEFINER functions executable by anon: %', extra; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) 뷰는 클라이언트에 비공개
-- ---------------------------------------------------------------------------
do $$
declare bad text;
begin
  select string_agg(c.relname, ', ') into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'v'
    and (has_table_privilege('authenticated', c.oid, 'select') or has_table_privilege('anon', c.oid, 'select'));
  if bad is not null then raise exception 'FAIL views readable by client roles: %', bad; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) anon(미로그인) 은 어떤 테이블에서도 0행
-- ---------------------------------------------------------------------------
set role anon;
do $$
declare
  t text;
  n int;
  leaked text := '';
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' order by 1 loop
    begin
      execute format('select count(*) from public.%I', t) into n;
      if n > 0 then leaked := leaked || t || ' '; end if;
    exception when insufficient_privilege then
      null;  -- 거부도 정상
    end;
  end loop;
  if leaked <> '' then raise exception 'FAIL anon can read rows from: %', leaked; end if;
end;
$$;
reset role;

-- ---------------------------------------------------------------------------
-- 픽스처 — 사용자 S1(추천 1건 받음), S2
-- ---------------------------------------------------------------------------
do $$
declare
  s1 uuid := '27270000-0000-4000-8000-000000000001';
  s2 uuid := '27270000-0000-4000-8000-000000000002';
  today date := (now() at time zone 'Asia/Seoul')::date;
begin
  insert into auth.users (id, email) values (s1, 'sec-1@test.dev'), (s2, 'sec-2@test.dev');
  update public.users set onboarding_completed = true, identity_verified = true, face_verified = true, age_verified = true where id in (s1, s2);
  insert into public.profiles (user_id, nickname, birth_year, gender, seeking_gender, region_code, height_cm, job_group, smoking, drinking)
  values (s1, '보안일', 1994, 'male', 'female', 'seoul', 176, 'it', 'none', 'none'),
         (s2, '보안이', 1996, 'female', 'male', 'seoul', 162, 'office', 'none', 'none');
  insert into public.recommendations (user_id, candidate_id, for_date, status, strategy, score_total, card)
  values (s1, s2, today, 'pending', 'high_confidence', 0.8, '{"nickname":"보안이"}');
end;
$$;

-- ---------------------------------------------------------------------------
-- 5)~8) S1 관점
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '27270000-0000-4000-8000-000000000001', false);
set role authenticated;

do $$
declare
  s1 uuid := '27270000-0000-4000-8000-000000000001';
  s2 uuid := '27270000-0000-4000-8000-000000000002';
  t text;
  n int;
  denied boolean;
  rec_id uuid;
  st text;
  sc numeric;
  i int;
  j jsonb;
begin
  -- 5) 서버 전용 테이블: 거부 또는 0행
  foreach t in array array['rate_limit_counters', 'admin_audit_log', 'app_settings', 'beta_cohorts', 'beta_invite_codes',
                           'user_identities', 'device_events', 'analytics_events', 'notification_events', 'moderation_actions',
                           'moderation_signals', 'server_errors', 'account_deletion_requests', 'recommendation_runs',
                           'face_webhook_events', 'face_verification_reviews', 'sms_otp_send_log'] loop
    begin
      execute format('select count(*) from public.%I', t) into n;
      if n > 0 then raise exception 'FAIL server-only table % readable (% rows)', t, n; end if;
    exception when insufficient_privilege then
      null;
    end;
  end loop;

  -- 6) recommendations 변경 범위
  select id into rec_id from public.recommendations where user_id = s1;
  denied := false;
  begin
    update public.recommendations set score_total = 1.0 where id = rec_id;
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client changed recommendation score'; end if;
  denied := false;
  begin
    update public.recommendations set card = '{"nickname":"조작"}'::jsonb where id = rec_id;
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client changed recommendation card'; end if;
  denied := false;
  begin
    update public.recommendations set status = 'expired' where id = rec_id;
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client set recommendation status to expired'; end if;

  update public.recommendations set status = 'skipped', skip_reason = 'not_now' where id = rec_id;
  select status, score_total into st, sc from public.recommendations where id = rec_id;
  if st <> 'skipped' or sc <> 0.8 then raise exception 'FAIL valid decision not applied: % %', st, sc; end if;

  denied := false;
  begin
    update public.recommendations set status = 'accepted' where id = rec_id;
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client re-decided a non-pending recommendation'; end if;

  -- 7) 신고 상한 10건/일 (사유 spam, 대상 S2 — 반복 신고는 내용상 허용되지만 상한에 걸린다)
  for i in 1..10 loop
    insert into public.reports (reporter_id, reported_id, reason, detail) values (s1, s2, 'spam', '테스트 ' || i);
  end loop;
  denied := false;
  begin
    insert into public.reports (reporter_id, reported_id, reason, detail) values (s1, s2, 'spam', '11번째');
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL 11th report in a day accepted'; end if;
  select count(*) into n from public.reports where reporter_id = s1;
  if n <> 10 then raise exception 'FAIL report count %, expected 10', n; end if;

  -- 8) 서버 전용 RPC
  denied := false;
  begin
    j := public.rate_limit_hit('x', 'y', 1, 60);
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client called rate_limit_hit'; end if;
  denied := false;
  begin
    n := public.admin_audit_record('me', 'hack', null, null, '{}'::jsonb);
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client called admin_audit_record'; end if;
end;
$$;

reset role;
select set_config('request.jwt.claim.sub', '', false);

-- 서버(트리거 밖)에서는 신고 상한이 적용되지 않는다 · 감사 기록은 서버에서 남는다
do $$
declare
  s1 uuid := '27270000-0000-4000-8000-000000000001';
  s2 uuid := '27270000-0000-4000-8000-000000000002';
  n int;
  j jsonb;
begin
  insert into public.reports (reporter_id, reported_id, reason, detail) values (s1, s2, 'spam', '서버 기록');
  select count(*) into n from public.reports where reporter_id = s1;
  if n <> 11 then raise exception 'FAIL server insert blocked by user rate limit'; end if;
  perform public.admin_audit_record('tester', 'security_test', 'user', s1::text, jsonb_build_object('ok', true));
  select count(*) into n from public.admin_audit_log where action = 'security_test';
  if n <> 1 then raise exception 'FAIL audit record missing'; end if;
  j := public.rate_limit_hit('sec-test', 'k', 2, 60);
  j := public.rate_limit_hit('sec-test', 'k', 2, 60);
  j := public.rate_limit_hit('sec-test', 'k', 2, 60);
  if (j->>'allowed')::boolean or (j->>'count')::int <> 3 or (j->>'retry_after_seconds')::int < 1 then
    raise exception 'FAIL rate_limit_hit result: %', j;
  end if;
  n := public.rate_limit_prune(interval '0 seconds');
end;
$$;

select 'SECURITY TESTS PASSED' as result;
