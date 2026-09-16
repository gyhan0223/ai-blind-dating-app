-- 0028_account_purge_jobs.sql
-- Issue #13 — 계정 삭제(익명화·완전 삭제)를 "단계별 상태를 가진 작업(job)" 으로 바꾼다.
--
-- 배경 (0019 · account-purge Edge 의 한계)
--   * Storage 삭제 → Didit 세션 삭제 → account_purge RPC → auth 삭제 가 한 요청 안에서 순서대로 실행되고, 외부 삭제(Storage·Didit)는
--     best effort 였다. 실패해도 완료로 보고되거나, 설정이 없으면 건너뛰었고, 감사 기록은 users.purged_at 뿐이었다.
--   * account_purge RPC 가 face_verifications 행을 지우면 Didit 세션 id 도 사라져 나중에 Provider 삭제를 재시도할 수 없었다.
--
-- 이 마이그레이션
--   1) account_purge_jobs — 사용자당 1행. 단계(storage · provider · db · auth)별 상태/실패 코드/시각, 시도 횟수, lease(동시 worker 방지),
--      재시도에 필요한 Provider 세션 id 스냅샷(provider 단계가 끝나면 지운다 — 무기한 보존 금지).
--      users 와 FK 를 두지 않는다 → hard delete(auth.users cascade) 뒤에도 "무엇이 언제 어떻게 끝났는지" 를 확인할 수 있다.
--   2) account_purge_job_events — 단계별 시도 기록(append-only). 결과 코드만 저장하며 개인정보·원문 오류 메시지·경로·세션 id 는 넣지 않는다.
--   3) RPC (service role 전용)
--        account_purge_job_claim(user, mode, requested_by, lease_seconds)  → 작업 생성/획득 (원자적 lease). 완료·다른 worker 진행 중이면 그대로 알린다
--        account_purge_job_stage(user, lease_owner, stage, outcome, error_code, detail) → 단계 결과 기록 (lease 소유자만)
--        account_purge_job_release(user, lease_owner)                          → lease 반환 + 전체 상태 계산 (모든 단계 done → done, 아니면 failed)
--        account_purge_job_skip_stage(user, stage, actor, note)                → 운영자가 확인 후 단계를 건너뛰기 (감사 기록). 자동 경로는 절대 쓰지 않는다
--        account_purge_batch_targets(grace, limit)                              → 유예 지난 신규 대상 + 재시도 필요한 실패 작업 (진행 중 lease 제외)
--        account_purge_jobs_prune(keep)                                         → 완료된 작업의 기록 정리 (보관 기간은 미확정 — 기본 365일)
--   (account_purge RPC 본체(0019)는 이 파일에서 바꾸지 않는다. 0029/0030 이 얼굴 정리 큐·동의 기록을 같은 트랜잭션에서 지우도록 확장한다)
--
-- 단계 의존성 (docs/data-retention.md 7절)
--   storage · provider : 서로 독립, db 와도 독립 (스냅샷 덕분에 db 단계 뒤에도 재시도 가능)
--   db                 : storage/provider 결과와 무관하게 진행한다 — 외부 삭제의 일시적 실패가 로컬 개인정보 삭제를 막지 않는다
--   auth (hard 만)     : db 단계가 done 이어야 한다 (account_purge 가 users 행을 필요로 하므로 순서 고정)
--   전체 done          : 필요한 모든 단계가 done (또는 운영자가 사유와 함께 skipped). 하나라도 failed/pending 이면 완료가 아니다
--
-- "이미 삭제됨" 판정은 명확한 결과만 인정한다 (Storage: 재조회 결과 0건 / auth: user_not_found). Provider 설정 누락·네트워크·권한·429·5xx 는 전부 실패.

