-- Admin monitor: read-only views across every group, including ones the admin isn't in.
create function admin_users() returns table (id uuid, display_name text, avatar_url text, email text, last_sign_in_at timestamptz, trips bigint)
language sql stable security definer set search_path = public as $$
  select p.id, p.display_name, p.avatar_url, u.email::text, u.last_sign_in_at,
    (select count(*) from members m where m.user_id = p.id and m.removed_at is null)
  from profiles p join auth.users u on u.id = p.id
  where is_admin()
  order by p.display_name
$$;

create function admin_groups() returns table (id uuid, name text, type text, cover_url text, created_at timestamptz, members bigint, bills bigint)
language sql stable security definer set search_path = public as $$
  select g.id, g.name, g.type, g.cover_url, g.created_at,
    (select count(*) from members m where m.group_id = g.id and m.removed_at is null),
    (select count(*) from bills b where b.group_id = g.id)
  from groups g
  where is_admin()
  order by g.created_at desc
$$;

-- One trip in the shapes the app already reads (members with profiles, bills with items/shares/payers).
create function admin_group(g uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'admin only'; end if;
  return jsonb_build_object(
    'group', (select to_jsonb(x) from groups x where x.id = g),
    'members', (select coalesce(jsonb_agg(to_jsonb(m) || jsonb_build_object('profiles',
        (select jsonb_build_object('display_name', p.display_name, 'avatar_url', p.avatar_url) from profiles p where p.id = m.user_id))), '[]')
      from members m where m.group_id = g),
    'bills', (select coalesce(jsonb_agg(to_jsonb(b) || jsonb_build_object(
        'bill_items', (select coalesce(jsonb_agg(to_jsonb(i) || jsonb_build_object('item_shares',
            (select coalesce(jsonb_agg(to_jsonb(s)), '[]') from item_shares s where s.item_id = i.id))), '[]')
          from bill_items i where i.bill_id = b.id),
        'bill_payers', (select coalesce(jsonb_agg(to_jsonb(bp)), '[]') from bill_payers bp where bp.bill_id = b.id))), '[]')
      from bills b where b.group_id = g),
    'activity', (select coalesce(jsonb_agg(to_jsonb(a) order by a.id desc), '[]') from activity a where a.group_id = g));
end $$;
