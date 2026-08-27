-- 0008_match_updates.sql
-- 매치 참가자가 만남 상태(meetup_state)와 대화 종료(status='closed')를
-- 갱신할 수 있게 한다. 그 외 컬럼 변경은 트리거로 차단.

create policy matches_update_participant on public.matches
  for update
  using (auth.uid() in (user_a, user_b))
  with check (auth.uid() in (user_a, user_b));

create or replace function public.guard_match_update()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is not null then
    -- 참가자는 meetup 상태 진행과 대화 종료만 할 수 있다
    if new.user_a is distinct from old.user_a
       or new.user_b is distinct from old.user_b
       or new.created_at is distinct from old.created_at then
      raise exception 'immutable match columns';
    end if;
    if new.status is distinct from old.status
       and not (
         new.status = 'closed'
         -- 차단 트리거 경유: 실제 차단 쌍일 때만 blocked 전이 허용
         or (new.status = 'blocked' and public.is_blocked_pair(new.user_a, new.user_b))
       ) then
      raise exception 'participants can only close a match';
    end if;
    if new.meetup_state is distinct from old.meetup_state
       and not (
         -- 상호 yes 가 실제로 성립했을 때만 mutual_interest 로 전이 가능
         (old.meetup_state = 'none' and new.meetup_state = 'mutual_interest'
          and public.meetup_mutual_yes(new.id))
         or (old.meetup_state = 'mutual_interest' and new.meetup_state in ('scheduled', 'completed'))
         or (old.meetup_state = 'scheduled' and new.meetup_state = 'completed')
       ) then
      raise exception 'invalid meetup_state transition';
    end if;
  end if;
  return new;
end;
$$;

create trigger matches_guard_update
  before update on public.matches
  for each row execute function public.guard_match_update();
