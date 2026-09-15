-- 0019_account_deletion.sql
-- Issue #13 (회원탈퇴 → 실제 개인정보 삭제·익명화 파이프라인) · #11 (인증용 얼굴 데이터 삭제 경로) · #14 (앱 밖 삭제 요청)
--
-- 모델 (docs/data-retention.md)
--   탈퇴(delete-account)           : users.status='deleted', deleted_at=now(). 30일 유예 — 같은 번호로 로그인해 복구할 수 있다.
--   익명화(account_purge, 유예 뒤)  : 개인정보·콘텐츠를 지우고 계정 스켈레톤(users 행·auth 계정·identity 해시·차단 플래그)만 남긴다.
--                                   상대의 대화 이력은 발신자 표시가 "탈퇴한 사용자" 인 자리표시 문구로 남는다 (상대 보호·신고 증거).
--   완전 삭제(hard, 운영자 요청 처리): 익명화 뒤 auth 계정까지 삭제(cascade) — 앱 밖 삭제 요청(#14) 등 명시 요청에만.
--   얼굴 데이터(storage faces/<uid>/*, Didit 세션)는 account-purge Edge Function 이 account_purge 호출 전에 지운다 (#11).
--
-- additive. 기존 status='deleted' 사용자는 deleted_at 이 null 이라 배포 시각을 deleted_at 으로 채운다 (유예는 그때부터).

alter table public.users
  add column if not exists deleted_at timestamptz,
  add column if not exists purged_at  timestamptz;

comment on column public.users.deleted_at is '탈퇴 요청 시각 (status=deleted). 복구하면 null. 유예 기간 기준';
comment on column public.users.purged_at is '개인정보 익명화 완료 시각 (account_purge). 이후 복구하면 온보딩을 처음부터 다시 한다';

update public.users set deleted_at = now() where status = 'deleted' and deleted_at is null;

-- status 전이에 따라 deleted_at 을 자동으로 맞춘다 (delete-account / 관리자 / 직접 SQL 어느 경로든)
create or replace function public.track_user_deleted_at()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'deleted' and old.status is distinct from 'deleted' then
    new.deleted_at := coalesce(new.deleted_at, now());
  elsif new.status = 'active' and old.status = 'deleted' then
    new.deleted_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists users_track_deleted_at on public.users;
create trigger users_track_deleted_at
  before update on public.users
  for each row execute function public.track_user_deleted_at();

-- ---------------------------------------------------------------------------
-- 앱 밖 삭제 요청 (#14) — 공개 웹 페이지(apps/admin /delete-account)가 service role 로 insert. 서버 전용 테이블
-- ---------------------------------------------------------------------------
create table if not exists public.account_deletion_requests (
  id          uuid primary key default gen_random_uuid(),
  contact     text not null check (char_length(contact) between 3 and 120),
  note        text check (note is null or char_length(note) <= 500),
  status      text not null default 'pending' check (status in ('pending', 'done', 'rejected')),
  admin_note  text,
  user_id     uuid references public.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  handled_at  timestamptz
);

create index if not exists account_deletion_requests_status_idx on public.account_deletion_requests (status, created_at);
alter table public.account_deletion_requests enable row level security;
revoke all on public.account_deletion_requests from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 익명화 대상 조회 (유예 지난 탈퇴 계정)
-- ---------------------------------------------------------------------------
create or replace function public.account_purge_candidates(p_grace interval default interval '30 days', p_limit int default 100)
returns table (user_id uuid, deleted_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select u.id, u.deleted_at
  from public.users u
  where u.status = 'deleted' and u.purged_at is null
    and u.deleted_at is not null and u.deleted_at < now() - p_grace
  order by u.deleted_at
  limit greatest(1, least(p_limit, 500));
$$;

-- ---------------------------------------------------------------------------
-- 익명화 본체 — 한 트랜잭션. service role 전용. 얼굴 storage·Didit 삭제는 호출자(Edge)가 먼저 한다.
-- 반환: 지운 항목 수 요약
-- ---------------------------------------------------------------------------
create or replace function public.account_purge(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  u public.users%rowtype;
  n int;
  out jsonb := '{}'::jsonb;
  cnt int;
begin
  if auth.uid() is not null then
    raise exception 'server only' using errcode = '42501';
  end if;
  select * into u from public.users where id = p_user_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if u.status not in ('deleted', 'banned') then
    raise exception 'not_deleted' using errcode = 'P0001';
  end if;

  -- 프로필·응답·설정 (본인 PII)
  delete from public.profiles where user_id = p_user_id; get diagnostics n = row_count; out := out || jsonb_build_object('profiles', n);
  delete from public.private_profiles where user_id = p_user_id; get diagnostics n = row_count; out := out || jsonb_build_object('private_profiles', n);
  delete from public.questionnaire_responses where user_id = p_user_id; get diagnostics n = row_count; out := out || jsonb_build_object('questionnaire_responses', n);
  delete from public.preference_settings where user_id = p_user_id; get diagnostics n = row_count; out := out || jsonb_build_object('preference_settings', n);
  delete from public.dealbreakers where user_id = p_user_id; get diagnostics n = row_count; out := out || jsonb_build_object('dealbreakers', n);
  delete from public.appearance_preference_events where user_id = p_user_id; get diagnostics n = row_count; out := out || jsonb_build_object('appearance_preference_events', n);

  -- 알림
  delete from public.push_tokens where user_id = p_user_id;
  delete from public.notification_preferences where user_id = p_user_id;
  delete from public.notification_events where recipient_id = p_user_id;

  -- 추천·좋아요 (본인 이력 삭제, 상대에게 저장된 내 카드는 비운다)
  delete from public.likes where from_user_id = p_user_id or to_user_id = p_user_id; get diagnostics n = row_count; out := out || jsonb_build_object('likes', n);
  delete from public.recommendations where user_id = p_user_id; get diagnostics n = row_count; out := out || jsonb_build_object('recommendations', n);
  update public.recommendations
  set card = '{}'::jsonb, status = case when status = 'pending' then 'expired' else status end
  where candidate_id = p_user_id and card <> '{}'::jsonb;
  get diagnostics n = row_count; out := out || jsonb_build_object('recommendation_cards_scrubbed', n);
  delete from public.recommendation_runs where user_id = p_user_id;

  -- 만남 (본인 응답만 — 상대의 응답·매치 집계 상태는 남는다)
  delete from public.meetup_intentions where user_id = p_user_id; get diagnostics n = row_count; out := out || jsonb_build_object('meetup_intentions', n);
  delete from public.meetup_outcomes where user_id = p_user_id; get diagnostics n = row_count; out := out || jsonb_build_object('meetup_outcomes', n);
  delete from public.meetup_feedback where user_id = p_user_id; get diagnostics n = row_count; out := out || jsonb_build_object('meetup_feedback', n);

  -- 활성 매치는 닫는다 (상대가 계속 메시지를 보내지 못하게 — can_chat_in 도 status 로 막는다)
  update public.matches set status = 'closed' where status = 'active' and p_user_id in (user_a, user_b);
  get diagnostics n = row_count; out := out || jsonb_build_object('matches_closed', n);

  -- 메시지: 상대의 대화 이력을 위해 행은 남기고 본문을 자리표시 문구로 바꾼다 (원문 삭제)
  update public.messages
  set content = '(탈퇴한 사용자의 메시지입니다)', client_message_id = null
  where sender_id = p_user_id and content <> '(탈퇴한 사용자의 메시지입니다)';
  get diagnostics n = row_count; out := out || jsonb_build_object('messages_redacted', n);

  -- 얼굴 인증 (storage·Didit 은 호출자가 먼저 삭제)
  delete from public.face_verification_reviews where user_id = p_user_id;
  delete from public.face_verifications where user_id = p_user_id; get diagnostics n = row_count; out := out || jsonb_build_object('face_verifications', n);

  -- 본인확인: 해시와 차단 플래그·계정 연결만 남긴다 (1인 1계정·차단 우회 방지). 생년월일·성별·검증 시각 제거
  update public.user_identities
  set birth_date = null, gender = null, identity_verified_at = null, adult_verified_at = null
  where user_id = p_user_id;
  get diagnostics n = row_count; out := out || jsonb_build_object('identities_anonymized', n);

  -- 행동 로그: 사용자 연결 해제
  update public.analytics_events set user_id = null where user_id = p_user_id;
  update public.device_events set user_id = null where user_id = p_user_id;

  -- 계정 스켈레톤: 이메일 제거·인증/온보딩 플래그 초기화 (복구하면 처음부터). phone 은 로그인 수단(auth.users)과 같이 남는다 — 완전 삭제는 hard
  update public.users
  set email = null,
      onboarding_completed = false,
      onboarding_step = 'welcome',
      identity_verified = false,
      face_verified = false,
      age_verified = false,
      purged_at = now()
  where id = p_user_id;

  select count(*) into cnt from public.profiles where user_id = p_user_id;
  return out || jsonb_build_object('user_id', p_user_id, 'purged_at', now(), 'remaining_profiles', cnt);
end;
$$;

revoke all on function public.account_purge(uuid) from public, anon, authenticated;
revoke all on function public.account_purge_candidates(interval, int) from public, anon, authenticated;
grant execute on function public.account_purge(uuid) to service_role;
grant execute on function public.account_purge_candidates(interval, int) to service_role;

-- 익명화가 필요한 사용자의 얼굴 자산 목록 (Edge 가 storage/Didit 삭제에 사용) — service role 전용
create or replace function public.account_face_assets(p_user_id uuid)
returns table (provider text, provider_session_id text, reference_path text, front_path text, left_path text, right_path text)
language sql
stable
security definer
set search_path = public
as $$
  select f.provider, f.provider_session_id, f.reference_path, f.front_path, f.left_path, f.right_path
  from public.face_verifications f where f.user_id = p_user_id;
$$;
revoke all on function public.account_face_assets(uuid) from public, anon, authenticated;
grant execute on function public.account_face_assets(uuid) to service_role;
