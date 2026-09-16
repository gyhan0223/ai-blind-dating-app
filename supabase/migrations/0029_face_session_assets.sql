-- 0029_face_session_assets.sql
-- Issue #11 — 재인증·실패 뒤 이전 얼굴 세션 데이터 정리 + 이전 세션이 최신 승인을 덮어쓰지 못하게 하는 규칙.
--
-- 배경
--   * reference image 가 사용자당 고정 경로(<uid>/liveness/reference.jpg) 에 upsert 됐다. 새 세션이 승인된 뒤 이전 세션의 웹훅이
--     늦게 도착하면 같은 경로를 덮어쓰고 approved 행이 둘이 됐다. 이전 세션 정리가 새 이미지를 지울 수도 있었다.
--   * 종료(expired/rejected/superseded)된 세션의 Provider 세션·이미지를 정리하는 경로가 없었다 (탈퇴 때만 삭제).
--
-- 이 마이그레이션
--   1) reference image 경로를 세션(행)별로 분리한다: <uid>/liveness/<face_verification_id>/reference.<ext>
--      (0013 의 CHECK `<uid>/liveness/%` 와 storage 정책(liveness/ 하위 클라이언트 차단)에 그대로 들어맞는다. 기존 고정 경로 행은 그대로 유효)
--      "현재 인증" = 그 사용자의 approved 행 중 verified_at 이 가장 최근인 행 (face_current_verification). users.face_verified 는 그 결과.
--   2) face_liveness_approve: 같은 사용자에게 다른 approved 행이 이미 있으면 이 행은 승인하지 않고 expired/superseded 로 마감한다
--      → { ok:false, reason:'superseded' }. 늦은 웹훅·sync·동시 인증이 최신 승인을 덮어쓰지 못한다.
--   3) face_asset_cleanup 큐 — 행이 expired/rejected 가 되면 트리거가 등록한다 (superseded 는 expired 의 사유 코드).
--      in_review(관리자 검토 중)·pending·approved 는 등록하지 않는다. 항목은 24시간 뒤부터 처리할 수 있다 (늦은 웹훅·재확인 여유 — 미확정 기본값).
--      claim RPC 가 처리 직전에 다시 확인한다: 행이 아직 종료 상태인가 · 승인 행이 그 경로를 참조하지 않는가(구 고정 경로 보호) · 삭제 작업(#13) 중인 사용자가 아닌가.
--      실행기(Storage/Provider 삭제)와 재시도 규칙은 #13 과 같다 (account-purge Edge `face_cleanup` 모드).
--   4) face_verifications/users 가 지워지면(익명화·hard delete) 큐 항목도 cascade — 삭제 작업이 전부 지우므로 중복 처리하지 않는다.

