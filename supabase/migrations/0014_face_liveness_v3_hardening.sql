-- 0014_face_liveness_v3_hardening.sql
-- Didit 얼굴 라이브니스 — API v3 계약 정합성 + 서버 안정성 보완 (0013 은 수정하지 않는다).
--
-- 배경
--   0013 의 승인 경로는 face_verifications.status='approved' 갱신과 users.face_verified=true 갱신이
--   Edge Function 의 서로 다른 요청으로 실행됐다. 둘 사이에서 실패하면 행만 approved 이고 사용자는 영원히
--   "처리 중" 에 머문다. 또 reference image 확보에 실패해도 approved 가 될 수 있었고, V3 웹훅의 event_id 를
--   멱등 처리에 쓰지 않았으며, 중복 얼굴로 in_review 가 된 사용자를 해소할 관리자 경로가 없었다.
--
-- 이 마이그레이션
--   1) face_liveness_approve  — 행 검증(user_id · provider_session_id · liveness_passed · reference_path) 후
--        face_verifications.approved + verified_at + users.face_verified=true 를 **하나의 트랜잭션** 으로 반영.
--        멱등: 이미 approved 인 행이라도 조건이 맞고 users.face_verified=false 인 비정상 상태면 플래그를 복구한다.
--        행 잠금(for update) 으로 동시 웹훅 + 앱 sync 가 들어와도 최종 상태가 같다.
--   2) face_liveness_admin_review — 관리자 승인/거절 + 감사 기록(face_verification_reviews) 을 같은 트랜잭션으로.
--        승인은 1) 을 재사용한다 (liveness_passed=true · reference_path 없으면 관리자도 승인 불가).
--   3) face_webhook_events — V3 웹훅 event_id 멱등 처리 테이블 (재전송은 Provider Decision 재조회 없이 200 duplicate).
--   4) face_verification_reviews — 처리자 · 시각 · 이전/이후 상태 · 비고. 매칭된 상대 사용자 정보는 어떤 컬럼에도 없다.
--   5) 새 테이블/함수는 전부 service role 전용 (public / anon / authenticated 권한 없음, RLS 정책 없음).
--
-- 라이브니스는 "실제 사람이 카메라 앞에 있다" 만 확인한다. 실명·생년월일·성인 여부를 증명하지 않는다.

-- ---------------------------------------------------------------------------
-- 1) provider_reason 설명 갱신 (텍스트 컬럼 — 제약 없음. 새 코드: awaiting_user, resubmission_requested,
--    reference_image_unavailable(승인 보류), admin_approved, admin_rejected)
-- ---------------------------------------------------------------------------
comment on column public.face_verifications.provider_reason is
  '사유 코드 (liveness_approved, liveness_declined, face_search_match, in_review, awaiting_user, resubmission_requested, '
  'session_expired, session_abandoned, superseded, provider_create_failed, decision_incomplete, reference_image_unavailable, '
  'admin_approved, admin_rejected). 사용자에게 유사 계정 정보를 노출하지 않는다';

-- ---------------------------------------------------------------------------
-- 2) V3 웹훅 event_id 멱등 테이블 (service role 전용)
-- ---------------------------------------------------------------------------
create table if not exists public.face_webhook_events (
  event_id            text primary key,
  provider            text not null default 'didit',
  provider_session_id text,
  webhook_type        text,
  provider_status     text,
  outcome             text not null,
  received_at         timestamptz not null default now()
);

comment on table public.face_webhook_events is
  'Provider 웹훅 event_id 처리 기록 — 같은 event_id 재전송은 Decision 재조회 없이 duplicate 로 응답한다. payload 는 저장하지 않는다';

create index if not exists face_webhook_events_received_idx on public.face_webhook_events (received_at);

alter table public.face_webhook_events enable row level security;
revoke all on table public.face_webhook_events from public, anon, authenticated;
grant all on table public.face_webhook_events to service_role;

