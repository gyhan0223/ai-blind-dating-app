-- schedule-recommendation-cron.sql — 추천 배치·Push 발송기 pg_cron 등록 (#22 / #17)
--
-- 사용 (SQL Editor 또는 psql, 운영자가 실행 — 이 저장소는 실제 등록을 수행하지 않는다):
--   1) <project-ref> 를 프로젝트 ref 로 바꾼다 (두 곳).
--   2) service role key 는 SQL 에 쓰지 않는다. Vault 에 'service_role_key' 이름으로 한 번만 저장한다:
--        select vault.create_secret('<service-role-key>', 'service_role_key');   -- 이미 있으면 생략
--      (키 자체는 대시보드 Settings → API 에서 복사. 이 파일·커밋·로그에 붙여 넣지 않는다)
--   3) 이 파일 전체를 실행한다. **반복 실행해도 같은 이름의 작업이 중복 등록되지 않는다** — 같은 이름은 먼저 내리고 다시 올린다 (교체).
--
-- 스케줄
--   daily-recommendation-batch : KST 09:00~21:45 낮 시간대 15분 간격 (UTC 00:00~12:45 = '*/15 0-12 * * *'). 후보 부족(exhausted) 사용자를 1시간 뒤부터,
--                                실패 사용자를 15분 뒤부터 다시 확인한다. 진행 위치는 서버 커서에 저장되어 호출마다 이어진다 (docs/matching-policy.md 10절).
--                                한 호출은 time_budget_ms(기본 50초) 안에서 멈춘다. pg_net 의 timeout_milliseconds 를 그보다 길게 둔다 (기본 5초는 너무 짧다).
--                                하루 52회 호출. 대상이 없으면 조회 몇 번으로 끝나므로 비용은 "기다리는 사용자 수" 에 비례한다.
--   send-push                  : 1분 간격 (docs/push-notifications.md). 이미 등록돼 있으면 같은 정의로 교체된다.
--   recommendation-runs-prune  : 매일 UTC 18:00 (KST 03:00) 30일 지난 실행 기록 정리.
--   notification-events-prune  : 매일 UTC 18:30 (KST 03:30) 발송 완료 30일 지난 이벤트 정리.
--
-- 운영상 변경점: 배치는 밤(KST 22:00~08:59)에 돌지 않으므로 배치가 만든 소개 알림은 밤에 울리지 않는다 (제품 결정 2026-09-18 — 낮 시간대만 재확인).
--   앱을 직접 열어 생성되는 소개(daily-recommendation)·메시지·매치 알림은 시간대와 무관하게 기존대로다. 21:45 이후 후보 부족으로 끝난 사용자는
--   다음 날 09:00 배치가 새 KST 날짜로 다시 확인한다 (자정을 넘기면 for_date 가 바뀌어 어차피 새 소개 대상이다).
--
-- 되돌리기: 맨 아래 "롤백" 절 참고.

-- ---------------------------------------------------------------------------
-- 0) 확장 확인 (Supabase 는 대시보드 Database → Extensions 에서 pg_cron · pg_net 을 켠다)
-- ---------------------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- 1) 같은 이름의 기존 작업 제거 (멱등 — 없으면 아무 일도 하지 않는다)
-- ---------------------------------------------------------------------------
select cron.unschedule(jobid)
from cron.job
where jobname in ('daily-recommendation-batch', 'send-push', 'recommendation-runs-prune', 'notification-events-prune');

-- ---------------------------------------------------------------------------
-- 2) 등록
-- ---------------------------------------------------------------------------
-- 추천 배치 — KST 09:00~21:45 15분 간격 (pg_cron 은 UTC: 0-12시). body 는 페이지 크기·시간 예산만 (after 는 보내지 않는다: 서버 커서가 이어간다)
select cron.schedule('daily-recommendation-batch', '*/15 0-12 * * *', $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/daily-recommendation-batch',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
    body := '{"max_users": 100, "time_budget_ms": 50000}'::jsonb,
    timeout_milliseconds := 120000);
$$);

-- Push 발송기 — 1분 간격 (docs/push-notifications.md 와 같은 정의)
select cron.schedule('send-push', '* * * * *', $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
    body := '{"limit": 200}'::jsonb,
    timeout_milliseconds := 30000);
$$);

-- 기록 정리
select cron.schedule('recommendation-runs-prune', '0 18 * * *', $$ select public.recommendation_runs_prune(interval '30 days') $$);
select cron.schedule('notification-events-prune', '30 18 * * *', $$ select public.notification_events_prune(interval '30 days') $$);

-- ---------------------------------------------------------------------------
-- 3) 확인
-- ---------------------------------------------------------------------------
--   select jobid, jobname, schedule, active from cron.job
--   where jobname in ('daily-recommendation-batch', 'send-push', 'recommendation-runs-prune', 'notification-events-prune');
--   -- 최근 실행 상태 (pg_cron 자체 기록 — HTTP 응답은 net._http_response 에서)
--   select jobid, status, start_time, end_time, return_message from cron.job_run_details order by start_time desc limit 20;
--   select id, status_code, content::text from net._http_response order by id desc limit 5;
--   -- 배치 진행 위치
--   select * from public.recommendation_batch_cursor;
--   select result, count(*) from public.recommendation_runs where for_date = (now() at time zone 'Asia/Seoul')::date group by 1;

-- ---------------------------------------------------------------------------
-- 4) 롤백 — 배치 시간대를 바꾸거나 완전히 내린다
-- ---------------------------------------------------------------------------
--   -- (a) 시간대만 바꾸기: 시간대 외에는 같은 정의. 배치 함수·커서는 그대로 두어도 안전하다 (커서는 호출마다 이어갈 뿐)
--   --     예전 아침 전용 = '*/15 0 * * *' (KST 09:00~09:45), 하루 전체 = '*/15 * * * *' (밤에도 소개·알림이 생길 수 있다)
--   select cron.unschedule(jobid) from cron.job where jobname = 'daily-recommendation-batch';
--   select cron.schedule('daily-recommendation-batch', '*/15 0 * * *', $$ ...위와 같은 net.http_post... $$);
--   -- (b) 완전히 내리기 (앱의 daily-recommendation 은 계속 동작한다 — 사용자가 앱을 열면 생성된다)
--   select cron.unschedule(jobid) from cron.job where jobname = 'daily-recommendation-batch';
--   -- (c) 진행 중 sweep 이 남긴 lease 를 즉시 풀어야 할 때 (함수가 죽으면 3분 뒤 자동 만료)
--   update public.recommendation_batch_cursor set lease_until = null;
