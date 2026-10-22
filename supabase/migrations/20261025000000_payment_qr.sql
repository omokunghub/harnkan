-- Payment QR image on the profile (bank app / TrueMoney / foreign wallets). Paste into SQL Editor → Run (once).
-- Private: only the owner and people sharing a group with them can open it.

alter table profiles add column payment_qr_path text
  check (payment_qr_path is null or payment_qr_path like id::text || '/%'); -- must live in your own folder

insert into storage.buckets (id, name, public) values ('payment-qr', 'payment-qr', false);
create policy "read own or groupmate QR" on storage.objects for select
  using (bucket_id = 'payment-qr' and (
    (storage.foldername(name))[1] = auth.uid()::text or shares_group(((storage.foldername(name))[1])::uuid)));
create policy "upload own QR" on storage.objects for insert
  with check (bucket_id = 'payment-qr' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "delete own QR" on storage.objects for delete
  using (bucket_id = 'payment-qr' and (storage.foldername(name))[1] = auth.uid()::text);
