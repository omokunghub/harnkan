-- Tighten two policies from init. Paste into SQL Editor → Run (once).

-- A comment's author must be a member of the bill's own group.
drop policy "comment as self" on comments;
create policy "comment as self" on comments for insert
  with check (exists (select 1 from members where id = member_id and user_id = auth.uid() and group_id = bill_group(bill_id)));

-- Members may rename a group, but not change its owner or invite code.
revoke update on groups from anon, authenticated;
grant update (name) on groups to authenticated;
