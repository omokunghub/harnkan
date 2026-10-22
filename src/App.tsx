import { useEffect, useState, type FormEvent } from 'react'
import { BrowserRouter, Link, Route, Routes, useNavigate, useParams } from 'react-router'
import type { Session } from '@supabase/supabase-js'
import { BILL_COLS, must, sb, shrink, useSession } from './supabase'
import { Avatar } from './Avatar'
import { PaymentQR } from './SettleUp'
import { balances, fmt } from './money'
import AddExpense from './AddExpense'
import { EditGroup, GroupIcon, GroupSettings } from './GroupSettings'
import GroupPage from './Group'
import NewBill from './NewBill'
import BillPage from './Bill'
import SettleUp from './SettleUp'

async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window))
    throw new Error('เครื่องนี้ไม่รองรับ (iPhone ต้อง Add to Home Screen แล้วเปิดจากไอคอนก่อน)')
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('ไม่ได้อนุญาตการแจ้งเตือน')
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: import.meta.env.VITE_VAPID_PUBLIC_KEY })
  must(await sb.from('push_subs').upsert({ endpoint: sub.endpoint, sub: sub.toJSON() }))
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
        <Route path="/g/:id" element={<GroupPage session={session} />} />
        <Route path="/g/:id/new" element={<NewBill session={session} />} />
        <Route path="/g/:id/settings" element={<GroupSettings session={session} />} />
        <Route path="/g/:id/edit" element={<EditGroup />} />
        <Route path="/g/:id/add" element={<AddExpense session={session} />} />
        <Route path="/b/:id/expense" element={<AddExpense session={session} />} />
        <Route path="/g/:id/settle" element={<SettleUp session={session} />} />
        <Route path="/b/:id" element={<BillPage session={session} />} />
        <Route path="/b/:id/edit" element={<NewBill session={session} />} />
      </Routes>
    </BrowserRouter>
  )
}

function Login() {
  // redirect back to the same URL so invite links survive the sign-in
  const go = () => sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.href } })
  return (
    <main className="center">
      <h1>หารกัน</h1>
      <p className="muted">ถ่ายใบเสร็จ ติ๊กของตัวเอง แล้วรู้เลยว่าต้องโอนใคร</p>
      <button onClick={go}>เข้าสู่ระบบด้วย Google</button>
    </main>
  )
}

function Groups({ session }: { session: Session }) {
  const [groups, setGroups] = useState<{ id: string; name: string; type: string; cover_url: string | null; net: [string, number][] }[]>()
  const [name, setName] = useState('')
  const [me, setMe] = useState<{ display_name: string; avatar_url: string | null }>()
  const nav = useNavigate()
  useEffect(() => {
    sb.from('profiles').select('display_name, avatar_url').eq('id', session.user.id).single().then((r) => setMe(r.data ?? undefined))
    // ponytail: pulls every bill the user can see to show per-group status; a SQL view if it gets slow
    Promise.all([
      sb.from('groups').select('id, name, type, cover_url').order('created_at', { ascending: false }),
      sb.from('members').select('id, group_id').eq('user_id', session.user.id),
      sb.from('bills').select(BILL_COLS),
      sb.from('settlements').select('*'),
    ]).then(([g, m, b, st]) => {
      const mine = new Map(must(m).map((x: { id: string; group_id: string }) => [x.group_id, x.id]))
      setGroups(must(g).map((gr: { id: string; name: string; type: string; cover_url: string | null }) => {
        const bal = balances(must(b).filter((x: { group_id: string }) => x.group_id === gr.id), must(st).filter((x: { group_id: string }) => x.group_id === gr.id))
        return { ...gr, net: [...bal].map(([cur, n]) => [cur, n.get(mine.get(gr.id)!) ?? 0] as [string, number]).filter(([, v]) => v) }
      }))
    })
  }, [session.user.id])
  const create = async (e: FormEvent) => {
    e.preventDefault()
    nav(`/g/${must(await sb.rpc('create_group', { group_name: name }))}`)
  }
  if (!groups) return null
  const all = groups.flatMap((g) => g.net)
  return (
    <main>
      <header>
        <h1>หารกัน</h1>
        <Link to="/me" aria-label="ตั้งค่าบัญชี"><Avatar url={me?.avatar_url} name={me?.display_name ?? '?'} size={36} /></Link>
      </header>
      <p className="status">{all.length ? groups.length + ' กลุ่ม' : '🎉 คุณเคลียร์หมดทุกกลุ่มแล้ว'}</p>
      {groups.map((g) => (
        <Link key={g.id} className="line group-line" to={`/g/${g.id}`}>
          <GroupIcon group={g} size={56} />
          <span className="grow">
            <b>{g.name}</b>
            {g.net.length ? g.net.map(([cur, v]) => (
              <small key={cur} className={v > 0 ? 'good' : 'owe'}>{v > 0 ? `คุณได้คืน ${fmt(v, cur)}` : `คุณติดอยู่ ${fmt(-v, cur)}`}</small>
            )) : <small className="muted">เคลียร์แล้ว</small>}
          </span>
        </Link>
      ))}
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
  const upload = async (file?: File) => {
    if (!file) return
    setBusy(true); setMsg('')
    try {
      const path = `${uid}/${Date.now()}.jpg`
      must(await sb.storage.from('avatars').upload(path, await shrink(file, 256), { contentType: 'image/jpeg' }))
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
  const push = () => enablePush().then(() => setMsg('เปิดแจ้งเตือนแล้ว'), (e) => setMsg(String(e.message ?? e)))
  return (
    <main>
      <header>
        <Link to="/" aria-label="กลับ">‹</Link>
        <h1>ตั้งค่าบัญชี</h1>
      </header>
      <div className="profile-pic">
        <Avatar url={p.avatar_url} name={p.display_name || '?'} size={96} />
        <label className="button ghost">
          {busy ? 'กำลังอัปโหลด…' : 'เปลี่ยนรูปโปรไฟล์'}
          <input hidden type="file" accept="image/*" disabled={busy} onChange={(e) => upload(e.target.files?.[0])} />
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
      <button className="ghost" onClick={push}>เปิดแจ้งเตือนบิลใหม่</button>
      <button className="ghost" onClick={() => sb.auth.signOut()}>ออกจากระบบ</button>
      {msg && <p className="muted" role="status">{msg}</p>}
    </main>
  )
}
