-- face_session_assets_tests.sql
-- Issue #11 — 세션별 reference 경로 · superseded 규칙 · 정리 큐 (0029). local_supabase_mock.sql + 전체 마이그레이션 적용 후 실행.
--   * 세션별 경로가 CHECK/정책 범위 안이고, 구 고정 경로 행도 유효
--   * 다른 approved 행이 있으면 face_liveness_approve 는 superseded (행은 expired/superseded, 플래그·현재 행 불변)
--   * expired/rejected 전이가 정리 큐에 등록되고, in_review/pending/approved 는 등록되지 않는다
--   * claim: 24시간 전엔 대상 아님 · 승인 행이 참조하는 구 고정 경로는 storage_path 가 null 로 · 늦게 approved 된 행은 cancelled
--     · 삭제 작업(#13) 이 있는 사용자는 제외 · lease 중 재획득 없음
--   * finish: 실패는 attempt_count 증가 + 백오프, done 은 완료 · prune
--   * 행 삭제(익명화)·사용자 삭제 시 cascade · 클라이언트 JWT 접근 불가
\set ON_ERROR_STOP on
select set_config('request.jwt.claim.sub', '', false);
reset role;

do $$
declare
  ua uuid := 'f11a0000-0000-4000-8000-000000000001';
  ub uuid := 'f11a0000-0000-4000-8000-000000000002';
begin
  insert into auth.users (id, email) values (ua, 'fsa-a@test.dev'), (ub, 'fsa-b@test.dev');
end;
$$;

-- 1) 경로 규칙 · superseded
do $$
declare
  ua uuid := 'f11a0000-0000-4000-8000-000000000001';
  old_id uuid;
  new_id uuid;
  cur uuid;
  res jsonb;
  st text; rs text; rp text;
  verified boolean;
  n int;
begin
  -- 구 고정 경로로 승인된 행 (기존 데이터 호환)
  insert into public.face_verifications (user_id, status, provider, provider_session_id, liveness_passed, expires_at)
  values (ua, 'pending', 'didit', 'fsa-sess-1', false, now() + interval '30 minutes') returning id into old_id;
  res := public.face_liveness_approve(old_id, ua, 'fsa-sess-1', ua || '/liveness/reference.jpg', true, 90, 'active', 'Approved', now(), 'liveness_approved');
  if (res->>'ok')::boolean is not true then raise exception 'FAIL legacy path approve: %', res; end if;
  select face_verification_id into cur from public.face_current_verification(ua);
  if cur <> old_id then raise exception 'FAIL current verification pointer'; end if;

  -- 새 세션(사용자가 다시 시작 — pending) 이 늦게 Approved 로 들어와도 superseded
  insert into public.face_verifications (user_id, status, provider, provider_session_id, liveness_passed, expires_at)
  values (ua, 'pending', 'didit', 'fsa-sess-2', false, now() + interval '30 minutes') returning id into new_id;
  res := public.face_liveness_approve(new_id, ua, 'fsa-sess-2', ua || '/liveness/' || new_id || '/reference.jpg', true, 95, 'active', 'Approved', now(), 'liveness_approved');
  if (res->>'reason') <> 'superseded' or (res->>'current_row_id')::uuid <> old_id then raise exception 'FAIL superseded: %', res; end if;
  select status, provider_reason, reference_path into st, rs, rp from public.face_verifications where id = new_id;
  if st <> 'expired' or rs <> 'superseded' or rp <> ua || '/liveness/' || new_id || '/reference.jpg' then
    raise exception 'FAIL superseded row state: % % %', st, rs, rp;
  end if;
  select status, reference_path into st, rp from public.face_verifications where id = old_id;
  select face_verified into verified from public.users where id = ua;
  if st <> 'approved' or rp <> ua || '/liveness/reference.jpg' or not verified then raise exception 'FAIL current row changed by superseded attempt'; end if;
  -- 정리 큐에 등록됐다 (세션별 경로 + Provider 세션)
  select count(*) into n from public.face_asset_cleanup where face_verification_id = new_id and reason = 'superseded'
     and storage_path = ua || '/liveness/' || new_id || '/reference.jpg' and provider_session_id = 'fsa-sess-2' and status = 'pending';
  if n <> 1 then raise exception 'FAIL superseded row not enqueued'; end if;
  -- superseded 된 행에 다시 approve 를 시도해도 되살아나지 않는다 (다른 approved 행이 있는 한)
  res := public.face_liveness_approve(new_id, ua, 'fsa-sess-2', ua || '/liveness/' || new_id || '/reference.jpg', true);
  if (res->>'reason') <> 'superseded' then raise exception 'FAIL superseded retry: %', res; end if;
  -- 이미 approved 인 행의 재호출은 여전히 멱등 ok
  res := public.face_liveness_approve(old_id, ua, 'fsa-sess-1', ua || '/liveness/reference.jpg', true);
  if (res->>'ok')::boolean is not true or (res->>'changed')::boolean then raise exception 'FAIL current row idempotent: %', res; end if;
