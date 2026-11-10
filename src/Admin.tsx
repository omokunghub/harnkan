import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { ArrowLeft } from 'lucide-react'
import { memberName, must, sb, useRates, type Member } from './supabase'
import { allocate, fmt, paidBy, toMajor, toMinor, UNCLAIMED, type Bill } from './money'
import { Avatar } from './Avatar'
import { ActivityLog, type Entry } from './Activity'
import { GroupIcon, type Group } from './GroupSettings'

// Admin-only monitor. The data comes from security-definer RPCs that check is_admin(); these pages just render it.
type User = { id: string; display_name: string; avatar_url: string | null; email: string; last_sign_in_at: string | null; trips: number }
type Trip = { id: string; name: string; type: string; cover_url: string | null; members: number; bills: number }
type BillRow = Bill & { id: string; title: string; created_by: string }
type Data = { group: Group; members: Member[]; bills: BillRow[]; activity: Entry[] }

const date = (d: string | null) => (d ? new Date(d).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }) : 'ไม่เคย')
const sum = (m: Map<string, number> | undefined) => (m?.size ? [...m].map(([c, v]) => fmt(v, c)).join(' + ') : '-')
const add = (m: Map<string, Map<string, number>>, k: string, cur: string, v: number) => {
  const per = m.get(k) ?? m.set(k, new Map()).get(k)!
  per.set(cur, (per.get(cur) ?? 0) + v)
}

function Top({ title, back }: { title: string; back: string }) {
  return (
    <header>
      <Link to={back} className="icon-btn" aria-label="กลับ"><ArrowLeft size={24} /></Link>
      <h1>{title}</h1>
    </header>
  )
}

export function AdminHome() {
  const [users, setUsers] = useState<User[]>()
  const [trips, setTrips] = useState<Trip[]>()
  const [err, setErr] = useState('')
  useEffect(() => {
    Promise.all([sb.rpc('admin_users'), sb.rpc('admin_groups')])
      .then(([u, t]) => { setUsers(must(u)); setTrips(must(t)) })
      .catch((e) => setErr(e.message))
  }, [])
  return (
    <main>
      <Top title="ผู้ดูแล" back="/me" />
      {err && <p className="bad" role="alert">{err}</p>}
      <h2>ทริปทั้งหมด ({trips?.length ?? '…'})</h2>
      {trips?.map((t) => (
        <Link key={t.id} className="line group-line" to={`/admin/g/${t.id}`}>
          <GroupIcon group={t} size={48} />
          <span className="grow"><b>{t.name}</b><small className="muted">สมาชิก {t.members} คน · {t.bills} บิล</small></span>
        </Link>
      ))}
      <h2>สมาชิกทั้งหมด ({users?.length ?? '…'})</h2>
      {users?.map((u) => (
        <div key={u.id} className="line">
          <Avatar url={u.avatar_url} name={u.display_name || '?'} size={40} />
          <span className="grow">
            <b>{u.display_name || '(ไม่มีชื่อ)'}</b>
            <small className="muted">{u.email}</small>
            <small className="muted">อยู่ {u.trips} ทริป · เข้าล่าสุด {date(u.last_sign_in_at)}</small>
          </span>
        </div>
      ))}
    </main>
  )
}

export function AdminTrip() {
  const { id } = useParams() as { id: string }
  const [d, setD] = useState<Data>()
  const [err, setErr] = useState('')
  useEffect(() => {
    sb.rpc('admin_group', { g: id }).then((r) => (r.error ? setErr(r.error.message) : setD(r.data)))
  }, [id])
  const fx = useRates(d?.group.currency ?? 'THB')
  if (err) return <main><Top title="ทริป" back="/admin" /><p className="bad" role="alert">{err}</p></main>
  if (!d) return null

  const name = (mid: string) => memberName(d.members.find((m) => m.id === mid))
  const byUser = (uid: string) => memberName(d.members.find((m) => m.user_id === uid)).replace(/^\?$/, 'อดีตสมาชิก')
  const total = (b: BillRow) => toMinor(b.grand_total, b.currency)
  // ponytail: biggest bill compared at today's rate; bills keep their own currency on screen
  const inBase = (b: BillRow) => toMajor(total(b), b.currency) * (b.currency === d.group.currency ? 1 : fx?.rates[b.currency] ?? 1)
  const biggest = d.bills.reduce<BillRow | undefined>((x, b) => (!x || inBase(b) > inBase(x) ? b : x), undefined)

  const opened = new Map<string, Map<string, number>>(), count = new Map<string, number>()
  const share = new Map<string, Map<string, number>>(), paid = new Map<string, Map<string, number>>()
  for (const b of d.bills) {
    add(opened, b.created_by, b.currency, total(b))
    count.set(b.created_by, (count.get(b.created_by) ?? 0) + 1)
    for (const p of allocate(b)) add(share, p.member_id === UNCLAIMED ? b.paid_by : p.member_id, b.currency, p.total)
    for (const [m, v] of paidBy(b)) add(paid, m, b.currency, v)
  }
  const openers = [...count].sort((a, b) => b[1] - a[1])
  const top = openers[0]

  return (
    <main>
      <Top title={d.group.name} back="/admin" />
      <p className="muted">{d.bills.length} บิล · สมาชิก {d.members.filter((m) => !m.removed_at).length} คน</p>

      <h2>เปิดบิลมากที่สุด</h2>
      {top ? <p><b>{byUser(top[0])}</b> {top[1]} บิล รวม {sum(opened.get(top[0]))}</p> : <p className="muted">ยังไม่มีบิล</p>}

      <h2>บิลสูงสุด</h2>
      {biggest ? <p><b>{biggest.title}</b> {fmt(total(biggest), biggest.currency)} · {name(biggest.paid_by)} จ่าย</p> : <p className="muted">ยังไม่มีบิล</p>}

      <h2>แต่ละคนเปิดบิล</h2>
      <table>
        <thead><tr><th>คน</th><th>บิล</th><th>ยอดรวม</th></tr></thead>
        <tbody>{openers.map(([uid, n]) => (
          <tr key={uid}><td>{byUser(uid)}</td><td>{n}</td><td>{sum(opened.get(uid))}</td></tr>
        ))}</tbody>
      </table>

      <h2>แต่ละคนใช้จ่าย</h2>
      <table>
        <thead><tr><th>คน</th><th>ส่วนของตัวเอง</th><th>ออกเงินไป</th></tr></thead>
        <tbody>{d.members.map((m) => (
          <tr key={m.id}>
            <td><span className="who"><Avatar member={m} size={24} />{memberName(m)}{m.removed_at ? ' (ออกแล้ว)' : ''}</span></td>
            <td>{sum(share.get(m.id))}</td><td>{sum(paid.get(m.id))}</td>
          </tr>
        ))}</tbody>
      </table>

      <ActivityLog entries={d.activity} members={d.members} title="Log ทั้งหมด" />
    </main>
  )
}
