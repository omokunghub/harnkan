-- The admin can put anyone who has already signed in once into a group, no invite link needed.
create function admin_list_users(g uuid) returns table (id uuid, display_name text, avatar_url text)
language sql stable security definer set search_path = public as $$
  select p.id, p.display_name, p.avatar_url from profiles p
  where is_admin() and is_member(g)
    and not exists (select 1 from members m where m.group_id = g and m.user_id = p.id and m.removed_at is null)
  order by p.display_name
$$;

create function admin_add_member(g uuid, u uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m uuid;
begin
  if not (is_admin() and is_member(g)) then raise exception 'admin only'; end if;
  insert into members (group_id, user_id) values (g, u)
  on conflict (group_id, user_id) do update set removed_at = null
  returning id into m;
  insert into activity (group_id, action, detail) values (g, 'member_add', jsonb_build_object('member', m));
end $$;
