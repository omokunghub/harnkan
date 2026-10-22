import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import type { Session } from '@supabase/supabase-js'
import { active, BILL_COLS, CURRENCIES, MEMBER_COLS, memberName, must, sb, type Member } from './supabase'
import { Avatar } from './Avatar'
import { checkPayers, mainPayer, PayerPicker, payerLabel, savePayers } from './Payers'
import { detectSplit, fmt, splitWeights, toMinor, type SplitMode } from './money'

const MODES: [SplitMode, string][] = [['equal', 'เท่ากัน'], ['exact', 'กำหนดยอด'], ['percent', 'เปอร์เซ็นต์'], ['shares', 'จำนวนส่วน']]
const today = () => new Date().toLocaleDateString('sv') // YYYY-MM-DD in local time

// Splitwise-style quick expense: one amount, who paid, how it splits. Receipts with line items go to NewBill.
export default function AddExpense({ session }: { session: Session }) {
  const params = useParams() as { id: string }
  const editing = location.pathname.startsWith('/b/') ? params.id : null
  const nav = useNavigate()
  const [groupId, setGroupId] = useState(editing ? '' : params.id)
  const [members, setMembers] = useState<Member[]>([])
  const [f, setF] = useState({ title: '', currency: 'THB', amount: '', paid_by: '', spent_on: today() })
  const [mode, setMode] = useState<SplitMode>('equal')
  const [values, setValues] = useState<Record<string, number>>({})
  const [itemId, setItemId] = useState<string>()
  const [showSplit, setShowSplit] = useState(false)
  const [payers, setPayers] = useState<Record<string, number>>({}) // empty = single payer f.paid_by
  const [showPayers, setShowPayers] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!editing) return
    sb.from('bills').select(BILL_COLS).eq('id', editing).single().then((r) => {
      const b = must(r)
      const it = b.bill_items[0]
      const w = Object.fromEntries(it.item_shares.map((s: { member_id: string; weight: number }) => [s.member_id, s.weight]))
      const d = detectSplit(b.grand_total, w, b.currency)
      setGroupId(b.group_id); setItemId(it.id); setMode(d.mode); setValues(d.values)
      setPayers(Object.fromEntries(b.bill_payers.map((p: { member_id: string; amount: number }) => [p.member_id, p.amount])))
      setF({ title: b.title, currency: b.currency, amount: String(b.grand_total), paid_by: b.paid_by, spent_on: b.spent_on })
    })
  }, [editing])
  useEffect(() => {
    if (!groupId) return
    sb.from('members').select(MEMBER_COLS).eq('group_id', groupId).then((r) => {
      const ms = active(must(r) as unknown as Member[])
      setMembers(ms)
      setF((f) => ({ ...f, paid_by: f.paid_by || ms.find((m) => m.user_id === session.user.id)?.id || '' }))
      setValues((v) => (Object.keys(v).length ? v : Object.fromEntries(ms.map((m) => [m.id, 1]))))
    })
  }, [groupId, session.user.id])
  useEffect(() => {
    if (groupId && !editing) sb.from('groups').select('currency').eq('id', groupId).single().then((r) => r.data && setF((f) => ({ ...f, currency: r.data.currency })))
  }, [groupId, editing])

  const cur = /^[A-Z]{3}$/.test(f.currency) ? f.currency : 'THB'
  const total = Number(f.amount) || 0
  const { weights, error } = splitWeights(mode, total, values, cur)
  const chosen = Object.keys(weights).length
  const me = members.find((m) => m.user_id === session.user.id)
  const nameOf = (m: Member) => (m.id === me?.id ? 'คุณ' : memberName(m))
  const setMode2 = (m: SplitMode) => {
    setMode(m)
    setValues(Object.fromEntries(members.map((mb) => [mb.id, m === 'equal' || m === 'shares' ? 1 : 0])))
  }
  const payerErr = checkPayers(payers, total, cur).error
  const summary = mode === 'equal'
    ? chosen === members.length ? 'เท่ากันทุกคน' : `เท่ากัน ${chosen} คน`
    : MODES.find(([m]) => m === mode)![1]

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (error) return setShowSplit(true)
    if (payerErr) return setShowPayers(true)
    try {
      const billId = editing ?? crypto.randomUUID()
      const iid = itemId ?? crypto.randomUUID()
      const paidBy = mainPayer(payers, f.paid_by)
      const row = { group_id: groupId, title: f.title, currency: cur, paid_by: paidBy, spent_on: f.spent_on, grand_total: total,
        service_charge: 0, vat: 0, discount: 0, vat_included: false }
      const shares = Object.entries(weights).map(([member_id, weight]) => ({ item_id: iid, member_id, weight }))
      if (editing) must(await sb.from('bills').update(row).eq('id', billId))
      else must(await sb.from('bills').insert({ ...row, id: billId }))
      await savePayers(billId, payers)
      must(await sb.from('bill_items').upsert({ id: iid, bill_id: billId, name: f.title, line_total: total }))
      must(await sb.from('item_shares').upsert(shares))
      must(await sb.from('item_shares').delete().eq('item_id', iid).not('member_id', 'in', `(${Object.keys(weights).join(',')})`))
      nav(`/b/${billId}`, { replace: true })
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  return (
    <main>
      <header>
        <Link to={editing ? `/b/${editing}` : `/g/${groupId}`} aria-label="กลับ">‹</Link>
        <h1>{editing ? 'แก้ค่าใช้จ่าย' : 'เพิ่มค่าใช้จ่าย'}</h1>
      </header>
      <form onSubmit={save} className="stack">
        <input required className="big-title" placeholder="รายละเอียด เช่น ค่าน้ำมัน" aria-label="รายละเอียด"
          value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        <div className="amount-row">
          <select aria-label="สกุลเงิน" className="cur" value={cur} onChange={(e) => setF({ ...f, currency: e.target.value })}>
            {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
          </select>
          <input required type="number" step="any" min="0.01" inputMode="decimal" placeholder="0.00" aria-label="จำนวนเงิน"
            className="big-amount" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        </div>

        <p className="sentence">
          จ่ายโดย{' '}
          <button type="button" className="pill" aria-expanded={showPayers} onClick={() => setShowPayers(!showPayers)}>{payerLabel(payers, f.paid_by, members, nameOf)}</button>{' '}
          หาร{' '}
          <button type="button" className="pill" aria-expanded={showSplit} onClick={() => setShowSplit(!showSplit)}>{summary}</button>
        </p>

        {showPayers && (
          <PayerPicker members={members} nameOf={nameOf} paidBy={f.paid_by} onPaidBy={(id) => setF({ ...f, paid_by: id })}
            payers={payers} onPayers={setPayers} total={total} cur={cur} onDone={() => setShowPayers(false)} />
        )}

        {showSplit && (
          <section className="card stack">
            <div className="tabs" role="tablist">
              {MODES.map(([m, label]) => (
                <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? '' : 'ghost'} onClick={() => setMode2(m)}>{label}</button>
              ))}
            </div>
            {members.map((m) => (
              <label key={m.id} className="split-row">
                <span className="who"><Avatar member={m} size={36} />{nameOf(m)}</span>
                {mode === 'equal'
                  ? <input type="checkbox" checked={!!values[m.id]} onChange={(e) => setValues({ ...values, [m.id]: e.target.checked ? 1 : 0 })} />
                  : <input type="number" step="any" min="0" inputMode="decimal" className="narrow" aria-label={`${nameOf(m)} ${summary}`}
                      value={values[m.id] || ''} onChange={(e) => setValues({ ...values, [m.id]: Number(e.target.value) })} />}
              </label>
            ))}
            <div className="row">
              <span className="muted">
                {mode === 'equal' && chosen ? `${fmt(Math.round(toMinor(total, cur) / chosen), cur)}/คน (${chosen} คน)` : ''}
              </span>
              {mode === 'equal' && (
                <label className="check">ทุกคน
                  <input type="checkbox" checked={chosen === members.length}
                    onChange={(e) => setValues(Object.fromEntries(members.map((m) => [m.id, e.target.checked ? 1 : 0])))} />
                </label>
              )}
            </div>
            {error && total > 0 && <p className="bad">{error}</p>}
          </section>
        )}

        <div className="row">
          <input type="date" aria-label="วันที่" value={f.spent_on} onChange={(e) => setF({ ...f, spent_on: e.target.value })} />
          {!editing && <Link className="button ghost" to={`/g/${groupId}/new`}>📷 สแกนใบเสร็จแทน</Link>}
        </div>
        <button disabled={!groupId || !members.length}>บันทึก</button>
        {err && <p className="bad">{err}</p>}
      </form>
    </main>
  )
}
