-- Delete a guest, or hand everything a guest has (ticks, payments, transfers, comments) to someone else in the group.
-- Any group member can do it, since any member can add guests. Paste into SQL Editor → Run (once).
create function merge_guest(guest uuid, into_member uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  g uuid := member_group(guest);
  gname text := (select guest_name from members where id = guest and user_id is null);
begin
  if not is_member(g) then raise exception 'not a member'; end if;
  if gname is null then raise exception 'guests only'; end if;
  if into_member is null then
    if exists (select 1 from item_shares where member_id = guest) or exists (select 1 from bill_payers where member_id = guest)
      or exists (select 1 from bills where paid_by = guest) or exists (select 1 from comments where member_id = guest)
      or exists (select 1 from settlements where guest in (from_member, to_member))
    then raise exception 'guest has bills: pick who takes them over'; end if;
  else
    if into_member = guest or not exists (select 1 from members where id = into_member and group_id = g and removed_at is null)
    then raise exception 'pick someone in this group'; end if;
    -- both ticked the same item / paid the same bill → add up
    update item_shares t set weight = t.weight + s.weight from item_shares s
      where s.member_id = guest and t.member_id = into_member and t.item_id = s.item_id;
    delete from item_shares s where s.member_id = guest
      and exists (select 1 from item_shares t where t.item_id = s.item_id and t.member_id = into_member);
    update item_shares set member_id = into_member where member_id = guest;
    update bill_payers t set amount = t.amount + s.amount from bill_payers s
      where s.member_id = guest and t.member_id = into_member and t.bill_id = s.bill_id;
    delete from bill_payers s where s.member_id = guest
      and exists (select 1 from bill_payers t where t.bill_id = s.bill_id and t.member_id = into_member);
    update bill_payers set member_id = into_member where member_id = guest;
    update bills set paid_by = into_member where paid_by = guest;
    update settlements set from_member = into_member where from_member = guest;
    update settlements set to_member = into_member where to_member = guest;
    delete from settlements where from_member = to_member; -- paying yourself means nothing
    update comments set member_id = into_member where member_id = guest;
  end if;
  insert into activity (group_id, action, detail) values (g, 'guest_merge', jsonb_build_object('guest', gname, 'into', into_member));
  delete from members where id = guest;
end $$;
