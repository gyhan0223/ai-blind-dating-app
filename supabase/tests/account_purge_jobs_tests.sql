-- account_purge_jobs_tests.sql
-- Issue #13 — 삭제 작업 상태·lease·단계 기록·재시도·감사 보존 (0028). local_supabase_mock.sql + 전체 마이그레이션 적용 후 실행.
--   * active 계정은 작업 생성 거부 · 존재하지 않는 사용자 not_found
--   * claim 이 Provider 세션을 스냅샷하고, db 단계(account_purge)가 face_verifications 를 지운 뒤에도 스냅샷이 남는다
--   * 유효한 lease 중 재요청은 busy · lease 만료 뒤 재획득 · 죽은 lease 의 단계 기록은 거부
--   * provider 실패 시 남은 세션만 유지, done 이면 스냅샷 삭제 (무기한 보존 금지)
--   * release: 모든 단계 done 일 때만 done, 아니면 failed → batch_targets 가 재시도 대상으로 돌려준다 (10분 뒤)
--   * 운영자 skip 은 실패한 단계만, db 단계는 불가 · anonymize done 뒤 hard 요청은 auth 단계만 다시 연다
--   * 사용자 행이 사라져도(hard delete) 작업·이벤트 기록이 남는다 · prune
--   * 클라이언트 JWT 로는 어떤 RPC/테이블도 접근 불가
\set ON_ERROR_STOP on
select set_config('request.jwt.claim.sub', '', false);
reset role;

do $$
declare
  ua uuid := 'ac13a000-0000-4000-8000-000000000001';
  ub uuid := 'ac13a000-0000-4000-8000-000000000002';
begin
  insert into auth.users (id, email) values (ua, 'purge-a@test.dev'), (ub, 'purge-b@test.dev');
  update public.users set status = 'active' where id in (ua, ub);
  insert into public.face_verifications (user_id, status, provider, provider_session_id, liveness_passed, reference_path)
  values (ua, 'approved', 'didit', 'sess-purge-a1', true, ua || '/liveness/reference.jpg');
  insert into public.face_verifications (user_id, status, provider, provider_session_id)
  values (ua, 'expired', 'didit', 'sess-purge-a2');
end;
$$;

-- 1) 상태 검증 · 스냅샷 · lease
do $$
declare
  ua uuid := 'ac13a000-0000-4000-8000-000000000001';
  r jsonb;
  lease text;
  n int;
