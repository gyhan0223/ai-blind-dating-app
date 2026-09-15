-- 0022_funnel_views.sql
-- Issue #24 — 사진 없는 대화 → 실제 만남 → 재만남 의향 퍼널의 정의를 DB 뷰로 고정한다 (service role 전용).
-- 관리자 대시보드와 raw query 가 같은 뷰를 읽으므로 수치가 어긋나지 않는다. 정의 문서: docs/funnel-metrics.md
--
-- 단위
--   * 사용자 기준 (funnel_user_facts): 사용자 한 명이 각 단계에 "한 번이라도" 도달했는지. 가입주(KST) cohort 로 묶는다.
--   * 매치 쌍 기준 (funnel_pair_facts): 매치 하나가 각 단계에 도달했는지. 매치 생성주 cohort.
-- 기준 (서버 사실만 — 클라이언트 이벤트로 확정하지 않는다)
--   추천 확인   : recommendations 행 존재 (status 무관)
--   호감 표현   : likes 행
--   매치        : matches 행
--   첫 메시지   : conversation_metrics.first_message_at
--   양방향 대화 : messages_a > 0 and messages_b > 0
--   대화 지속   : 매치 생성 후 7일 안에 양방향이고 active_days >= 2 (진정성 점수가 아니라 관찰 기준)
--   상호 만남 의향: matches.mutual_interest_at (0016 이후) 또는 과거 상태값
--   만남 응답   : meetup_outcomes 행 (한쪽 이상)
--   양측 만남 확인: matches.meetup_state = 'met_confirmed' (legacy completed 는 별도 컬럼)
--   피드백      : meetup_feedback 행. 재만남 의향 yes / 다음 소개 의향 yes 는 값으로 구분, 미응답(null)·not_sure 는 부정이 아니다

create or replace view public.funnel_pair_facts as
select
  m.id as match_id,
  m.created_at as matched_at,
  date_trunc('week', (m.created_at at time zone 'Asia/Seoul'))::date as cohort_week,
  m.status,
  cm.first_message_at is not null as first_message,
  coalesce(cm.messages_a, 0) > 0 and coalesce(cm.messages_b, 0) > 0 as two_way,
  (coalesce(cm.messages_a, 0) > 0 and coalesce(cm.messages_b, 0) > 0
     and coalesce(cm.active_days, 0) >= 2
     and cm.first_message_at <= m.created_at + interval '7 days') as sustained_7d,
  (m.mutual_interest_at is not null or m.meetup_state in ('mutual_interest', 'scheduled', 'completed', 'met_confirmed', 'interest_withdrawn')) as mutual_interest,
  exists (select 1 from public.meetup_outcomes o where o.match_id = m.id) as outcome_reported,
  exists (select 1 from public.meetup_outcomes o where o.match_id = m.id and o.outcome = 'met') as one_side_met,
  m.meetup_state = 'met_confirmed' as both_confirmed,
  m.meetup_state = 'completed' as legacy_completed,
  exists (select 1 from public.meetup_feedback f where f.match_id = m.id) as feedback_any,
  (select count(*) from public.meetup_feedback f where f.match_id = m.id) as feedback_count,
  (select count(*) from public.meetup_feedback f where f.match_id = m.id and f.met_again_intent = 'yes') as met_again_yes,
  (select count(*) from public.meetup_feedback f where f.match_id = m.id and f.met_again_intent = 'no') as met_again_no,
  (select count(*) from public.meetup_feedback f where f.match_id = m.id and f.next_intro_intent = 'yes') as next_intro_yes,
  (select count(*) from public.meetup_feedback f where f.match_id = m.id and f.next_intro_intent = 'no') as next_intro_no
from public.matches m
left join public.conversations c on c.match_id = m.id
left join public.conversation_metrics cm on cm.conversation_id = c.id;

