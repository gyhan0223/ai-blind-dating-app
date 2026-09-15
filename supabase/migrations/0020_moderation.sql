-- 0020_moderation.sql
-- Issue #15 (신고·차단 운영 정책 · 관리자 워크플로우 · audit trail) · #16 (채팅 rate limit · 반복 스팸 · 위험 패턴 신호)
--
-- additive. 정책 문서: docs/moderation-policy.md
--   1) reports: 사유 확장(성희롱·금전 요구·스토킹·신상 요구·허위 정보·미성년 의심), severity(normal/urgent), 처리 상태
--      (pending → reviewing → actioned | dismissed; 과거 resolved 유지), action_taken · admin_note · handled_at
--   2) moderation_actions: 경고/정지/해제/영구 차단/기각 감사 기록. 관리자 웹은 admin_moderate_user RPC 로만 상태를 바꾼다
--   3) users.suspended_until + moderation_lift_expired_suspensions() (기간 정지 자동 해제)
--   4) send_message rate limit: 대화당 60초 20건 · 사용자당 1시간 200건 · 같은 본문 5분 안 3회 → 거부 (원문 저장 없음)
--   5) moderation_signals: 메시지 위험 패턴(연락처·외부 메신저·금전·초반 연락처 요구·욕설) 을 **신호로만** 기록.
--      자동 제재 없음. 원문은 저장하지 않고 message_id 로만 연결 (운영자가 신고 검토 시 참고). 서버 전용.

-- ---------------------------------------------------------------------------
-- 1) reports 확장
-- ---------------------------------------------------------------------------
alter table public.reports drop constraint if exists reports_reason_check;
alter table public.reports add constraint reports_reason_check
  check (reason in (
    'unpleasant_conversation', 'sexual_remarks', 'threat', 'impersonation', 'spam', 'other',
    'harassment', 'scam_money', 'stalking', 'personal_info_request', 'false_info', 'underage'));

alter table public.reports drop constraint if exists reports_status_check;
alter table public.reports add constraint reports_status_check
  check (status in ('pending', 'reviewing', 'resolved', 'actioned', 'dismissed'));

alter table public.reports
  add column if not exists severity     text not null default 'normal' check (severity in ('normal', 'urgent')),
  add column if not exists action_taken text check (action_taken is null or action_taken in ('none', 'warned', 'suspended', 'banned')),
  add column if not exists handled_by   text,
  add column if not exists handled_at   timestamptz;

comment on column public.reports.severity is
  'urgent = 위협·스토킹·미성년 의심·신고자가 긴급 표시. 우선 처리 (docs/moderation-policy.md)';

-- 신고 insert 정책: 사유가 threat/stalking/underage 이거나 신고자가 urgent 로 보낸 경우만 urgent. 상태는 pending 만
drop policy if exists reports_insert_own on public.reports;
create policy reports_insert_own on public.reports
  for insert with check (
    reporter_id = auth.uid() and status = 'pending'
    and (severity = 'normal' or reason in ('threat', 'stalking', 'underage', 'sexual_remarks', 'harassment', 'scam_money'))
  );

-- 위협·스토킹·미성년 의심은 신고자 선택과 무관하게 urgent
create or replace function public.reports_default_severity()
returns trigger
language plpgsql
as $$
begin
  if new.reason in ('threat', 'stalking', 'underage') then
    new.severity := 'urgent';
  end if;
  return new;
end;
$$;
drop trigger if exists reports_default_severity on public.reports;
create trigger reports_default_severity
  before insert on public.reports
  for each row execute function public.reports_default_severity();

-- ---------------------------------------------------------------------------
-- 2) 감사 기록 + 관리자 조치 RPC
-- ---------------------------------------------------------------------------
alter table public.users add column if not exists suspended_until timestamptz;

create table if not exists public.moderation_actions (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.users (id) on delete cascade,
  action      text not null check (action in ('warn', 'suspend', 'unsuspend', 'ban', 'unban', 'dismiss', 'note')),
  reason      text,
  report_id   uuid references public.reports (id) on delete set null,
  until_at    timestamptz,
  actor       text not null,
  created_at  timestamptz not null default now()
);
create index if not exists moderation_actions_user_idx on public.moderation_actions (user_id, created_at desc);
alter table public.moderation_actions enable row level security;
revoke all on public.moderation_actions from anon, authenticated;

