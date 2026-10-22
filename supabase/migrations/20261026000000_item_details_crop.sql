-- Receipt lines: add-on/set details, and where the line sits on the receipt photo.
-- Paste into SQL Editor → Run (once).

alter table bill_items
  add column details text check (length(details) <= 500),
  -- [ymin, xmin, ymax, xmax] on a 0–1000 scale of the receipt photo (same as Gemini's box_2d)
  add column crop smallint[] check (crop is null or (cardinality(crop) = 4 and 0 <= all (crop) and 1000 >= all (crop)
    and crop[1] < crop[3] and crop[2] < crop[4]));

-- log edits to details too; moving the crop box isn't worth a log line
create or replace function log_item() returns trigger
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
  elsif (new.name, new.line_total, new.qty, new.details) is distinct from (old.name, old.line_total, old.qty, old.details) then
    insert into activity (group_id, bill_id, action, detail) values (b.group_id, new.bill_id, 'item_update', jsonb_build_object('name', new.name,
      'changes', row_diff(to_jsonb(old) - 'position' - 'name_translated' - 'crop', to_jsonb(new) - 'position' - 'name_translated' - 'crop')));
  end if;
  return null;
end $$;