begin
  r := public.account_purge_job_claim(ua, 'anonymize', 'test');
  if (r->>'reason') <> 'not_deleted' then raise exception 'FAIL active user claim: %', r; end if;
  r := public.account_purge_job_claim(gen_random_uuid(), 'anonymize', 'test');
  if (r->>'reason') <> 'not_found' then raise exception 'FAIL unknown user claim: %', r; end if;
  select count(*) into n from public.account_purge_jobs; if n <> 0 then raise exception 'FAIL job created for refused claim'; end if;

  update public.users set status = 'deleted' where id = ua;
  r := public.account_purge_job_claim(ua, 'anonymize', 'test', 300);
  if (r->>'ok')::boolean is not true or (r->>'attempt_count')::int <> 1 then raise exception 'FAIL first claim: %', r; end if;
  lease := r->>'lease_owner';
  if jsonb_array_length(r->'provider_sessions') <> 2 then raise exception 'FAIL snapshot should hold 2 sessions: %', r; end if;
  if (r->'stages'->>'storage') <> 'pending' then raise exception 'FAIL initial stages: %', r; end if;

  -- 유효한 lease 중 재요청 → busy (관리자 중복 클릭 · 동시 worker)
  r := public.account_purge_job_claim(ua, 'anonymize', 'test2');
  if (r->>'reason') <> 'busy' then raise exception 'FAIL concurrent claim not busy: %', r; end if;
  select count(*) into n from public.account_purge_job_events where user_id = ua and outcome = 'busy';
  if n <> 1 then raise exception 'FAIL busy not recorded'; end if;

  -- 다른 owner 로는 단계 기록 불가
  r := public.account_purge_job_stage(ua, 'wrong-owner', 'storage', 'done', null, '{}'::jsonb);
  if (r->>'reason') <> 'lease_lost' then raise exception 'FAIL foreign lease accepted: %', r; end if;

  -- storage done, provider 부분 실패(1개 남음), db done
  r := public.account_purge_job_stage(ua, lease, 'storage', 'done', null, '{"removed": 3}'::jsonb);
  if (r->>'ok')::boolean is not true then raise exception 'FAIL storage stage: %', r; end if;
  r := public.account_purge_job_stage(ua, lease, 'provider', 'failed', 'provider_server_error', '{"deleted": 1}'::jsonb,
        '[{"provider":"didit","session_id":"sess-purge-a1","deleted":true},{"provider":"didit","session_id":"sess-purge-a2","deleted":false}]'::jsonb);
  if (r->>'ok')::boolean is not true then raise exception 'FAIL provider stage: %', r; end if;
  perform public.account_purge(ua);
  r := public.account_purge_job_stage(ua, lease, 'db', 'done', null, '{}'::jsonb);
  select count(*) into n from public.face_verifications where user_id = ua; if n <> 0 then raise exception 'FAIL face rows remain'; end if;
  -- db 단계 뒤에도 재시도용 스냅샷은 남는다
  select jsonb_array_length(provider_sessions) into n from public.account_purge_jobs where user_id = ua;
  if n <> 2 then raise exception 'FAIL snapshot lost after db stage'; end if;

  r := public.account_purge_job_release(ua, lease);
  if (r->>'status') <> 'failed' then raise exception 'FAIL release should be failed: %', r; end if;
  select count(*) into n from public.account_purge_jobs where user_id = ua and status = 'failed' and stage_storage = 'done' and stage_provider = 'failed'
     and provider_error = 'provider_server_error' and stage_db = 'done' and lease_owner is null;
  if n <> 1 then raise exception 'FAIL job state after release'; end if;
  -- 이미 익명화된 사용자는 purge_candidates 에서 빠지지만, 실패 작업은 batch_targets 에 (10분 뒤) 나타난다
  select count(*) into n from public.account_purge_batch_targets(interval '0 days', 100) t where t.user_id = ua;
  if n <> 0 then raise exception 'FAIL failed job retried immediately'; end if;
  update public.account_purge_jobs set updated_at = now() - interval '11 minutes' where user_id = ua;
  select count(*) into n from public.account_purge_batch_targets(interval '0 days', 100) t where t.user_id = ua and t.kind = 'retry';
  if n <> 1 then raise exception 'FAIL failed job not a retry target'; end if;

  -- 재획득 → 남은 세션만 스냅샷에서 온다 (deleted=true 표시 유지)
  r := public.account_purge_job_claim(ua, 'anonymize', 'test');
  if (r->>'attempt_count')::int <> 2 then raise exception 'FAIL reclaim attempt: %', r; end if;
  if (r->'stages'->>'storage') <> 'done' or (r->'stages'->>'db') <> 'done' or (r->'stages'->>'provider') <> 'failed' then
    raise exception 'FAIL reclaim stages: %', r;
  end if;
  if (r->'provider_sessions'->0->>'deleted')::boolean is not true or (r->'provider_sessions'->1->>'deleted')::boolean then
    raise exception 'FAIL snapshot deleted flags: %', r;
  end if;
  lease := r->>'lease_owner';
  r := public.account_purge_job_stage(ua, lease, 'provider', 'done', null, '{"deleted": 1}'::jsonb);
  select jsonb_array_length(provider_sessions) into n from public.account_purge_jobs where user_id = ua;
  if n <> 0 then raise exception 'FAIL snapshot not cleared after provider done'; end if;
  r := public.account_purge_job_release(ua, lease);
  if (r->>'status') <> 'done' then raise exception 'FAIL release should be done: %', r; end if;
  select count(*) into n from public.account_purge_jobs where user_id = ua and status = 'done' and completed_at is not null;
  if n <> 1 then raise exception 'FAIL done job'; end if;

  -- done 뒤 같은 모드 재요청 → already_done
  r := public.account_purge_job_claim(ua, 'anonymize', 'test');
  if (r->>'reason') <> 'already_done' then raise exception 'FAIL already_done: %', r; end if;
  -- hard 요청 → auth 단계만 다시 연다
  r := public.account_purge_job_claim(ua, 'hard', 'admin');
  if (r->>'ok')::boolean is not true or (r->>'mode') <> 'hard' or (r->'stages'->>'auth') <> 'pending' or (r->'stages'->>'db') <> 'done' then
    raise exception 'FAIL hard upgrade: %', r;
  end if;
  lease := r->>'lease_owner';
  r := public.account_purge_job_stage(ua, lease, 'auth', 'failed', 'auth_server_error', '{}'::jsonb);
  r := public.account_purge_job_release(ua, lease);
  if (r->>'status') <> 'failed' then raise exception 'FAIL hard release: %', r; end if;

  -- 운영자 skip: db 는 불가, 실패한 auth 는 가능 → done
  r := public.account_purge_job_skip_stage(ua, 'db', 'ops', 'x');
  if (r->>'reason') <> 'invalid_args' then raise exception 'FAIL db skip allowed: %', r; end if;
  r := public.account_purge_job_skip_stage(ua, 'storage', 'ops', 'x');
  if (r->>'reason') <> 'invalid_state' then raise exception 'FAIL skip of done stage allowed: %', r; end if;
  r := public.account_purge_job_skip_stage(ua, 'auth', 'ops', 'auth user already removed in dashboard');
  if (r->>'ok')::boolean is not true or (r->>'status') <> 'done' then raise exception 'FAIL auth skip: %', r; end if;
  select count(*) into n from public.account_purge_job_events where user_id = ua and stage = 'auth' and outcome = 'skipped' and actor = 'ops';
  if n <> 1 then raise exception 'FAIL skip not audited'; end if;

  -- lease 만료 뒤 재획득 (죽은 worker)
  update public.users set status = 'deleted' where id = 'ac13a000-0000-4000-8000-000000000002';
  r := public.account_purge_job_claim('ac13a000-0000-4000-8000-000000000002', 'anonymize', 'dead', 30);
  lease := r->>'lease_owner';
  update public.account_purge_jobs set lease_until = now() - interval '1 second' where user_id = 'ac13a000-0000-4000-8000-000000000002';
  r := public.account_purge_job_claim('ac13a000-0000-4000-8000-000000000002', 'anonymize', 'alive', 30);
  if (r->>'ok')::boolean is not true or (r->>'attempt_count')::int <> 2 then raise exception 'FAIL expired lease takeover: %', r; end if;
  r := public.account_purge_job_stage('ac13a000-0000-4000-8000-000000000002', lease, 'storage', 'done', null, '{}'::jsonb);
  if (r->>'reason') <> 'lease_lost' then raise exception 'FAIL dead worker could record: %', r; end if;
  perform public.account_purge_job_release('ac13a000-0000-4000-8000-000000000002', (select lease_owner from public.account_purge_jobs where user_id = 'ac13a000-0000-4000-8000-000000000002'));
