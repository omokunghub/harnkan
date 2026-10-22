// Called by Database Webhooks on INSERT into bills and comments → web push to the rest of the group.
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:you@...), NOTIFY_SECRET
// Deploy: npx supabase functions deploy notify --no-verify-jwt
import { createClient } from 'npm:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3'

const env = (k: string) => Deno.env.get(k)!
webpush.setVapidDetails(env('VAPID_SUBJECT'), env('VAPID_PUBLIC_KEY'), env('VAPID_PRIVATE_KEY'))
const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'))

Deno.serve(async (req) => {
  if (req.headers.get('x-notify-secret') !== env('NOTIFY_SECRET')) return new Response('forbidden', { status: 403 })
  const { table, record } = await req.json()

  let groupId: string, author: string, msg: { title: string; body: string; url: string }
  if (table === 'bills') {
    groupId = record.group_id
    author = record.created_by
    msg = { title: `บิลใหม่: ${record.title}`, body: 'เข้าไปติ๊กรายการของคุณ', url: `/b/${record.id}` }
  } else if (table === 'comments') {
    const { data: b } = await sb.from('bills').select('group_id, title').eq('id', record.bill_id).single()
    const { data: m } = await sb.from('members').select('user_id').eq('id', record.member_id).single()
    if (!b || !m) return new Response('gone')
    groupId = b.group_id
    author = m.user_id
    msg = { title: `คอมเมนต์ใน ${b.title}`, body: record.body, url: `/b/${record.bill_id}` }
  } else return new Response('ignored')

  const { data: ms } = await sb.from('members').select('user_id').eq('group_id', groupId).not('user_id', 'is', null).neq('user_id', author)
  const { data: subs } = await sb.from('push_subs').select('endpoint, sub').in('user_id', (ms ?? []).map((m) => m.user_id))
  await Promise.all((subs ?? []).map((s) =>
    webpush.sendNotification(s.sub, JSON.stringify(msg)).catch(async (e: { statusCode?: number }) => {
      // phone unsubscribed or app removed → forget it
      if (e.statusCode === 404 || e.statusCode === 410) await sb.from('push_subs').delete().eq('endpoint', s.endpoint)
    })))
  return new Response('ok')
})
