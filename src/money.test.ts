import { expect, test } from 'vitest'
import { allocate, applyRates, balances, checkReceipt, convertNet, detectSplit, simplify, splitExact, splitWeights, UNCLAIMED, type Bill } from './money'

const sh = (...ms: string[]) => ms.map((member_id) => ({ member_id, weight: 1 }))
const bill = (p: Partial<Bill>): Bill => ({
  currency: 'THB', paid_by: 'a', service_charge: 0, vat: 0, vat_included: false, discount: 0, grand_total: 0, bill_items: [], ...p,
})
const byMember = (b: Bill) => Object.fromEntries(allocate(b).map((p) => [p.member_id, p]))

// 1,000 → +SC 10% → +VAT 7% = 1,177; a: 400, b: 300, shared a/b/c: 300
const thai = bill({
  service_charge: 100, vat: 77, grand_total: 1177,
  bill_items: [
    { line_total: 400, item_shares: sh('a') },
    { line_total: 300, item_shares: sh('b') },
    { line_total: 300, item_shares: sh('a', 'b', 'c') },
  ],
})

test('thai SC then VAT, shared item', () => {
  const p = byMember(thai)
  expect(p.a.total).toBe(58850) // 500/1000 * 1177
  expect(p.b.total).toBe(47080)
  expect(p.c.total).toBe(11770)
  expect(p.a).toMatchObject({ net: 50000, sc: 5000, vat: 3850 })
  expect(checkReceipt(thai, 1000)).toEqual([])
})

test('rounding always sums to grand total', () => {
  const parts = splitExact(10000, new Map([['a', 1], ['b', 1], ['c', 1]]))
  expect([...parts.values()].sort()).toEqual([3333, 3333, 3334])
  const odd = bill({ grand_total: 100, bill_items: [{ line_total: 100, item_shares: sh('a', 'b', 'c') }] })
  expect(allocate(odd).reduce((s, p) => s + p.total, 0)).toBe(10000)
})

test('VAT included in prices is not added again', () => {
  const p = byMember(bill({ vat: 7, vat_included: true, grand_total: 107, bill_items: [{ line_total: 107, item_shares: sh('a') }] }))
  expect(p.a).toMatchObject({ total: 10700, net: 10000, vat: 700 })
})

test('discount and weights', () => {
  const b = bill({ discount: 100, grand_total: 900, bill_items: [{ line_total: 1000, item_shares: [{ member_id: 'a', weight: 3 }, { member_id: 'b', weight: 1 }] }] })
  const p = byMember(b)
  expect(p.a).toMatchObject({ total: 67500, discount: 7500, net: 75000 })
  expect(p.b.total).toBe(22500)
})

test('JPY has no decimals', () => {
  const b = bill({ currency: 'JPY', grand_total: 1000, bill_items: [{ line_total: 1000, item_shares: sh('a', 'b', 'c') }] })
  expect(allocate(b).map((p) => p.total).sort()).toEqual([333, 333, 334])
})

test('unclaimed items stay with the payer', () => {
  const b = bill({ paid_by: 'a', grand_total: 200, bill_items: [{ line_total: 100, item_shares: sh('b') }, { line_total: 100, item_shares: [] }] })
  expect(byMember(b)[UNCLAIMED].total).toBe(10000)
  const net = balances([b], []).get('THB')!
  expect(Object.fromEntries(net)).toEqual({ a: 10000, b: -10000 })
})

test('balances per currency, settlements, simplify', () => {
  const b1 = bill({ paid_by: 'a', grand_total: 300, bill_items: [{ line_total: 300, item_shares: sh('a', 'b', 'c') }] })
  const b2 = bill({ paid_by: 'b', grand_total: 300, bill_items: [{ line_total: 300, item_shares: sh('a', 'b', 'c') }] })
  const jp = bill({ currency: 'JPY', paid_by: 'c', grand_total: 900, bill_items: [{ line_total: 900, item_shares: sh('a', 'b', 'c') }] })
  const all = balances([b1, b2, jp], [{ currency: 'THB', from_member: 'c', to_member: 'a', amount: 50 }])
  const thb = all.get('THB')!
  // each paid 300 split 3 ways → a +100, b +100, c −200; c already paid a 50
  expect(Object.fromEntries(thb)).toEqual({ a: 5000, b: 10000, c: -15000 })
  expect(simplify(thb)).toEqual([{ from: 'c', to: 'b', amount: 10000 }, { from: 'c', to: 'a', amount: 5000 }])
  expect(Object.fromEntries(all.get('JPY')!)).toEqual({ c: 600, a: -300, b: -300 })
})