-- ---------------------------------------------------------------------------
-- 3) 관리자 검토 감사 기록 (service role 전용)
-- ---------------------------------------------------------------------------
create table if not exists public.face_verification_reviews (
  id                   uuid primary key default gen_random_uuid(),
  face_verification_id uuid not null references public.face_verifications (id) on delete cascade,
  user_id              uuid not null references public.users (id) on delete cascade,
  action               text not null check (action in ('approve', 'reject')),
  previous_status      text not null,
  new_status           text not null,
  actor                text not null,
  note                 text,
  created_at           timestamptz not null default now()
);

comment on table public.face_verification_reviews is
  '관리자 얼굴 인증 검토 감사 기록 (처리자·시각·결과). 중복 매칭된 상대 사용자 정보·얼굴 이미지는 저장하지 않는다';

create index if not exists face_verification_reviews_row_idx
  on public.face_verification_reviews (face_verification_id, created_at desc);

alter table public.face_verification_reviews enable row level security;
revoke all on table public.face_verification_reviews from public, anon, authenticated;
grant all on table public.face_verification_reviews to service_role;

-- ---------------------------------------------------------------------------
-- 4) 원자적 승인 RPC (service role 전용, SECURITY DEFINER)
--
--  face_liveness_approve(p_row_id, p_user_id, p_provider_session_id, p_reference_path, p_liveness_passed, ...)
--    → { ok: true, status: 'approved', face_verified: true, changed: bool }
--    → { ok: false, reason: 'row_not_found' | 'user_mismatch' | 'session_mismatch' | 'reference_missing'
--                           | 'liveness_not_passed' | 'rejected_row' | 'user_not_found' | 'invalid_args' }
--
--  호출자(Edge Function)는 Provider Decision 을 직접 조회한 뒤에만 p_liveness_passed=true 로 호출한다.
--  행과 사용자 행을 for update 로 잠가 동시 호출을 직렬화한다. 조건 불충족이면 아무것도 바꾸지 않는다.
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
begin
  if p_row_id is null or p_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_args');
  end if;

  -- 사용자별 advisory lock: begin_session 과 같은 키로 직렬화 (세션 생성과 승인이 겹치지 않게)
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
    -- Provider Declined / 관리자 거절 행은 자동 승인으로 되살리지 않는다 (새 세션으로만 재시도)
    return jsonb_build_object('ok', false, 'reason', 'rejected_row');
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
           -- out-of-order 보호 트리거를 위해 저장값보다 과거로는 내려가지 않는다
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

