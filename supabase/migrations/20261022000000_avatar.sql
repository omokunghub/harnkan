-- Profile pictures: default to the Google photo, users may upload their own.
-- Paste into SQL Editor → Run (once).

alter table profiles add column avatar_url text
  -- only Google photos or our own avatars bucket, so nobody can make groupmates load a tracking URL
  check (avatar_url ~ '^https://(lh[0-9]\.googleusercontent\.com/|[a-z0-9]+\.supabase\.co/storage/v1/object/public/avatars/)');

update profiles p set avatar_url = coalesce(u.raw_user_meta_data->>'avatar_url', u.raw_user_meta_data->>'picture')
from auth.users u where u.id = p.id
  and coalesce(u.raw_user_meta_data->>'avatar_url', u.raw_user_meta_data->>'picture') ~ '^https://lh[0-9]\.googleusercontent\.com/';

create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare pic text := coalesce(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture');
begin
  insert into profiles (id, display_name, avatar_url) values (new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    case when pic ~ '^https://lh[0-9]\.googleusercontent\.com/' then pic end);
  return new;
end $$;

-- public bucket: avatars are shown to groupmates; each user writes only inside their own folder
insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true);
create policy "upload own avatar" on storage.objects for insert
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "delete own avatar" on storage.objects for delete
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
