-- Multiple payers per bill, group base currency, app admin (remove members, reset invite link).
-- Paste into SQL Editor → Run (once).

-- ---------- several people paid one bill ----------
-- No rows = bills.paid_by paid everything (all older bills). With rows, they must add up to grand_total (checked in the app).
create table bill_payers (
  bill_id uuid not null references bills on delete cascade,
  member_id uuid not null references members,
  amount numeric not null check (amount > 0),
  primary key (bill_id, member_id)
);
alter table bill_payers enable row level security;
create policy "members use payers" on bill_payers for all using (is_member(bill_group(bill_id)))
  with check (is_member(bill_group(bill_id)) and member_group(member_id) = bill_group(bill_id));

-- ---------- group base currency for totals ----------
alter table groups add column currency text not null default 'THB' check (currency ~ '^[A-Z]{3}$');
grant update (currency) on groups to authenticated;

-- ---------- app admin ----------
create table app_admins (user_id uuid primary key references auth.users on delete cascade);
alter table app_admins enable row level security;
create policy "see if I am admin" on app_admins for select using (user_id = auth.uid());
-- no insert policy: admins are added only from the SQL Editor (bottom of this file)

create function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_admins where user_id = auth.uid())
$$;

-- Removed members keep their name in old bills but lose access to the group.
alter table members add column removed_at timestamptz;
create or replace function is_member(g uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where group_id = g and user_id = auth.uid() and removed_at is null)
$$;

create or replace function join_group(code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare g uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select id into g from groups where invite_code = code;
  if g is null then raise exception 'invalid invite'; end if;
  insert into members (group_id, user_id) values (g, auth.uid())
  on conflict (group_id, user_id) do update set removed_at = null; -- rejoining needs the current link
  return g;
end $$;

create function remove_member(m uuid) returns void
language plpgsql security definer set search_path = public as $$
declare g uuid := member_group(m);
begin
  if not (is_admin() and is_member(g)) then raise exception 'admin only'; end if;
  update members set removed_at = now() where id = m and removed_at is null;
  insert into activity (group_id, action, detail) values (g, 'member_remove', jsonb_build_object('member', m));
end $$;

create function reset_invite(g uuid) returns text
language plpgsql security definer set search_path = public as $$
declare code text := replace(gen_random_uuid()::text, '-', '');
begin
  if not (is_admin() and is_member(g)) then raise exception 'admin only'; end if;
  update groups set invite_code = code where id = g;
  insert into activity (group_id, action) values (g, 'invite_reset');
  return code;
end $$;

-- make yourself the admin
insert into app_admins (user_id) select id from auth.users where email = 'omokungkub@gmail.com';