-- ---------------------------------------------------------------------------
-- 1) 현재 인증 조회 (service role 전용) — reference 포인터
-- ---------------------------------------------------------------------------
create or replace function public.face_current_verification(p_user_id uuid)
returns table (face_verification_id uuid, reference_path text, provider_session_id text, verified_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select fv.id, fv.reference_path, fv.provider_session_id, fv.verified_at
    from public.face_verifications fv
   where fv.user_id = p_user_id and fv.status = 'approved'
   order by fv.verified_at desc nulls last, fv.created_at desc
   limit 1;
$$;
revoke all on function public.face_current_verification(uuid) from public, anon, authenticated;
grant execute on function public.face_current_verification(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 2) 정리 큐
-- ---------------------------------------------------------------------------
create table if not exists public.face_asset_cleanup (
  id                   uuid primary key default gen_random_uuid(),
  face_verification_id uuid not null unique references public.face_verifications (id) on delete cascade,
  user_id              uuid not null references public.users (id) on delete cascade,
  storage_path         text check (storage_path is null or storage_path like (user_id::text || '/liveness/%')),
  provider             text,
  provider_session_id  text,
  reason               text not null check (reason in ('expired', 'rejected', 'superseded')),
  status               text not null default 'pending' check (status in ('pending', 'done', 'failed', 'cancelled')),
  eligible_at          timestamptz not null default now() + interval '24 hours',
  attempt_count        int not null default 0,
  last_error           text check (last_error is null or char_length(last_error) <= 64),
  lease_until          timestamptz,
  created_at           timestamptz not null default now(),
  done_at              timestamptz
);

comment on table public.face_asset_cleanup is
  '종료된 얼굴 세션(expired/rejected/superseded)의 이미지 경로·Provider 세션 정리 큐 (#11). 서버 전용. 항목은 행/사용자 삭제 시 cascade';

create index if not exists face_asset_cleanup_pending_idx on public.face_asset_cleanup (status, eligible_at) where status in ('pending', 'failed');

alter table public.face_asset_cleanup enable row level security;
revoke all on public.face_asset_cleanup from public, anon, authenticated;
grant all on public.face_asset_cleanup to service_role;

-- 종료 상태로 바뀌면 등록 (같은 행은 한 번만). 사유: superseded 는 provider_reason 으로 구분
create or replace function public.face_verifications_enqueue_cleanup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('expired', 'rejected') and (old.status is distinct from new.status)
     and (new.reference_path is not null or new.provider_session_id is not null) then
    insert into public.face_asset_cleanup (face_verification_id, user_id, storage_path, provider, provider_session_id, reason)
    values (new.id, new.user_id, new.reference_path, new.provider, new.provider_session_id,
            case when new.provider_reason = 'superseded' then 'superseded' when new.status = 'rejected' then 'rejected' else 'expired' end)
    on conflict (face_verification_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists face_verifications_enqueue_cleanup on public.face_verifications;
create trigger face_verifications_enqueue_cleanup
  after update of status on public.face_verifications
  for each row execute function public.face_verifications_enqueue_cleanup();

-- 처리 대상 획득 (service role 전용). 처리 직전 안전 조건을 다시 확인한다
create or replace function public.face_asset_cleanup_claim(p_limit int default 50, p_lease_seconds int default 300, p_max_attempts int default 20)
returns table (id uuid, user_id uuid, storage_path text, provider text, provider_session_id text, attempt_count int)
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
  ts timestamptz := now();
  row_status text;
  referenced boolean;
begin
  if auth.uid() is not null then
    raise exception 'server only' using errcode = '42501';
  end if;
  for c in
    select q.*
      from public.face_asset_cleanup q
     where q.status in ('pending', 'failed')
       and q.eligible_at <= ts
       and (q.lease_until is null or q.lease_until < ts)
       and q.attempt_count < greatest(1, p_max_attempts)
       and not exists (select 1 from public.account_purge_jobs j where j.user_id = q.user_id)   -- 삭제 작업이 전부 지운다
     order by q.eligible_at
     limit greatest(1, least(p_limit, 500))
     for update skip locked
  loop
    -- 사용자별 advisory lock: 승인 RPC 와 직렬화 (승인 도중의 경로를 지우지 않는다)
    perform pg_advisory_xact_lock(hashtext('face_liveness:' || c.user_id::text));
    select fv.status into row_status from public.face_verifications fv where fv.id = c.face_verification_id;
    if row_status is null or row_status not in ('expired', 'rejected') then
      -- 늦은 웹훅으로 approved/in_review 가 됐다 → 정리하지 않는다
      update public.face_asset_cleanup set status = 'cancelled', done_at = ts, last_error = 'row_not_terminal' where face_asset_cleanup.id = c.id;
      continue;
    end if;
    -- 승인 행이 같은 경로(구 고정 경로)를 참조하면 storage 는 건드리지 않는다
    referenced := c.storage_path is not null and exists (
      select 1 from public.face_verifications a
       where a.user_id = c.user_id and a.status = 'approved' and a.reference_path = c.storage_path
    );
    update public.face_asset_cleanup
       set lease_until = ts + make_interval(secs => greatest(30, least(p_lease_seconds, 3600))),
           storage_path = case when referenced then null else face_asset_cleanup.storage_path end
     where face_asset_cleanup.id = c.id;
    id := c.id;
    user_id := c.user_id;
    storage_path := case when referenced then null else c.storage_path end;
    provider := c.provider;
    provider_session_id := c.provider_session_id;
    attempt_count := c.attempt_count;
    return next;
  end loop;
  return;
end;
$$;
revoke all on function public.face_asset_cleanup_claim(int, int, int) from public, anon, authenticated;
grant execute on function public.face_asset_cleanup_claim(int, int, int) to service_role;

create or replace function public.face_asset_cleanup_finish(p_id uuid, p_outcome text, p_error_code text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    raise exception 'server only' using errcode = '42501';
  end if;
  if p_outcome not in ('done', 'failed') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_args');
  end if;
  update public.face_asset_cleanup
     set status = p_outcome,
         attempt_count = attempt_count + 1,
         last_error = case when p_outcome = 'done' then null else left(p_error_code, 64) end,
         lease_until = null,
         done_at = case when p_outcome = 'done' then now() else null end,
         -- 실패는 지수 백오프 (최대 1일)
         eligible_at = case when p_outcome = 'done' then eligible_at else now() + least(interval '1 day', make_interval(mins => 10 * power(2, least(attempt_count, 8))::int)) end
   where id = p_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.face_asset_cleanup_finish(uuid, text, text) from public, anon, authenticated;
grant execute on function public.face_asset_cleanup_finish(uuid, text, text) to service_role;

-- 완료 항목 정리 (기록은 face_verifications 행이 있는 동안만 의미 있다)
create or replace function public.face_asset_cleanup_prune(p_keep interval default interval '30 days')
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  delete from public.face_asset_cleanup where status in ('done', 'cancelled') and done_at < now() - p_keep;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.face_asset_cleanup_prune(interval) from public, anon, authenticated;
grant execute on function public.face_asset_cleanup_prune(interval) to service_role;

-- ---------------------------------------------------------------------------
-- 3) 승인 RPC: 다른 approved 행이 있으면 이 행은 superseded (0014 의 본체를 확장 — 시그니처 동일)
-- ---------------------------------------------------------------------------
create or replace function public.face_liveness_approve(
  p_row_id uuid,
  p_user_id uuid,
  p_provider_session_id text,
  p_reference_path text,
  p_liveness_passed boolean default false,
  p_liveness_score numeric default null,
  p_liveness_method text default null,
  p_provider_status text default null,
  p_provider_event_at timestamptz default null,
  p_reason text default 'liveness_approved'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.face_verifications%rowtype;
  u_verified boolean;
  changed boolean := false;
  event_at timestamptz := coalesce(p_provider_event_at, now());
  other_approved uuid;
begin
  if p_row_id is null or p_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_args');
  end if;

  perform pg_advisory_xact_lock(hashtext('face_liveness:' || p_user_id::text));

  select * into r from public.face_verifications where id = p_row_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'row_not_found');
  end if;
  if r.user_id <> p_user_id then
    return jsonb_build_object('ok', false, 'reason', 'user_mismatch');
  end if;
  if r.provider_session_id is null or p_provider_session_id is null
     or r.provider_session_id <> p_provider_session_id then
    return jsonb_build_object('ok', false, 'reason', 'session_mismatch');
  end if;
  if p_reference_path is null or p_reference_path not like (r.user_id::text || '/liveness/%') then
    return jsonb_build_object('ok', false, 'reason', 'reference_missing');
  end if;
  if not (coalesce(p_liveness_passed, false) or r.liveness_passed) then
    return jsonb_build_object('ok', false, 'reason', 'liveness_not_passed');
  end if;
  if r.status = 'rejected' then
    return jsonb_build_object('ok', false, 'reason', 'rejected_row');
  end if;

  -- #11: 같은 사용자에게 이미 다른 approved 행이 있으면 이 세션은 대체된 것이다 — 승인하지 않고 종료 처리 (정리 큐 등록은 트리거)
  if r.status <> 'approved' then
    select a.id into other_approved from public.face_verifications a
     where a.user_id = p_user_id and a.status = 'approved' and a.id <> p_row_id
     limit 1;
    if other_approved is not null then
      update public.face_verifications
         set status = 'expired',
             provider_reason = 'superseded',
             reference_path = coalesce(reference_path, p_reference_path),   -- 이미 저장된 세션별 이미지가 있으면 정리 큐가 지우도록 남긴다
             provider_event_at = greatest(coalesce(provider_event_at, event_at), event_at)
       where id = p_row_id;
      return jsonb_build_object('ok', false, 'reason', 'superseded', 'current_row_id', other_approved);
    end if;
  end if;

  select face_verified into u_verified from public.users where id = p_user_id for update;
  if u_verified is null then
    return jsonb_build_object('ok', false, 'reason', 'user_not_found');
  end if;

  if r.status <> 'approved'
     or r.reference_path is distinct from p_reference_path
     or not r.liveness_passed
     or r.verified_at is null then
    update public.face_verifications
       set status            = 'approved',
           liveness_passed   = true,
           reference_path    = p_reference_path,
           liveness_score    = coalesce(p_liveness_score, liveness_score),
           liveness_method   = coalesce(p_liveness_method, liveness_method),
           provider_status   = coalesce(p_provider_status, provider_status),
           provider_event_at = greatest(coalesce(provider_event_at, event_at), event_at),
           provider_reason   = coalesce(p_reason, 'liveness_approved'),
           verified_at       = coalesce(verified_at, now())
     where id = p_row_id;
    changed := true;
  end if;

  if not u_verified then
    update public.users set face_verified = true where id = p_user_id;
    changed := true;
  end if;

  return jsonb_build_object('ok', true, 'status', 'approved', 'face_verified', true, 'changed', changed);
end;
$$;
