// Reads a receipt photo with Gemini. Secrets: GEMINI_API_KEY (required), GEMINI_MODEL (optional).
// Deploy: npx supabase functions deploy scan-receipt
import { createClient } from 'npm:@supabase/supabase-js@2'

const MODEL = Deno.env.get('GEMINI_MODEL') ?? 'gemini-flash-lite-latest'
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const num = { type: 'NUMBER', nullable: true }
const schema = {
  type: 'OBJECT',
  properties: {
    merchant: { type: 'STRING', nullable: true },
    currency: { type: 'STRING', description: 'ISO 4217 code, e.g. THB, JPY' },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          name_translated: { type: 'STRING' },
          qty: num,
          line_total: { type: 'NUMBER' },
        },
        required: ['name', 'name_translated', 'line_total'],
      },
    },
    subtotal: num,
    service_charge: { type: 'OBJECT', properties: { rate: num, amount: num } },
    vat: { type: 'OBJECT', properties: { rate: num, amount: num, included: { type: 'BOOLEAN' } } },
    discount: num,
    grand_total: { type: 'NUMBER' },
  },
  required: ['currency', 'items', 'grand_total'],
}
const prompt = (lang: string) => `Extract this receipt.
- Copy numbers exactly as printed. Never calculate a value that is not printed; use null instead.
- items: one entry per purchased line; line_total is the line's printed amount (qty × unit price). Do not include subtotal, service charge, tax, discount or total lines as items.
- service_charge: the service charge line (rate in percent, e.g. 10).
- vat: the VAT/tax line (rate in percent, e.g. 7). included=true when the receipt says prices already include VAT (e.g. "VAT included", "รวมภาษีมูลค่าเพิ่ม", "内税", "税込"), false when VAT is added on top.
- discount: total discount as a positive number.
- grand_total: the final amount paid.
- name_translated: the item name translated to ${lang}. Keep it short like a menu.`

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

  // Only people already in a group can spend the Gemini quota.
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  })
  const { data: m } = await sb.from('members').select('id').limit(1)
  if (!m?.length) return json({ error: 'join a group first' }, 403)

  const { image, mime = 'image/jpeg', lang = 'Thai' } = await req.json()
  if (typeof image !== 'string' || image.length > 8_000_000) return json({ error: 'bad image' }, 400)

  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': Deno.env.get('GEMINI_API_KEY')! },
    body: JSON.stringify({
      contents: [{ parts: [{ inline_data: { mime_type: mime, data: image } }, { text: prompt(lang) }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0 },
    }),
  })
  if (!r.ok) return json({ error: r.status === 429 ? 'quota' : `gemini ${r.status}`, detail: await r.text() }, 502)
  const text = (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) return json({ error: 'no result' }, 502)
  return json(JSON.parse(text))
})
