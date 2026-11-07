import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { ArrowLeft, Minus, Pencil, Plus, Scissors, Square, SquareCheck, TriangleAlert, Users } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router'
import type { Session } from '@supabase/supabase-js'
import { active, BILL_COLS, MEMBER_COLS, memberName, must, sb, share, useSignedUrl, type Member } from './supabase'
import { allocate, checkReceipt, fmt, paidBy, toMinor, UNCLAIMED, type Bill, type Item } from './money'
import { Avatar } from './Avatar'
import { ACTIVITY_COLS, ActivityLog, type Entry } from './Activity'
import { CropEditor, CropView, type Box } from './Crop'

type ItemRow = Item & { id: string; name: string; name_translated: string | null; position: number; qty: number; details: string | null; crop: Box | null; crop_angle: number }
type BillRow = Omit<Bill, 'bill_items'> & { id: string; group_id: string; title: string; image_path: string | null; bill_items: ItemRow[] }
type Comment = { id: string; member_id: string; body: string; created_at: string }

export default function BillPage({ session }: { session: Session }) {
  const { id } = useParams() as { id: string }
  const nav = useNavigate()
  const [bill, setBill] = useState<BillRow>()
  const [members, setMembers] = useState<Member[]>([])
  const [comments, setComments] = useState<Comment[]>([])
  const [open, setOpen] = useState<string>() // item whose "split with" editor is open
  const [text, setText] = useState('')
  const [log, setLog] = useState<Entry[]>([])
  const [tickFor, setTickFor] = useState<string>() // whose items a tap toggles; default me
  const [draft, setDraft] = useState<{ id: string; name: string; details: string; qty: string; line_total: string }>() // ✏️ inline edit
  const [cropFor, setCropFor] = useState<ItemRow>() // ✂️ editor
  const img = useSignedUrl(bill?.image_path)

  const load = useCallback(async () => {
    const b = must(await sb.from('bills').select(BILL_COLS).eq('id', id).single()) as BillRow
    b.bill_items.sort((x, y) => x.position - y.position)
    const [m, c, a] = await Promise.all([
      sb.from('members').select(MEMBER_COLS).eq('group_id', b.group_id),
      sb.from('comments').select('*').eq('bill_id', id).order('created_at'),
      sb.from('activity').select(ACTIVITY_COLS).eq('bill_id', id).order('created_at', { ascending: false }),
    ])
    setBill(b); setMembers(must(m) as unknown as Member[]); setComments(must(c)); setLog(must(a))
  }, [id])

  useEffect(() => {
    load()
    // ponytail: any share/comment change in the user's groups triggers a refetch; filter per bill if it gets chatty
    const ch = sb.channel(`bill-${id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'item_shares' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'comments', filter: `bill_id=eq.${id}` }, load)
      .subscribe()
    return () => { sb.removeChannel(ch) }
  }, [id, load])

  if (!bill) return null
  const cur = bill.currency
  const me = members.find((m) => m.user_id === session.user.id)
  const who = tickFor ?? me?.id
  const simple = !bill.image_path && bill.bill_items.length === 1 // quick expense from AddExpense
  const taxed = bill.service_charge > 0 || bill.vat > 0 || bill.discount > 0
  const name = (mid: string) => memberName(members.find((m) => m.id === mid))
  const payer = members.find((m) => m.id === bill.paid_by)
  const payers = paidBy(bill)
  const shares = allocate(bill)
  const mine = shares.find((p) => p.member_id === me?.id)
  const unclaimed = bill.bill_items.filter((i) => !i.item_shares.length)
  const notYet = members.filter((m) => m.user_id && !bill.bill_items.some((i) => i.item_shares.some((s) => s.member_id === m.id)))

  const setShare = async (item_id: string, member_id: string, weight: number) => {
    if (weight > 0) must(await sb.from('item_shares').upsert({ item_id, member_id, weight }))
    else must(await sb.from('item_shares').delete().match({ item_id, member_id }))
    load()
  }
  const toggle = (i: ItemRow) => who && setShare(i.id, who, i.item_shares.some((s) => s.member_id === who) ? 0 : 1)
  const splitAll = async () => {
    if (!confirm('ติ๊กทุกคนในทุกรายการ (หารเท่ากัน)?')) return
    must(await sb.from('item_shares').upsert(bill.bill_items.flatMap((i) => members.map((m) => ({ item_id: i.id, member_id: m.id, weight: 1 })))))
    load()
  }
  const remove = async () => {
    if (!confirm('ลบบิลนี้?')) return
    must(await sb.from('bills').delete().eq('id', id))
    if (bill.image_path) await sb.storage.from('receipts').remove([bill.image_path])
    nav(`/g/${bill.group_id}`, { replace: true })
  }
  const saveItem = async (e: FormEvent) => {
    e.preventDefault()
    if (!draft) return
    must(await sb.from('bill_items').update({ name: draft.name.trim(), details: draft.details.trim() || null, qty: Math.max(1, Math.round(Number(draft.qty)) || 1), line_total: Number(draft.line_total) }).eq('id', draft.id))
    setDraft(undefined); load()
  }
  const saveCrop = async (crop: Box | null, crop_angle: number) => {
    must(await sb.from('bill_items').update({ crop, crop_angle }).eq('id', cropFor!.id))
    setCropFor(undefined); load()
  }
  const warnings = simple ? [] : checkReceipt(bill)
  const comment = async (e: FormEvent) => {
    e.preventDefault()
    if (!me) return
    must(await sb.from('comments').insert({ bill_id: id, member_id: me.id, body: text }))
    setText(''); load()
  }

  return (
    <main>
      <header>
        <Link to={`/g/${bill.group_id}`} className="icon-btn" aria-label="กลับ"><ArrowLeft size={24} /></Link>
        <h1>{bill.title}</h1>
        <Link to={simple ? `/b/${id}/expense` : `/b/${id}/edit`}>แก้</Link>
      </header>
      <Link className="pill" to={`${simple ? `/b/${id}/expense` : `/b/${id}/edit`}?payers=1`} aria-label="แก้คนจ่าย">
        {payers.length > 1
          ? payers.map(([m, v]) => `${name(m)} จ่าย ${fmt(v, cur)}`).join(' · ')
          : `${memberName(payer)} จ่าย ${fmt(toMinor(bill.grand_total, cur), cur)}`} <Pencil size={14} aria-hidden />
      </Link>
      {img && <a href={img} target="_blank"><img className="receipt" src={img} alt="ใบเสร็จ" /></a>}

      {!simple && <>
      {unclaimed.length > 0 && <p className="bad">ยังไม่มีคนเลือก {unclaimed.length} รายการ</p>}
      {notYet.length > 0 && <p className="muted">ยังไม่ได้ติ๊ก: {notYet.map(memberName).join(', ')}</p>}
      <div className="chips" role="group" aria-label="ติ๊กให้ใคร">
        <span className="muted">ติ๊กให้:</span>
        {active(members).map((m) => (
          <button key={m.id} className={m.id === who ? '' : 'ghost'} aria-pressed={m.id === who} onClick={() => setTickFor(m.id)}>
            <Avatar member={m} size={24} /> {m.id === me?.id ? 'ฉัน' : memberName(m)}
          </button>
        ))}
      </div>
      <p className="muted">เลือกคนด้านบน แล้วแตะรายการที่เป็นของคนนั้น · <Users size={14} aria-label="ปุ่มคน" /> หารหลายคน · <Pencil size={14} aria-label="ปุ่มดินสอ" /> แก้รายการ{img && <> · <Scissors size={14} aria-label="ปุ่มกรรไกร" /> ตัดภาพบรรทัด</>}</p>
      {warnings.map((w) => <p key={w} className="bad"><TriangleAlert size={16} aria-hidden /> {w}</p>)}

      {bill.bill_items.map((i) => {
        const ticked = i.item_shares.some((s) => s.member_id === who)
        return (
          <div key={i.id} className={`card item ${ticked ? 'mine' : ''} ${i.item_shares.length ? '' : 'unclaimed'}`}>
            <div className="row">
              <button className="item-main" aria-pressed={ticked} onClick={() => toggle(i)}>
                <span><span className="tick" aria-hidden>{ticked ? <SquareCheck size={20} /> : <Square size={20} />}</span>{i.qty > 1 && <b>{i.qty}× </b>}{i.name}{i.name_translated && i.name_translated !== i.name && <small className="muted"> · {i.name_translated}</small>}
                  {i.details && <small className="muted item-details">+ {i.details}</small>}</span>
                <span>{fmt(toMinor(i.line_total, cur), cur)}</span>
              </button>
              <button className="ghost" aria-label="เลือกคนหาร" aria-expanded={open === i.id} onClick={() => setOpen(open === i.id ? undefined : i.id)}><Users size={20} /></button>
            </div>
            <div className="row">
              <small className="muted">{i.item_shares.map((s) => name(s.member_id) + (s.weight > 1 ? ` ×${s.weight}` : '')).join(', ')}</small>
              <span className="item-tools">
                <button className="icon-btn" aria-label={`แก้รายการ ${i.name}`}
                  onClick={() => setDraft(draft?.id === i.id ? undefined : { id: i.id, name: i.name, details: i.details ?? '', qty: String(i.qty ?? 1), line_total: String(i.line_total) })}><Pencil size={18} /></button>
                {img && <button className="icon-btn" aria-label={`ตัดภาพบรรทัด ${i.name}`} onClick={() => setCropFor(i)}><Scissors size={18} /></button>}
              </span>
            </div>
            {ticked && i.qty > 1 && (() => {
              const w = i.item_shares.find((s) => s.member_id === who)!.weight
              const taken = i.item_shares.reduce((a, s) => a + s.weight, 0)
              return (
                <div className="row qty-row">
                  <span className="grow">{who === me?.id ? 'ฉัน' : name(who!)}สั่ง <b>{w}</b> จาก {i.qty} ที่{taken !== i.qty && <small className="bad"> · ติ๊กรวม {taken}/{i.qty}</small>}</span>
                  <button className="ghost" aria-label="ลดจำนวน" disabled={w <= 1} onClick={() => setShare(i.id, who!, w - 1)}><Minus size={18} /></button>
                  <button className="ghost" aria-label="เพิ่มจำนวน" onClick={() => setShare(i.id, who!, w + 1)}><Plus size={18} /></button>
                </div>
              )
            })()}
            {img && i.crop && <CropView src={img} box={i.crop} angle={i.crop_angle} />}
            {draft?.id === i.id && (
              <form onSubmit={saveItem} className="item-edit-inline">
                <input required aria-label="ชื่อรายการ" maxLength={200} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                <input aria-label="รายละเอียด / add-on" placeholder="รายละเอียด / add-on" maxLength={500} value={draft.details}
                  onChange={(e) => setDraft({ ...draft, details: e.target.value })} />
                <label className="row">จำนวน (ที่)<input aria-label="จำนวน" type="number" min="1" step="1" inputMode="numeric" className="narrow" value={draft.qty} onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => setDraft({ ...draft, qty: e.target.value })} /></label>
                <input required aria-label="ราคา" type="number" step="any" min="0" inputMode="decimal" value={draft.line_total}
                  onChange={(e) => setDraft({ ...draft, line_total: e.target.value })} />
                <div className="row">
                  <button type="button" className="ghost" onClick={() => setDraft(undefined)}>ยกเลิก</button>
                  <button>บันทึก</button>
                </div>
              </form>
            )}
            {open === i.id && (
              <div className="stack">
                {members.map((m) => {
                  const s = i.item_shares.find((x) => x.member_id === m.id)
                  return (
                    <div key={m.id} className="row">
                      <label className="check">
                        <input type="checkbox" checked={!!s} onChange={(e) => setShare(i.id, m.id, e.target.checked ? 1 : 0)} /> {memberName(m)}
                      </label>
                      {s && i.qty > 1 && <small className="muted">กี่ที่</small>}{s && <WeightInput label={`ส่วนของ ${memberName(m)}`} value={s.weight} onSave={(w) => setShare(i.id, m.id, w)} />}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
      <div className="row">
        <button className="ghost" onClick={splitAll}>หารเท่ากันทุกคน</button>
        <button className="ghost" onClick={() => share(bill.title, location.href)}>แชร์ให้เพื่อนมาติ๊ก</button>
      </div>
      </>}

      {cropFor && img && <CropEditor src={img} box={cropFor.crop} angle={cropFor.crop_angle} onSave={saveCrop} onClose={() => setCropFor(undefined)} />}

      <h2>แต่ละคนจ่าย</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th></th>{taxed && <><th>ก่อน SC/VAT</th><th>SC</th><th>VAT</th></>}{bill.discount > 0 && <th>ส่วนลด</th>}<th>รวม</th></tr></thead>
          <tbody>
            {shares.map((p) => (
              <tr key={p.member_id} className={p.member_id === me?.id ? 'mine' : p.member_id === UNCLAIMED ? 'bad' : ''}>
                <td>{p.member_id === UNCLAIMED ? 'ยังไม่มีคนเลือก' : name(p.member_id)}</td>
                {taxed && <><td>{fmt(p.net, cur)}</td><td>{fmt(p.sc, cur)}</td><td>{fmt(p.vat, cur)}</td></>}
                {bill.discount > 0 && <td>−{fmt(p.discount, cur)}</td>}
                <td><b>{fmt(p.total, cur)}</b></td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><th>รวม</th>{taxed && <><th>{fmt(shares.reduce((a, p) => a + p.net, 0), cur)}</th><th>{fmt(shares.reduce((a, p) => a + p.sc, 0), cur)}</th><th>{fmt(shares.reduce((a, p) => a + p.vat, 0), cur)}</th></>}
            {bill.discount > 0 && <th>−{fmt(shares.reduce((a, p) => a + p.discount, 0), cur)}</th>}<th>{fmt(shares.reduce((a, p) => a + p.total, 0), cur)}</th></tr></tfoot>
        </table>
      </div>
      {bill.vat_included && <p className="muted">ราคาในใบเสร็จรวม VAT แล้ว — ช่อง VAT คือส่วนที่รวมอยู่ ไม่ได้บวกเพิ่ม</p>}

      {mine && me && payer && me.id !== payer.id && payers.length === 1 && (
        <p className="card mine">ส่วนของคุณในบิลนี้ <b>{fmt(mine.total, cur)}</b> (โอนคืน <b>{memberName(payer)}</b> ทีเดียวตอนเคลียร์ในหน้ากลุ่ม)</p>
      )}

      <h2>คอมเมนต์</h2>
      {comments.map((c) => <p key={c.id}><b>{name(c.member_id)}:</b> {c.body}</p>)}
      <form onSubmit={comment} className="row">
        <input required maxLength={2000} placeholder="พิมพ์ข้อความ…" value={text} onChange={(e) => setText(e.target.value)} />
        <button>ส่ง</button>
      </form>

      <ActivityLog entries={log} members={members} />

      <button className="ghost bad" onClick={remove}>ลบบิล</button>
    </main>
  )
}

// Lets the box be empty while typing (clear "1", type "2"); saves only a whole number ≥ 1, on blur / Enter.
function WeightInput({ label, value, onSave }: { label: string; value: number; onSave: (w: number) => void }) {
  const [v, setV] = useState(String(value))
  useEffect(() => setV(String(value)), [value])
  const commit = () => {
    const w = Math.round(Number(v))
    if (w >= 1 && w !== value) onSave(w)
    else setV(String(value))
  }
  return <input aria-label={label} type="number" min="1" step="1" inputMode="numeric" className="narrow" value={v}
    onFocus={(e) => e.currentTarget.select()} onChange={(e) => setV(e.target.value)} onBlur={commit}
    onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
}
