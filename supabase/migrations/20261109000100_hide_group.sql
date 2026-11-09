-- Each person can fold a finished trip away on their own home screen; nobody else's list changes.
alter table members add column hidden_at timestamptz;

create function set_group_hidden(g uuid, hide boolean) returns void
language sql security definer set search_path = public as $$
  update members set hidden_at = case when hide then now() end where group_id = g and user_id = auth.uid()
$$;