-- 관리자 조치 (service role 전용). 상태 변경과 감사 기록을 한 트랜잭션에.
--   warn      : 상태 변화 없음, 기록만
--   suspend   : status=suspended, suspended_until = now()+p_days (null 이면 무기한)
--   unsuspend : status=active, suspended_until null
--   ban       : status=banned (identity 에 banned 동기화 — 0009 트리거)
--   unban     : status=active
--   dismiss/note : 기록만 (dismiss 는 report 를 dismissed 로)
create or replace function public.admin_moderate_user(
  p_user_id uuid,
  p_action text,
  p_reason text default null,
  p_report_id uuid default null,
  p_actor text default 'admin',
  p_days int default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  u public.users%rowtype;
  until_ts timestamptz;
begin
  if auth.uid() is not null then
    raise exception 'server only' using errcode = '42501';
  end if;
  if p_action not in ('warn', 'suspend', 'unsuspend', 'ban', 'unban', 'dismiss', 'note') then
    raise exception 'invalid_action' using errcode = '22023';
  end if;
  select * into u from public.users where id = p_user_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  if p_action = 'suspend' then
    until_ts := case when p_days is null then null else now() + make_interval(days => p_days) end;
    update public.users set status = 'suspended', suspended_until = until_ts where id = p_user_id;
  elsif p_action = 'unsuspend' then
    if u.status <> 'suspended' then raise exception 'not_suspended' using errcode = 'P0001'; end if;
    update public.users set status = 'active', suspended_until = null where id = p_user_id;
  elsif p_action = 'ban' then
    update public.users set status = 'banned', suspended_until = null where id = p_user_id;
    -- 차단된 계정의 기기 알림·활성 매치 정리
    delete from public.push_tokens where user_id = p_user_id;
    update public.matches set status = 'closed' where status = 'active' and p_user_id in (user_a, user_b);
  elsif p_action = 'unban' then
    if u.status <> 'banned' then raise exception 'not_banned' using errcode = 'P0001'; end if;
    update public.users set status = 'active' where id = p_user_id;
  end if;

  if p_report_id is not null then
    update public.reports
    set status = case when p_action = 'dismiss' then 'dismissed' when p_action = 'note' then status else 'actioned' end,
        action_taken = case p_action when 'warn' then 'warned' when 'suspend' then 'suspended' when 'ban' then 'banned'
                                     when 'dismiss' then 'none' else action_taken end,
        handled_by = p_actor,
        handled_at = case when p_action = 'note' then handled_at else now() end,
        admin_note = coalesce(p_reason, admin_note)
    where id = p_report_id;
  end if;

  insert into public.moderation_actions (user_id, action, reason, report_id, until_at, actor)
  values (p_user_id, p_action, left(p_reason, 500), p_report_id, until_ts, left(p_actor, 60));

  select * into u from public.users where id = p_user_id;
  return jsonb_build_object('status', u.status, 'suspended_until', u.suspended_until);
end;
$$;

revoke all on function public.admin_moderate_user(uuid, text, text, uuid, text, int) from public, anon, authenticated;
grant execute on function public.admin_moderate_user(uuid, text, text, uuid, text, int) to service_role;

-- 기간 정지 자동 해제 (cron 1시간)
create or replace function public.moderation_lift_expired_suspensions()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  with lifted as (
    update public.users set status = 'active', suspended_until = null
    where status = 'suspended' and suspended_until is not null and suspended_until <= now()
    returning id
  )
  insert into public.moderation_actions (user_id, action, reason, actor)
  select id, 'unsuspend', '기간 만료 자동 해제', 'system' from lifted;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.moderation_lift_expired_suspensions() from public, anon, authenticated;
grant execute on function public.moderation_lift_expired_suspensions() to service_role;

-- ---------------------------------------------------------------------------
-- 3) 위험 패턴 신호 (자동 제재 없음, 원문 저장 없음)
-- ---------------------------------------------------------------------------
create table if not exists public.moderation_signals (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references public.users (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete cascade,
  message_id      uuid references public.messages (id) on delete cascade,
  flags           text[] not null,
  created_at      timestamptz not null default now()
);
create index if not exists moderation_signals_user_idx on public.moderation_signals (user_id, created_at desc);
alter table public.moderation_signals enable row level security;
revoke all on public.moderation_signals from anon, authenticated;

comment on table public.moderation_signals is
  '메시지 위험 패턴 신호 (#16). flags: contact_info | external_messenger | money_request | link | early_contact_request | profanity. 신고 검토 보조 신호이며 자동 제재 근거가 아니다. 원문 없음';

-- 규칙 (오탐을 줄이기 위해 보수적으로): 정상 대화("카페 갈래요", "주말에 시간 되세요")는 걸리지 않아야 한다 — moderation_tests.sql
create or replace function public.message_risk_flags(p_content text)
returns text[]
language plpgsql
immutable
as $$
declare
  c text := lower(coalesce(p_content, ''));
  flags text[] := '{}';
  compact text := regexp_replace(c, '[\s\-\.]', '', 'g');
begin
  -- 휴대전화 번호 (010 + 8자리, 구분자 무시)
  if compact ~ '01[016789][0-9]{7,8}' then flags := array_append(flags, 'contact_info'); end if;
  -- 외부 메신저 아이디 요구/제공
  if c ~ '(카톡|카카오톡|kakao|라인\s?(아이디|id)|line\s?id|텔레그램|telegram|인스타|instagram|insta|디엠|dm\s*주|오픈채팅|open\.kakao)' then
    flags := array_append(flags, 'external_messenger');
  end if;
  -- 금전 요구·투자 권유
  if c ~ '(계좌|송금|입금|빌려\s?줄|돈\s?좀|투자|코인|비트코인|수익\s?보장|대출|상품권|기프티콘\s?좀)' then
    flags := array_append(flags, 'money_request');
  end if;
  -- 링크
  if c ~ '(https?://|www\.|\.com/|\.kr/|bit\.ly|t\.me/)' then flags := array_append(flags, 'link'); end if;
  -- 욕설·성적 표현 (좁게 — 보조 신호)
  if c ~ '(씨발|시발|ㅅㅂ|병신|ㅂㅅ|개새끼|좆|섹스|자위|야동|몸매\s?좀|벗어)' then flags := array_append(flags, 'profanity'); end if;
  return flags;
end;
$$;

create or replace function public.handle_message_risk_signal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  flags text[] := public.message_risk_flags(new.content);
  total int;
begin
  if array_length(flags, 1) is null then
    return new;
  end if;
  -- 대화 초반(양쪽 합 10건 미만)의 연락처/외부 메신저 요구는 별도 표시
  select coalesce(total_messages, 0) into total from public.conversation_metrics where conversation_id = new.conversation_id;
  if coalesce(total, 0) <= 10 and (flags && array['contact_info', 'external_messenger']) then
    flags := array_append(flags, 'early_contact_request');
  end if;
  insert into public.moderation_signals (user_id, conversation_id, message_id, flags)
  values (new.sender_id, new.conversation_id, new.id, flags);
  return new;
end;
$$;

drop trigger if exists messages_risk_signal on public.messages;
create trigger messages_risk_signal
  after insert on public.messages
  for each row execute function public.handle_message_risk_signal();

-- 반복 패턴 요약 (관리자 웹): 최근 30일 신고자/피신고 횟수·조치 이력·위험 신호 수
create or replace view public.moderation_user_summary as
select
  u.id as user_id,
  u.status,
  u.suspended_until,
  (select count(*) from public.reports r where r.reported_id = u.id and r.created_at > now() - interval '30 days') as reported_30d,
  (select count(*) from public.reports r where r.reporter_id = u.id and r.created_at > now() - interval '30 days') as reporter_30d,
  (select count(*) from public.moderation_actions a where a.user_id = u.id and a.action in ('warn', 'suspend', 'ban')) as sanctions,
  (select count(*) from public.moderation_signals s where s.user_id = u.id and s.created_at > now() - interval '30 days') as signals_30d
from public.users u;
revoke all on public.moderation_user_summary from public, anon, authenticated;
grant select on public.moderation_user_summary to service_role;

-- ---------------------------------------------------------------------------
-- 4) send_message rate limit — 0016 본문 + 제한. (SECURITY INVOKER 유지 — RLS 적용)
-- ---------------------------------------------------------------------------
create or replace function public.send_message(
  p_conversation_id uuid,
  p_client_message_id uuid,
  p_content text
)
returns public.messages
language plpgsql
security invoker
set search_path = public
as $$
declare
  uid       uuid := auth.uid();
  v_content text := btrim(coalesce(p_content, ''));
  existing  public.messages%rowtype;
  inserted  public.messages%rowtype;
  n int;
