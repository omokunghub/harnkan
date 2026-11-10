-- Admin "add without a link" picker: show each person's email, two accounts can share a display name.
drop function admin_list_users(uuid);
create function admin_list_users(g uuid) returns table (id uuid, display_name text, avatar_url text, email text)
language sql stable security definer set search_path = public as $$
  select p.id, p.display_name, p.avatar_url, u.email::text from profiles p join auth.users u on u.id = p.id
  where is_admin() and is_member(g)
    and not exists (select 1 from members m where m.group_id = g and m.user_id = p.id and m.removed_at is null)
  order by p.display_name, u.email
$$;
