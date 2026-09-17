-- 0032_recommendation_batch_hourly.sql
-- Issue #22 — 후보 부족 사용자를 앱 미접속 중에도 서버가 매시간 다시 확인한다 (#23 대기 → #22 재확인 → #17 알림).
--
-- 배경
--   배치(daily-recommendation-batch)는 지금까지 아침 한 번(KST 09:00~09:45) "미리 준비" 용으로만 돌았다.
--   아침 실행에서 "후보 없음(exhausted)" 으로 끝난 사용자는 앱을 직접 열지 않으면 다음 날 아침까지 아무도 다시 찾아주지 않았다.
--   이제 배치를 KST 09:00~21:45 사이 매시간(15분 페이지 간격) 돌린다 — docs/matching-policy.md 10절.
--
-- 이 마이그레이션이 바꾸는 것 (additive — 행 데이터는 바꾸지 않는다)
--   1) recommendation_batch_targets 에 p_retry_after_seconds(기본 3600) 인자를 추가한다.
--      매시간 cron(:00) 과 1시간 창을 그대로 쓰면 09:00:05 에 exhausted 로 끝난 사용자가 10:00:00 에는 "1시간 안" 이라 빠지고
--      11:00 에야 다시 확인되어 사실상 두 시간에 한 번이 된다. 배치는 창을 50분(3000초)으로 넘겨 매시간 정확히 한 번 재확인한다.
--      앱의 daily-recommendation 은 기본값(1시간)을 그대로 쓴다 — 앱 "다시 확인" 이 서버 재시도 주기를 우회하지 않는다 (#23).
--      같은 값을 recommendation_run_claim(p_retry_after_seconds) 에도 넘기므로 대상 선정과 실행권 판정이 어긋나지 않는다.
--   2) 그 외 조건은 0026 정의 그대로다: 진행 중 대화가 가득 찬 사용자(conversation_active_count ≥ 한도)와 그날 ok/slots_full 로 끝난 사용자는
--      대상에서 뺀다 (#24 — 같은 날 재시도 없음). 후보 부족(exhausted)과 자리 부족(slots_full)은 계속 구분된다.
--      (함수 정의 이력: 0017 → 0026 → 여기. 시그니처가 바뀌므로 drop 후 재생성)
--
-- 바뀌지 않는 것
--   * 후보 없는 실행은 그날 소개 완료(ok)가 아니다 — 창이 지나면 다시 대상이 된다. 하루 한 명 한도는 ok 로 끝난 사용자에게만 적용된다.
--   * (user_id, for_date) 당 실행 행 1개 · claim 잠금 — 앱 요청·배치·재시도가 겹쳐도 소개는 하루 한 명이다.
--   * 알림은 recommendations insert 트리거(0018)가 실제 저장된 소개에만 dedupe 키 'recommendation:<user>:<date>' 로 1건 넣는다.
--     후보 부족 상태를 반복 확인하는 것만으로는 notification_events 가 생기지 않는다 (#17).

drop function if exists public.recommendation_batch_targets(date, uuid, int);

create or replace function public.recommendation_batch_targets(
  p_for_date date,
  p_after uuid default null,
  p_limit int default 200,
  p_retry_after_seconds int default 3600
)
returns table (user_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select u.id
  from public.users u
  where u.status = 'active' and u.onboarding_completed and u.identity_verified and u.face_verified and u.age_verified
    and (p_after is null or u.id > p_after)
    and public.conversation_active_count(u.id) < public.conversation_slot_limit()
    and not exists (
      select 1 from public.recommendations r
      where r.user_id = u.id and r.for_date = p_for_date and r.status <> 'expired')
    and not exists (
      select 1 from public.recommendation_runs x
      where x.user_id = u.id and x.for_date = p_for_date
        and (x.status = 'running' and x.lease_until > now()
             or x.status = 'done' and x.result in ('ok', 'slots_full')
             or x.status = 'done' and x.result = 'exhausted'
                and x.finished_at > now() - make_interval(secs => greatest(coalesce(p_retry_after_seconds, 3600), 60))))
  order by u.id
  limit greatest(1, least(p_limit, 500));
$$;

comment on function public.recommendation_batch_targets(date, uuid, int, int) is
  '배치 대상 (#22): 자격 있고 대화 자리가 남고 오늘(KST) 추천이 없으며, 실행 중/오늘 ok/오늘 slots_full 이 아니고, exhausted 는 p_retry_after_seconds(기본 3600, 배치는 3000) 가 지난 사용자. service role 전용';

revoke all on function public.recommendation_batch_targets(date, uuid, int, int) from public, anon, authenticated;
grant execute on function public.recommendation_batch_targets(date, uuid, int, int) to service_role;
