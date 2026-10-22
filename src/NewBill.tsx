import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import type { Session } from '@supabase/supabase-js'
import { active, BILL_COLS, CURRENCIES, type Member, MEMBER_COLS, memberName, must, sb, shrink } from './supabase'
import { applyRates, checkReceipt, fmt, toMinor, type Bill } from './money'

type Row = { id: string; name: string; name_translated: string; qty: number; line_total: number }
const newRow = (name = '', line_total = 0): Row => ({ id: crypto.randomUUID(), name, name_translated: '', qty: 1, line_total })

const toBase64 = (b: Blob) =>
  new Promise<string>((res) => {
    const r = new FileReader()
    r.onload = () => res((r.result as string).split(',')[1])
    r.readAsDataURL(b)
  })

export default function NewBill({ session }: { session: Session }) {
  const params = useParams() as { id: string }
  const editing = location.pathname.startsWith('/b/') ? params.id : null
  const [q] = useSearchParams()
  const nav = useNavigate()
  const [groupId, setGroupId] = useState(editing ? '' : params.id)
  const [members, setMembers] = useState<Member[]>([])
  const [f, setF] = useState({ title: '', currency: 'THB', paid_by: '', service_charge: 0, vat: 0, vat_included: false, discount: 0 })
  const [grand, setGrand] = useState('') // '' = auto from items + SC + VAT − discount
  const [items, setItems] = useState<Row[]>(q.get('manual') ? [newRow('ค่าใช้จ่าย')] : [])
  const [printedSubtotal, setPrintedSubtotal] = useState<number | null>(null)
  const [blob, setBlob] = useState<Blob>()
  const [preview, setPreview] = useState<string>()
  const [imagePath, setImagePath] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!editing) return
    sb.from('bills').select(BILL_COLS).eq('id', editing).single().then((r) => {
      const b = must(r)
      setGroupId(b.group_id); setImagePath(b.image_path); setGrand(String(b.grand_total))
      setF({ title: b.title, currency: b.currency, paid_by: b.paid_by, service_charge: b.service_charge, vat: b.vat, vat_included: b.vat_included, discount: b.discount })
      setItems(b.bill_items.sort((x: { position: number }, y: { position: number }) => x.position - y.position)
        .map(({ id, name, name_translated, qty, line_total }: Row) => ({ id, name, name_translated: name_translated ?? '', qty, line_total })))
    })
  }, [editing])
  useEffect(() => {
    if (!groupId) return
    sb.from('members').select(MEMBER_COLS).eq('group_id', groupId).then((r) => {
      const ms = must(r) as unknown as Member[]
      setMembers(active(ms))
      setF((f) => ({ ...f, paid_by: f.paid_by || ms.find((m) => m.user_id === session.user.id)?.id || '' }))
    })
  }, [groupId, session.user.id])

  const scan = async (file?: File) => {
    if (!file) return
    setBusy(true); setStatus('กำลังอ่านใบเสร็จ…')
    try {
      const b = await shrink(file)
      setBlob(b); setPreview(URL.createObjectURL(b))
      const { data: d, error } = await sb.functions.invoke('scan-receipt', { body: { image: await toBase64(b), lang: 'Thai' } })
      if (error) throw new Error((await error.context?.json?.().catch(() => null))?.error ?? error.message)
      setItems(d.items.map((i: Row) => ({ ...newRow(i.name, i.line_total), name_translated: i.name_translated, qty: i.qty ?? 1 })))
      setF((f) => ({
        ...f,
        title: f.title || d.merchant || 'ใบเสร็จ',
        currency: d.currency || f.currency,
        service_charge: d.service_charge?.amount ?? 0,
        vat: d.vat?.amount ?? 0,
        vat_included: d.vat?.included ?? false,
        discount: d.discount ?? 0,
      }))
      setGrand(String(d.grand_total ?? ''))
      setPrintedSubtotal(d.subtotal ?? null)
      setStatus(`ตรวจรายการให้ตรงกับใบเสร็จก่อนโพสต์ · อ่านด้วย ${d.model}`)
    } catch (e) {
      const msg = (e as Error).message
      setStatus(msg === 'quota' ? 'โควต้า AI วันนี้หมดทุกรุ่นแล้ว — กรอกเองได้เลย'
        : msg === 'busy' ? 'AI ทุกรุ่นคนใช้เยอะอยู่ ลองใหม่อีกสักครู่ หรือกรอกเองได้เลย'
        : `อ่านไม่สำเร็จ (${msg}) — กรอกเองได้เลย`)
      setItems((it) => (it.length ? it : [newRow()]))
    }
    setBusy(false)
  }

  const cur = /^[A-Z]{3}$/.test(f.currency) ? f.currency : 'THB'
  const itemsTotal = items.reduce((a, i) => a + Number(i.line_total || 0), 0)
  const autoGrand = itemsTotal + Number(f.service_charge) + (f.vat_included ? 0 : Number(f.vat)) - Number(f.discount)
  const grandTotal = grand === '' ? autoGrand : Number(grand)
  const asBill: Bill = { ...f, currency: cur, grand_total: grandTotal, bill_items: items.map((i) => ({ line_total: i.line_total, item_shares: [] })) }
  const warnings = items.length ? checkReceipt(asBill, printedSubtotal) : []
  const m = (x: number) => fmt(toMinor(x, cur), cur)
  const pct = (x: number, of: number) => (of ? ` (${Math.round((x / of) * 1000) / 10}%)` : '')
  const setItem = (id: string, patch: Partial<Row>) => setItems(items.map((i) => (i.id === id ? { ...i, ...patch } : i)))
  const plusPlus = () => {
    setF({ ...f, ...applyRates(itemsTotal, 10, 7, false, cur), vat_included: false, discount: 0 })
    setGrand('')
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    const billId = editing ?? crypto.randomUUID()
    const row = { ...f, currency: cur, grand_total: grandTotal, group_id: groupId, image_path: imagePath }
    const itemRows = items.map((i, position) => ({ ...i, bill_id: billId, position }))
    try {
      if (blob && !imagePath) {
        row.image_path = `${groupId}/${billId}.jpg`
        must(await sb.storage.from('receipts').upload(row.image_path, blob, { contentType: 'image/jpeg' }))
      }
      if (editing) {
        must(await sb.from('bills').update(row).eq('id', billId))
        must(await sb.from('bill_items').upsert(itemRows))
        must(await sb.from('bill_items').delete().eq('bill_id', billId).not('id', 'in', `(${items.map((i) => i.id).join(',')})`))
      } else {
        must(await sb.from('bills').insert({ ...row, id: billId }))
        const r = await sb.from('bill_items').insert(itemRows)
        if (r.error) await sb.from('bills').delete().eq('id', billId) // no half-saved bills
        must(r)
      }
      nav(`/b/${billId}`, { replace: true })
    } catch (err) {
      setStatus(`บันทึกไม่สำเร็จ: ${(err as Error).message}`)
      setBusy(false)
    }
  }

  const showForm = items.length > 0 || editing
  return (
    <main>
      <header>
        <Link to={editing ? `/b/${editing}` : `/g/${groupId}`}>‹</Link>
        <h1>{editing ? 'แก้บิล' : 'บิลใหม่'}</h1>
      </header>

      {!editing && !q.get('manual') && (
        <label className="button">
          📷 ถ่ายรูป / เลือกรูปใบเสร็จ
          <input hidden type="file" accept="image/*" capture="environment" onChange={(e) => scan(e.target.files?.[0])} />
        </label>
      )}
      {preview && <img className="receipt" src={preview} alt="ใบเสร็จ" />}
      {status && <p className="muted">{status}</p>}

      {showForm && (
        <form onSubmit={save} className="stack">
          <label>ชื่อบิล<input required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
          <div className="row">
            <label>ใครจ่าย
              <select required value={f.paid_by} onChange={(e) => setF({ ...f, paid_by: e.target.value })}>
                {members.map((mb) => <option key={mb.id} value={mb.id}>{memberName(mb)}</option>)}
              </select>
            </label>
            <label>สกุลเงิน
              <select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>
                {[...new Set([f.currency, ...CURRENCIES])].map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
          </div>

          <h2>รายการ</h2>
          {items.map((i) => (
            <div key={i.id} className="item-edit">
              <input required aria-label="ชื่อรายการ" value={i.name} onChange={(e) => setItem(i.id, { name: e.target.value })} />
              <input aria-label="ราคา" type="number" step="any" min="0" required value={i.line_total} onChange={(e) => setItem(i.id, { line_total: Number(e.target.value) })} />
              <button type="button" className="ghost" aria-label="ลบรายการ" onClick={() => setItems(items.filter((x) => x.id !== i.id))}>✕</button>
              {i.name_translated && i.name_translated !== i.name && <small className="muted">{i.name_translated}</small>}
            </div>
          ))}
          <button type="button" className="ghost" onClick={() => setItems([...items, newRow()])}>+ เพิ่มรายการ</button>

          <h2>SC / VAT / ส่วนลด</h2>
          <button type="button" className="ghost" onClick={plusPlus}>ราคา ++ (SC 10% + VAT 7%)</button>
          <div className="row">
            <label>Service charge<input type="number" step="any" min="0" value={f.service_charge} onChange={(e) => setF({ ...f, service_charge: Number(e.target.value) })} /></label>
            <label>VAT<input type="number" step="any" min="0" value={f.vat} onChange={(e) => setF({ ...f, vat: Number(e.target.value) })} /></label>
            <label>ส่วนลด<input type="number" step="any" min="0" value={f.discount} onChange={(e) => setF({ ...f, discount: Number(e.target.value) })} /></label>
          </div>
          <label className="check"><input type="checkbox" checked={f.vat_included} onChange={(e) => setF({ ...f, vat_included: e.target.checked })} /> ราคารวม VAT แล้ว</label>
          <label>ยอดสุทธิตามใบเสร็จ
            <input type="number" step="any" min="0" placeholder={String(autoGrand)} value={grand} onChange={(e) => setGrand(e.target.value)} />
          </label>
          <p className="muted">
            รายการ {m(itemsTotal)} + SC {m(f.service_charge)}{pct(f.service_charge, itemsTotal)}
            {f.vat_included ? ` (มี VAT ${m(f.vat)} รวมอยู่แล้ว)` : ` + VAT ${m(f.vat)}${pct(f.vat, itemsTotal + Number(f.service_charge))}`}
            {f.discount ? ` − ส่วนลด ${m(f.discount)}` : ''} = <b>{m(grandTotal)}</b>
          </p>
          {warnings.map((w) => <p key={w} className="bad">⚠ {w}</p>)}
          <button disabled={busy || !items.length || !groupId}>{editing ? 'บันทึก' : 'โพสต์บิล แล้วไปติ๊กรายการ'}</button>
        </form>
      )}
    </main>
  )
}