create or replace view public.funnel_user_facts as
select
  u.id as user_id,
  u.created_at as signed_up_at,
  date_trunc('week', (u.created_at at time zone 'Asia/Seoul'))::date as cohort_week,
  u.status,
  u.is_demo,
  u.onboarding_completed and u.identity_verified and u.face_verified as onboarded,
  exists (select 1 from public.recommendations r where r.user_id = u.id) as got_recommendation,
  exists (select 1 from public.likes l where l.from_user_id = u.id) as liked,
  exists (select 1 from public.matches m where u.id in (m.user_a, m.user_b)) as matched,
  exists (select 1 from public.matches m join public.conversations c on c.match_id = m.id
          join public.messages msg on msg.conversation_id = c.id
          where u.id in (m.user_a, m.user_b) and msg.sender_id = u.id) as sent_message,
  exists (select 1 from public.funnel_pair_facts p join public.matches m on m.id = p.match_id
          where u.id in (m.user_a, m.user_b) and p.two_way) as two_way,
  exists (select 1 from public.funnel_pair_facts p join public.matches m on m.id = p.match_id
          where u.id in (m.user_a, m.user_b) and p.sustained_7d) as sustained_7d,
  exists (select 1 from public.funnel_pair_facts p join public.matches m on m.id = p.match_id
          where u.id in (m.user_a, m.user_b) and p.mutual_interest) as mutual_interest,
  exists (select 1 from public.meetup_outcomes o where o.user_id = u.id and o.outcome = 'met') as reported_met,
  exists (select 1 from public.matches m where u.id in (m.user_a, m.user_b) and m.meetup_state = 'met_confirmed') as both_confirmed,
  exists (select 1 from public.meetup_feedback f where f.user_id = u.id) as gave_feedback,
  exists (select 1 from public.meetup_feedback f where f.user_id = u.id and f.met_again_intent = 'yes') as met_again_yes,
  exists (select 1 from public.meetup_feedback f where f.user_id = u.id and f.next_intro_intent = 'yes') as next_intro_yes
from public.users u;

-- cohort 별 집계 (가입주). demo 계정 제외
create or replace view public.funnel_user_cohorts as
select
  cohort_week,
  count(*) as signed_up,
  count(*) filter (where onboarded) as onboarded,
  count(*) filter (where got_recommendation) as got_recommendation,
  count(*) filter (where liked) as liked,
  count(*) filter (where matched) as matched,
  count(*) filter (where sent_message) as sent_message,
  count(*) filter (where two_way) as two_way,
  count(*) filter (where sustained_7d) as sustained_7d,
  count(*) filter (where mutual_interest) as mutual_interest,
  count(*) filter (where reported_met) as reported_met,
  count(*) filter (where both_confirmed) as both_confirmed,
  count(*) filter (where gave_feedback) as gave_feedback,
  count(*) filter (where met_again_yes) as met_again_yes,
  count(*) filter (where next_intro_yes) as next_intro_yes
from public.funnel_user_facts
where not is_demo
group by cohort_week
order by cohort_week desc;

create or replace view public.funnel_pair_cohorts as
select
  cohort_week,
  count(*) as matched,
  count(*) filter (where first_message) as first_message,
  count(*) filter (where two_way) as two_way,
  count(*) filter (where sustained_7d) as sustained_7d,
  count(*) filter (where mutual_interest) as mutual_interest,
  count(*) filter (where outcome_reported) as outcome_reported,
  count(*) filter (where one_side_met) as one_side_met,
  count(*) filter (where both_confirmed) as both_confirmed,
  count(*) filter (where legacy_completed) as legacy_completed,
  count(*) filter (where feedback_any) as feedback_any,
  count(*) filter (where met_again_yes = 2) as met_again_both_yes,
  count(*) filter (where met_again_yes >= 1) as met_again_any_yes,
  count(*) filter (where next_intro_yes >= 1) as next_intro_any_yes
from public.funnel_pair_facts
group by cohort_week
order by cohort_week desc;

revoke all on public.funnel_pair_facts from public, anon, authenticated;
revoke all on public.funnel_user_facts from public, anon, authenticated;
revoke all on public.funnel_user_cohorts from public, anon, authenticated;
revoke all on public.funnel_pair_cohorts from public, anon, authenticated;
grant select on public.funnel_pair_facts, public.funnel_user_facts, public.funnel_user_cohorts, public.funnel_pair_cohorts to service_role;

comment on view public.funnel_user_cohorts is '가입주 cohort 사용자 퍼널 (#24). demo 제외. 각 열은 "한 번이라도 도달" 사용자 수';
comment on view public.funnel_pair_cohorts is '매치 생성주 cohort 매치 쌍 퍼널 (#24). both_confirmed 는 양측 met 응답, legacy_completed 는 0016 이전 한쪽 완료';
