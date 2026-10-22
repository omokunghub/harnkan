// Runs every migration in an in-memory Postgres with minimal Supabase stubs, then checks RLS and the activity log.
import { PGlite } from '@electric-sql/pglite'
import { readdirSync, readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

const A = '00000000-0000-0000-0000-00000000000a', B = '00000000-0000-0000-0000-00000000000b', C = '00000000-0000-0000-0000-00000000000c'

async function setup() {
  const db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth; create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.uid', true), '')::uuid $$;
    create schema storage; create table storage.buckets (id text primary key, name text, public bool);
    create table storage.objects (id uuid default gen_random_uuid(), bucket_id text, name text);
    alter table storage.objects enable row level security;
    grant all on storage.objects to anon, authenticated;
    create function storage.foldername(name text) returns text[] language sql as $$ select string_to_array(name, '/') $$;
    create publication supabase_realtime;
    grant usage on schema public, auth, storage to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on sequences to anon, authenticated;
    alter default privileges in schema public grant execute on functions to anon, authenticated;`)
  const dir = new URL('./migrations/', import.meta.url)
  for (const f of readdirSync(dir).sort()) await db.exec(readFileSync(new URL(f, dir), 'utf8'))
  await db.exec(`insert into auth.users (id, raw_user_meta_data) values
    ('${A}', '{"full_name":"Alice"}'), ('${B}', '{"full_name":"Bob"}'), ('${C}', '{"full_name":"Outsider"}')`)
  const q = async (sql: string, p?: unknown[]) => (await db.query<any>(sql, p)).rows
  const as = async (uid: string, sql: string, p?: unknown[]) => {
    await db.exec(`set role authenticated; set request.uid = '${uid}'`)
    try { return await q(sql, p) } finally { await db.exec('reset role') }
  }
  return { q, as }
}

test('activity log records who did what, and nobody can forge or erase it', async () => {
  const { q, as } = await setup()
  const [{ id: g }] = await as(A, `select create_group('trip') as id`)
  const [{ invite_code }] = await q(`select invite_code from groups where id = $1`, [g])
  await as(B, `select join_group($1)`, [invite_code])
  const member = async (u: string) => (await q(`select id from members where user_id = $1`, [u]))[0].id
  const mA = await member(A), mB = await member(B)
  const [{ id: guest }] = await as(A, `insert into members (group_id, guest_name) values ($1, 'Guest') returning id`, [g])
  const [{ id: bill }] = await as(A, `insert into bills (group_id, paid_by, title, grand_total) values ($1, $2, 'Dinner', 200) returning id`, [g, mA])
  const [i1, i2] = (await as(A, `insert into bill_items (bill_id, name, line_total) values ($1, 'Rice', 100), ($1, 'Soup', 100) returning id`, [bill])).map((r) => r.id)

  await as(A, `insert into item_shares (item_id, member_id) values ($1, $2), ($3, $4)`, [i1, mA, i2, guest]) // creator assigns
  const upsertB = `insert into item_shares (item_id, member_id, weight) values ($1, $2, $3) on conflict (item_id, member_id) do update set weight = excluded.weight`
  await as(B, upsertB, [i2, mB, 1])
  await as(B, upsertB, [i2, mB, 2])
  await as(B, upsertB, [i2, mB, 2]) // no-op
  await as(B, `delete from item_shares where item_id = $1 and member_id = $2`, [i2, guest]) // B fixes the creator's mistake
  await as(A, `update bills set grand_total = 210 where id = $1`, [bill])
  await as(A, `update bills set grand_total = 210 where id = $1`, [bill]) // no-op
  await as(A, `update bill_items set line_total = 110 where id = $1`, [i1])
  await as(A, `update bill_items set position = 5 where id = $1`, [i1]) // reorder only
  await as(B, `insert into settlements (group_id, from_member, to_member, amount) values ($1, $2, $3, 50)`, [g, mB, mA])

  await expect(as(B, `insert into activity (group_id, action) values ($1, 'fake')`, [g])).rejects.toThrow()
  expect(await as(B, `delete from activity returning id`)).toHaveLength(0)
  expect(await as(B, `update activity set action = 'x' returning id`)).toHaveLength(0)
  expect(await as(C, `select * from activity`)).toHaveLength(0)

  await as(A, `delete from bills where id = $1`, [bill])
  const log = await q(`select action, p.display_name as actor from activity a join profiles p on p.id = a.actor order by a.id`)
  expect(log.map((r) => `${r.actor} ${r.action}`)).toEqual([
    'Alice bill_create', // items posted with the bill are not logged separately
    'Alice share_add', 'Alice share_add',
    'Bob share_add', 'Bob share_update', 'Bob share_remove',
    'Alice bill_update', 'Alice item_update',
    'Bob settle_add',
    'Alice bill_delete', // no cascade noise from its items/shares
  ])

  await as(A, `delete from groups where id = $1`, [g])
  expect(await q(`select * from activity`)).toHaveLength(0)
})

test('outsiders see nothing and cannot claim items in other groups', async () => {
  const { q, as } = await setup()
  const [{ id: g }] = await as(A, `select create_group('trip') as id`)
  const [{ id: mA }] = await q(`select id from members where user_id = $1`, [A])
  const [{ id: bill }] = await as(A, `insert into bills (group_id, paid_by, title, grand_total) values ($1, $2, 'x', 1) returning id`, [g, mA])
  const [{ id: item }] = await as(A, `insert into bill_items (bill_id, name, line_total) values ($1, 'x', 1) returning id`, [bill])
  for (const t of ['groups', 'members', 'bills', 'bill_items', 'item_shares', 'settlements', 'comments', 'activity'])
    expect(await as(C, `select * from ${t}`), t).toHaveLength(0)
  const [{ id: g2 }] = await as(C, `select create_group('mine') as id`)
  const [{ id: mC }] = await q(`select id from members where group_id = $1`, [g2])
  await expect(as(C, `insert into item_shares (item_id, member_id) values ($1, $2)`, [item, mC])).rejects.toThrow()
  await expect(as(B, `select join_group('wrong-code')`)).rejects.toThrow()
})

test('avatars default to the Google photo and only accept trusted URLs', async () => {
  const { q, as } = await setup()
  const D = '00000000-0000-0000-0000-00000000000d'
  await q(`insert into auth.users (id, raw_user_meta_data) values ($1, '{"full_name":"Dee","avatar_url":"https://lh3.googleusercontent.com/a/xyz"}')`, [D])
  expect((await q(`select avatar_url from profiles where id = $1`, [D]))[0].avatar_url).toBe('https://lh3.googleusercontent.com/a/xyz')
  const own = `https://abc.supabase.co/storage/v1/object/public/avatars/${D}/1.jpg`
  await as(D, `update profiles set avatar_url = $1 where id = $2`, [own, D])
  await expect(as(D, `update profiles set avatar_url = 'https://evil.example/pixel.gif' where id = $1`, [D])).rejects.toThrow()
  expect(await as(A, `update profiles set avatar_url = null where id = $1 returning id`, [D])).toHaveLength(0) // not your profile
})

