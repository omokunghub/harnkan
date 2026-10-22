-- HarnKan schema. Paste into Supabase → SQL Editor, or `npx supabase db push`.

create table profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text not null default '',
  promptpay text -- phone number or e-wallet id
);

create table groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  invite_code text unique not null default replace(gen_random_uuid()::text, '-', ''),
  created_by uuid not null references auth.users,
  created_at timestamptz not null default now()
);

create table members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups on delete cascade,
  user_id uuid references profiles on delete cascade,
  guest_name text, -- friend without an account
  unique (group_id, user_id),
  check ((user_id is null) <> (guest_name is null))
);

create table bills (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups on delete cascade,
  paid_by uuid not null references members,
  title text not null,
  currency text not null default 'THB',
  image_path text,
  service_charge numeric not null default 0,
  vat numeric not null default 0,
  vat_included boolean not null default false,
  discount numeric not null default 0,
  grand_total numeric not null check (grand_total >= 0),
  created_by uuid not null default auth.uid() references auth.users,
  created_at timestamptz not null default now()
);

create table bill_items (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references bills on delete cascade,
  position int not null default 0,
  name text not null,
  name_translated text,
  qty numeric not null default 1,
  line_total numeric not null check (line_total >= 0)
);

create table item_shares (
  item_id uuid not null references bill_items on delete cascade,
  member_id uuid not null references members on delete cascade,
  weight int not null default 1 check (weight > 0),
  primary key (item_id, member_id)
);

create table settlements (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups on delete cascade,
  from_member uuid not null references members,
  to_member uuid not null references members,
  amount numeric not null check (amount > 0),
  currency text not null default 'THB',
  slip_path text,
  created_by uuid not null default auth.uid() references auth.users,
  created_at timestamptz not null default now()
);

create table comments (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references bills on delete cascade,
  member_id uuid not null references members,
  body text not null check (length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

create table push_subs (
  endpoint text primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  sub jsonb not null
);

create index on members (user_id);
create index on bills (group_id, created_at desc);
create index on bill_items (bill_id);
create index on settlements (group_id);
create index on comments (bill_id);

-- ---------- helpers (security definer so policies don't recurse into members' own RLS) ----------
create function is_member(g uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where group_id = g and user_id = auth.uid())
$$;
create function member_group(m uuid) returns uuid
language sql stable security definer set search_path = public as $$ select group_id from members where id = m $$;
create function bill_group(b uuid) returns uuid
language sql stable security definer set search_path = public as $$ select group_id from bills where id = b $$;
create function item_group(i uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select b.group_id from bill_items i2 join bills b on b.id = i2.bill_id where i2.id = i
$$;
create function shares_group(u uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members a join members b on a.group_id = b.group_id
                 where a.user_id = auth.uid() and b.user_id = u)
$$;

-- ---------- RPCs ----------
create function create_group(group_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare g uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into groups (name, created_by) values (group_name, auth.uid()) returning id into g;
  insert into members (group_id, user_id) values (g, auth.uid());
  return g;
end $$;

create function join_group(code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare g uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select id into g from groups where invite_code = code;
  if g is null then raise exception 'invalid invite'; end if;
  insert into members (group_id, user_id) values (g, auth.uid()) on conflict do nothing;
  return g;
end $$;

-- profile row for every new sign-up, name from Google
create function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, display_name) values (new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();

-- ---------- RLS ----------
alter table profiles enable row level security;
alter table groups enable row level security;
alter table members enable row level security;
alter table bills enable row level security;
alter table bill_items enable row level security;
alter table item_shares enable row level security;
alter table settlements enable row level security;
alter table comments enable row level security;
alter table push_subs enable row level security;

create policy "see self and groupmates" on profiles for select using (id = auth.uid() or shares_group(id));
create policy "edit self" on profiles for update using (id = auth.uid());

create policy "members see group" on groups for select using (is_member(id));
create policy "members rename group" on groups for update using (is_member(id));
create policy "creator deletes group" on groups for delete using (created_by = auth.uid());

create policy "members see members" on members for select using (is_member(group_id));
-- real users join via join_group(); members may add/rename/remove guests only
create policy "add guest" on members for insert with check (is_member(group_id) and user_id is null);
create policy "rename guest" on members for update using (is_member(group_id) and user_id is null);
create policy "remove guest" on members for delete using (is_member(group_id) and user_id is null);

create policy "members use bills" on bills for all using (is_member(group_id))
  with check (is_member(group_id) and member_group(paid_by) = group_id);
create policy "members use items" on bill_items for all using (is_member(bill_group(bill_id)))
  with check (is_member(bill_group(bill_id)));
create policy "members use shares" on item_shares for all using (is_member(item_group(item_id)))
  with check (is_member(item_group(item_id)) and member_group(member_id) = item_group(item_id));
create policy "members use settlements" on settlements for all using (is_member(group_id))
  with check (is_member(group_id) and member_group(from_member) = group_id and member_group(to_member) = group_id);

create policy "members read comments" on comments for select using (is_member(bill_group(bill_id)));
create policy "comment as self" on comments for insert
  with check (is_member(bill_group(bill_id)) and exists (select 1 from members where id = member_id and user_id = auth.uid()));
create policy "delete own comment" on comments for delete
  using (exists (select 1 from members where id = member_id and user_id = auth.uid()));

create policy "own push subs" on push_subs for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- storage: receipts/{group_id}/... (receipt photos and transfer slips) ----------
insert into storage.buckets (id, name, public) values ('receipts', 'receipts', false);
create policy "members read receipts" on storage.objects for select
  using (bucket_id = 'receipts' and is_member(((storage.foldername(name))[1])::uuid));
create policy "members upload receipts" on storage.objects for insert
  with check (bucket_id = 'receipts' and is_member(((storage.foldername(name))[1])::uuid));
create policy "members delete receipts" on storage.objects for delete
  using (bucket_id = 'receipts' and is_member(((storage.foldername(name))[1])::uuid));

-- ---------- realtime: friends see ticks and comments live ----------
alter publication supabase_realtime add table item_shares, comments;
