-- 0021_server_errors.sql
-- Issue #20 — Edge Function 오류 추적 (자체 로그 범위, 무료). 민감정보 없는 메시지·컨텍스트만 저장한다.
--   * 기록은 Edge Function 이 _shared/observability/report.ts 로 한다 (마스킹 후 RPC). service role 전용.
--   * 관리자 웹 /errors 가 최근 오류를 보여준다. 30일 뒤 정리.
--   * 사용자 식별은 opaque uuid 만. 전화번호·이메일·토큰·얼굴 경로·메시지 원문은 기록 전에 마스킹된다 (redact.ts, selftest 로 검증).

create table if not exists public.server_errors (
  id           bigint generated always as identity primary key,
  function     text not null,
  environment  text,
  release      text,
  name         text,
  message      text not null,
  stack        text,
  context      jsonb not null default '{}'::jsonb,
  fingerprint  text,
  created_at   timestamptz not null default now()
);
create index if not exists server_errors_created_idx on public.server_errors (created_at desc);
create index if not exists server_errors_fp_idx on public.server_errors (fingerprint, created_at desc);
alter table public.server_errors enable row level security;
revoke all on public.server_errors from anon, authenticated;

create or replace function public.record_server_error(
  p_function text,
  p_message text,
  p_name text default null,
  p_stack text default null,
  p_context jsonb default '{}'::jsonb,
  p_environment text default null,
  p_release text default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id bigint;
begin
  if auth.uid() is not null then
    raise exception 'server only' using errcode = '42501';
  end if;
  insert into public.server_errors (function, environment, release, name, message, stack, context, fingerprint)
  values (
    left(coalesce(p_function, 'unknown'), 80),
    left(p_environment, 40),
    left(p_release, 60),
    left(p_name, 80),
    left(coalesce(p_message, 'unknown_error'), 2000),
    left(p_stack, 4000),
    coalesce(p_context, '{}'::jsonb),
    md5(left(coalesce(p_function, '') || '|' || coalesce(p_name, '') || '|' || regexp_replace(coalesce(p_message, ''), '[0-9]+', 'N', 'g'), 400))
  )
  returning id into new_id;
  return new_id;
end;
$$;
revoke all on function public.record_server_error(text, text, text, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.record_server_error(text, text, text, text, jsonb, text, text) to service_role;

create or replace function public.server_errors_prune(p_keep interval default interval '30 days')
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  delete from public.server_errors where created_at < now() - p_keep;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.server_errors_prune(interval) from public, anon, authenticated;
grant execute on function public.server_errors_prune(interval) to service_role;
