// Reads a receipt photo with Gemini. Secrets: GEMINI_API_KEY (required), GEMINI_MODELS (optional, comma-separated, tried in order).
// Deploy: npx supabase functions deploy scan-receipt
import { createClient } from 'npm:@supabase/supabase-js@2'

// Busy/out-of-quota model → next one. Free-tier quota is per model, so the chain also adds up quota.
const MODELS = (Deno.env.get('GEMINI_MODELS') ?? Deno.env.get('GEMINI_MODEL') ?? 'gemini-flash-lite-latest,gemini-flash-latest,gemini-2.5-flash-lite')
  .split(',').map((m) => m.trim()).filter(Boolean)
const RETRYABLE = new Set([404, 408, 429, 500, 502, 503, 504]) // 404 = model retired → next one
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
          details: { type: 'STRING', nullable: true },
          box_2d: { type: 'ARRAY', items: { type: 'INTEGER' }, description: '[ymin, xmin, ymax, xmax] of this item and its detail lines, 0-1000' },
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
- items: one entry per line that has its own printed price; line_total is that printed amount (qty × unit price). Do not include subtotal, service charge, tax, discount or total lines as items.
- Lines without their own price (add-ons, options, set/combo components such as "Addon - None", "2 COB", "PEPSI 340 ML") are NOT items: put them, comma-separated, in "details" of the priced item they belong to (usually the priced line just above them; a set name is followed by its components).
- box_2d: bounding box of the item's line(s) on the image, including its detail lines, as [ymin, xmin, ymax, xmax] scaled 0-1000.
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

  const body = JSON.stringify({
    contents: [{ parts: [{ inline_data: { mime_type: mime, data: image } }, { text: prompt(lang) }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0 },
  })
  const tried: string[] = []
  let quotaOnly = true
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) { // one quick retry for a busy (503) model
      let r: Response
      try {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': Deno.env.get('GEMINI_API_KEY')! },
          body,
          signal: AbortSignal.timeout(25_000),
        })
      } catch {
        tried.push(`${model}:timeout`); quotaOnly = false; break
      }
      if (r.ok) {
        const text = (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text
        if (text) return json({ ...JSON.parse(text), model })
        tried.push(`${model}:empty`); quotaOnly = false; break
      }
      tried.push(`${model}:${r.status}`)
      if (r.status !== 429) quotaOnly = false
      if (!RETRYABLE.has(r.status)) return json({ error: `gemini ${r.status}`, detail: await r.text(), tried }, 502)
      if (r.status !== 503 || attempt) break
      await new Promise((ok) => setTimeout(ok, 1500))
    }
  }
  return json({ error: quotaOnly ? 'quota' : 'busy', tried }, 502)
})