test('VAT-included receipt may print subtotal before VAT (Black Canyon)', () => {
  const b = bill({ vat: 6.87, vat_included: true, grand_total: 105, bill_items: [{ line_total: 105, item_shares: [] }] })
  expect(checkReceipt(b, 98.13)).toEqual([]) // 105 − 6.87
  expect(checkReceipt(b, 105)).toEqual([])
  expect(checkReceipt(b, 90)).toHaveLength(1)
})

test('"++" preset and mismatch warning', () => {
  expect(applyRates(1000, 10, 7, false, 'THB')).toEqual({ service_charge: 100, vat: 77, grand_total: 1177 })
  expect(applyRates(1070, 0, 7, true, 'THB')).toEqual({ service_charge: 0, vat: 70, grand_total: 1070 })
  expect(checkReceipt({ ...thai, grand_total: 1300 }, 900)).toHaveLength(2)
})

test('manual split modes all land on exact totals', () => {
  const total = (mode: Parameters<typeof splitWeights>[0], values: Record<string, number>) => {
    const { weights, error } = splitWeights(mode, 500, values, 'THB')
    expect(error).toBe('')
    const b = bill({ grand_total: 500, bill_items: [{ line_total: 500, item_shares: Object.entries(weights).map(([member_id, weight]) => ({ member_id, weight })) }] })
    expect(detectSplit(500, weights, 'THB').mode).toBe(mode)
    return Object.fromEntries(allocate(b).map((p) => [p.member_id, p.total]))
  }
  expect(total('equal', { a: 1, b: 1, c: 0 })).toEqual({ a: 25000, b: 25000 })
  expect(total('exact', { a: 120.5, b: 379.5 })).toEqual({ a: 12050, b: 37950 })
  expect(total('percent', { a: 60, b: 40 })).toEqual({ a: 30000, b: 20000 })
  expect(total('shares', { a: 3, b: 2 })).toEqual({ a: 30000, b: 20000 })
  expect(splitWeights('exact', 500, { a: 100 }, 'THB').error).toMatch('ขาด')
  expect(splitWeights('percent', 500, { a: 50 }, 'THB').error).toMatch('100%')
  expect(splitWeights('equal', 500, { a: 0 }, 'THB').error).toBeTruthy()
})

test('several payers: credits follow what each actually paid', () => {
  const b = bill({ paid_by: 'a', grand_total: 300, bill_payers: [{ member_id: 'a', amount: 200 }, { member_id: 'b', amount: 100 }],
    bill_items: [{ line_total: 300, item_shares: sh('a', 'b', 'c') }] })
  expect(Object.fromEntries(balances([b], []).get('THB')!)).toEqual({ a: 10000, b: 0, c: -10000 })
})

test('convert balances to one currency (estimate)', () => {
  const jp = bill({ currency: 'JPY', paid_by: 'a', grand_total: 1000, bill_items: [{ line_total: 1000, item_shares: sh('a', 'b') }] })
  const th = bill({ paid_by: 'b', grand_total: 100, bill_items: [{ line_total: 100, item_shares: sh('a', 'b') }] })
  const all = balances([jp, th], [])
  // a: +500 JPY, −50 THB ; at 0.2 THB/JPY → +100 − 50 = +50 THB
  expect(Object.fromEntries(convertNet(all, 'THB', { JPY: 0.2 }))).toEqual({ a: 5000, b: -5000 })
  expect(Object.fromEntries(convertNet(all, 'JPY', { THB: 5 }))).toEqual({ a: 250, b: -250 })
})
