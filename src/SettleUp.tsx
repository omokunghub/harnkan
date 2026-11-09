import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import generatePayload from 'promptpay-qr'
import QRCode from 'qrcode'
import { FormHeader } from './FormHeader'
import { CURRENCIES, MEMBER_COLS, memberName, must, sb, shrink, useSignedUrl, type Member } from './supabase'

// The payee's own QR image (bank app, TrueMoney, foreign wallets). Amount must be typed in their app.
export function PaymentQR({ path, amountText }: { path?: string | null; amountText?: string }) {
  const url = useSignedUrl(path, 'payment-qr')
  return url ? (
    <figure className="qr">
      <a href={url} target="_blank"><img src={url} alt="QR รับเงิน" /></a>
      <figcaption className="muted">QR รับเงินของเพื่อน — ใส่ยอด{amountText ? ` ${amountText}` : ''} เองในแอปธนาคาร</figcaption>
    </figure>
  ) : null
}

export function PromptPayQR({ id, amount }: { id: string; amount: number }) {
  const [src, setSrc] = useState<string>()
  useEffect(() => {
    QRCode.toDataURL(generatePayload(id, { amount }), { width: 240, margin: 1 }).then(setSrc)
  }, [id, amount])
  return src ? (
    <figure className="qr">
      <img src={src} alt={`PromptPay ${amount} บาท`} />
      <figcaption className="muted">สแกนด้วยแอปธนาคาร · PromptPay {id}</figcaption>
    </figure>
  ) : null
}

export default function SettleUp() {
  const { id } = useParams() as { id: string }
  const [q] = useSearchParams()
  const nav = useNavigate()
  const [members, setMembers] = useState<Member[]>([])
  const [f, setF] = useState({ from_member: q.get('from') ?? '', to_member: q.get('to') ?? '', amount: q.get('amount') ?? '', currency: q.get('cur') ?? 'THB' })
  const [slip, setSlip] = useState<File>()
  const [err, setErr] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false) // a slow slip upload invited a second tap → duplicate transfer

  useEffect(() => {
    sb.from('members').select(MEMBER_COLS).eq('group_id', id).then((r) => {
      setMembers(must(r) as unknown as Member[])
    })
  }, [id])

  const from = members.find((m) => m.id === f.from_member)
  const to = members.find((m) => m.id === f.to_member)
  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      const sid = crypto.randomUUID()
      let slip_path = null
      if (slip) {
        slip_path = `${id}/slips/${sid}.jpg`
        must(await sb.storage.from('receipts').upload(slip_path, await shrink(slip), { contentType: 'image/jpeg' }))
      }
      must(await sb.from('settlements').insert({ id: sid, group_id: id, ...f, amount: Number(f.amount), slip_path }))
      nav(`/g/${id}`, { replace: true })
    } catch (e) {
      setErr((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <main>
      <FormHeader title="บันทึกการโอน" back={`/g/${id}`} formId="settle-form" dirty={dirty} disabled={busy || !from || !to} />
      <form id="settle-form" onSubmit={save} onChange={() => setDirty(true)} className="stack">
        <p><b>{memberName(from)}</b> โอนให้ <b>{memberName(to)}</b></p>
        <div className="row">
          <label>จำนวน<input required type="number" step="any" min="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>
          <label>สกุลเงิน
            <select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>
              {[...new Set([f.currency, ...CURRENCIES])].map((c) => <option key={c}>{c}</option>)}
            </select>
          </label>
        </div>
        {f.currency === 'THB' && to?.profiles?.promptpay && Number(f.amount) > 0 && <PromptPayQR id={to.profiles.promptpay} amount={Number(f.amount)} />}
        <PaymentQR path={to?.profiles?.payment_qr_path} amountText={f.amount ? `${f.amount} ${f.currency}` : ''} />
        {to && !to.profiles?.payment_qr_path && !(f.currency === 'THB' && to.profiles?.promptpay) && <p className="muted">{memberName(to)} ยังไม่มีการแนบ QR</p>}
        <label>แนบสลิป (ไม่บังคับ)<input type="file" accept="image/*" onChange={(e) => setSlip(e.target.files?.[0])} /></label>
        {err && <p className="bad">{err}</p>}
      </form>
    </main>
  )
}