end;
$$;

-- 2) 큐 등록 규칙 · claim 안전 조건
do $$
declare
  ua uuid := 'f11a0000-0000-4000-8000-000000000001';
  ub uuid := 'f11a0000-0000-4000-8000-000000000002';
  rev uuid; rej uuid; exp uuid; legacy uuid; late uuid;
  n int;
  c record;
  res jsonb;
begin
  -- in_review 는 등록되지 않는다 (관리자 검토 자료 보호)
  insert into public.face_verifications (user_id, status, provider, provider_session_id, liveness_passed, provider_reason)
  values (ub, 'pending', 'didit', 'fsa-b-review', false, null) returning id into rev;
  update public.face_verifications set status = 'in_review', liveness_passed = true, provider_reason = 'face_search_match' where id = rev;
  select count(*) into n from public.face_asset_cleanup where face_verification_id = rev; if n <> 0 then raise exception 'FAIL in_review enqueued'; end if;
  -- 관리자 거절 → rejected → 등록
  res := public.face_liveness_admin_review(rev, 'reject', 'ops', null);
  select count(*) into n from public.face_asset_cleanup where face_verification_id = rev and reason = 'rejected' and provider_session_id = 'fsa-b-review';
  if n <> 1 then raise exception 'FAIL rejected not enqueued'; end if;
  rej := rev;
  -- expired 전이 → 등록. 세션 id 도 경로도 없는 행은 등록하지 않는다
  insert into public.face_verifications (user_id, status, provider, provider_session_id) values (ub, 'pending', 'didit', 'fsa-b-exp') returning id into exp;
  update public.face_verifications set status = 'expired', provider_reason = 'session_expired' where id = exp;
  select count(*) into n from public.face_asset_cleanup where face_verification_id = exp and reason = 'expired'; if n <> 1 then raise exception 'FAIL expired not enqueued'; end if;
  insert into public.face_verifications (user_id, status, provider) values (ub, 'pending', 'didit') returning id into late;
  update public.face_verifications set status = 'expired' where id = late;
  select count(*) into n from public.face_asset_cleanup where face_verification_id = late; if n <> 0 then raise exception 'FAIL empty row enqueued'; end if;

  -- 24시간 전에는 claim 대상이 아니다
  select count(*) into n from public.face_asset_cleanup_claim(50); if n <> 0 then raise exception 'FAIL claimed before grace (%)', n; end if;
  update public.face_asset_cleanup set eligible_at = now() - interval '1 second';

  -- 구 고정 경로를 참조하는 expired 행: storage_path 는 null 로 돌려주고 provider 세션만 정리한다
  insert into public.face_verifications (user_id, status, provider, provider_session_id, reference_path)
  values (ua, 'pending', 'didit', 'fsa-a-legacy', null) returning id into legacy;
  update public.face_verifications set reference_path = ua || '/liveness/reference.jpg' where id = legacy;
  update public.face_verifications set status = 'expired' where id = legacy;
  update public.face_asset_cleanup set eligible_at = now() - interval '1 second' where face_verification_id = legacy;

  -- 늦게 approved 가 된 행의 항목은 cancelled (승인 행은 절대 정리하지 않는다)
  --   (expired 행을 다시 approved 로: 다른 approved 행이 없는 ub 로 시뮬레이션)
  update public.users set face_verified = false where id = ub;
  update public.face_verifications set liveness_passed = true where id = exp;
  res := public.face_liveness_approve(exp, ub, 'fsa-b-exp', ub || '/liveness/' || exp || '/reference.jpg', true);
  if (res->>'ok')::boolean is not true then raise exception 'FAIL late approve of expired row: %', res; end if;

  n := 0;
  for c in select * from public.face_asset_cleanup_claim(200) loop
    if c.user_id not in (ua, ub) then continue; end if;   -- 다른 테스트 파일이 만든 행은 무시
    n := n + 1;
    if c.storage_path = ua || '/liveness/reference.jpg' then raise exception 'FAIL legacy shared path handed to cleanup'; end if;
    if c.id = (select id from public.face_asset_cleanup where face_verification_id = exp) then raise exception 'FAIL approved row item claimed'; end if;
  end loop;
  -- claim 된 항목: superseded(ua, 세션별 경로 유지) · rejected(ub) · legacy(ua, 경로 null)
  if n <> 3 then raise exception 'FAIL claim count % (expected 3)', n; end if;
  select count(*) into n from public.face_asset_cleanup where face_verification_id = exp and status = 'cancelled'; if n <> 1 then raise exception 'FAIL late-approved item not cancelled'; end if;
  select count(*) into n from public.face_asset_cleanup where user_id in (ua, ub) and status in ('pending','failed') and lease_until > now(); if n <> 3 then raise exception 'FAIL leases not set'; end if;
  -- lease 중에는 다시 나오지 않는다
  select count(*) into n from public.face_asset_cleanup_claim(200) q where q.user_id in (ua, ub); if n <> 0 then raise exception 'FAIL re-claimed during lease'; end if;
  -- 세션별 경로 항목은 경로가 유지된다
  select count(*) into n from public.face_asset_cleanup q join public.face_verifications f on f.id = q.face_verification_id
   where f.provider_session_id = 'fsa-sess-2' and q.storage_path like ua || '/liveness/%/reference.jpg';
  if n <> 1 then raise exception 'FAIL per-session path dropped'; end if;

  -- finish: 실패 → attempt +1, 백오프, failed 상태로 남아 재시도 대상 / done → 완료
  res := public.face_asset_cleanup_finish((select id from public.face_asset_cleanup where face_verification_id = rej), 'failed', 'provider_server_error');
  select count(*) into n from public.face_asset_cleanup where face_verification_id = rej and status = 'failed' and attempt_count = 1 and last_error = 'provider_server_error' and eligible_at > now() and lease_until is null;
  if n <> 1 then raise exception 'FAIL finish failed state'; end if;
  res := public.face_asset_cleanup_finish((select id from public.face_asset_cleanup where face_verification_id = legacy), 'done', null);
  select count(*) into n from public.face_asset_cleanup where face_verification_id = legacy and status = 'done' and done_at is not null; if n <> 1 then raise exception 'FAIL finish done state'; end if;
  if (public.face_asset_cleanup_finish(gen_random_uuid(), 'done', null)->>'reason') <> 'not_found' then raise exception 'FAIL finish unknown id'; end if;
  -- 백오프가 지나면 다시 대상
  update public.face_asset_cleanup set eligible_at = now() - interval '1 second' where face_verification_id = rej;
  select count(*) into n from public.face_asset_cleanup_claim(200) q where q.id = (select id from public.face_asset_cleanup where face_verification_id = rej);
  if n <> 1 then raise exception 'FAIL failed item not retried after backoff'; end if;
  -- 최대 시도 초과는 제외
  update public.face_asset_cleanup set attempt_count = 20, lease_until = null where face_verification_id = rej;
  select count(*) into n from public.face_asset_cleanup_claim(200, 300, 20) q where q.id = (select id from public.face_asset_cleanup where face_verification_id = rej);
  if n <> 0 then raise exception 'FAIL max attempts not enforced'; end if;

  -- 삭제 작업(#13)이 있는 사용자의 항목은 제외 → 삭제 작업이 전부 지운다
  update public.face_asset_cleanup set lease_until = null, status = 'pending', attempt_count = 0 where user_id = ua;
  update public.users set status = 'deleted' where id = ua;
  perform public.account_purge_job_claim(ua, 'anonymize', 'test');
  select count(*) into n from public.face_asset_cleanup_claim(200) q where q.user_id = ua; if n <> 0 then raise exception 'FAIL items claimed for user under purge'; end if;
  -- 익명화(행 삭제) → 항목 cascade
  perform public.account_purge(ua);
  select count(*) into n from public.face_asset_cleanup where user_id = ua; if n <> 0 then raise exception 'FAIL items not cascaded on purge'; end if;
  -- prune
  update public.face_asset_cleanup set done_at = now() - interval '40 days' where face_verification_id = legacy;
  n := public.face_asset_cleanup_prune(interval '30 days');
end;
$$;

-- 3) 클라이언트 접근 차단
select set_config('request.jwt.claim.sub', 'f11a0000-0000-4000-8000-000000000002', false);
set role authenticated;
do $$
declare n int; denied boolean := false; r record;
begin
  begin select count(*) into n from public.face_asset_cleanup; if n > 0 then raise exception 'rows'; end if; exception when others then denied := true; end;
  denied := false;
  begin select count(*) into n from public.face_asset_cleanup_claim(1); exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client could claim cleanup'; end if;
  denied := false;
  begin select * into r from public.face_current_verification('f11a0000-0000-4000-8000-000000000002'); exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client could read current verification'; end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', false);

select 'FACE SESSION ASSETS TESTS PASSED' as result;
