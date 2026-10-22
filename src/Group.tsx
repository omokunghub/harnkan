import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import type { Session } from '@supabase/supabase-js'
import { BILL_COLS, MEMBER_COLS, memberName, must, sb, useSignedUrl, type Member } from './supabase'
import { GROUP_TYPES, tripDates, type Group } from './GroupSettings'
import { ACTIVITY_COLS, ActivityLog, type Entry } from './Activity'
import { allocate, balances, fmt, simplify, toMajor, toMinor, UNCLAIMED, type Bill, type Settlement } from './money'

type BillRow = Bill & { id: string; title: string; spent_on: string; image_path: string | null }
type SettlementRow = Settlement & { id: string; slip_path: string | null; created_at: string }
type Row = { date: string; bill?: BillRow; settle?: SettlementRow }

export default function GroupPage({ session }: { session: Session }) {
  const { id } = useParams() as { id: string }
  const nav = useNavigate()
  const [group, setGroup] = useState<Group>()
  const [members, setMembers] = useState<Member[]>([])
  const [bills, setBills] = useState<BillRow[]>([])
  const [settles, setSettles] = useState<SettlementRow[]>([])
  const [log, setLog] = useState<Entry[]>([])
  const [panel, setPanel] = useState<'' | 'balances'>('')

  // ponytail: loads every bill of the group to compute balances; paginate if a group reaches thousands of bills
  const load = useCallback(async () => {
    const [g, m, b, s, a] = await Promise.all([
      sb.from('groups').select('*').eq('id', id).single(),
      sb.from('members').select(MEMBER_COLS).eq('group_id', id),
      sb.from('bills').select(BILL_COLS).eq('group_id', id),
      sb.from('settlements').select('*').eq('group_id', id),
      // item-level changes live on each bill's own log
      sb.from('activity').select(ACTIVITY_COLS).eq('group_id', id).not('action', 'like', 'item_%').not('action', 'like', 'share_%')
        .order('created_at', { ascending: false }).limit(30),
    ])
    setGroup(must(g)); setMembers(must(m) as unknown as Member[]); setBills(must(b)); setSettles(must(s)); setLog(must(a))
  }, [id])
  useEffect(() => { load() }, [load])

  if (!group) return null
  const name = (mid: string) => memberName(members.find((m) => m.id === mid))
  const me = members.find((m) => m.user_id === session.user.id)
  const you = (mid: string) => (mid === me?.id ? 'คุณ' : name(mid))
  const bal = balances(bills, settles)
  const moves = [...bal].flatMap(([cur, net]) => simplify(net).map((mv) => ({ cur, ...mv })))
  const myNet = [...bal].map(([cur, net]) => [cur, net.get(me?.id ?? '') ?? 0] as const).filter(([, v]) => v)
  const myMove = moves.find((mv) => mv.from === me?.id)

  const rows: Row[] = [
    ...bills.map((bill) => ({ date: bill.spent_on, bill })),
    ...settles.map((settle) => ({ date: settle.created_at.slice(0, 10), settle })),
  ].sort((a, b) => b.date.localeCompare(a.date))
  const month = (d: string) => new Date(d).toLocaleDateString('th-TH', { month: 'long', year: 'numeric' })

  return (
    <main className="has-fab">
      <section className={`hero ${group.cover_url ? 'has-cover' : ''}`}
        style={group.cover_url ? { backgroundImage: `linear-gradient(transparent 30%, rgba(0,0,0,.65)), url("${group.cover_url}")` } : undefined}>
        <div className="hero-bar">
          <Link to="/" className="round" aria-label="กลับ">←</Link>
          <Link to={`/g/${id}/settings`} className="round" aria-label="ตั้งค่ากลุ่ม">⚙️</Link>
        </div>
        <h1 className="group-title">{group.cover_url ? '' : (GROUP_TYPES[group.type] ?? GROUP_TYPES.other)[0] + ' '}{group.name}</h1>
        <div className="tabs">
          {group.type === 'trip' && <Link className="hero-pill" to={`/g/${id}/edit`}>📅 {tripDates(group) || 'ใส่วันที่ทริป'}</Link>}
          <Link className="hero-pill" to={`/g/${id}/settings`}>👥 {members.length} คน</Link>
        </div>
      </section>

      <p className="status">
        {myNet.length === 0 ? '🎉 เคลียร์หมดแล้วในกลุ่มนี้' : myNet.map(([cur, v]) => (
          <span key={cur} className={v > 0 ? 'good' : 'owe'}>{v > 0 ? `คุณได้คืน ${fmt(v, cur)}` : `คุณติดอยู่ ${fmt(-v, cur)}`} </span>
        ))}
      </p>

      <div className="tabs">
        <button className="ghost" onClick={() => nav(myMove
          ? `/g/${id}/settle?from=${myMove.from}&to=${myMove.to}&amount=${toMajor(myMove.amount, myMove.cur)}&cur=${myMove.cur}`
          : `/g/${id}/settle`)}>โอนคืน</button>
        <button className={panel === 'balances' ? '' : 'ghost'} aria-expanded={panel === 'balances'}
          onClick={() => setPanel(panel === 'balances' ? '' : 'balances')}>ยอดคงเหลือ</button>
      </div>

      {panel === 'balances' && (
        <section className="card stack">
          {moves.map(({ cur, from, to, amount }) => (
            <div key={cur + from + to} className={`row ${from === me?.id || to === me?.id ? 'mine' : ''}`}>
              <span>{you(from)} ต้องโอนให้ {you(to)} <b>{fmt(amount, cur)}</b></span>
              <Link to={`/g/${id}/settle?from=${from}&to=${to}&amount=${toMajor(amount, cur)}&cur=${cur}`}>โอนแล้ว</Link>
            </div>
          ))}
          {!moves.length && <p className="muted">ไม่มียอดค้าง</p>}
        </section>
      )}

      {rows.map((r, i) => (
        <div key={r.bill?.id ?? r.settle!.id}>
          {(i === 0 || month(rows[i - 1].date) !== month(r.date)) && <h2>{month(r.date)}</h2>}
          {r.bill ? <BillLine bill={r.bill} me={me?.id} name={you} /> : <SettleLine s={r.settle!} name={you} />}
        </div>
      ))}
      {!rows.length && <p className="muted center-text">ยังไม่มีค่าใช้จ่าย กด "เพิ่มค่าใช้จ่าย" ด้านล่างได้เลย</p>}

      <ActivityLog entries={log} members={members} title="ความเคลื่อนไหวล่าสุด" />

      <Link className="button fab" to={`/g/${id}/add`}>🧾 เพิ่มค่าใช้จ่าย</Link>
    </main>
  )
}