revoke all on function public.face_liveness_approve(uuid, uuid, text, text, boolean, numeric, text, text, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.face_liveness_approve(uuid, uuid, text, text, boolean, numeric, text, text, timestamptz, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 5) 관리자 검토 RPC (service role 전용) — 승인/거절 + 감사 기록을 한 트랜잭션으로
--
--  face_liveness_admin_review(p_row_id, p_action, p_actor, p_note, p_reference_path, p_liveness_score, p_liveness_method, p_provider_status)
--    approve: 행이 in_review 이고 liveness_passed=true 이며 reference_path(인자 또는 행)가 있어야 한다 → face_liveness_approve
--    reject : 행이 in_review/pending 일 때만. status='rejected', provider_reason='admin_rejected'.
--             users.face_verified 는 true 로 만들지 않으며, 다른 approved 행이 없으면 false 로 유지한다.
--    → { ok: true, status, face_verified } | { ok: false, reason }
--  호출자(admin-face-review Edge Function)는 approve 전에 Provider Decision 을 다시 조회해 liveness Approved 를 확인한다.
-- ---------------------------------------------------------------------------
create or replace function public.face_liveness_admin_review(
  p_row_id uuid,
  p_action text,
  p_actor text,
  p_note text default null,
  p_reference_path text default null,
  p_liveness_score numeric default null,
  p_liveness_method text default null,
  p_provider_status text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.face_verifications%rowtype;
  res jsonb;
  ref text;
  has_other_approved boolean;
begin
  if p_row_id is null or p_action not in ('approve', 'reject') or coalesce(btrim(p_actor), '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_args');
  end if;
  if length(p_actor) > 64 or (p_note is not null and length(p_note) > 500) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_args');
  end if;

  select * into r from public.face_verifications where id = p_row_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'row_not_found');
  end if;

  if p_action = 'approve' then
    if r.status <> 'in_review' then
      return jsonb_build_object('ok', false, 'reason', 'invalid_state');
    end if;
    if not r.liveness_passed then
      return jsonb_build_object('ok', false, 'reason', 'liveness_not_passed');
    end if;
    ref := coalesce(p_reference_path, r.reference_path);
    if ref is null then
      return jsonb_build_object('ok', false, 'reason', 'reference_missing');
    end if;

    res := public.face_liveness_approve(
      r.id, r.user_id, r.provider_session_id, ref,
      true, p_liveness_score, p_liveness_method, p_provider_status, now(), 'admin_approved'
    );
    if coalesce((res->>'ok')::boolean, false) is not true then
      return res;
    end if;

    insert into public.face_verification_reviews
      (face_verification_id, user_id, action, previous_status, new_status, actor, note)
    values (r.id, r.user_id, 'approve', r.status, 'approved', btrim(p_actor), p_note);

    return jsonb_build_object('ok', true, 'status', 'approved', 'face_verified', true);
  end if;

  -- reject
  if r.status not in ('in_review', 'pending') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_state');
  end if;

  update public.face_verifications
     set status            = 'rejected',
         provider_reason   = 'admin_rejected',
         provider_event_at = greatest(coalesce(provider_event_at, now()), now())
   where id = r.id;

  select exists (
    select 1 from public.face_verifications
     where user_id = r.user_id and status = 'approved' and id <> r.id
  ) into has_other_approved;
  if not has_other_approved then
    update public.users set face_verified = false where id = r.user_id and face_verified;
  end if;

  insert into public.face_verification_reviews
    (face_verification_id, user_id, action, previous_status, new_status, actor, note)
  values (r.id, r.user_id, 'reject', r.status, 'rejected', btrim(p_actor), p_note);

  return jsonb_build_object('ok', true, 'status', 'rejected', 'face_verified', false);
end;
$$;

revoke all on function public.face_liveness_admin_review(uuid, text, text, text, text, numeric, text, text)
  from public, anon, authenticated;
grant execute on function public.face_liveness_admin_review(uuid, text, text, text, text, numeric, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 6) 오래된 웹훅 이벤트 기록 정리 (선택 — pg_cron 등으로 주기 실행. Didit 재시도는 수 분 안에 끝난다)
-- ---------------------------------------------------------------------------
create or replace function public.face_liveness_prune_webhook_events(p_older_than interval default interval '7 days')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  delete from public.face_webhook_events where received_at < now() - p_older_than;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.face_liveness_prune_webhook_events(interval) from public, anon, authenticated;
grant execute on function public.face_liveness_prune_webhook_events(interval) to service_role;

-- ---------------------------------------------------------------------------
-- 7) 운영 점검용 — 승인 행과 사용자 플래그가 어긋난 비정상 데이터 조회 (service role 전용)
--    approved 인데 users.face_verified=false 이거나 reference_path 가 없는 행. 앱 sync / 웹훅 / 관리자 "복구" 가 해소한다.
-- ---------------------------------------------------------------------------
create or replace function public.face_liveness_inconsistent_rows()
returns table (face_verification_id uuid, user_id uuid, provider_session_id text, reference_path text, face_verified boolean)
language sql
security definer
set search_path = public
as $$
  select fv.id, fv.user_id, fv.provider_session_id, fv.reference_path, u.face_verified
    from public.face_verifications fv
    join public.users u on u.id = fv.user_id
   where fv.status = 'approved'
     and fv.provider_session_id is not null
     and (u.face_verified = false or fv.reference_path is null);
$$;

revoke all on function public.face_liveness_inconsistent_rows() from public, anon, authenticated;
grant execute on function public.face_liveness_inconsistent_rows() to service_role;
