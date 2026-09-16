-- 0031_admin_login_guard.sql
-- Issue #27 — 관리자 로그인 실패 잠금을 인스턴스 메모리에서 DB 로 옮긴다 (여러 서버 인스턴스·재시작에 걸쳐 동일 적용).
--
--   * admin_login_locks(key) — key 는 관리자 웹이 서버 secret 으로 HMAC 한 클라이언트 식별자(IP 해시). 원문 IP 는 저장하지 않는다.
--   * admin_login_guard(key, event, max_failures, lock_seconds) — 행 잠금(for update) 아래에서 판정·갱신을 한 트랜잭션에 수행한다.
--       check   : 잠금 여부만 (카운트 변경 없음)
--       failure : 잠금 중이면 그대로 잠금 · 아니면 실패 +1, 상한 도달 시 잠금 시작(카운트 0)
--       success : 행 삭제 (초기화)
--     → { locked: bool, locked_seconds: int, failures: int }
--   * 정책은 호출자가 넘긴다 (관리자 웹 기본: 5회 실패 → 15분 잠금 — 기존 정책 유지).
--   * service role 전용. 사용자 JWT/anon 은 테이블도 RPC 도 접근할 수 없다 (제한 초기화·조회 불가).
--   * 관리자 웹은 RPC 오류 시 로그인을 허용하지 않는다 (fail-closed — adminAuth.ts).

create table if not exists public.admin_login_locks (
  key          text primary key check (char_length(key) between 8 and 128),
  failures     int not null default 0,
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);

comment on table public.admin_login_locks is '관리자 로그인 실패 카운터·잠금 (#27). key = HMAC(IP) 등 — 원문 없음. 서버 전용';

alter table public.admin_login_locks enable row level security;
revoke all on public.admin_login_locks from public, anon, authenticated;
grant all on public.admin_login_locks to service_role;

create or replace function public.admin_login_guard(p_key text, p_event text, p_max_failures int default 5, p_lock_seconds int default 900)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.admin_login_locks%rowtype;
  ts timestamptz := now();
  remaining int;
begin
  if auth.uid() is not null then
    raise exception 'server only' using errcode = '42501';
  end if;
  if p_key is null or char_length(p_key) < 8 or p_event not in ('check', 'failure', 'success')
     or p_max_failures is null or p_max_failures < 1 or p_lock_seconds is null or p_lock_seconds < 1 then
    raise exception 'invalid admin_login_guard arguments';
  end if;

  if p_event = 'success' then
    delete from public.admin_login_locks where key = p_key;
    return jsonb_build_object('locked', false, 'locked_seconds', 0, 'failures', 0);
  end if;

  if p_event = 'check' then
    select * into r from public.admin_login_locks where key = p_key;
    if found and r.locked_until is not null and r.locked_until > ts then
      remaining := greatest(1, ceil(extract(epoch from (r.locked_until - ts)))::int);
      return jsonb_build_object('locked', true, 'locked_seconds', remaining, 'failures', r.failures);
    end if;
    return jsonb_build_object('locked', false, 'locked_seconds', 0, 'failures', coalesce(r.failures, 0));
  end if;

  -- failure: 행을 만들고 잠근 뒤 판정 (동시 실패도 직렬화된다)
  insert into public.admin_login_locks (key) values (p_key) on conflict (key) do nothing;
  select * into r from public.admin_login_locks where key = p_key for update;
  if r.locked_until is not null and r.locked_until > ts then
    remaining := greatest(1, ceil(extract(epoch from (r.locked_until - ts)))::int);
    update public.admin_login_locks set updated_at = ts where key = p_key;
    return jsonb_build_object('locked', true, 'locked_seconds', remaining, 'failures', r.failures);
  end if;
  -- 만료된 잠금은 새 창으로 시작
  if r.locked_until is not null and r.locked_until <= ts then
    r.failures := 0;
  end if;
  r.failures := r.failures + 1;
  if r.failures >= p_max_failures then
    update public.admin_login_locks
       set failures = 0, locked_until = ts + make_interval(secs => p_lock_seconds), updated_at = ts
     where key = p_key;
    return jsonb_build_object('locked', true, 'locked_seconds', p_lock_seconds, 'failures', 0);
  end if;
  update public.admin_login_locks set failures = r.failures, locked_until = null, updated_at = ts where key = p_key;
  return jsonb_build_object('locked', false, 'locked_seconds', 0, 'failures', r.failures);
end;
$$;

revoke all on function public.admin_login_guard(text, text, int, int) from public, anon, authenticated;
grant execute on function public.admin_login_guard(text, text, int, int) to service_role;

create or replace function public.admin_login_locks_prune(p_keep interval default interval '1 day')
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  delete from public.admin_login_locks where updated_at < now() - p_keep and (locked_until is null or locked_until < now());
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.admin_login_locks_prune(interval) from public, anon, authenticated;
grant execute on function public.admin_login_locks_prune(interval) to service_role;
