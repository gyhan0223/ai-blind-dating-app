-- 0011_skip_reason_detail.sql
-- 추천 스킵 사유를 2단계(항목 → 구체 사유)로 세분화한다.
--   skip_reason        : 아쉬웠던 항목 (age / region / height / job / smoking_drinking / style / not_now / other)
--   skip_reason_detail : 항목별 구체 사유 (예: age → too_old / too_young)
-- detail 값 목록은 클라이언트(lib/recommendations.ts SKIP_CATEGORIES)가 관리한다.
-- 지금은 수집만 하고, 추후 추천 가중치 보정/탐색 정책의 입력으로 사용한다.

alter table public.recommendations drop constraint if exists recommendations_skip_reason_check;
alter table public.recommendations add constraint recommendations_skip_reason_check
  check (skip_reason is null or skip_reason in (
    'age', 'region', 'height', 'job', 'smoking_drinking', 'style', 'not_now', 'other',
    -- 0010 에서 수집된 값 하위 호환
    'conditions', 'distance'
  ));

alter table public.recommendations add column skip_reason_detail text;
