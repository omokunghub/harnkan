-- Admin mode in group settings: show which email each member signed in with.
create function admin_member_emails(g uuid) returns table (user_id uuid, email text)
language sql stable security definer set search_path = public as $$
  select m.user_id, u.email::text from members m join auth.users u on u.id = m.user_id
  where is_admin() and m.group_id = g
$$;
