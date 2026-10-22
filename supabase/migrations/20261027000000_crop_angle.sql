-- Tilt for the crop box: the photo is turned this many degrees (around its centre) before cutting.
-- Paste into SQL Editor → Run (once).
alter table bill_items add column crop_angle real not null default 0 check (crop_angle between -45 and 45);
