-- 0030_face_consents.sql
-- Issue #12 — 얼굴(생체) 정보 처리 별도 동의 증적.
--
--   * 사용자 · 동의 종류 · 문서 버전 · 서버 시각 만 저장한다 (문서 본문은 코드에 있다 — _shared/consent/faceConsentPolicy.ts).
--   * 쓰기는 서버(service role, start-face-liveness `consent` 액션)만 한다. 사용자 id 는 JWT 에서, 시각은 DB now() 에서 온다 →
--     타인의 동의·동의 시각·문서 버전을 클라이언트가 위조할 수 없다. 클라이언트는 본인 행 조회만 가능하다.
--   * unique(user_id, kind, doc_version): 중복 동의 요청은 멱등. 버전이 바뀌면 새 행이 필요하다 (재동의).
--   * 기존 사용자에게 동의 이력을 자동 생성하지 않는다 (backfill 없음).
--   * 익명화(users.purged_at) 시 동의 행을 지운다 (0025 의 waitlist 와 같은 패턴). hard delete 는 users cascade.
--   * start-face-liveness 는 신규 세션 생성 전에 현재 버전의 동의를 서버에서 확인한다. sync/웹훅/관리자 검토(진행 중 검증)는 동의를 요구하지 않는다.

create table if not exists public.face_consents (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users (id) on delete cascade,
  kind        text not null check (kind in ('face_biometric')),
  doc_version text not null check (doc_version ~ '^[0-9A-Za-z.\-]{1,40}$'),
  granted_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),
  unique (user_id, kind, doc_version)
);

comment on table public.face_consents is
  '얼굴(생체) 정보 처리 별도 동의 증적 (#12). 서버 전용 쓰기 · 본인 조회. 문서 본문은 코드(faceConsentPolicy.ts)에 있고 여기엔 버전만';

create index if not exists face_consents_user_idx on public.face_consents (user_id, kind, doc_version) where revoked_at is null;

alter table public.face_consents enable row level security;

drop policy if exists face_consents_select_own on public.face_consents;
create policy face_consents_select_own on public.face_consents
  for select using (auth.uid() = user_id);
-- insert/update/delete 정책 없음 → authenticated 는 쓸 수 없다. 트리거가 2차 방어

create or replace function public.guard_face_consents_server_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    raise exception 'face_consents can only be changed by the server' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  -- 시각은 서버가 정한다 (클라이언트 입력 무시)
  if tg_op = 'INSERT' then
    new.granted_at := now();
  elsif tg_op = 'UPDATE' then
    new.granted_at := old.granted_at;
  end if;
  return new;
end;
$$;

drop trigger if exists face_consents_server_only on public.face_consents;
create trigger face_consents_server_only
  before insert or update or delete on public.face_consents
  for each row execute function public.guard_face_consents_server_only();

-- 익명화 시 동의 행 삭제
create or replace function public.handle_user_purged_face_consents()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.purged_at is not null and old.purged_at is null then
    delete from public.face_consents where user_id = new.id;
  end if;
  return new;
end;
$$;
drop trigger if exists users_purged_face_consents on public.users;
create trigger users_purged_face_consents after update of purged_at on public.users for each row execute function public.handle_user_purged_face_consents();
