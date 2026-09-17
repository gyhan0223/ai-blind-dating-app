-- 0032_identity_verification_sessions.sql
-- Issue #6 — 본인확인 세션을 서버가 소유한다 (인증 세션 ↔ JWT 사용자 결속 · 만료 · 1회 사용 · 결과 재사용 차단).
--
-- 이전: verify-identity 의 request 가 돌려준 requestId 는 서버 어디에도 기록되지 않아
--       confirm/recover 가 "누가 시작한 세션인지" · "이미 쓴 세션인지" · "만료됐는지" 를 판단할 수 없었다.
--       (Mock Provider 는 verificationId 자체를 보지 않으므로 지금까지 드러나지 않았다)
-- 이후: request 가 세션 행을 만들고 provider_session_id 는 서버에만 남는다. 클라이언트는 우리 세션 id(requestId)만 받는다.
--       confirm 은 (id, user_id=호출자, status=pending, 만료 전) 조건부 갱신으로 세션을 "점유(checking)" 한 뒤 Provider 를 호출한다
--       → 같은 세션의 동시 confirm 은 하나만 Provider 에 닿고, 타인의 세션·만료 세션·이미 끝난 세션은 여기서 거부된다.
--       결과는 세션 행에 남아(해시·생년월일·성별·outcome) recover 가 Provider 를 다시 부르지 않고 서버가 검증한 결과만 쓴다.
--
-- 개인정보: raw identityKey/DI · 이름 · 전화번호 · 인증번호는 저장하지 않는다. identity_key_hash 는 user_identities 와 같은 서버 HMAC 값.
--          생년월일·성별은 user_identities 에도 있는 값이며 세션은 identity_verification_sessions_prune 으로 지운다 (기본 1일).
-- 서버 전용: RLS 정책 없음 + grant 회수. 계정 삭제 시 cascade.

create table if not exists public.identity_verification_sessions (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.users (id) on delete cascade,
  provider             text not null check (char_length(provider) between 1 and 40),
  provider_session_id  text check (provider_session_id is null or char_length(provider_session_id) <= 200),
  status               text not null default 'pending'
                         check (status in ('pending', 'checking', 'completed', 'existing_account', 'recovered', 'failed', 'expired')),
  outcome              text check (outcome is null or outcome in ('created', 'already_verified', 'relinked', 'existing_account', 'blocked', 'underage')),
  identity_key_hash    text,
  birth_date           date,
  gender               text check (gender is null or gender in ('male', 'female')),
  owner_user_id        uuid,                       -- existing_account 일 때 기존 계정 (복구 대상). FK 없음 — 계정 삭제 후에도 판단 기록 유지
  attempts             int not null default 0,     -- Provider 가 실패(틀린 코드 등)라고 답한 횟수
  expires_at           timestamptz not null,
  checking_since       timestamptz,
  consumed_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

comment on table public.identity_verification_sessions is '본인확인 세션 (#6). 서버 전용. raw DI·이름·전화번호·인증번호 없음. prune 으로 정리';

create index if not exists identity_verification_sessions_user_idx on public.identity_verification_sessions (user_id, created_at desc);
create index if not exists identity_verification_sessions_status_idx on public.identity_verification_sessions (status, expires_at);

create trigger identity_verification_sessions_touch_updated_at
  before update on public.identity_verification_sessions
  for each row execute function public.touch_updated_at();

alter table public.identity_verification_sessions enable row level security;
revoke all on public.identity_verification_sessions from public, anon, authenticated;
grant all on public.identity_verification_sessions to service_role;

-- 끝난 세션·만료 세션 정리 (service role 전용). 완료된 세션도 결과 재사용 창을 짧게 두기 위해 1일 뒤 지운다
create or replace function public.identity_verification_sessions_prune(p_keep interval default interval '1 day')
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  if auth.uid() is not null then
    raise exception 'server only' using errcode = '42501';
  end if;
  delete from public.identity_verification_sessions
   where (status in ('completed', 'existing_account', 'recovered', 'failed', 'expired') and updated_at < now() - p_keep)
      or (expires_at < now() - p_keep);
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.identity_verification_sessions_prune(interval) from public, anon, authenticated;
grant execute on function public.identity_verification_sessions_prune(interval) to service_role;
