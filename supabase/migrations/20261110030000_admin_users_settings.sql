-- Admin user list: which settings each person has (push devices by push-service host, PromptPay, QR, hidden trips).
drop function admin_users();
create function admin_users() returns table (id uuid, display_name text, avatar_url text, email text, last_sign_in_at timestamptz,
  trips bigint, push_hosts text[], promptpay boolean, payment_qr boolean, hidden bigint)
language sql stable security definer set search_path = public as $$
  select p.id, p.display_name, p.avatar_url, u.email::text, u.last_sign_in_at,
    (select count(*) from members m where m.user_id = p.id and m.removed_at is null),
    array(select split_part(s.endpoint, '/', 3) from push_subs s where s.user_id = p.id),
    coalesce(p.promptpay, '') <> '', p.payment_qr_path is not null,
    (select count(*) from members m where m.user_id = p.id and m.removed_at is null and m.hidden_at is not null)
  from profiles p join auth.users u on u.id = p.id
  where is_admin()
  order by p.display_name
$$;
