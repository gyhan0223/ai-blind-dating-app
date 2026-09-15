-- 0024_profile_edit.sql
-- Issue #25 — 온보딩 후 프로필·선호 조건·Dealbreaker·가치관 수정.
--
--   1) profiles 보호 컬럼 — 최종 사용자는 gender / birth_year 를 본인확인 결과(user_identities)와 다르게 저장할 수 없고,
--        온보딩 완료 뒤에는 바꿀 수 없다. user_id 변경 불가. (인증 플래그는 0001, 온보딩 완료는 0015 가 이미 보호)
--   2) 변경 이벤트 — 온보딩을 마친 사용자가 profiles / private_profiles 를 고치면 서버 트리거가 analytics_events 에
--        profile_updated / values_updated 를 남긴다. payload 는 바뀐 "컬럼 이름" 만 (값 없음).
--   3) preferences_save(p_settings, p_dealbreakers) — 선호 설정 upsert + Dealbreaker 동기화를 한 트랜잭션으로.
--        중간 실패 시 아무것도 바뀌지 않는다. 허용 키만 받고 appearance_importance 는 받지 않는다 (#39).
--        온보딩 완료 사용자의 호출은 preferences_updated 이벤트를 남긴다.
--
-- 반영 시점: 추천 엔진은 생성 시점에 preference_settings / dealbreakers / profiles 를 읽으므로(#40 DataSource)
--   수정값은 "다음 추천 생성" 부터 반영된다. 이미 만들어진 오늘 추천은 다시 계산하지 않는다 (앱이 안내한다).
--
-- 검증: supabase/tests/profile_edit_tests.sql

-- ---------------------------------------------------------------------------
-- 1) profiles 보호 컬럼
-- ---------------------------------------------------------------------------
-- 본인확인 결과(출생연도·성별)만 호출자 본인에 한해 돌려주는 헬퍼 — user_identities 는 클라이언트 비공개 테이블이라 DEFINER 로 읽는다.
-- 남의 값은 조회할 수 없고, 본인 값은 이미 본인이 아는 정보다 (해시·원문 없음).
create or replace function public.identity_facts_self()
returns table (birth_year int, gender text)
language sql
stable
security definer
set search_path = public
as $$
  select extract(year from i.birth_date)::int, i.gender
  from public.user_identities i
  where i.user_id = auth.uid()
  limit 1;
$$;
revoke all on function public.identity_facts_self() from public, anon;
grant execute on function public.identity_facts_self() to authenticated, service_role;

-- 가드 트리거는 SECURITY INVOKER (DEFINER 안에서는 is_end_user_request() 가 항상 false — 0016 원칙)
create or replace function public.guard_profile_protected_columns()
returns trigger
language plpgsql
as $$
declare
  ident record;
  completed boolean;
begin
  if not public.is_end_user_request() then
    return new;
  end if;

  if tg_op = 'UPDATE' and new.user_id is distinct from old.user_id then
    raise exception 'profile owner cannot be changed' using errcode = '42501';
  end if;

  -- 본인확인 결과가 있으면 성별·출생연도는 그 값과 같아야 한다 (insert/update 공통)
  select f.birth_year, f.gender into ident from public.identity_facts_self() f;
  if found then
    if ident.birth_year is not null and new.birth_year <> ident.birth_year then
      raise exception 'birth_year must match identity verification' using errcode = '42501';
    end if;
    if ident.gender is not null and new.gender <> ident.gender then
      raise exception 'gender must match identity verification' using errcode = '42501';
    end if;
  end if;

  -- 온보딩을 마친 뒤에는 성별·출생연도를 바꿀 수 없다
  if tg_op = 'UPDATE' and (new.gender is distinct from old.gender or new.birth_year is distinct from old.birth_year) then
    select u.onboarding_completed into completed from public.users u where u.id = old.user_id;
    if coalesce(completed, false) then
      raise exception 'gender and birth_year are locked after onboarding' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_protected on public.profiles;
create trigger profiles_guard_protected
  before insert or update on public.profiles
  for each row execute function public.guard_profile_protected_columns();

-- ---------------------------------------------------------------------------
-- 2) 변경 이벤트 (컬럼 이름만)
-- ---------------------------------------------------------------------------
create or replace function public.changed_columns(p_old jsonb, p_new jsonb, p_ignore text[])
returns text[]
language sql
immutable
as $$
  select coalesce(array_agg(n.key order by n.key), '{}')
  from jsonb_each(p_new) n
  join jsonb_each(p_old) o on o.key = n.key
  where n.value is distinct from o.value
    and not (n.key = any (p_ignore));
$$;

create or replace function public.handle_profile_edit()
returns trigger
language plpgsql
as $$
declare
  fields text[];
  completed boolean;
  ev text;
begin
  if not public.is_end_user_request() then
    return new;
  end if;
  select u.onboarding_completed into completed from public.users u where u.id = new.user_id;
  if not coalesce(completed, false) then
    return new;  -- 온보딩 중 저장은 onboarding_completed 로 충분하다
  end if;
  fields := public.changed_columns(to_jsonb(old), to_jsonb(new), array['updated_at', 'created_at', 'user_id']);
  if array_length(fields, 1) is null then
    return new;
  end if;
  ev := case tg_table_name when 'profiles' then 'profile_updated' else 'values_updated' end;
  insert into public.analytics_events (user_id, event_type, payload)
  values (new.user_id, ev, jsonb_build_object('fields', to_jsonb(fields)));
  return new;
end;
$$;

drop trigger if exists profiles_handle_edit on public.profiles;
create trigger profiles_handle_edit
  after update on public.profiles
  for each row execute function public.handle_profile_edit();

