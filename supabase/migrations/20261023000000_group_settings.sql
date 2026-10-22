-- Group type and trip dates (Splitwise-style "Customize group"). Paste into SQL Editor → Run (once).
alter table groups
  add column type text not null default 'trip' check (type in ('trip', 'home', 'couple', 'other')),
  add column start_on date,
  add column end_on date,
  add constraint trip_dates check (end_on is null or start_on is null or end_on >= start_on);

-- members may edit these too (owner and invite code stay locked, see hardening)
grant update (name, type, start_on, end_on) on groups to authenticated;
