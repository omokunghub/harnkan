import { must, sb, type Member } from './supabase'
import { Avatar } from './Avatar'
import { fmt, toMinor } from './money'

// Who paid a bill. Empty `payers` = one person (paidBy) paid it all; otherwise amounts per member.
export type Payers = Record<string, number>

export function checkPayers(payers: Payers, total: number, cur: string) {
  const multi = Object.keys(payers).length > 0
  const paidSum = Object.values(payers).reduce((a, v) => a + toMinor(v, cur), 0)
  const left = toMinor(total, cur) - paidSum
  const error = multi && left ? `จ่ายรวม ${fmt(paidSum, cur)} จาก ${fmt(toMinor(total, cur), cur)} — เหลือ ${fmt(left, cur)}` : ''
  return { multi, paidSum, error }
}

// bills.paid_by stays the biggest payer, so older screens still show someone sensible.
export const mainPayer = (payers: Payers, paidBy: string) =>
  Object.keys(payers).length ? Object.entries(payers).sort((a, b) => b[1] - a[1])[0][0] : paidBy

export async function savePayers(billId: string, payers: Payers) {
  must(await sb.from('bill_payers').delete().eq('bill_id', billId))
  if (Object.keys(payers).length)
    must(await sb.from('bill_payers').insert(Object.entries(payers).map(([member_id, amount]) => ({ bill_id: billId, member_id, amount }))))
}

export function payerLabel(payers: Payers, paidBy: string, members: Member[], nameOf: (m: Member) => string) {
  const n = Object.keys(payers).length
  const one = members.find((m) => m.id === paidBy)
  return n ? `${n} คน` : one ? nameOf(one) : 'เลือก'
}

export function PayerPicker({ members, nameOf, paidBy, onPaidBy, payers, onPayers, total, cur, onDone }: {
  members: Member[]; nameOf: (m: Member) => string
  paidBy: string; onPaidBy: (id: string) => void
  payers: Payers; onPayers: (p: Payers) => void
  total: number; cur: string; onDone: () => void
}) {
  const { multi, paidSum, error } = checkPayers(payers, total, cur)
  return (
    <section className="card stack" aria-label="ใครจ่าย">
      {!multi ? <>
        {members.map((m) => (
          <button key={m.id} type="button" className="list-row" aria-pressed={m.id === paidBy} onClick={() => { onPaidBy(m.id); onDone() }}>
            <Avatar member={m} size={36} /><span className="grow">{nameOf(m)}</span>{m.id === paidBy && '✓'}
          </button>
        ))}
        <button type="button" className="list-row" onClick={() => onPayers({ [paidBy || members[0]?.id]: total })}>
          <span className="row-icon" aria-hidden>👥</span>หลายคนช่วยกันจ่าย
        </button>
      </> : <>
        {members.map((m) => (
          <label key={m.id} className="split-row">
            <span className="who"><Avatar member={m} size={36} />{nameOf(m)}</span>
            <input type="number" step="any" min="0" inputMode="decimal" className="narrow" placeholder="0.00" aria-label={`${nameOf(m)} จ่าย`}
              value={payers[m.id] || ''} onChange={(e) => {
                const v = Number(e.target.value), next = { ...payers, [m.id]: v }
                if (!v) delete next[m.id]
                onPayers(next)
              }} />
          </label>
        ))}
        <p className={error ? 'bad' : 'muted'}>{error || `จ่ายรวม ${fmt(paidSum, cur)} ครบแล้ว ✓`}</p>
        <div className="row">
          <button type="button" className="ghost" onClick={() => onPayers({})}>กลับไปจ่ายคนเดียว</button>
          {!error && <button type="button" onClick={onDone}>เสร็จ</button>}
        </div>
      </>}
    </section>
  )
}
