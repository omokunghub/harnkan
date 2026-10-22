-- Date the money was spent (Splitwise-style timeline), separate from when the bill was posted.
alter table bills add column spent_on date not null default current_date;
update bills set spent_on = created_at::date;
