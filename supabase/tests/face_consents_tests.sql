-- face_consents_tests.sql
-- Issue #12 — 얼굴 정보 처리 별도 동의 증적 (0030).
--   * 클라이언트 JWT 로는 insert/update/delete 불가 (본인·타인 모두), 본인 행만 조회
--   * 서버 insert: granted_at 은 서버 시각 (입력값 무시), (user, kind, version) 유일 → 중복 요청 멱등
--   * 버전 형식 · 종류 제약 · 익명화 시 삭제 · hard delete cascade
\set ON_ERROR_STOP on
select set_config('request.jwt.claim.sub', '', false);
reset role;

do $$
declare
  ua uuid := 'c012a000-0000-4000-8000-000000000001';
  ub uuid := 'c012a000-0000-4000-8000-000000000002';
begin
  insert into auth.users (id, email) values (ua, 'consent-a@test.dev'), (ub, 'consent-b@test.dev');
end;
$$;

-- 1) 클라이언트 쓰기 차단 (본인 행도, 타인 행도) · 시각 위조 불가
select set_config('request.jwt.claim.sub', 'c012a000-0000-4000-8000-000000000001', false);
set role authenticated;
do $$
declare
  ua uuid := 'c012a000-0000-4000-8000-000000000001';
  ub uuid := 'c012a000-0000-4000-8000-000000000002';
  denied boolean;
  n int;
begin
  denied := false;
  begin insert into public.face_consents (user_id, kind, doc_version) values (ua, 'face_biometric', '2026-09-16.draft.1'); exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client inserted own consent'; end if;
  denied := false;
  begin insert into public.face_consents (user_id, kind, doc_version, granted_at) values (ub, 'face_biometric', '2026-09-16.draft.1', '1999-01-01'); exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client inserted consent for another user'; end if;
  select count(*) into n from public.face_consents; if n <> 0 then raise exception 'FAIL client-visible rows before any consent'; end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', false);

-- 2) 서버 기록: 시각은 서버, 멱등, 제약
do $$
declare
  ua uuid := 'c012a000-0000-4000-8000-000000000001';
  ub uuid := 'c012a000-0000-4000-8000-000000000002';
  t timestamptz;
  n int;
  denied boolean;
begin
  insert into public.face_consents (user_id, kind, doc_version, granted_at) values (ua, 'face_biometric', '2026-09-16.draft.1', '1999-01-01');
  select granted_at into t from public.face_consents where user_id = ua;
  if t < now() - interval '1 minute' then raise exception 'FAIL granted_at not server time: %', t; end if;
  -- 중복 → unique 위반 (서버 어댑터는 ignoreDuplicates 로 멱등 처리)
  denied := false;
  begin insert into public.face_consents (user_id, kind, doc_version) values (ua, 'face_biometric', '2026-09-16.draft.1'); exception when unique_violation then denied := true; end;
  if not denied then raise exception 'FAIL duplicate consent allowed'; end if;
  insert into public.face_consents (user_id, kind, doc_version) values (ua, 'face_biometric', '2026-09-16.draft.1') on conflict (user_id, kind, doc_version) do nothing;
  select count(*) into n from public.face_consents where user_id = ua; if n <> 1 then raise exception 'FAIL idempotent upsert'; end if;
  -- granted_at 은 갱신으로도 바꿀 수 없다
  update public.face_consents set granted_at = '1999-01-01' where user_id = ua;
  select granted_at into t from public.face_consents where user_id = ua;
  if t < now() - interval '1 minute' then raise exception 'FAIL granted_at changed by update'; end if;
  -- 제약
  denied := false;
  begin insert into public.face_consents (user_id, kind, doc_version) values (ub, 'marketing', '1'); exception when check_violation then denied := true; end;
  if not denied then raise exception 'FAIL unknown kind allowed'; end if;
  denied := false;
  begin insert into public.face_consents (user_id, kind, doc_version) values (ub, 'face_biometric', 'bad version!'); exception when check_violation then denied := true; end;
  if not denied then raise exception 'FAIL bad version allowed'; end if;
  -- 새 버전은 별도 행 (재동의)
  insert into public.face_consents (user_id, kind, doc_version) values (ua, 'face_biometric', '2027-01-01.1');
  select count(*) into n from public.face_consents where user_id = ua; if n <> 2 then raise exception 'FAIL new version row'; end if;
end;
$$;

-- 3) 본인 행만 조회 · 갱신/삭제 불가
select set_config('request.jwt.claim.sub', 'c012a000-0000-4000-8000-000000000001', false);
set role authenticated;
do $$
declare n int; denied boolean;
begin
  select count(*) into n from public.face_consents; if n <> 2 then raise exception 'FAIL own rows not visible (%)', n; end if;
  update public.face_consents set revoked_at = now(); -- 정책 없음 → 0행
  select count(*) into n from public.face_consents where revoked_at is not null; if n <> 0 then raise exception 'FAIL client revoked consent'; end if;
  delete from public.face_consents;
  select count(*) into n from public.face_consents; if n <> 2 then raise exception 'FAIL client deleted consent'; end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', 'c012a000-0000-4000-8000-000000000002', false);
set role authenticated;
do $$
declare n int;
begin
  select count(*) into n from public.face_consents; if n <> 0 then raise exception 'FAIL other user sees consent rows'; end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', false);

-- 4) 익명화 시 삭제 · hard delete cascade
do $$
declare
  ua uuid := 'c012a000-0000-4000-8000-000000000001';
  ub uuid := 'c012a000-0000-4000-8000-000000000002';
  n int;
begin
  insert into public.face_consents (user_id, kind, doc_version) values (ub, 'face_biometric', '2026-09-16.draft.1');
  update public.users set status = 'deleted' where id = ua;
  perform public.account_purge(ua);
  select count(*) into n from public.face_consents where user_id = ua; if n <> 0 then raise exception 'FAIL consent not deleted on purge'; end if;
  delete from auth.users where id = ub;
  select count(*) into n from public.face_consents where user_id = ub; if n <> 0 then raise exception 'FAIL consent not cascaded on hard delete'; end if;
end;
$$;

select 'FACE CONSENTS TESTS PASSED' as result;