test('members can customize the group but not take it over', async () => {
  const { q, as } = await setup()
  const [{ id: g }] = await as(A, `select create_group('trip') as id`)
  const [{ invite_code }] = await q(`select invite_code from groups where id = $1`, [g])
  await as(B, `select join_group($1)`, [invite_code])
  await as(B, `update groups set name = 'Fukuoka', type = 'home', start_on = '2026-10-10', end_on = '2026-10-15' where id = $1`, [g])
  expect((await q(`select name, type from groups where id = $1`, [g]))[0]).toEqual({ name: 'Fukuoka', type: 'home' })
  await expect(as(B, `update groups set end_on = '2026-10-01' where id = $1`, [g])).rejects.toThrow() // before start
  await expect(as(B, `update groups set created_by = $2 where id = $1`, [g, B])).rejects.toThrow()
  await expect(as(B, `update groups set invite_code = 'mine' where id = $1`, [g])).rejects.toThrow()
  expect(await as(C, `update groups set name = 'x' where id = $1 returning id`, [g])).toHaveLength(0)
})

test('group covers: members only, our bucket only', async () => {
  const { q, as } = await setup()
  const [{ id: g }] = await as(A, `select create_group('trip') as id`)
  const ok = `https://abc.supabase.co/storage/v1/object/public/covers/${g}/1.jpg`
  await as(A, `update groups set cover_url = $1 where id = $2`, [ok, g])
  await expect(as(A, `update groups set cover_url = 'https://evil.example/x.jpg' where id = $1`, [g])).rejects.toThrow()
  expect(await as(C, `update groups set cover_url = null where id = $1 returning id`, [g])).toHaveLength(0)
  await as(A, `insert into storage.objects (bucket_id, name) values ('covers', $1)`, [`${g}/1.jpg`])
  await expect(as(C, `insert into storage.objects (bucket_id, name) values ('covers', $1)`, [`${g}/2.jpg`])).rejects.toThrow()
})

