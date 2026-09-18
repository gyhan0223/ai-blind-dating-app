-- 0035_admin_accounts_gotrue_metadata.sql
-- Issue #27 — 관리자 계정이 앱 사용자 행(public.users / subscriptions)을 만들지 않는다는 정책을 실제 GoTrue 에서도 지킨다.
--
-- 발견 (실제 로컬 Supabase Auth 통합 테스트 — docs/local-supabase-integration.md):
--   GoTrue 의 Admin API createUser 는 auth.users 를 먼저 insert 하고(raw_app_meta_data 에는 provider/providers 만),
--   요청의 app_metadata(bonsim_admin=true)는 같은 트랜잭션의 **별도 update** 로 적용한다 (supabase/auth internal/api/admin.go adminUserCreate).
--   0033 의 after-insert 트리거(handle_new_auth_user)는 insert 시점에 표식을 볼 수 없어 관리자 계정마다 public.users 행이 생겼고,
--   그 결과 admin_member_add 가 모든 관리자 추가를 app_user_not_allowed 로 거부했다 (mock SQL 테스트는 auth.users 에 표식과 함께 직접 insert 해서 드러나지 않았다).
--
-- 수정 (additive):
--   * auth.users 의 raw_app_meta_data 가 bonsim_admin=true 로 바뀌는 순간, "같은 트랜잭션에서 방금 생긴 빈 앱 사용자 행" 만 거둔다.
--     조건: users.created_at = now() (트랜잭션 시작 시각 — 같은 트랜잭션에서 insert 된 행만 일치) · onboarding 미완료 · profiles 없음.
--     기존 앱 사용자에게 누군가 표식을 붙여도 데이터는 지우지 않는다 (그 계정은 여전히 admin_member_add 에서 app_user_not_allowed).
--   * 이미 이 버그로 생긴 행 정리: admin_members 에 있고 온보딩·프로필이 없는 계정의 public.users 행 (한 번, 멱등).
--   * handle_new_auth_user 는 그대로 (insert 시점에 표식이 있는 경우 — seed·SQL 직접 생성 — 는 계속 건너뛴다).

create or replace function public.handle_auth_user_admin_marker()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(new.raw_app_meta_data->>'bonsim_admin', '') = 'true'
     and coalesce(old.raw_app_meta_data->>'bonsim_admin', '') <> 'true' then
    delete from public.users u
     where u.id = new.id
       and u.created_at = now()            -- 같은 트랜잭션에서 방금 만들어진 행 (GoTrue createUser: insert → update)
       and not u.onboarding_completed
       and not exists (select 1 from public.profiles p where p.user_id = u.id);
    -- subscriptions · analytics 등은 users FK on delete cascade
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_admin_marker on auth.users;
create trigger on_auth_user_admin_marker
  after update of raw_app_meta_data on auth.users
  for each row execute function public.handle_auth_user_admin_marker();

revoke all on function public.handle_auth_user_admin_marker() from public, anon, authenticated;

-- 이미 생긴 관리자 계정의 빈 앱 사용자 행 정리 (관리자 = admin_members 행. 온보딩·프로필이 있는 행은 건드리지 않는다 — 그런 계정은 관리자여서는 안 되므로 운영자가 확인)
delete from public.users u
 using public.admin_members m
 where m.user_id = u.id
   and not u.onboarding_completed
   and not exists (select 1 from public.profiles p where p.user_id = u.id);