end;
$$;

-- 2) hard delete 뒤에도 기록 유지 · 감사 이벤트에 민감정보 없음 · prune
do $$
declare
  ua uuid := 'ac13a000-0000-4000-8000-000000000001';
  n int;
  leaked int;
begin
  delete from auth.users where id = ua;   -- hard delete (cascade)
  select count(*) into n from public.users where id = ua; if n <> 0 then raise exception 'FAIL user row should be gone'; end if;
  select count(*) into n from public.account_purge_jobs where user_id = ua and status = 'done'; if n <> 1 then raise exception 'FAIL job lost after hard delete'; end if;
  select count(*) into n from public.account_purge_job_events where user_id = ua; if n < 8 then raise exception 'FAIL events lost after hard delete (%)', n; end if;
  select count(*) into leaked from public.account_purge_job_events where detail::text like '%sess-purge%' or detail::text like '%liveness%';
  if leaked <> 0 then raise exception 'FAIL session id / path leaked into events'; end if;
  -- hard delete 뒤 재요청은 사용자가 없어도 기존 작업 기준으로 처리된다 (already_done)
  if (public.account_purge_job_claim(ua, 'hard', 'admin')->>'reason') <> 'already_done' then raise exception 'FAIL claim after hard delete'; end if;
  update public.account_purge_jobs set completed_at = now() - interval '400 days' where user_id = ua;
  n := public.account_purge_jobs_prune(interval '365 days');
  if n <> 1 then raise exception 'FAIL prune: %', n; end if;
  select count(*) into n from public.account_purge_job_events where user_id = ua; if n <> 0 then raise exception 'FAIL events not pruned with job'; end if;
end;
$$;

-- 3) 클라이언트 JWT 차단
select set_config('request.jwt.claim.sub', 'ac13a000-0000-4000-8000-000000000002', false);
set role authenticated;
do $$
declare r jsonb; n int; denied boolean;
begin
  denied := false;
  begin r := public.account_purge_job_claim('ac13a000-0000-4000-8000-000000000002', 'anonymize', 'me'); exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client could claim purge job'; end if;
  denied := false;
  begin r := public.account_purge_job_skip_stage('ac13a000-0000-4000-8000-000000000002', 'auth', 'me'); exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client could skip stage'; end if;
  denied := false;
  begin select count(*) into n from public.account_purge_jobs; if n > 0 then raise exception 'rows'; end if; exception when others then denied := true; end;
  begin select count(*) into n from public.account_purge_job_events; if n > 0 then raise exception 'rows'; end if; exception when others then denied := true; end;
  denied := false;
  begin select count(*) into n from public.account_purge_batch_targets(interval '0 days', 10); exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client could list batch targets'; end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', false);

select 'ACCOUNT PURGE JOBS TESTS PASSED' as result;