test('only the app admin can remove members or reset the invite; removed members lose access', async () => {
  const { q, as } = await setup()
  await q(`insert into app_admins (user_id) values ($1)`, [A])
  const [{ id: g }] = await as(A, `select create_group('trip') as id`)
  const [{ invite_code: code1 }] = await q(`select invite_code from groups where id = $1`, [g])
  await as(B, `select join_group($1)`, [code1])
  const [{ id: mA }] = await q(`select id from members where user_id = $1`, [A])
  const [{ id: mB }] = await q(`select id from members where user_id = $1`, [B])
  const [{ id: bill }] = await as(A, `insert into bills (group_id, paid_by, title, grand_total) values ($1, $2, 'x', 100) returning id`, [g, mA])

  await expect(as(B, `select remove_member($1)`, [mA])).rejects.toThrow('admin only')
  await expect(as(B, `select reset_invite($1)`, [g])).rejects.toThrow('admin only')
  expect(await as(B, `select * from app_admins`)).toHaveLength(0)
  await expect(as(B, `insert into app_admins values ($1)`, [B])).rejects.toThrow()

  await as(A, `select remove_member($1)`, [mB])
  expect(await as(B, `select * from bills`)).toHaveLength(0) // lost access
  expect((await as(A, `select removed_at from members where id = $1`, [mB]))[0].removed_at).not.toBeNull() // name kept

  const [{ reset_invite: code2 }] = await as(A, `select reset_invite($1)`, [g])
  await expect(as(B, `select join_group($1)`, [code1])).rejects.toThrow('invalid invite') // old link dead
  await as(B, `select join_group($1)`, [code2]) // new link brings them back
  expect(await as(B, `select * from bills where id = $1`, [bill])).toHaveLength(1)
  const log = (await q(`select action from activity where action in ('member_remove', 'invite_reset')`)).map((r) => r.action)
  expect(log).toEqual(['member_remove', 'invite_reset'])
})

test('several payers per bill, all inside the group', async () => {
  const { q, as } = await setup()
  const [{ id: g }] = await as(A, `select create_group('trip') as id`)
  const [{ invite_code }] = await q(`select invite_code from groups where id = $1`, [g])
  await as(B, `select join_group($1)`, [invite_code])
  const [{ id: mA }] = await q(`select id from members where user_id = $1`, [A])
  const [{ id: mB }] = await q(`select id from members where user_id = $1`, [B])
  const [{ id: bill }] = await as(A, `insert into bills (group_id, paid_by, title, grand_total) values ($1, $2, 'x', 100) returning id`, [g, mA])
  await as(B, `insert into bill_payers (bill_id, member_id, amount) values ($1, $2, 60), ($1, $3, 40)`, [bill, mA, mB])
  const [{ id: g2 }] = await as(C, `select create_group('other') as id`)
  const [{ id: mC }] = await q(`select id from members where group_id = $1`, [g2])
  await expect(as(A, `insert into bill_payers (bill_id, member_id, amount) values ($1, $2, 1)`, [bill, mC])).rejects.toThrow()
  expect(await as(C, `select * from bill_payers`)).toHaveLength(0)
  await as(A, `update groups set currency = 'JPY' where id = $1`, [g])
  await expect(as(A, `update groups set currency = 'yen' where id = $1`, [g])).rejects.toThrow()
})

