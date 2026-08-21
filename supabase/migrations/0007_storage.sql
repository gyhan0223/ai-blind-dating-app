-- 0007_storage.sql
-- 얼굴 이미지 전용 private bucket
--
-- 원칙:
--  * public bucket 금지 — public URL 이 만들어지지 않는다.
--  * 경로 규칙: faces/<user_id>/<pose>.jpg
--  * 본인 폴더만 읽기/쓰기 가능. 다른 사용자의 얼굴 이미지는 어떤 경로로도 접근 불가.
--  * 서버(관리/검수)는 service role 로만 접근.

do $$
begin
  -- 로컬 검증 환경에는 storage 스키마가 없을 수 있다 (실제 Supabase 에서만 실행)
  if exists (select 1 from information_schema.tables
             where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public)
    values ('faces', 'faces', false)
    on conflict (id) do nothing;

    execute $pol$
      create policy faces_select_own on storage.objects
        for select using (
          bucket_id = 'faces' and (storage.foldername(name))[1] = auth.uid()::text
        )
    $pol$;
    execute $pol$
      create policy faces_insert_own on storage.objects
        for insert with check (
          bucket_id = 'faces' and (storage.foldername(name))[1] = auth.uid()::text
        )
    $pol$;
    execute $pol$
      create policy faces_update_own on storage.objects
        for update using (
          bucket_id = 'faces' and (storage.foldername(name))[1] = auth.uid()::text
        )
    $pol$;
    execute $pol$
      create policy faces_delete_own on storage.objects
        for delete using (
          bucket_id = 'faces' and (storage.foldername(name))[1] = auth.uid()::text
        )
    $pol$;
  end if;
end;
$$;
