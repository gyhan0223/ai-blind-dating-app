-- funnel_tests.sql — Issue #24: 퍼널 뷰가 서버 사실을 정확히 세는지 (앞선 테스트들이 만든 데이터 위에서), 클라이언트는 읽을 수 없음
\set ON_ERROR_STOP on
select set_config('request.jwt.claim.sub', '', false);

do $$
declare
  -- meetup_flow_tests 의 P·Q 매치: 양방향 대화 · 상호 관심 · 양측 met · 피드백 2건(P: no, Q: yes)
  mid uuid;
  r record;
  n int;
begin
  select m.id into mid from public.matches m
  where m.user_a = least('f1000000-0000-4000-8000-000000000041'::uuid, 'f2000000-0000-4000-8000-000000000042'::uuid)
    and m.user_b = greatest('f1000000-0000-4000-8000-000000000041'::uuid, 'f2000000-0000-4000-8000-000000000042'::uuid);
  select * into r from public.funnel_pair_facts where match_id = mid;
  if not r.first_message or not r.two_way or not r.mutual_interest or not r.outcome_reported or not r.one_side_met or not r.both_confirmed then
    raise exception 'FAIL pair facts: % % % % % %', r.first_message, r.two_way, r.mutual_interest, r.outcome_reported, r.one_side_met, r.both_confirmed;
  end if;
  if r.legacy_completed then raise exception 'FAIL legacy flag on met_confirmed pair'; end if;
  if r.feedback_count <> 2 or r.met_again_yes <> 1 or r.met_again_no <> 1 then
    raise exception 'FAIL feedback counts: % yes=% no=%', r.feedback_count, r.met_again_yes, r.met_again_no;
  end if;
  -- 미응답(null)·not_sure 는 yes/no 어느 쪽에도 세지 않는다
  if r.next_intro_yes <> 1 or r.next_intro_no <> 0 then raise exception 'FAIL next_intro counts (not_sure must not count): yes=% no=%', r.next_intro_yes, r.next_intro_no; end if;

  -- legacy completed 매치(P·S)는 both_confirmed 아님
  select * into r from public.funnel_pair_facts p
  where p.match_id = (select m.id from public.matches m
    where m.user_a = least('f1000000-0000-4000-8000-000000000041'::uuid, 'f4000000-0000-4000-8000-000000000044'::uuid)
      and m.user_b = greatest('f1000000-0000-4000-8000-000000000041'::uuid, 'f4000000-0000-4000-8000-000000000044'::uuid));
  if r.both_confirmed or not r.legacy_completed then raise exception 'FAIL legacy pair classification'; end if;

  -- 사용자 기준: P 는 양측 확인·피드백까지 도달
  select * into r from public.funnel_user_facts where user_id = 'f1000000-0000-4000-8000-000000000041';
  if not (r.matched and r.sent_message and r.two_way and r.mutual_interest and r.reported_met and r.both_confirmed and r.gave_feedback) then
    raise exception 'FAIL user facts for P';
  end if;
  if r.met_again_yes then raise exception 'FAIL P met_again should be no'; end if;
  -- cohort 뷰가 돈다
  select count(*) into n from public.funnel_user_cohorts;
  if n < 1 then raise exception 'FAIL user cohorts empty'; end if;
  select count(*) into n from public.funnel_pair_cohorts where both_confirmed >= 1;
  if n < 1 then raise exception 'FAIL pair cohorts missing confirmed'; end if;
end;
$$;

select set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000041', false);
set role authenticated;
do $$
declare denied boolean := false; n int;
begin
  begin
    select count(*) into n from public.funnel_user_cohorts;
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL client can read funnel views'; end if;
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '', false);

select 'FUNNEL TESTS PASSED' as result;