drop trigger if exists private_profiles_handle_edit on public.private_profiles;
create trigger private_profiles_handle_edit
  after update on public.private_profiles
  for each row execute function public.handle_profile_edit();

-- ---------------------------------------------------------------------------
-- 3) preferences_save — 선호 설정 + Dealbreaker 원자 저장 (SECURITY INVOKER: RLS 가 본인 행만 허용)
-- ---------------------------------------------------------------------------
create or replace function public.preferences_save(p_settings jsonb, p_dealbreakers jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  allowed_settings constant text[] := array[
    'age_min', 'age_max', 'age_direction', 'height_min', 'height_max', 'regions',
    'smoking_pref', 'drinking_pref', 'personality_keywords',
    'personality_importance', 'values_importance', 'lifestyle_importance', 'relationship_importance'
  ];
  allowed_kinds constant text[] := array[
    'age_range', 'height_range', 'smoking', 'drinking', 'regions', 'marriage_intent', 'children_intent', 'religion'
  ];
  k text;
  base public.preference_settings%rowtype;
  merged public.preference_settings%rowtype;
  d jsonb;
  kinds text[] := '{}';
  db_kind text;
  completed boolean;
begin
  if uid is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception 'invalid_settings';
  end if;
  for k in select jsonb_object_keys(p_settings) loop
    if not (k = any (allowed_settings)) then
      raise exception 'invalid_setting_key' using detail = k;
    end if;
  end loop;
  if p_dealbreakers is null or jsonb_typeof(p_dealbreakers) <> 'array' then
    raise exception 'invalid_dealbreakers';
  end if;

  -- 기존 행(없으면 기본값 행) 위에 넘어온 키만 덮어쓴다 — 넘기지 않은 항목은 그대로 남는다
  select * into base from public.preference_settings where user_id = uid;
  if not found then
    base := jsonb_populate_record(null::public.preference_settings, jsonb_build_object('user_id', uid));
    base.regions := '{}';
    base.personality_keywords := '{}';
    base.smoking_pref := 'any';
    base.drinking_pref := 'any';
    base.age_direction := 'any';
    base.appearance_importance := 3;
    base.personality_importance := 3;
    base.values_importance := 3;
    base.lifestyle_importance := 3;
    base.relationship_importance := 3;
  end if;
  merged := jsonb_populate_record(base, p_settings || jsonb_build_object('user_id', uid));

  insert into public.preference_settings as ps (
    user_id, age_min, age_max, age_direction, height_min, height_max, regions, smoking_pref, drinking_pref,
    personality_keywords, personality_importance, values_importance, lifestyle_importance, relationship_importance
  ) values (
    uid, merged.age_min, merged.age_max, merged.age_direction, merged.height_min, merged.height_max,
    coalesce(merged.regions, '{}'), merged.smoking_pref, merged.drinking_pref,
    coalesce(merged.personality_keywords, '{}'), merged.personality_importance, merged.values_importance,
    merged.lifestyle_importance, merged.relationship_importance
  )
  on conflict (user_id) do update set
    age_min = excluded.age_min,
    age_max = excluded.age_max,
    age_direction = excluded.age_direction,
    height_min = excluded.height_min,
    height_max = excluded.height_max,
    regions = excluded.regions,
    smoking_pref = excluded.smoking_pref,
    drinking_pref = excluded.drinking_pref,
    personality_keywords = excluded.personality_keywords,
    personality_importance = excluded.personality_importance,
    values_importance = excluded.values_importance,
    lifestyle_importance = excluded.lifestyle_importance,
    relationship_importance = excluded.relationship_importance;

  -- Dealbreaker: 넘어온 종류는 upsert, 나머지는 삭제 (전체 목록이 진실)
  for d in select * from jsonb_array_elements(p_dealbreakers) loop
    if jsonb_typeof(d) <> 'object' or d->>'kind' is null then
      raise exception 'invalid_dealbreaker';
    end if;
    db_kind := d->>'kind';
    if not (db_kind = any (allowed_kinds)) then
      raise exception 'invalid_dealbreaker_kind' using detail = db_kind;
    end if;
    if db_kind = any (kinds) then
      raise exception 'duplicate_dealbreaker_kind' using detail = db_kind;
    end if;
    if d ? 'value' and jsonb_typeof(d->'value') <> 'object' then
      raise exception 'invalid_dealbreaker_value' using detail = db_kind;
    end if;
    kinds := array_append(kinds, db_kind);
    insert into public.dealbreakers as db (user_id, kind, value)
    values (uid, db_kind, coalesce(d->'value', '{}'::jsonb))
    on conflict (user_id, kind) do update set value = excluded.value;
  end loop;
  delete from public.dealbreakers db where db.user_id = uid and not (db.kind = any (kinds));

  select u.onboarding_completed into completed from public.users u where u.id = uid;
  if coalesce(completed, false) then
    insert into public.analytics_events (user_id, event_type, payload)
    values (uid, 'preferences_updated', jsonb_build_object(
      'settings', (select coalesce(jsonb_agg(x order by x), '[]'::jsonb) from jsonb_object_keys(p_settings) x),
      'dealbreakers', to_jsonb(kinds)
    ));
  end if;

  return jsonb_build_object('saved', true, 'dealbreakers', to_jsonb(kinds));
end;
$$;

revoke all on function public.preferences_save(jsonb, jsonb) from public, anon;
grant execute on function public.preferences_save(jsonb, jsonb) to authenticated, service_role;

comment on function public.preferences_save(jsonb, jsonb) is
  '선호 설정 + Dealbreaker 원자 저장 (#25). 허용 키 외 거부, appearance_importance 미수용, 다음 추천 생성부터 반영';
