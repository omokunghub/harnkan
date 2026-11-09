// Called by Database Webhooks on INSERT into bill_notifies (friend added to a bill) and settlements (tell the creditor).
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:you@...), NOTIFY_SECRET
// Deploy: npx supabase functions deploy notify --no-verify-jwt
import { createClient } from 'npm:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3'

const env = (k: string) => Deno.env.get(k)!
webpush.setVapidDetails(env('VAPID_SUBJECT'), env('VAPID_PUBLIC_KEY'), env('VAPID_PRIVATE_KEY'))
const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'))

const memberOf = async (id: string) =>
  (await sb.from('members').select('user_id, guest_name, profiles(display_name)').eq('id', id).single()).data as
    { user_id: string | null; guest_name: string | null; profiles: { display_name: string } | null } | null

Deno.serve(async (req) => {
  if (req.headers.get('x-notify-secret') !== env('NOTIFY_SECRET')) return new Response('forbidden', { status: 403 })
  const { table, record } = await req.json()

  let to: string | null | undefined, msg: { title: string; body: string; url: string }
  if (table === 'bill_notifies') {
    const [{ data: bill }, member, { data: actor }] = await Promise.all([
      sb.from('bills').select('title').eq('id', record.bill_id).single(),
      memberOf(record.member_id),
      sb.from('profiles').select('display_name').eq('id', record.actor).single(),
    ])
    if (!bill) return new Response('gone')
    to = member?.user_id
    msg = { title: `บิลใหม่: ${bill.title}`, body: `${actor?.display_name || 'เพื่อน'} เพิ่มชื่อคุณในบิลนี้`, url: `/b/${record.bill_id}` }
  } else if (table === 'settlements') {
    const [creditor, payer, { data: group }] = await Promise.all([
      memberOf(record.to_member), memberOf(record.from_member),
      sb.from('groups').select('name').eq('id', record.group_id).single(),
    ])
    if (creditor?.user_id === record.created_by) return new Response('self') // creditor recorded it themselves
    to = creditor?.user_id
    const amount = Number(record.amount).toLocaleString('en-US', { maximumFractionDigits: 2 })
    msg = { title: group?.name ?? 'หารกัน', body: `${payer?.guest_name ?? payer?.profiles?.display_name ?? 'เพื่อน'} โอนคืนให้คุณ ${amount} ${record.currency}`, url: `/g/${record.group_id}` }
  } else return new Response('ignored')
  if (!to) return new Response('no account') // guests have no phone

  const { data: subs } = await sb.from('push_subs').select('endpoint, sub').eq('user_id', to)
  const sent = await Promise.all((subs ?? []).map((s) =>
    webpush.sendNotification(s.sub, JSON.stringify(msg)).then(() => 'sent', async (e: { statusCode?: number; body?: string; message?: string }) => {
      // phone unsubscribed or app removed → forget it
      if (e.statusCode === 404 || e.statusCode === 410) await sb.from('push_subs').delete().eq('endpoint', s.endpoint)
      return `failed ${e.statusCode ?? e.message} ${e.body ?? ''}`.trim()
    })))
  return new Response(sent.length ? sent.join(' | ') : 'no devices') // shows up in net._http_response
})
