import { useEffect, useState, type FormEvent } from 'react'
import { ArrowLeft, Bell, BellOff, CircleCheck, Eye, EyeOff, ShieldCheck } from 'lucide-react'
import { BrowserRouter, Link, Route, Routes, useNavigate, useParams } from 'react-router'
import type { Session } from '@supabase/supabase-js'
import { BILL_COLS, fetchRates, must, sb, shrink, useIsAdmin, useSession } from './supabase'
import { Avatar } from './Avatar'
import { AvatarCropper } from './Crop'
import { PaymentQR } from './SettleUp'
import { balances, fmt, inOne, memberNet } from './money'
import AddExpense from './AddExpense'
import { EditGroup, GroupIcon, GroupSettings } from './GroupSettings'
import GroupPage from './Group'
import NewBill from './NewBill'
import BillPage from './Bill'
import SettleUp from './SettleUp'
import { AdminHome, AdminTrip } from './Admin'

async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window))
    throw new Error('เครื่องนี้ไม่รองรับ (iPhone ต้อง Add to Home Screen แล้วเปิดจากไอคอนก่อน)')
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('ไม่ได้อนุญาตการแจ้งเตือน')
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: import.meta.env.VITE_VAPID_PUBLIC_KEY })
  must(await sb.from('push_subs').upsert({ endpoint: sub.endpoint, sub: sub.toJSON() }))
}

// This device's current subscription, if any.
async function pushSub() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null
  return (await navigator.serviceWorker.ready).pushManager.getSubscription()
}
async function disablePush() {
  const sub = await pushSub()
  if (!sub) return
  must(await sb.from('push_subs').delete().eq('endpoint', sub.endpoint))
  await sub.unsubscribe()
  try { localStorage.setItem('push-asked', '1') } catch { /* private mode */ } // turned off on purpose: don't ask again
}

export default function App() {
  const session = useSession()
  if (session === undefined) return null
  if (!session) return <Login />
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Groups session={session} />} />
        <Route path="/join/:code" element={<Join />} />
        <Route path="/me" element={<Profile session={session} />} />
        <Route path="/admin" element={<AdminHome />} />
        <Route path="/admin/g/:id" element={<AdminTrip />} />
        <Route path="/g/:id" element={<GroupPage session={session} />} />
        <Route path="/g/:id/new" element={<NewBill session={session} />} />
        <Route path="/g/:id/settings" element={<GroupSettings session={session} />} />
        <Route path="/g/:id/edit" element={<EditGroup />} />
        <Route path="/g/:id/add" element={<AddExpense session={session} />} />
        <Route path="/b/:id/expense" element={<AddExpense session={session} />} />
        <Route path="/g/:id/settle" element={<SettleUp />} />
        <Route path="/b/:id" element={<BillPage session={session} />} />
        <Route path="/b/:id/edit" element={<NewBill session={session} />} />
      </Routes>
    </BrowserRouter>
  )
}

function Login() {
  // redirect back to the same URL so invite links survive the sign-in
  const go = () => sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } })
  // Supabase sends failures back as ?error_description= or #error_description= — show it instead of silently looping
  const err = new URLSearchParams(location.search + '&' + location.hash.slice(1)).get('error_description')
  return (
    <main className="center">
      <h1>หารกัน</h1>
      <p className="muted">ถ่ายใบเสร็จ ติ๊กของตัวเอง แล้วรู้เลยว่าต้องโอนใคร</p>
      <button onClick={go}>เข้าสู่ระบบด้วย Google</button>
      {err && <p className="bad" role="alert">ล็อกอินไม่สำเร็จ: {err}</p>}
    </main>
  )
}

type Trip = { id: string; name: string; type: string; cover_url: string | null; net: [string, number][]; hidden: boolean; approx: boolean }

