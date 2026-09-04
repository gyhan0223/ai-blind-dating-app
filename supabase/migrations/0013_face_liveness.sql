-- 0013_face_liveness.sql
-- Didit 능동형 라이브니스(3D Action & Flash) 연동 — face_verifications 확장.
--
-- 배경
--   기존 흐름은 사용자가 정면/좌/우 3장을 직접 촬영해 올리고 서버가 "파일 3개 존재" 만 확인한 뒤
--   liveness_passed=true 로 처리했다 (Mock). 실제 라이브니스가 아니므로 production 에서는
--   Didit 의 서버 판정(서명 검증된 웹훅 + Decision API 재조회) 없이는 절대 승인이 나오면 안 된다.
--
-- 설계 원칙
--   * 행 생성/갱신은 전부 서버(service role) 전용이다. 클라이언트는 본인 행 "조회" 만 가능하다.
--     (0002 의 face_verifications_insert_own 정책 제거 → 모바일이 pending 행을 무한 삽입하거나
--      임의의 approved 행을 만드는 경로가 없다. DB 트리거가 2차 방어.)
--   * provider_session_id(Didit session id) 는 UNIQUE — 웹훅 멱등 처리와 사용자 매핑의 기준.
--   * 상태 전이 보호: approved 는 뒤늦게 도착한 오래된 이벤트로 되돌릴 수 없다.
--     provider_event_at 이 저장된 값보다 과거인 갱신은 거부한다.
--   * 점수는 0~100 (Didit liveness score 정규화 범위). reference_path 는 반드시 <user_id>/liveness/ 아래.
--   * 전체 Didit 응답/웹훅 payload 는 저장하지 않는다 — 최소 필드(상태·점수·방식·사유 코드)만.
--   * feature_vector 는 이번 작업에서 만들지 않는다 (null 유지). 다음 작업(얼굴 임베딩)이 reference_path 를 입력으로 사용.
--   * 세션 생성 rate limit 은 DB RPC(face_liveness_begin_session) 가 행 잠금 하에서 판정한다.
--   * storage: 서버가 저장한 reference image(<user_id>/liveness/*) 는 클라이언트가 읽기/쓰기/삭제할 수 없다.
--     (사용자가 자기 폴더의 reference.jpg 를 임의 사진으로 덮어쓰면 "라이브니스가 검증된 이미지" 가 아니게 된다)
--
-- 라이브니스는 "실제 사람이 카메라 앞에 있다" 만 확인한다. 실명·생년월일·성인 여부를 증명하지 않는다
-- (본인확인은 verify-identity / 향후 KCP 본인인증이 담당).

-- ---------------------------------------------------------------------------
-- 1) 상태 값 확장: pending | approved | rejected | in_review | expired
-- ---------------------------------------------------------------------------
alter table public.face_verifications drop constraint if exists face_verifications_status_check;
alter table public.face_verifications add constraint face_verifications_status_check
  check (status in ('pending', 'approved', 'rejected', 'in_review', 'expired'));

-- ---------------------------------------------------------------------------
-- 2) 컬럼 추가 (기존 front/left/right/feature_vector 는 호환을 위해 유지 — 새 흐름에서는 사용하지 않음)
-- ---------------------------------------------------------------------------
alter table public.face_verifications
  add column if not exists provider_session_id text,
  add column if not exists provider_status     text,
  add column if not exists liveness_method     text,
  add column if not exists liveness_score      numeric(5, 2),
  add column if not exists provider_reason     text,
  add column if not exists reference_path      text,
  add column if not exists attempt_count       integer not null default 1,
  add column if not exists provider_event_at   timestamptz,
  add column if not exists verified_at         timestamptz,
  add column if not exists expires_at          timestamptz;

comment on column public.face_verifications.provider_session_id is
  'Provider(Didit) verification session id — 웹훅/Decision 조회의 사용자 매핑 키. UNIQUE';
comment on column public.face_verifications.provider_status is
  'Provider 가 마지막으로 알린 원본 상태 문자열 (예: Approved / Declined / In Review). 감사용 최소 정보';
comment on column public.face_verifications.liveness_method is
  'Provider 라이브니스 방식 코드 (예: ACTIVE_3D). 전체 응답은 저장하지 않는다';
comment on column public.face_verifications.liveness_score is
  'Provider 라이브니스 점수 (0~100). 임계값 판정은 Provider 워크플로 설정을 따르며 로컬 임계값을 두지 않는다';
comment on column public.face_verifications.provider_reason is
  '사유 코드 (예: liveness_declined, face_search_match, provider_error). 사용자에게 유사 계정 정보를 노출하지 않는다';
comment on column public.face_verifications.reference_path is
  'private bucket faces 의 검증된 reference image 경로 (<user_id>/liveness/reference.jpg). public URL 없음';
comment on column public.face_verifications.attempt_count is
  '이 사용자의 몇 번째 라이브니스 세션인지 (세션 단위). 세션 안의 재시도 횟수는 Provider 워크플로(최대 3회)가 관리';
comment on column public.face_verifications.provider_event_at is
  '마지막으로 반영한 Provider 이벤트 시각 — 이보다 오래된 이벤트는 무시/거부 (out-of-order 보호)';

alter table public.face_verifications drop constraint if exists face_verifications_liveness_score_range;
alter table public.face_verifications add constraint face_verifications_liveness_score_range
  check (liveness_score is null or (liveness_score >= 0 and liveness_score <= 100));

alter table public.face_verifications drop constraint if exists face_verifications_attempt_count_positive;
alter table public.face_verifications add constraint face_verifications_attempt_count_positive
  check (attempt_count >= 1);

-- reference image 는 반드시 본인 폴더의 liveness/ 아래 (서버 저장 경로 규칙)
alter table public.face_verifications drop constraint if exists face_verifications_reference_path_scope;
alter table public.face_verifications add constraint face_verifications_reference_path_scope
  check (reference_path is null or reference_path like (user_id::text || '/liveness/%'));

-- 실제 provider 세션 행이 approved 이면 liveness_passed 가 반드시 true 여야 한다.
-- (provider_session_id 가 없는 기존 mock/seed 행은 호환을 위해 예외)
alter table public.face_verifications drop constraint if exists face_verifications_approved_requires_liveness;
alter table public.face_verifications add constraint face_verifications_approved_requires_liveness
  check (provider_session_id is null or status <> 'approved' or liveness_passed);

create unique index if not exists face_verifications_provider_session_uidx
  on public.face_verifications (provider_session_id)
  where provider_session_id is not null;

create index if not exists face_verifications_user_status_idx
  on public.face_verifications (user_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- 3) 클라이언트 쓰기 차단
--    * 0002 의 insert 정책 제거 → authenticated 는 어떤 행도 만들 수 없다 (select_own 만 남는다).
--    * 트리거 2차 방어: JWT(auth.uid()) 컨텍스트에서의 insert/update/delete 는 정책과 무관하게 거부.
-- ---------------------------------------------------------------------------
drop policy if exists face_verifications_insert_own on public.face_verifications;

create or replace function public.guard_face_verifications_server_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    raise exception 'face_verifications can only be changed by the server';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists face_verifications_server_only on public.face_verifications;
create trigger face_verifications_server_only
  before insert or update or delete on public.face_verifications
  for each row execute function public.guard_face_verifications_server_only();

-- ---------------------------------------------------------------------------
-- 4) 상태 전이 보호 (service role 갱신에도 적용)
--    * approved → 다른 상태: 거부 (오래된 웹훅/재전송이 승인을 되돌릴 수 없다)
--      운영 도구에서 의도적으로 취소해야 할 때만 트랜잭션 안에서
--      set_config('app.face_verification_override', 'on', true) 후 갱신한다.
--    * provider_event_at 이 저장값보다 과거인 갱신: 거부 (out-of-order 이벤트)
--    * liveness_passed true → false, verified_at 제거: 거부 (override 없이는 불가)
--    * approved 로 바뀌면 verified_at 자동 기록
-- ---------------------------------------------------------------------------
create or replace function public.guard_face_verifications_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  override boolean := coalesce(current_setting('app.face_verification_override', true), '') = 'on';
begin
  if not override then
    if old.status = 'approved' and new.status is distinct from 'approved' then
      raise exception 'approved face verification cannot be reverted (session %)', old.id;
    end if;
    if old.liveness_passed and not new.liveness_passed then
      raise exception 'liveness_passed cannot be cleared (session %)', old.id;
    end if;
    if old.verified_at is not null and new.verified_at is null then
      raise exception 'verified_at cannot be cleared (session %)', old.id;
    end if;
    if old.provider_session_id is not null
       and new.provider_session_id is distinct from old.provider_session_id then
      raise exception 'provider_session_id cannot be changed once attached (session %)', old.id;
    end if;
  end if;

  if new.provider_event_at is not null and old.provider_event_at is not null
     and new.provider_event_at < old.provider_event_at then
    raise exception 'stale provider event ignored (session %)', old.id;
  end if;

  if new.status = 'approved' and new.verified_at is null then
    new.verified_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists face_verifications_guard_transition on public.face_verifications;
create trigger face_verifications_guard_transition
  before update on public.face_verifications
  for each row execute function public.guard_face_verifications_transition();

-- ---------------------------------------------------------------------------
-- 5) 세션 생성 rate limit + pending 재사용 판정 RPC (service role 전용)
--
--  face_liveness_begin_session(p_user_id, p_provider, p_max_per_hour, p_max_per_day, p_reuse_margin_seconds)
--    → { action: 'already_verified' }
--    → { action: 'reuse', id, provider_session_id, expires_at }
--         (유효한 pending 세션이 있으면 새로 만들지 않고 돌려준다 — token 은 서버가 다시 발급하지 않으므로
--          Edge Function 은 이 경우 Provider 에 세션을 새로 만들지 않고 안내만 한다)
--    → { action: 'rate_limited', reason: 'hourly' | 'daily', retry_after_seconds }
--    → { action: 'create', id, attempt_count }
--         (pending 행을 먼저 만들어 두고 Edge Function 이 Provider 세션을 붙인다.
--          Provider 호출 실패 시 Edge Function 이 그 행을 expired/provider_error 로 마감한다)
--
--  사용자별 advisory lock 으로 동시 요청에도 판정이 직렬화된다. 거부된 요청은 행을 만들지 않는다.
--  만료된 pending 행은 여기서 expired 로 정리한다.
-- ---------------------------------------------------------------------------
create or replace function public.face_liveness_begin_session(
  p_user_id uuid,
  p_provider text default 'didit',
  p_max_per_hour integer default 5,
  p_max_per_day integer default 10,
  p_reuse_margin_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ts timestamptz := now();
  verified boolean;
  reusable public.face_verifications%rowtype;
  hour_count integer;
  day_count integer;
  total_count integer;
  oldest_in_window timestamptz;
  new_id uuid;
begin
  if p_user_id is null then
    raise exception 'face_liveness_begin_session: user id required';
  end if;
  if p_max_per_hour < 1 or p_max_per_day < 1 then
    raise exception 'face_liveness_begin_session: limits must be >= 1';
  end if;

  perform pg_advisory_xact_lock(hashtext('face_liveness:' || p_user_id::text));

  select face_verified into verified from public.users where id = p_user_id;
  if verified is null then
    raise exception 'face_liveness_begin_session: unknown user';
  end if;
  if verified then
    return jsonb_build_object('action', 'already_verified');
  end if;

  -- 만료된 pending 세션 정리 (Provider 세션이 붙지 않은 채 2분이 지난 행 포함)
  update public.face_verifications
     set status = 'expired',
         provider_reason = coalesce(provider_reason, 'session_expired')
   where user_id = p_user_id
     and status = 'pending'
     and (
       (expires_at is not null and expires_at <= ts)
       or (provider_session_id is null and created_at <= ts - interval '2 minutes')
     );

  -- 유효한 pending 세션 재사용
  select * into reusable
    from public.face_verifications
   where user_id = p_user_id
     and status = 'pending'
     and provider_session_id is not null
     and expires_at is not null
     and expires_at > ts + make_interval(secs => greatest(p_reuse_margin_seconds, 0))
   order by created_at desc
   limit 1;
  if found then
    return jsonb_build_object(
      'action', 'reuse',
      'id', reusable.id,
      'provider_session_id', reusable.provider_session_id,
      'expires_at', reusable.expires_at
    );
  end if;

  -- 시간당 / 일일 세션 생성 상한 (실패·만료 포함 — Provider 장애 시 연타 방지)
  select count(*), min(created_at) into hour_count, oldest_in_window
    from public.face_verifications
   where user_id = p_user_id and created_at > ts - interval '1 hour';
  if hour_count >= p_max_per_hour then
    return jsonb_build_object(
      'action', 'rate_limited',
      'reason', 'hourly',
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (oldest_in_window + interval '1 hour' - ts)))::integer)
    );
  end if;

  select count(*), min(created_at) into day_count, oldest_in_window
    from public.face_verifications
   where user_id = p_user_id and created_at > ts - interval '24 hours';
  if day_count >= p_max_per_day then
    return jsonb_build_object(
      'action', 'rate_limited',
      'reason', 'daily',
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (oldest_in_window + interval '24 hours' - ts)))::integer)
    );
  end if;

  select count(*) into total_count from public.face_verifications where user_id = p_user_id;

  insert into public.face_verifications (user_id, status, provider, liveness_passed, attempt_count)
  values (p_user_id, 'pending', p_provider, false, total_count + 1)
  returning id into new_id;

  return jsonb_build_object('action', 'create', 'id', new_id, 'attempt_count', total_count + 1);
end;
$$;

revoke all on function public.face_liveness_begin_session(uuid, text, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.face_liveness_begin_session(uuid, text, integer, integer, integer)
  to service_role;

-- 오래된 pending/in_review 정리 (선택 — pg_cron 등으로 주기 실행)
create or replace function public.face_liveness_expire_stale(p_older_than interval default interval '1 day')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  update public.face_verifications
     set status = 'expired', provider_reason = coalesce(provider_reason, 'session_expired')
   where status = 'pending'
     and created_at < now() - p_older_than;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.face_liveness_expire_stale(interval) from public, anon, authenticated;
grant execute on function public.face_liveness_expire_stale(interval) to service_role;

-- ---------------------------------------------------------------------------
-- 6) storage 정책 강화 — 서버가 저장한 reference image(<user_id>/liveness/*) 는 클라이언트 접근 불가.
--    (0007 의 정책은 "본인 폴더 전체" 허용이었다. liveness/ 하위는 service role 만 다룬다)
--    로컬 검증 환경에는 storage 스키마가 없을 수 있으므로 존재할 때만 실행한다.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'storage' and table_name = 'buckets') then
    execute 'drop policy if exists faces_select_own on storage.objects';
    execute 'drop policy if exists faces_insert_own on storage.objects';
    execute 'drop policy if exists faces_update_own on storage.objects';
    execute 'drop policy if exists faces_delete_own on storage.objects';

    execute $pol$
      create policy faces_select_own on storage.objects
        for select using (
          bucket_id = 'faces'
          and (storage.foldername(name))[1] = auth.uid()::text
          and coalesce((storage.foldername(name))[2], '') <> 'liveness'
        )
    $pol$;
    execute $pol$
      create policy faces_insert_own on storage.objects
        for insert with check (
          bucket_id = 'faces'
          and (storage.foldername(name))[1] = auth.uid()::text
          and coalesce((storage.foldername(name))[2], '') <> 'liveness'
        )
    $pol$;
    execute $pol$
      create policy faces_update_own on storage.objects
        for update using (
          bucket_id = 'faces'
          and (storage.foldername(name))[1] = auth.uid()::text
          and coalesce((storage.foldername(name))[2], '') <> 'liveness'
        )
    $pol$;
    execute $pol$
      create policy faces_delete_own on storage.objects
        for delete using (
          bucket_id = 'faces'
          and (storage.foldername(name))[1] = auth.uid()::text
          and coalesce((storage.foldername(name))[2], '') <> 'liveness'
        )
    $pol$;
  end if;
end;
$$;
