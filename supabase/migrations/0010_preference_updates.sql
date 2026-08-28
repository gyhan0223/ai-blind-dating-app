-- 0010_preference_updates.sql
-- 이상형/추천 피드백 보강
--  1) 연상·연하·동갑 선호 (preference_settings.age_direction)
--     — Dealbreaker 가 아니라 soft preference. MatchingEngine 가감점에 반영.
--  2) 추천 스킵 사유 (recommendations.skip_reason)
--     — "이번에는 넘길게요" 시 선택. 지금은 수집만 하고,
--       추후 추천 가중치 보정/탐색 정책의 입력으로 사용한다.

alter table public.preference_settings
  add column age_direction text not null default 'any';
alter table public.preference_settings
  add constraint preference_settings_age_direction_check
  check (age_direction in ('any', 'older', 'same', 'younger'));

alter table public.recommendations
  add column skip_reason text;
alter table public.recommendations
  add constraint recommendations_skip_reason_check
  check (skip_reason is null or skip_reason in ('conditions', 'style', 'distance', 'not_now', 'other'));
