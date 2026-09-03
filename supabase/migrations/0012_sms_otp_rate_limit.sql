-- 0012_sms_otp_rate_limit.sql
-- SMS OTP 발송 남용 방지 — 전화번호별 재전송 쿨다운 + 시간당 상한 (서버 측 강제).
--
-- 배경
--   Supabase Auth 의 Rate Limits(대시보드)는 "프로젝트 전체 시간당 SMS 수" 만 제한한다.
--   같은 번호로 60초 안에 다시 요청해도 서버가 막지 않아, 한 번호가 프로젝트 한도(기본 30건/h)와
--   SOLAPI 잔액을 혼자 소진할 수 있다. 앱의 60초 타이머는 화면에서만 동작하므로(번호 변경/재시작으로
--   우회 가능) 진짜 차단은 send-sms Edge Function(Send SMS Hook)이 이 RPC 로 수행한다.
--
-- 설계
--   * sms_otp_send_log: 전화번호별 마지막 발송 시각 + 1시간 창(window) 발송 횟수.
--     전화번호 원문은 저장하지 않는다 — send-sms 가 서버 secret 으로 만든 HMAC 해시만 저장.
--   * RLS 정책 없음 + anon/authenticated 권한 회수 → 클라이언트 접근 완전 차단 (service role 전용).
--   * sms_otp_rate_limit_check(): 행 잠금(select ... for update) 후 판정·갱신을 한 트랜잭션에서 수행 →
--     동시 요청(같은 번호로 두 번 동시에 누름)에도 정확히 한 번만 허용된다.
--   * 허용된 요청만 기록한다. 거부된 요청은 last_sent_at 을 갱신하지 않으므로
--     "계속 눌러서 쿨다운이 계속 연장되는" 일이 없다.

create table public.sms_otp_send_log (
  phone_hash        text primary key,
  last_sent_at      timestamptz not null,
  window_started_at timestamptz not null,
  window_count      integer not null default 0 check (window_count >= 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.sms_otp_send_log is
  'SMS OTP 발송 쿨다운/시간당 상한 상태 (send-sms Edge Function 전용, 전화번호 HMAC 해시만 저장)';

create trigger sms_otp_send_log_touch_updated_at
  before update on public.sms_otp_send_log
  for each row execute function public.touch_updated_at();

-- 클라이언트 접근 차단: RLS on + 정책 없음 + 권한 회수 (service role 만 사용)
alter table public.sms_otp_send_log enable row level security;
revoke all on table public.sms_otp_send_log from anon, authenticated;

-- ---------------------------------------------------------------------------
-- sms_otp_rate_limit_check(p_phone_hash, p_cooldown_seconds, p_max_per_hour)
--   → { allowed: boolean, reason: 'ok' | 'cooldown' | 'hourly_limit', retry_after_seconds: int }
--
--   cooldown     : 마지막 허용 발송 후 p_cooldown_seconds 안의 재요청 거부
--   hourly_limit : 1시간 창 안에서 p_max_per_hour 건을 넘는 요청 거부 (창은 첫 발송 시각부터 1시간)
--   허용 시 last_sent_at / window_count 를 갱신하고 allowed=true 를 돌려준다.
-- ---------------------------------------------------------------------------
create or replace function public.sms_otp_rate_limit_check(
  p_phone_hash text,
  p_cooldown_seconds integer default 60,
  p_max_per_hour integer default 5
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.sms_otp_send_log%rowtype;
  ts timestamptz := now();
  cooldown interval := make_interval(secs => greatest(p_cooldown_seconds, 0));
  window_len interval := interval '1 hour';
  retry_after integer;
begin
  if p_phone_hash is null or length(p_phone_hash) < 16 then
    raise exception 'sms_otp_rate_limit_check: invalid phone hash';
  end if;
  if p_max_per_hour < 1 then
    raise exception 'sms_otp_rate_limit_check: p_max_per_hour must be >= 1';
  end if;

  select * into r from public.sms_otp_send_log where phone_hash = p_phone_hash for update;

  if not found then
    insert into public.sms_otp_send_log (phone_hash, last_sent_at, window_started_at, window_count)
    values (p_phone_hash, ts, ts, 1);
    return jsonb_build_object('allowed', true, 'reason', 'ok', 'retry_after_seconds', 0);
  end if;

  -- 1) 재전송 쿨다운
  if r.last_sent_at + cooldown > ts then
    retry_after := greatest(1, ceil(extract(epoch from (r.last_sent_at + cooldown - ts)))::integer);
    return jsonb_build_object('allowed', false, 'reason', 'cooldown', 'retry_after_seconds', retry_after);
  end if;

  -- 2) 1시간 창 — 만료됐으면 새 창 시작
  if r.window_started_at + window_len <= ts then
    r.window_started_at := ts;
    r.window_count := 0;
  end if;

  if r.window_count >= p_max_per_hour then
    retry_after := greatest(1, ceil(extract(epoch from (r.window_started_at + window_len - ts)))::integer);
    return jsonb_build_object('allowed', false, 'reason', 'hourly_limit', 'retry_after_seconds', retry_after);
  end if;

  update public.sms_otp_send_log
     set last_sent_at = ts,
         window_started_at = r.window_started_at,
         window_count = r.window_count + 1
   where phone_hash = p_phone_hash;

  return jsonb_build_object('allowed', true, 'reason', 'ok', 'retry_after_seconds', 0);
end;
$$;

-- service role 만 호출 가능 (PostgREST 기본 grant 회수)
revoke all on function public.sms_otp_rate_limit_check(text, integer, integer) from public, anon, authenticated;
grant execute on function public.sms_otp_rate_limit_check(text, integer, integer) to service_role;

-- 오래된 상태 행 정리 (선택 — pg_cron 등으로 주기 실행. 행 하나가 전화번호 하나라 크기는 작다)
create or replace function public.sms_otp_send_log_prune(p_older_than interval default interval '2 days')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  delete from public.sms_otp_send_log where last_sent_at < now() - p_older_than;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.sms_otp_send_log_prune(interval) from public, anon, authenticated;
grant execute on function public.sms_otp_send_log_prune(interval) to service_role;
