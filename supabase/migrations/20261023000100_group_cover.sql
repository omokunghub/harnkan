-- Group cover photo. Paste into SQL Editor → Run (once), after group_settings.
alter table groups add column cover_url text
  check (cover_url ~ '^https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/covers/');
grant update (cover_url) on groups to authenticated;

-- public bucket: covers/{group_id}/...; only members of that group may upload or delete
insert into storage.buckets (id, name, public) values ('covers', 'covers', true);
create policy "members upload covers" on storage.objects for insert
  with check (bucket_id = 'covers' and is_member(((storage.foldername(name))[1])::uuid));
create policy "members delete covers" on storage.objects for delete
  using (bucket_id = 'covers' and is_member(((storage.foldername(name))[1])::uuid));
