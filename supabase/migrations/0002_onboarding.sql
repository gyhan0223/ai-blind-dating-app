-- 0002_onboarding.sql
-- 온보딩 데이터: 얼굴 인증 / 설문 / 이상형(Preference)과 Dealbreaker / 외모 취향 테스트

-- ---------------------------------------------------------------------------
-- face_verifications — 얼굴 인증 기록
--  * 이미지 원본은 private storage bucket("faces")에만 저장하며 여기에는 경로만 둔다.
--  * 어떤 사용자도 타인의 행을 볼 수 없다 (관리는 service role 전용).
--  * feature_vector 는 MVP 모의값 — 실서비스에서 얼굴 임베딩 모델로 교체.
-- ---------------------------------------------------------------------------
create table public.face_verifications (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users (id) on delete cascade,
  status          text not null default 'pending'
                    check (status in ('pending', 'approved', 'rejected')),
  front_path      text,
  left_path       text,
  right_path      text,
  liveness_passed boolean not null default false,
  provider        text not null default 'mock',
  feature_vector  jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index face_verifications_user_idx on public.face_verifications (user_id, created_at desc);

create trigger face_verifications_touch_updated_at
  before update on public.face_verifications
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- questionnaire_questions — 성격/라이프스타일/연애 스타일 문항 (앱 컨텐츠, 서버 관리)
-- ---------------------------------------------------------------------------
create table public.questionnaire_questions (
  id         text primary key,
  category   text not null check (category in ('personality', 'lifestyle', 'relationship')),
  text_ko    text not null,
  -- 매칭 시 어느 축으로 집계할지 (예: personality.extraversion)
  axis       text not null,
  -- true면 5가 축의 낮은 방향을 의미 (역채점)
  reverse    boolean not null default false,
  sensitive  boolean not null default false,
  optional   boolean not null default false,
  sort_order int not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger questionnaire_questions_touch_updated_at
  before update on public.questionnaire_questions
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- questionnaire_responses — 사용자의 1~5 응답
-- ---------------------------------------------------------------------------
create table public.questionnaire_responses (
  user_id     uuid not null references public.users (id) on delete cascade,
  question_id text not null references public.questionnaire_questions (id),
  value       smallint not null check (value between 1 and 5),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (user_id, question_id)
);

create trigger questionnaire_responses_touch_updated_at
  before update on public.questionnaire_responses
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- preference_settings — 맞으면 점수가 올라가는 선호 + 개인화 매칭 중요도
-- ---------------------------------------------------------------------------
create table public.preference_settings (
  user_id                 uuid primary key references public.users (id) on delete cascade,
  age_min                 int check (age_min between 19 and 80),
  age_max                 int check (age_max between 19 and 80),
  height_min              int check (height_min between 130 and 220),
  height_max              int check (height_max between 130 and 220),
  regions                 text[] not null default '{}',
  smoking_pref            text not null default 'any' check (smoking_pref in ('any', 'prefer_non')),
  drinking_pref           text not null default 'any' check (drinking_pref in ('any', 'prefer_light')),
  personality_keywords    text[] not null default '{}',
  -- 개인화 매칭 중요도 (1~5): 이 사용자에게 각 차원이 얼마나 중요한가
  appearance_importance   smallint not null default 3 check (appearance_importance between 1 and 5),
  personality_importance  smallint not null default 3 check (personality_importance between 1 and 5),
  values_importance       smallint not null default 3 check (values_importance between 1 and 5),
  lifestyle_importance    smallint not null default 3 check (lifestyle_importance between 1 and 5),
  relationship_importance smallint not null default 3 check (relationship_importance between 1 and 5),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  check (age_min is null or age_max is null or age_min <= age_max),
  check (height_min is null or height_max is null or height_min <= height_max)
);

create trigger preference_settings_touch_updated_at
  before update on public.preference_settings
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- dealbreakers — 조건이 맞지 않으면 추천에서 제외되는 규칙 (행 단위)
--   kind 예: age_range {"min":28,"max":36} / smoking {"allow":false}
--            regions {"codes":["seoul","gyeonggi"]} / marriage_intent {"min":3}
--            children_intent {"min":2} / height_range {"min":165,"max":190}
--            drinking {"max":"sometimes"} / religion {"exclude":["..."]}
-- ---------------------------------------------------------------------------
create table public.dealbreakers (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users (id) on delete cascade,
  kind       text not null check (kind in (
               'age_range', 'height_range', 'smoking', 'drinking',
               'regions', 'marriage_intent', 'children_intent', 'religion')),
  value      jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, kind)
);

create trigger dealbreakers_touch_updated_at
  before update on public.dealbreakers
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- appearance_preference_events — 외모 취향 A/B 선택 기록
--  * option_a/b 는 테스트용 얼굴 asset id (실사용자 얼굴은 절대 사용하지 않음)
-- ---------------------------------------------------------------------------
create table public.appearance_preference_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users (id) on delete cascade,
  option_a   text not null,
  option_b   text not null,
  selected   text not null,
  created_at timestamptz not null default now(),
  check (selected in (option_a, option_b))
);

create index appearance_pref_user_idx on public.appearance_preference_events (user_id, created_at);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.face_verifications           enable row level security;
alter table public.questionnaire_questions      enable row level security;
alter table public.questionnaire_responses      enable row level security;
alter table public.preference_settings          enable row level security;
alter table public.dealbreakers                 enable row level security;
alter table public.appearance_preference_events enable row level security;

-- 얼굴 인증: 본인 조회/생성만. 승인(status 변경)은 service role 전용.
create policy face_verifications_select_own on public.face_verifications
  for select using (user_id = auth.uid());
create policy face_verifications_insert_own on public.face_verifications
  for insert with check (user_id = auth.uid() and status = 'pending');

-- 문항: 로그인한 사용자 모두 조회 가능, 수정은 서버 전용
create policy questionnaire_questions_read on public.questionnaire_questions
  for select using (auth.uid() is not null);

-- 응답/선호/딜브레이커/외모취향: 본인만
create policy questionnaire_responses_own on public.questionnaire_responses
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy preference_settings_own on public.preference_settings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy dealbreakers_own on public.dealbreakers
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy appearance_pref_select_own on public.appearance_preference_events
  for select using (user_id = auth.uid());
create policy appearance_pref_insert_own on public.appearance_preference_events
  for insert with check (user_id = auth.uid());