-- ---------------------------------------------------------------------------
-- 1) 작업 테이블
-- ---------------------------------------------------------------------------
create table if not exists public.account_purge_jobs (
  user_id            uuid primary key,                 -- FK 없음 (hard delete 뒤에도 기록 유지)
  mode               text not null check (mode in ('anonymize', 'hard')),
  status             text not null default 'pending' check (status in ('pending', 'running', 'failed', 'done')),
  requested_by       text not null default 'batch' check (char_length(requested_by) between 1 and 64),
  stage_storage      text not null default 'pending' check (stage_storage in ('pending', 'done', 'failed', 'skipped')),
  stage_provider     text not null default 'pending' check (stage_provider in ('pending', 'done', 'failed', 'skipped')),
  stage_db           text not null default 'pending' check (stage_db in ('pending', 'done', 'failed', 'skipped')),
  stage_auth         text not null default 'pending' check (stage_auth in ('pending', 'done', 'failed', 'skipped')),
  storage_error      text check (storage_error is null or char_length(storage_error) <= 64),
  provider_error     text check (provider_error is null or char_length(provider_error) <= 64),
  db_error           text check (db_error is null or char_length(db_error) <= 64),
  auth_error         text check (auth_error is null or char_length(auth_error) <= 64),
  storage_at         timestamptz,
  provider_at        timestamptz,
  db_at              timestamptz,
  auth_at            timestamptz,
  -- 재시도용 스냅샷: [{ "provider": "didit", "session_id": "...", "deleted": false }] — provider 단계가 done/skipped 되면 '[]' 로 비운다
  provider_sessions  jsonb not null default '[]'::jsonb,
  attempt_count      int not null default 0,
  lease_owner        text,
  lease_until        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  completed_at       timestamptz
);

comment on table public.account_purge_jobs is
  '계정 삭제 작업 상태 (#13). 사용자당 1행, users 와 FK 없음(hard delete 뒤에도 유지). 개인정보 없음 — 단계 상태·고정 오류 코드·시각·Provider 세션 id 스냅샷(단계 완료 시 삭제)';

create index if not exists account_purge_jobs_status_idx on public.account_purge_jobs (status, updated_at);

alter table public.account_purge_jobs enable row level security;
revoke all on public.account_purge_jobs from public, anon, authenticated;
grant all on public.account_purge_jobs to service_role;

create table if not exists public.account_purge_job_events (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.account_purge_jobs (user_id) on delete cascade,
  stage       text not null check (stage in ('job', 'storage', 'provider', 'db', 'auth')),
  outcome     text not null check (outcome in ('claimed', 'done', 'failed', 'skipped', 'released', 'busy')),
  error_code  text check (error_code is null or char_length(error_code) <= 64),
  actor       text check (actor is null or char_length(actor) <= 64),
  detail      jsonb not null default '{}'::jsonb,   -- 수치만 (removed_count 등). 경로·세션 id·오류 원문 금지
  created_at  timestamptz not null default now()
);

comment on table public.account_purge_job_events is '계정 삭제 작업의 단계별 시도 기록 (append-only, #13). 결과 코드·수치만 저장';

create index if not exists account_purge_job_events_user_idx on public.account_purge_job_events (user_id, created_at);

alter table public.account_purge_job_events enable row level security;
revoke all on public.account_purge_job_events from public, anon, authenticated;
grant all on public.account_purge_job_events to service_role;