function Groups({ session }: { session: Session }) {
  const [groups, setGroups] = useState<Trip[]>()
  const [msg, setMsg] = useState('')
  const [askPush, setAskPush] = useState(false)
  const [name, setName] = useState('')
  const [me, setMe] = useState<{ display_name: string; avatar_url: string | null }>()
  const nav = useNavigate()
  useEffect(() => {
    // A banner, not a prompt on load: iPhone only allows the permission request from a tap, and Chrome hides unprompted ones.
    if (!('PushManager' in window) || !('Notification' in window)) return
    pushSub().then((sub) => {
      if (sub) return enablePush() // make sure the server still knows this device
      if (Notification.permission === 'denied') return
      try { setAskPush(!localStorage.getItem('push-asked')) } catch { setAskPush(true) } // private mode
    }).catch(() => {})
  }, [session.user.id])
  const answerPush = (yes: boolean) => {
    setAskPush(false)
    try { localStorage.setItem('push-asked', '1') } catch { /* private mode */ }
    if (yes) enablePush().then(() => setMsg(''), (e) => setMsg(`เปิดแจ้งเตือนไม่สำเร็จ: ${e.message ?? e}`))
  }
  useEffect(() => {
    sb.from('profiles').select('display_name, avatar_url').eq('id', session.user.id).single().then((r) => setMe(r.data ?? undefined))
    // ponytail: pulls every bill the user can see to show per-group status; a SQL view if it gets slow
    Promise.all([
      sb.from('groups').select('id, name, type, cover_url, currency').order('created_at', { ascending: false }),
      sb.from('members').select('id, group_id, hidden_at').eq('user_id', session.user.id),
      sb.from('bills').select(BILL_COLS),
      sb.from('settlements').select('*'),
    ]).then(async ([g, m, b, st]) => {
      const mine = new Map(must(m).map((x: { id: string; group_id: string; hidden_at: string | null }) => [x.group_id, x]))
      const rows = must(g).map((gr: { id: string; name: string; type: string; cover_url: string | null; currency: string }) => ({
        gr, bal: balances(must(b).filter((x: { group_id: string }) => x.group_id === gr.id), must(st).filter((x: { group_id: string }) => x.group_id === gr.id)),
      }))
      const mixed = rows.filter(({ gr, bal }) => [...bal.keys()].some((c) => c !== gr.currency)).map(({ gr }) => gr.currency)
      const fx = new Map(await Promise.all([...new Set(mixed)].map(async (c) => [c, (await fetchRates(c).catch(() => undefined))?.rates] as const)))
      setGroups(rows.map(({ gr, bal }) => {
        const one = inOne(bal, gr.currency, fx.get(gr.currency))
        return { ...gr, net: memberNet(bal, one, gr.currency, mine.get(gr.id)!.id), hidden: !!mine.get(gr.id)!.hidden_at, approx: !!one && [...bal.keys()].some((c) => c !== gr.currency) }
      }))
    })
  }, [session.user.id])
  const create = async (e: FormEvent) => {
    e.preventDefault()
    nav(`/g/${must(await sb.rpc('create_group', { group_name: name }))}`)
  }
  if (!groups) return null
  const all = groups.flatMap((g) => g.net)
  const owes = (g: Trip) => g.net.some(([, v]) => v < 0)
  const folded = groups.filter((g) => g.hidden && !owes(g)) // a new debt brings a hidden trip back by itself
  const setHidden = async (g: Trip, hide: boolean) => {
    // ponytail: checked in the browser only; hiding just tidies your own list, so there's nothing to protect server-side
    if (hide && owes(g)) return setMsg(`ยังซ่อน "${g.name}" ไม่ได้ เพราะคุณยังติดเงินเพื่อนในทริปนี้`)
    setMsg('')
    try {
      must(await sb.rpc('set_group_hidden', { g: g.id, hide }))
      setGroups(groups.map((x) => (x.id === g.id ? { ...x, hidden: hide } : x)))
    } catch (e) { setMsg(`ทำไม่สำเร็จ: ${(e as Error).message}`) }
  }
  const row = (g: Trip) => {
    const isFolded = folded.includes(g)
    return (
      <div key={g.id} className="group-row">
        <Link className="line group-line" to={`/g/${g.id}`}>
          <GroupIcon group={g} size={56} />
          <span className="grow">
            <b>{g.name}</b>
            {g.net.length ? g.net.map(([cur, v]) => (
              <small key={cur} className={v > 0 ? 'good' : 'owe'}>{v > 0 ? 'คุณได้คืน' : 'คุณติดอยู่'} {g.approx && '≈ '}{fmt(Math.abs(v), cur)}</small>
            )) : <small className="muted">เคลียร์แล้ว</small>}
          </span>
        </Link>
        <button className="icon-btn" aria-label={`${isFolded ? 'เลิกซ่อน' : 'ซ่อน'} ${g.name}`} onClick={() => setHidden(g, !isFolded)}>
          {isFolded ? <Eye size={20} /> : <EyeOff size={20} />}
        </button>
      </div>
    )
  }
  return (
    <main>
      <header>
        <h1>หารกัน</h1>
        <Link to="/me" aria-label="ตั้งค่าบัญชี"><Avatar url={me?.avatar_url} name={me?.display_name ?? '?'} size={36} /></Link>
      </header>
      <p className="status">{all.length ? groups.length + ' กลุ่ม' : <span className="good"><CircleCheck size={20} aria-hidden /> คุณเคลียร์หมดทุกกลุ่มแล้ว</span>}</p>
      {askPush && (
        <section className="push-ask" aria-label="เปิดการแจ้งเตือน">
          <p><Bell size={20} aria-hidden /> เปิดแจ้งเตือนไหม? จะได้รู้เมื่อเพื่อนเพิ่มชื่อคุณในบิล หรือโอนเงินคืนให้คุณ</p>
          <div className="row">
            <button className="ghost" onClick={() => answerPush(false)}>ไว้ก่อน</button>
            <button onClick={() => answerPush(true)}>เปิดแจ้งเตือน</button>
          </div>
        </section>
      )}
      {msg && <p className="bad" role="alert">{msg}</p>}
      {groups.filter((g) => !folded.includes(g)).map(row)}
      {folded.length > 0 && (
        <details className="activity">
          <summary>ทริปที่ซ่อนไว้ ({folded.length})</summary>
          {folded.map(row)}
        </details>
      )}
      {!groups.length && <p className="muted">ยังไม่มีกลุ่ม สร้างใหม่ หรือขอลิงก์เชิญจากเพื่อน</p>}
      <form onSubmit={create} className="row">
        <input required placeholder="ชื่อกลุ่มใหม่ เช่น ทริปญี่ปุ่น" value={name} onChange={(e) => setName(e.target.value)} />
        <button>สร้าง</button>
      </form>
    </main>
  )
}

