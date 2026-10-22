// All bill math. Amounts in DB are major units (e.g. 117.70 THB); everything here works in
// integer minor units (satang/cents, yen has none) so splits always add up exactly.

export type Share = { member_id: string; weight: number }
export type Item = { line_total: number; item_shares: Share[] }
export type Bill = {
  currency: string
  paid_by: string
  service_charge: number
  vat: number
  vat_included: boolean
  discount: number
  grand_total: number
  bill_items: Item[]
  bill_payers?: { member_id: string; amount: number }[] // empty/missing = paid_by paid it all
}
export type Settlement = { currency: string; from_member: string; to_member: string; amount: number }
export type PersonShare = { member_id: string; total: number; net: number; sc: number; vat: number; discount: number }

export const UNCLAIMED = '_unclaimed'

export const decimals = (cur: string) =>
  new Intl.NumberFormat('en', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits ?? 2
export const toMinor = (x: number, cur: string) => Math.round(Number(x || 0) * 10 ** decimals(cur))
export const toMajor = (minor: number, cur: string) => minor / 10 ** decimals(cur)
export const fmt = (minor: number, cur: string) =>
  new Intl.NumberFormat('th-TH', { style: 'currency', currency: cur }).format(toMajor(minor, cur))

// Split `total` by weights; largest-remainder rounding so the parts sum to `total` exactly.
export function splitExact(total: number, weights: Map<string, number>) {
  const sum = [...weights.values()].reduce((a, b) => a + b, 0)
  const out = new Map<string, number>()
  if (!sum) return out
  const raw = [...weights].map(([k, w]) => [k, (total * w) / sum] as const)
  for (const [k, v] of raw) out.set(k, Math.floor(v))
  let left = total - [...out.values()].reduce((a, b) => a + b, 0)
  for (const [k] of raw.sort((a, b) => (b[1] % 1) - (a[1] % 1))) {
    if (left-- <= 0) break
    out.set(k, out.get(k)! + 1)
  }
  return out
}

// Each person's share of the bill. Proportional to the items they ticked, applied to the printed
// grand total, so it works whatever order the shop applies SC/VAT/discount in.
// Items nobody ticked go to UNCLAIMED.
export function allocate(bill: Bill): PersonShare[] {
  const cur = bill.currency
  const base = new Map<string, number>()
  const add = (k: string, v: number) => base.set(k, (base.get(k) ?? 0) + v)
  for (const it of bill.bill_items) {
    const amt = toMinor(it.line_total, cur)
    const sw = it.item_shares.reduce((a, s) => a + s.weight, 0)
    if (!sw) add(UNCLAIMED, amt)
    else for (const s of it.item_shares) add(s.member_id, (amt * s.weight) / sw)
  }
  const split = (x: number) => splitExact(toMinor(x, cur), base)
  const total = split(bill.grand_total), sc = split(bill.service_charge), vat = split(bill.vat), disc = split(bill.discount)
  return [...total].map(([m, t]) => {
    const p = { member_id: m, total: t, sc: sc.get(m) ?? 0, vat: vat.get(m) ?? 0, discount: disc.get(m) ?? 0 }
    return { ...p, net: t - p.sc - p.vat + p.discount }
  })
}

// SC on items, VAT on items+SC — the usual Thai "++" receipt. Returns major units for the form.
export function applyRates(itemsTotal: number, scRate: number, vatRate: number, vatIncluded: boolean, cur: string) {
  const items = toMinor(itemsTotal, cur)
  const sc = Math.round((items * scRate) / 100)
  const vat = vatIncluded
    ? Math.round(((items + sc) * vatRate) / (100 + vatRate))
    : Math.round(((items + sc) * vatRate) / 100)
  return {
    service_charge: toMajor(sc, cur),
    vat: toMajor(vat, cur),
    grand_total: toMajor(items + sc + (vatIncluded ? 0 : vat), cur),
  }
}

// Warnings for the review screen. Tolerance of 1 major unit covers receipts that round to whole baht.
export function checkReceipt(bill: Bill, printedSubtotal?: number | null) {
  const cur = bill.currency
  const tol = 10 ** decimals(cur)
  const items = bill.bill_items.reduce((a, it) => a + toMinor(it.line_total, cur), 0)
  const warn: string[] = []
  // VAT-included receipts often print the subtotal before VAT (105 − 6.87 = 98.13); either is fine
  const okSubtotals = bill.vat_included ? [items, items - toMinor(bill.vat, cur)] : [items]
  if (printedSubtotal != null && okSubtotals.every((s) => Math.abs(s - toMinor(printedSubtotal, cur)) > tol))
    warn.push(`ยอดรวมรายการ ${fmt(items, cur)} ไม่ตรงกับ subtotal บนใบเสร็จ ${fmt(toMinor(printedSubtotal, cur), cur)} — อาจอ่านรายการขาด/เกิน`)
  const expected =
    items + toMinor(bill.service_charge, cur) + (bill.vat_included ? 0 : toMinor(bill.vat, cur)) - toMinor(bill.discount, cur)
  if (Math.abs(expected - toMinor(bill.grand_total, cur)) > tol)
    warn.push(`รายการ + SC + VAT − ส่วนลด = ${fmt(expected, cur)} แต่ยอดสุทธิคือ ${fmt(toMinor(bill.grand_total, cur), cur)}`)
  return warn
}

// Who paid how much (minor units).
export function paidBy(b: Bill): [string, number][] {
  return b.bill_payers?.length
    ? b.bill_payers.map((p) => [p.member_id, toMinor(p.amount, b.currency)])
    : [[b.paid_by, toMinor(b.grand_total, b.currency)]]
}

// Net position per currency per member: + means others owe them.
export function balances(bills: Bill[], settlements: Settlement[]) {
  const out = new Map<string, Map<string, number>>()
  const add = (cur: string, m: string, v: number) => {
    const net = out.get(cur) ?? out.set(cur, new Map()).get(cur)!
    net.set(m, (net.get(m) ?? 0) + v)
  }
  for (const b of bills) {
    for (const [m, v] of paidBy(b)) add(b.currency, m, v)
    for (const p of allocate(b)) add(b.currency, p.member_id === UNCLAIMED ? b.paid_by : p.member_id, -p.total)
  }
  for (const s of settlements) {
    add(s.currency, s.from_member, toMinor(s.amount, s.currency))
    add(s.currency, s.to_member, -toMinor(s.amount, s.currency))
  }
  return out
}

// Fewest-ish transfers: match biggest debtor with biggest creditor. At most n-1 transfers.
export function simplify(net: Map<string, number>) {
  const cred = [...net].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
  const debt = [...net].filter(([, v]) => v < 0).map(([k, v]) => [k, -v] as [string, number]).sort((a, b) => b[1] - a[1])
  const moves: { from: string; to: string; amount: number }[] = []
  for (let i = 0, j = 0; i < debt.length && j < cred.length; ) {
    const amount = Math.min(debt[i][1], cred[j][1])
    moves.push({ from: debt[i][0], to: cred[j][0], amount })
    if (!(debt[i][1] -= amount)) i++
    if (!(cred[j][1] -= amount)) j++
  }
  return moves
}

// Manual expenses are one item whose share weights encode the split, so allocate() handles every mode.
export type SplitMode = 'equal' | 'exact' | 'percent' | 'shares'
export function splitWeights(mode: SplitMode, total: number, values: Record<string, number>, cur: string) {
  const weights: Record<string, number> = {}
  for (const [m, v] of Object.entries(values)) {
    const w = mode === 'equal' ? (v ? 1 : 0) : mode === 'exact' ? toMinor(v, cur) : mode === 'percent' ? Math.round(v * 100) : Math.round(v)
    if (w > 0) weights[m] = w
  }
  const sum = Object.values(weights).reduce((a, b) => a + b, 0)
  let error = ''
  if (!sum) error = 'เลือกอย่างน้อย 1 คน'
  else if (mode === 'exact' && sum !== toMinor(total, cur)) error = `รวมได้ ${fmt(sum, cur)} ยังขาด/เกิน ${fmt(toMinor(total, cur) - sum, cur)}`
  else if (mode === 'percent' && sum !== 10000) error = `รวมได้ ${sum / 100}% ต้องเป็น 100%`
  return { weights, error }
}

// Back from stored weights to the form, for editing.
export function detectSplit(total: number, weights: Record<string, number>, cur: string): { mode: SplitMode; values: Record<string, number> } {
  const ws = Object.values(weights), sum = ws.reduce((a, b) => a + b, 0)
  if (ws.every((w) => w === 1)) return { mode: 'equal', values: weights }
  const map = (f: (w: number) => number) => Object.fromEntries(Object.entries(weights).map(([m, w]) => [m, f(w)]))
  if (sum === toMinor(total, cur)) return { mode: 'exact', values: map((w) => toMajor(w, cur)) }
  if (sum === 10000) return { mode: 'percent', values: map((w) => w / 100) }
  return { mode: 'shares', values: weights }
}

// Estimate: fold every currency into one, using rates[cur] = value of 1 `cur` in `to`. Missing rate → that currency is skipped.
export function convertNet(byCur: Map<string, Map<string, number>>, to: string, rates: Record<string, number>) {
  const out = new Map<string, number>()
  for (const [cur, net] of byCur) {
    const rate = cur === to ? 1 : rates[cur]
    if (!rate) continue
    for (const [m, v] of net) out.set(m, (out.get(m) ?? 0) + toMinor(toMajor(v, cur) * rate, to))
  }
  return out
}