test('payment QR: own folder only, visible to groupmates but not outsiders', async () => {
  const { q, as } = await setup()
  const [{ id: g }] = await as(A, `select create_group('trip') as id`)
  const [{ invite_code }] = await q(`select invite_code from groups where id = $1`, [g])
  await as(B, `select join_group($1)`, [invite_code])
  await as(A, `insert into storage.objects (bucket_id, name) values ('payment-qr', $1)`, [`${A}/1.jpg`])
  await as(A, `update profiles set payment_qr_path = $1 where id = $2`, [`${A}/1.jpg`, A])
  await expect(as(A, `update profiles set payment_qr_path = $1 where id = $2`, [`${B}/x.jpg`, A])).rejects.toThrow() // not your folder
  await expect(as(B, `insert into storage.objects (bucket_id, name) values ('payment-qr', $1)`, [`${A}/2.jpg`])).rejects.toThrow()
  expect(await as(B, `select name from storage.objects where bucket_id = 'payment-qr'`)).toHaveLength(1) // groupmate sees it
  expect(await as(C, `select name from storage.objects where bucket_id = 'payment-qr'`)).toHaveLength(0) // outsider doesn't
})

test('item details and crop box: validated, details edits logged, crop moves not', async () => {
  const { q, as } = await setup()
  const [{ id: g }] = await as(A, `select create_group('trip') as id`)
  const [{ id: mA }] = await q(`select id from members where user_id = $1`, [A])
  const [{ id: bill }] = await as(A, `insert into bills (group_id, paid_by, title, grand_total) values ($1, $2, 'KFC', 129) returning id`, [g, mA])
  const [{ id: item }] = await as(A, `insert into bill_items (bill_id, name, line_total, details, crop) values ($1, 'ImKhoom2_AG', 129, '2 COB', '{100,20,140,980}') returning id`, [bill])
  await expect(as(A, `update bill_items set crop = '{100,20,90,980}' where id = $1`, [item])).rejects.toThrow() // ymax < ymin
  await expect(as(A, `update bill_items set crop = '{1,2,3}' where id = $1`, [item])).rejects.toThrow()
  await expect(as(A, `update bill_items set crop = '{0,0,10,1001}' where id = $1`, [item])).rejects.toThrow()
  await q(`update bills set created_at = now() - interval '1 hour' where id = $1`, [bill]) // past the posting window
  await as(A, `update bill_items set crop = '{90,0,150,1000}' where id = $1`, [item])
  await as(A, `update bill_items set details = '2 COB, HS Piece(2), Pepsi' where id = $1`, [item])
  const log = await q(`select action, detail from activity where action = 'item_update'`)
  expect(log).toHaveLength(1)
  expect(Object.keys(log[0].detail.changes)).toEqual(['details'])
})

test('crop angle limited to ±45°', async () => {
  const { q, as } = await setup()
  const [{ id: g }] = await as(A, `select create_group('trip') as id`)
  const [{ id: mA }] = await q(`select id from members where user_id = $1`, [A])
  const [{ id: bill }] = await as(A, `insert into bills (group_id, paid_by, title, grand_total) values ($1, $2, 'x', 1) returning id`, [g, mA])
  const [{ id: item }] = await as(A, `insert into bill_items (bill_id, name, line_total) values ($1, 'x', 1) returning id`, [bill])
  await as(A, `update bill_items set crop_angle = -12.5 where id = $1`, [item])
  await expect(as(A, `update bill_items set crop_angle = 90 where id = $1`, [item])).rejects.toThrow()
})