function Join() {
  const { code } = useParams()
  const nav = useNavigate()
  const [err, setErr] = useState('')
  useEffect(() => {
    sb.rpc('join_group', { code }).then((r) => (r.error ? setErr(r.error.message) : nav(`/g/${r.data}`, { replace: true })))
  }, [code, nav])
  return <main className="center">{err ? <p className="bad">ลิงก์เชิญใช้ไม่ได้: {err}</p> : <p>กำลังเข้ากลุ่ม…</p>}</main>
}

function Profile({ session }: { session: Session }) {
  const [p, setP] = useState({ display_name: '', promptpay: '', avatar_url: null as string | null, payment_qr_path: null as string | null })
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [cropping, setCropping] = useState<File>()
  const uid = session.user.id
  const meta = session.user.user_metadata
  const googlePic: string | null = meta.avatar_url ?? meta.picture ?? null
  useEffect(() => {
    sb.from('profiles').select('display_name, promptpay, avatar_url, payment_qr_path').eq('id', uid).single()
      .then((r) => { const d = must(r); setP({ display_name: d.display_name, promptpay: d.promptpay ?? '', avatar_url: d.avatar_url, payment_qr_path: d.payment_qr_path }) })
  }, [uid])
  const setAvatar = async (avatar_url: string | null) => {
    const old = p.avatar_url
    must(await sb.from('profiles').update({ avatar_url }).eq('id', uid))
    setP((x) => ({ ...x, avatar_url }))
    if (old?.includes('/avatars/')) await sb.storage.from('avatars').remove([old.split('/avatars/')[1]]) // our own upload
  }
  const upload = async (photo: Blob) => {
    setCropping(undefined); setBusy(true); setMsg('')
    try {
      const path = `${uid}/${Date.now()}.jpg`
      must(await sb.storage.from('avatars').upload(path, photo, { contentType: 'image/jpeg' }))
      await setAvatar(sb.storage.from('avatars').getPublicUrl(path).data.publicUrl)
      setMsg('เปลี่ยนรูปแล้ว')
    } catch (e) {
      setMsg(`อัปโหลดไม่สำเร็จ: ${(e as Error).message}`)
    }
    setBusy(false)
  }
  // Payment QR lives in a private bucket; groupmates get short-lived signed URLs.
  const setQr = async (file?: File) => {
    setBusy(true); setMsg('')
    try {
      let path: string | null = null
      if (file) {
        path = `${uid}/${Date.now()}.jpg`
        must(await sb.storage.from('payment-qr').upload(path, await shrink(file, 1200), { contentType: 'image/jpeg' }))
      }
      must(await sb.from('profiles').update({ payment_qr_path: path }).eq('id', uid))
      if (p.payment_qr_path) await sb.storage.from('payment-qr').remove([p.payment_qr_path])
      setP((x) => ({ ...x, payment_qr_path: path }))
      setMsg(file ? 'บันทึก QR แล้ว' : 'ลบ QR แล้ว')
    } catch (e) {
      setMsg(`ไม่สำเร็จ: ${(e as Error).message}`)
    }
    setBusy(false)
  }
  const save = async (e: FormEvent) => {
    e.preventDefault()
    must(await sb.from('profiles').update({ display_name: p.display_name.trim(), promptpay: p.promptpay || null }).eq('id', uid))
    setMsg('บันทึกแล้ว')
  }
  const admin = useIsAdmin()
  const [pushOn, setPushOn] = useState(false)
  useEffect(() => { pushSub().then((s) => setPushOn(!!s)).catch(() => {}) }, [])
  const push = async () => {
    if (busy) return // each tap talks to the server; rapid taps would overlap
    setBusy(true); setMsg('')
    try {
      await (pushOn ? disablePush() : enablePush())
      setMsg(pushOn ? 'ปิดแจ้งเตือนแล้ว' : 'เปิดแจ้งเตือนแล้ว')
    } catch (e) { setMsg(String((e as Error).message ?? e)) }
    setPushOn(!!(await pushSub().catch(() => null))) // show what the device really has
    setBusy(false)
  }
  return (
    <main>
      <header>
        <Link to="/" className="icon-btn" aria-label="กลับ"><ArrowLeft size={24} /></Link>
        <h1>ตั้งค่าบัญชี</h1>
      </header>
      <div className="profile-pic">
        <Avatar url={p.avatar_url} name={p.display_name || '?'} size={96} />
        <label className="button ghost">
          {busy ? 'กำลังอัปโหลด…' : 'เปลี่ยนรูปโปรไฟล์'}
          <input hidden type="file" accept="image/*" disabled={busy} onChange={(e) => { setCropping(e.target.files?.[0]); e.target.value = '' }} />
        </label>
        {googlePic && p.avatar_url !== googlePic && (
          <button type="button" className="ghost" onClick={() => setAvatar(googlePic)}>ใช้รูปจาก Google</button>
        )}
        <small className="muted">{session.user.email}</small>
      </div>
      <form onSubmit={save} className="stack">
        <label>ชื่อที่เพื่อนเห็น
          <input required maxLength={40} value={p.display_name} onChange={(e) => setP({ ...p, display_name: e.target.value })} />
        </label>
        <label>PromptPay (เบอร์โทร) — ให้เพื่อนสแกนโอน
          <input inputMode="numeric" value={p.promptpay} onChange={(e) => setP({ ...p, promptpay: e.target.value.replace(/\D/g, '') })} />
        </label>
        <button>บันทึก</button>
      </form>
      <h2>QR รับเงิน</h2>
      <p className="muted">รูป QR จากแอปธนาคาร / TrueMoney / แอปจ่ายเงินต่างประเทศ เพื่อนในกลุ่มเดียวกันเท่านั้นที่เห็น</p>
      <PaymentQR path={p.payment_qr_path} />
      <div className="row">
        <label className="button ghost">
          {busy ? 'กำลังอัปโหลด…' : p.payment_qr_path ? 'เปลี่ยนรูป QR' : 'ใส่รูป QR'}
          <input hidden type="file" accept="image/*" disabled={busy} onChange={(e) => { setQr(e.target.files?.[0]); e.target.value = '' }} />
        </label>
        {p.payment_qr_path && <button type="button" className="ghost" disabled={busy} onClick={() => setQr()}>ลบ QR</button>}
      </div>
      <button className="ghost" style={{ width: '100%' }} disabled={busy} aria-pressed={pushOn} onClick={push}>{pushOn ? <BellOff size={20} aria-hidden /> : <Bell size={20} aria-hidden />} {pushOn ? 'ปิดแจ้งเตือน' : 'เปิดแจ้งเตือน'}</button>
      {admin && <Link className="button ghost" style={{ width: '100%', marginTop: 'var(--s2)' }} to="/admin"><ShieldCheck size={20} aria-hidden /> หน้าผู้ดูแล</Link>}
      <button className="ghost" style={{ width: '100%', marginTop: 'var(--s2)' }} onClick={() => sb.auth.signOut()}>ออกจากระบบ</button>
      {msg && <p className="muted" role="status">{msg}</p>}
      {cropping && <AvatarCropper file={cropping} onDone={upload} onClose={() => setCropping(undefined)} />}
    </main>
  )
}