begin
  if uid is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if p_conversation_id is null or p_client_message_id is null then
    raise exception 'client_message_id_required' using errcode = '22023';
  end if;
  if char_length(v_content) < 1 or char_length(v_content) > 2000 then
    raise exception 'invalid_content' using errcode = '22023';
  end if;

  -- 재시도(같은 키)는 제한과 무관하게 저장된 행을 돌려준다
  select * into existing from public.messages
  where conversation_id = p_conversation_id and sender_id = uid and client_message_id = p_client_message_id;
  if found then
    if existing.content <> v_content then
      raise exception 'message_content_mismatch' using errcode = 'P0001';
    end if;
    return existing;
  end if;

  -- rate limit (#16): 대화당 60초 20건 · 사용자 전체 1시간 200건 · 같은 본문 5분 안 3회
  select count(*) into n from public.messages
  where conversation_id = p_conversation_id and sender_id = uid and created_at > now() - interval '60 seconds';
  if n >= 20 then raise exception 'rate_limited' using errcode = 'P0001'; end if;
  select count(*) into n from public.messages
  where sender_id = uid and created_at > now() - interval '1 hour';
  if n >= 200 then raise exception 'rate_limited' using errcode = 'P0001'; end if;
  select count(*) into n from public.messages
  where conversation_id = p_conversation_id and sender_id = uid and content = v_content and created_at > now() - interval '5 minutes';
  if n >= 3 then raise exception 'repeated_content' using errcode = 'P0001'; end if;

  begin
    insert into public.messages (conversation_id, sender_id, content, client_message_id)
    values (p_conversation_id, uid, v_content, p_client_message_id)
    returning * into inserted;
    return inserted;
  exception when unique_violation then
    select * into existing from public.messages
    where conversation_id = p_conversation_id and sender_id = uid and client_message_id = p_client_message_id;
    if not found then
      raise;
    end if;
    if existing.content <> v_content then
      raise exception 'message_content_mismatch' using errcode = 'P0001';
    end if;
    return existing;
  end;
end;
$$;