function DateBox({ date }: { date: string }) {
  const d = new Date(date)
  return (
    <span className="date-box">
      <small>{d.toLocaleDateString('th-TH', { month: 'short' })}</small>
      <b>{d.getDate()}</b>
    </span>
  )
}

function BillLine({ bill, me, name }: { bill: BillRow; me?: string; name: (id: string) => string }) {
  const cur = bill.currency
  const total = toMinor(bill.grand_total, cur)
  const parts = allocate(bill)
  const owed = parts.filter((p) => p.member_id === me || (p.member_id === UNCLAIMED && bill.paid_by === me)).reduce((a, p) => a + p.total, 0)
  const lent = bill.paid_by === me ? total - owed : 0
  return (
    <Link className="line" to={`/b/${bill.id}`}>
      <DateBox date={bill.spent_on} />
      <span className="icon" aria-hidden>{bill.image_path ? '🧾' : '📝'}</span>
      <span className="grow">
        <b>{bill.title}</b>
        <small className="muted">{name(bill.paid_by)} จ่าย {fmt(total, cur)}</small>
      </span>
      <span className="right">
        {lent > 0 ? <><small className="good">คุณให้ยืม</small><b className="good">{fmt(lent, cur)}</b></>
          : owed > 0 && bill.paid_by !== me ? <><small className="owe">คุณยืม</small><b className="owe">{fmt(owed, cur)}</b></>
          : <small className="muted">ไม่เกี่ยวกับคุณ</small>}
      </span>
    </Link>
  )
}

function SettleLine({ s, name }: { s: SettlementRow; name: (id: string) => string }) {
  const slip = useSignedUrl(s.slip_path)
  return (
    <div className="line">
      <DateBox date={s.created_at} />
      <span className="icon" aria-hidden>💵</span>
      <span className="grow">{name(s.from_member)} โอนให้ {name(s.to_member)} {fmt(toMinor(s.amount, s.currency), s.currency)}</span>
      {slip && <a className="right" href={slip} target="_blank">สลิป</a>}
    </div>
  )
}
