-- Web push: one row per person per bill, the first time someone else adds them to it.
-- The Database Webhook fires on INSERT here, so a bill with many items still sends one notification per person.
create table bill_notifies (
  bill_id uuid not null references bills on delete cascade,
  member_id uuid not null references members on delete cascade,
  actor uuid not null references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  primary key (bill_id, member_id)
);
alter table bill_notifies enable row level security; -- no policies: only the trigger writes, only the notify function reads

create function queue_bill_notify() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into bill_notifies (bill_id, member_id, actor)
  select i.bill_id, m.id, auth.uid()
  from bill_items i, members m
  where i.id = new.item_id and m.id = new.member_id
    and m.user_id is not null and m.user_id <> auth.uid() -- guests have no phone; ticking yourself isn't news
  on conflict do nothing;
  return null;
end $$;
create trigger queue_bill_notify after insert on item_shares for each row execute function queue_bill_notify();