-- ---------------------------------------------------------------------------
-- 2) 작업 획득 (생성 + lease) — 원자적. 동시 worker / 중복 관리자 요청은 busy 로 끝난다
-- ---------------------------------------------------------------------------
create or replace function public.account_purge_job_claim(
  p_user_id uuid,
  p_mode text default 'anonymize',
  p_requested_by text default 'batch',
  p_lease_seconds int default 300
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  u_status text;
  j public.account_purge_jobs%rowtype;
  owner text := encode(gen_random_bytes(12), 'hex');
  sessions jsonb;
  ts timestamptz := now();
begin
  if auth.uid() is not null then
    raise exception 'server only' using errcode = '42501';
  end if;
  if p_user_id is null or p_mode not in ('anonymize', 'hard') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_args');
  end if;

  -- 사용자별 직렬화 (작업 행이 아직 없어도 두 worker 가 동시에 만들지 못하게)
  perform pg_advisory_xact_lock(hashtext('account_purge:' || p_user_id::text));

  select status into u_status from public.users where id = p_user_id;
  select * into j from public.account_purge_jobs where user_id = p_user_id for update;

  if not found then
    -- 새 작업: 사용자는 반드시 존재하고 deleted/banned 여야 한다
    if u_status is null then
      return jsonb_build_object('ok', false, 'reason', 'not_found');
    end if;
    if u_status not in ('deleted', 'banned') then
      return jsonb_build_object('ok', false, 'reason', 'not_deleted');
    end if;
    -- Provider 세션 스냅샷 — db 단계가 face_verifications 를 지운 뒤에도 재시도할 수 있게 지금 저장한다
    select coalesce(jsonb_agg(jsonb_build_object('provider', a.provider, 'session_id', a.provider_session_id, 'deleted', false)), '[]'::jsonb)
      into sessions
      from public.account_face_assets(p_user_id) a
     where a.provider_session_id is not null;
    insert into public.account_purge_jobs (user_id, mode, requested_by, provider_sessions)
    values (p_user_id, p_mode, left(coalesce(nullif(trim(p_requested_by), ''), 'batch'), 64), sessions)
    returning * into j;
  else
    if j.status = 'done' then
      -- anonymize 가 끝난 뒤 hard 가 요청되면 auth 단계만 다시 연다
      if p_mode = 'hard' and j.mode = 'anonymize' then
        update public.account_purge_jobs
           set mode = 'hard', status = 'failed', stage_auth = 'pending', completed_at = null, updated_at = ts
         where user_id = p_user_id
         returning * into j;
      else
        return jsonb_build_object('ok', false, 'reason', 'already_done', 'job', to_jsonb(j) - 'provider_sessions' - 'lease_owner');
      end if;
    elsif p_mode = 'hard' and j.mode = 'anonymize' then
      update public.account_purge_jobs set mode = 'hard', updated_at = ts where user_id = p_user_id returning * into j;
    end if;
    -- 다른 worker 가 유효한 lease 를 쥐고 있으면 busy
    if j.status = 'running' and j.lease_until is not null and j.lease_until > ts then
      insert into public.account_purge_job_events (user_id, stage, outcome, actor) values (p_user_id, 'job', 'busy', left(p_requested_by, 64));
      return jsonb_build_object('ok', false, 'reason', 'busy', 'lease_until', j.lease_until);
    end if;
  end if;

  update public.account_purge_jobs
     set status = 'running',
         lease_owner = owner,
         lease_until = ts + make_interval(secs => greatest(30, least(p_lease_seconds, 3600))),
         attempt_count = attempt_count + 1,
         updated_at = ts
   where user_id = p_user_id
   returning * into j;

  insert into public.account_purge_job_events (user_id, stage, outcome, actor, detail)
  values (p_user_id, 'job', 'claimed', left(p_requested_by, 64), jsonb_build_object('attempt', j.attempt_count, 'mode', j.mode));

  return jsonb_build_object(
    'ok', true,
    'lease_owner', owner,
    'mode', j.mode,
    'attempt_count', j.attempt_count,
    'stages', jsonb_build_object('storage', j.stage_storage, 'provider', j.stage_provider, 'db', j.stage_db, 'auth', j.stage_auth),
    'provider_sessions', j.provider_sessions,
    'user_exists', u_status is not null
  );
end;
$$;

revoke all on function public.account_purge_job_claim(uuid, text, text, int) from public, anon, authenticated;
grant execute on function public.account_purge_job_claim(uuid, text, text, int) to service_role;

-- ---------------------------------------------------------------------------
-- 3) 단계 결과 기록 — lease 소유자만. provider done 이면 세션 스냅샷을 지운다 (부분 성공은 남은 세션만 유지)
-- ---------------------------------------------------------------------------
create or replace function public.account_purge_job_stage(
  p_user_id uuid,
  p_lease_owner text,
  p_stage text,
  p_outcome text,
  p_error_code text default null,
  p_detail jsonb default '{}'::jsonb,
  p_remaining_sessions jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  j public.account_purge_jobs%rowtype;
  ts timestamptz := now();
  code text := left(p_error_code, 64);
begin
  if auth.uid() is not null then
    raise exception 'server only' using errcode = '42501';
  end if;
  if p_stage not in ('storage', 'provider', 'db', 'auth') or p_outcome not in ('done', 'failed') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_args');
  end if;
  select * into j from public.account_purge_jobs where user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if j.lease_owner is null or p_lease_owner is null or j.lease_owner <> p_lease_owner or j.lease_until < ts then
    return jsonb_build_object('ok', false, 'reason', 'lease_lost');
  end if;
  if p_outcome = 'done' then code := null; end if;

  if p_stage = 'storage' then
    update public.account_purge_jobs set stage_storage = p_outcome, storage_error = code, storage_at = ts, updated_at = ts where user_id = p_user_id;
  elsif p_stage = 'provider' then
    update public.account_purge_jobs
       set stage_provider = p_outcome, provider_error = code, provider_at = ts, updated_at = ts,
           provider_sessions = case when p_outcome = 'done' then '[]'::jsonb else coalesce(p_remaining_sessions, provider_sessions) end
     where user_id = p_user_id;
  elsif p_stage = 'db' then
    update public.account_purge_jobs set stage_db = p_outcome, db_error = code, db_at = ts, updated_at = ts where user_id = p_user_id;
  else
    update public.account_purge_jobs set stage_auth = p_outcome, auth_error = code, auth_at = ts, updated_at = ts where user_id = p_user_id;
  end if;

  insert into public.account_purge_job_events (user_id, stage, outcome, error_code, detail)
  values (p_user_id, p_stage, p_outcome, code, coalesce(p_detail, '{}'::jsonb));
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.account_purge_job_stage(uuid, text, text, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.account_purge_job_stage(uuid, text, text, text, text, jsonb, jsonb) to service_role;

-- 전체 상태 계산: 필요한 단계가 전부 done/skipped 이면 done, 아니면 failed (재시도 대상)
create or replace function public.account_purge_job_release(p_user_id uuid, p_lease_owner text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  j public.account_purge_jobs%rowtype;
  ts timestamptz := now();
  complete boolean;
begin
  if auth.uid() is not null then
    raise exception 'server only' using errcode = '42501';
  end if;
  select * into j from public.account_purge_jobs where user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if j.lease_owner is null or p_lease_owner is null or j.lease_owner <> p_lease_owner then
    return jsonb_build_object('ok', false, 'reason', 'lease_lost');
  end if;
  complete := j.stage_storage in ('done', 'skipped') and j.stage_provider in ('done', 'skipped') and j.stage_db in ('done', 'skipped')
              and (j.mode = 'anonymize' or j.stage_auth in ('done', 'skipped'));
  update public.account_purge_jobs
     set status = case when complete then 'done' else 'failed' end,
         completed_at = case when complete then ts else null end,
         lease_owner = null, lease_until = null, updated_at = ts
   where user_id = p_user_id
   returning * into j;
  insert into public.account_purge_job_events (user_id, stage, outcome, detail)
  values (p_user_id, 'job', 'released', jsonb_build_object('status', j.status));
  return jsonb_build_object('ok', true, 'status', j.status, 'job', to_jsonb(j) - 'provider_sessions' - 'lease_owner');
end;
$$;

revoke all on function public.account_purge_job_release(uuid, text) from public, anon, authenticated;
grant execute on function public.account_purge_job_release(uuid, text) to service_role;

-- 운영자 판단으로 단계 건너뛰기 (예: Provider 콘솔에서 이미 삭제된 세션이 404 로 계속 실패). 자동 경로는 절대 호출하지 않는다.
create or replace function public.account_purge_job_skip_stage(p_user_id uuid, p_stage text, p_actor text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  j public.account_purge_jobs%rowtype;
  ts timestamptz := now();
begin
  if auth.uid() is not null then
    raise exception 'server only' using errcode = '42501';
  end if;
  if p_stage not in ('storage', 'provider', 'auth') or coalesce(btrim(p_actor), '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_args');   -- db 단계는 건너뛸 수 없다 (로컬 개인정보는 반드시 지운다)
  end if;
  select * into j from public.account_purge_jobs where user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if j.status = 'running' and j.lease_until is not null and j.lease_until > ts then
    return jsonb_build_object('ok', false, 'reason', 'busy');
  end if;
  if (p_stage = 'storage' and j.stage_storage <> 'failed') or (p_stage = 'provider' and j.stage_provider <> 'failed') or (p_stage = 'auth' and j.stage_auth <> 'failed') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_state');  -- 실패한 단계만 건너뛸 수 있다
  end if;
  if p_stage = 'storage' then
    update public.account_purge_jobs set stage_storage = 'skipped', storage_at = ts, updated_at = ts where user_id = p_user_id;
  elsif p_stage = 'provider' then
    update public.account_purge_jobs set stage_provider = 'skipped', provider_at = ts, provider_sessions = '[]'::jsonb, updated_at = ts where user_id = p_user_id;
  else
    update public.account_purge_jobs set stage_auth = 'skipped', auth_at = ts, updated_at = ts where user_id = p_user_id;
  end if;
  insert into public.account_purge_job_events (user_id, stage, outcome, actor, detail)
  values (p_user_id, p_stage, 'skipped', left(btrim(p_actor), 64), jsonb_build_object('note', left(coalesce(p_note, ''), 200)));
  -- 전체 상태 재계산
  select * into j from public.account_purge_jobs where user_id = p_user_id;
  if j.stage_storage in ('done', 'skipped') and j.stage_provider in ('done', 'skipped') and j.stage_db in ('done', 'skipped')
     and (j.mode = 'anonymize' or j.stage_auth in ('done', 'skipped')) then
    update public.account_purge_jobs set status = 'done', completed_at = ts, updated_at = ts where user_id = p_user_id;
  end if;
  select * into j from public.account_purge_jobs where user_id = p_user_id;
  return jsonb_build_object('ok', true, 'status', j.status);
end;
$$;

revoke all on function public.account_purge_job_skip_stage(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.account_purge_job_skip_stage(uuid, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4) 배치 대상: 유예 지난 신규 탈퇴 계정 + 실패한 작업(재시도). 유효한 lease 가 있는 작업은 제외
-- ---------------------------------------------------------------------------
create or replace function public.account_purge_batch_targets(p_grace interval default interval '30 days', p_limit int default 100)
returns table (user_id uuid, kind text, mode text)
language sql
stable
security definer
set search_path = public
as $$
  (
    select c.user_id, 'new'::text as kind, 'anonymize'::text as mode
      from public.account_purge_candidates(p_grace, greatest(1, least(p_limit, 500))) c
     where not exists (select 1 from public.account_purge_jobs j where j.user_id = c.user_id)
  )
  union all
  (
    select j.user_id, 'retry'::text, j.mode
      from public.account_purge_jobs j
     where j.status = 'failed'
       and (j.lease_until is null or j.lease_until < now())
       and j.updated_at < now() - interval '10 minutes'   -- 방금 실패한 작업을 같은 배치에서 연타하지 않는다
     order by j.updated_at
     limit greatest(1, least(p_limit, 500))
  )
  limit greatest(1, least(p_limit, 500));
$$;

revoke all on function public.account_purge_batch_targets(interval, int) from public, anon, authenticated;
grant execute on function public.account_purge_batch_targets(interval, int) to service_role;

-- 완료된 작업 기록 정리 — 보관 기간은 미확정 (docs/data-retention.md 7절). 기본 365일
create or replace function public.account_purge_jobs_prune(p_keep interval default interval '365 days')
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  delete from public.account_purge_jobs where status = 'done' and completed_at < now() - p_keep;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.account_purge_jobs_prune(interval) from public, anon, authenticated;
grant execute on function public.account_purge_jobs_prune(interval) to service_role;

-- 운영 화면용 요약 (service role 전용) — 실패 단계·재시도 가능 여부
create or replace function public.account_purge_job_summary(p_user_ids uuid[])
returns table (user_id uuid, mode text, status text, stage_storage text, stage_provider text, stage_db text, stage_auth text,
               storage_error text, provider_error text, db_error text, auth_error text, attempt_count int, updated_at timestamptz, running boolean)
language sql
stable
security definer
set search_path = public
as $$
  select j.user_id, j.mode, j.status, j.stage_storage, j.stage_provider, j.stage_db, j.stage_auth,
         j.storage_error, j.provider_error, j.db_error, j.auth_error, j.attempt_count, j.updated_at,
         (j.status = 'running' and j.lease_until is not null and j.lease_until > now()) as running
    from public.account_purge_jobs j
   where j.user_id = any (p_user_ids);
$$;

revoke all on function public.account_purge_job_summary(uuid[]) from public, anon, authenticated;
grant execute on function public.account_purge_job_summary(uuid[]) to service_role;
