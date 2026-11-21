-- Any member can add a "friend" (someone they're in another trip with right now) without an invite link.
-- The admin still sees everyone who has signed in. Emails only go to the admin.
create function list_friends(g uuid) returns table (id uuid, display_name text, avatar_url text, email text)
language sql stable security definer set search_path = public as $$
  select p.id, p.display_name, p.avatar_url, case when is_admin() then u.email::text end
  from profiles p join auth.users u on u.id = p.id
  where is_member(g)
    and not exists (select 1 from members m where m.group_id = g and m.user_id = p.id and m.removed_at is null)
    and (is_admin() or exists (
      select 1 from members mine join members theirs on theirs.group_id = mine.group_id
      where mine.user_id = auth.uid() and mine.removed_at is null
        and theirs.user_id = p.id and theirs.removed_at is null))
  order by p.display_name, u.email
$$;

create function add_friend(g uuid, u uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m uuid;
begin
  if not exists (select 1 from list_friends(g) f where f.id = u) then raise exception 'not your friend'; end if;
  insert into members (group_id, user_id) values (g, u)
  on conflict (group_id, user_id) do update set removed_at = null
  returning id into m;
  insert into activity (group_id, action, detail) values (g, 'member_add', jsonb_build_object('member', m));
end $$;

