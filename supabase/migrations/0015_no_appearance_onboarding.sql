-- 0015_no_appearance_onboarding.sql
-- Issue #39 — "사진 없이 대화로 먼저 알아가는 소개팅" MVP 에 맞춘 온보딩/프로필 전환.
--
-- 배경
--   MVP 는 외모 취향 테스트·외모 중요도·얼굴 임베딩 추천을 제공하지 않는다 (#30 로드맵, #8/#9/#10 은 MVP 이후 검토).
--   얼굴 라이브니스는 "실제 사람 확인·중복 가입 방지" 인증 목적으로만 유지한다 (#7).
--   상대를 알아갈 수 있도록 공개 프로필에 짧은 자기소개·연애 목적·공개 질문 답변을 추가한다.
--
-- 이 마이그레이션 (additive — 기존 데이터/컬럼 삭제 없음)
--   1) profiles: intro(짧은 자기소개) · relationship_goal(연애 목적) · public_answers(공개 질문 답변) 추가.
--        세 컬럼은 모두 "상대에게 공개되는" 정보다 (profiles = 공개 테이블). 민감/가치관 응답은 계속 private_profiles.
--   2) users 보호 트리거 보강: 클라이언트(JWT) 가 onboarding_completed 를 true 로 바꾸려면
--        identity_verified 와 face_verified 가 모두 true 여야 한다.
--        (온보딩 완료 판정은 클라이언트가 내리지만, 인증을 건너뛴 완료는 DB 가 거부한다 — 홈 진입 가드의 서버 측 방어선)
--   3) 외모 관련 컬럼/테이블(appearance_preference_events, preference_settings.appearance_importance,
--        face_verifications.feature_vector) 은 삭제하지 않고 "MVP 미사용" 으로 표시만 한다.
--        새 클라이언트는 더 이상 쓰지 않으며, 기존 행은 보존된다 (#40 이 매칭 계산에서 제외한다).
--
-- 기존 사용자 호환
--   * onboarding_step='appearance' 에 멈춘 사용자는 이 마이그레이션이 임의로 완료 처리하지 않는다.
--     앱의 Gate 가 인증 상태와 남은 필수 입력(자기소개 등)을 확인해 적절한 단계로 보낸다.
--   * 기존 profiles 행은 intro/relationship_goal 이 null — 앱이 'intro' 단계로 안내한다.

-- ---------------------------------------------------------------------------
-- 1) profiles 공개 자기소개 컬럼
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists intro             text,
  add column if not exists relationship_goal text,
  add column if not exists public_answers    jsonb not null default '{}'::jsonb;

comment on column public.profiles.intro is
  '짧은 자기소개 (공개 — 추천 카드에 표시). 최대 300자';
comment on column public.profiles.relationship_goal is
  '연애 목적 (공개 — 추천 카드에 표시): serious | marriage_minded | take_it_slow | undecided';
comment on column public.profiles.public_answers is
  '공개 질문 답변 {prompt_id: text} (공개 — 추천 카드에 표시). 허용 prompt_id 는 서버(_shared/matching/publicPrompts.ts)와 앱 상수가 동기';

alter table public.profiles drop constraint if exists profiles_intro_length;
alter table public.profiles add constraint profiles_intro_length
  check (intro is null or char_length(intro) between 1 and 300);

alter table public.profiles drop constraint if exists profiles_relationship_goal_check;
alter table public.profiles add constraint profiles_relationship_goal_check
  check (relationship_goal is null or relationship_goal in ('serious', 'marriage_minded', 'take_it_slow', 'undecided'));

-- 답변은 객체여야 하고, 전체 크기·항목 수·각 답변 길이를 제한한다 (카드 스냅샷 비대화 방지)
create or replace function public.public_answers_valid(v jsonb)
returns boolean
language sql
immutable
as $$
  select v is not null
     and jsonb_typeof(v) = 'object'
     and (select count(*) from jsonb_object_keys(v)) <= 8
     and char_length(v::text) <= 2000
     and not exists (
       select 1 from jsonb_each(v) e
       where jsonb_typeof(e.value) <> 'string'
          or char_length(e.value #>> '{}') > 200
          or char_length(e.key) > 40
     );
$$;

alter table public.profiles drop constraint if exists profiles_public_answers_valid;
alter table public.profiles add constraint profiles_public_answers_valid
  check (public.public_answers_valid(public_answers));

-- ---------------------------------------------------------------------------
-- 2) 온보딩 완료는 인증(본인확인 + 얼굴 라이브니스) 이후에만 — 클라이언트(JWT) 컨텍스트 한정
--    (0001 의 guard_user_protected_columns 는 그대로 두고 별도 트리거로 추가한다)
-- ---------------------------------------------------------------------------
create or replace function public.guard_onboarding_completion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null
     and new.onboarding_completed
     and not old.onboarding_completed
     and not (new.identity_verified and new.face_verified) then
    raise exception 'onboarding cannot be completed before identity and face verification';
  end if;
  return new;
end;
$$;

drop trigger if exists users_guard_onboarding_completion on public.users;
create trigger users_guard_onboarding_completion
  before update on public.users
  for each row execute function public.guard_onboarding_completion();

-- ---------------------------------------------------------------------------
-- 3) 외모 관련 데이터 — MVP 미사용 표시 (삭제하지 않음)
-- ---------------------------------------------------------------------------
comment on table public.appearance_preference_events is
  'MVP(#39) 에서 사용하지 않음 — 외모 취향 테스트는 온보딩에서 제외됨. 기존 행 보존. 매칭 계산 제외는 #40';
comment on column public.preference_settings.appearance_importance is
  'MVP(#39) 에서 사용하지 않음 — 앱이 더 이상 입력받지 않는다 (기본값 3 유지). 매칭 가중치 제외는 #40';
comment on column public.face_verifications.feature_vector is
  '얼굴 임베딩 — MVP 에서 생성하지 않음 (null). 인증용 라이브니스 결과와 무관. 도입 여부는 MVP 이후 별도 검토(#8)';
