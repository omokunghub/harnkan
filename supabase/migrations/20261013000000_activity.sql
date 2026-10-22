-- Activity log: who did what. Written only by triggers, so it can't be skipped, forged or erased from the app.
-- Paste into SQL Editor → Run (once).

create table activity (
  id bigint generated always as identity primary key,
  group_id uuid not null references groups on delete cascade,
  bill_id uuid, -- no FK: the log outlives a deleted bill
  actor uuid default auth.uid(),
  action text not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index on activity (group_id, created_at desc);
create index on activity (bill_id, created_at desc);
alter table activity enable row level security;
create policy "members read activity" on activity for select using (is_member(group_id));
-- no insert/update/delete policies on purpose

-- {field: [old, new]} for fields that changed
create function row_diff(o jsonb, n jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce(jsonb_object_agg(k, jsonb_build_array(o -> k, n -> k)), '{}')
  from jsonb_object_keys(n) as t(k) where o -> k is distinct from n -> k
$$;

create function log_bill() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into activity (group_id, bill_id, action, detail)
    values (new.group_id, new.id, 'bill_create', jsonb_build_object('title', new.title, 'total', new.grand_total, 'currency', new.currency));
  elsif tg_op = 'UPDATE' then
    if new is not distinct from old then return null; end if;
    insert into activity (group_id, bill_id, action, detail)
    values (new.group_id, new.id, 'bill_update', jsonb_build_object('title', new.title, 'changes', row_diff(to_jsonb(old), to_jsonb(new))));
  else
    if not exists (select 1 from groups where id = old.group_id) then return null; end if; -- whole group deleted
    insert into activity (group_id, bill_id, action, detail)
    values (old.group_id, old.id, 'bill_delete', jsonb_build_object('title', old.title));
  end if;
  return null;
end $$;
create trigger log_bill after insert or update or delete on bills for each row execute function log_bill();

create function log_item() returns trigger
language plpgsql security definer set search_path = public as $$
declare b record;
begin
  select group_id, created_by, created_at into b from bills
  where id = case when tg_op = 'DELETE' then old.bill_id else new.bill_id end;
  if not found then return null; end if; -- bill deleted along with its items
  if tg_op = 'DELETE' then
    insert into activity (group_id, bill_id, action, detail) values (b.group_id, old.bill_id, 'item_remove', jsonb_build_object('name', old.name));
  elsif tg_op = 'INSERT' then
    -- ponytail: items saved by the poster right after posting count as part of bill_create; an RPC would make it exact
    if b.created_by = auth.uid() and b.created_at > now() - interval '30 seconds' then return null; end if;
    insert into activity (group_id, bill_id, action, detail) values (b.group_id, new.bill_id, 'item_add', jsonb_build_object('name', new.name, 'price', new.line_total));
  elsif (new.name, new.line_total, new.qty) is distinct from (old.name, old.line_total, old.qty) then
    insert into activity (group_id, bill_id, action, detail) values (b.group_id, new.bill_id, 'item_update', jsonb_build_object('name', new.name,
      'changes', row_diff(to_jsonb(old) - 'position' - 'name_translated', to_jsonb(new) - 'position' - 'name_translated')));
  end if;
  return null;
end $$;
create trigger log_item after insert or update or delete on bill_items for each row execute function log_item();

create function log_share() returns trigger
language plpgsql security definer set search_path = public as $$
declare it record;
begin
  select i.name, i.bill_id, b.group_id into it from bill_items i join bills b on b.id = i.bill_id
  where i.id = case when tg_op = 'DELETE' then old.item_id else new.item_id end;
  if not found then return null; end if; -- item/bill deleted along with its shares
  if tg_op = 'INSERT' then
    insert into activity (group_id, bill_id, action, detail)
    values (it.group_id, it.bill_id, 'share_add', jsonb_build_object('item', it.name, 'member', new.member_id, 'weight', new.weight));
  elsif tg_op = 'DELETE' then
    insert into activity (group_id, bill_id, action, detail)
    values (it.group_id, it.bill_id, 'share_remove', jsonb_build_object('item', it.name, 'member', old.member_id));
  elsif new.weight <> old.weight then
    insert into activity (group_id, bill_id, action, detail)
    values (it.group_id, it.bill_id, 'share_update', jsonb_build_object('item', it.name, 'member', new.member_id, 'weight', new.weight));
  end if;
  return null;
end $$;
create trigger log_share after insert or update or delete on item_shares for each row execute function log_share();

create function log_settlement() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into activity (group_id, action, detail) values (new.group_id, 'settle_add',
      jsonb_build_object('from', new.from_member, 'to', new.to_member, 'amount', new.amount, 'currency', new.currency));
  elsif exists (select 1 from groups where id = old.group_id) then
    insert into activity (group_id, action, detail) values (old.group_id, 'settle_remove',
      jsonb_build_object('from', old.from_member, 'to', old.to_member, 'amount', old.amount, 'currency', old.currency));
  end if;
  return null;
end $$;
create trigger log_settlement after insert or delete on settlements for each row execute function log_settlement();
