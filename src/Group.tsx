import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import type { Session } from '@supabase/supabase-js'
import { active, BILL_COLS, MEMBER_COLS, memberName, must, sb, useRates, useSignedUrl, type Member } from './supabase'
import { GROUP_TYPES, tripDates, type Group } from './GroupSettings'
import { ACTIVITY_COLS, ActivityLog, type Entry } from './Activity'
import { allocate, balances, convertNet, fmt, paidBy, simplify, toMajor, toMinor, UNCLAIMED, type Bill, type Settlement } from './money'

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
  const [viewCur, setViewCur] = useState<string>()

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

  const view = viewCur ?? group?.currency ?? 'THB'
  const fx = useRates(view)
  if (!group) return null
  const name = (mid: string) => memberName(members.find((m) => m.id === mid))
  const me = members.find((m) => m.user_id === session.user.id)
  const you = (mid: string) => (mid === me?.id ? 'คุณ' : name(mid))
  const bal = balances(bills, settles)
  const used = [...bal.keys()]
  const curOptions = [...new Set([group.currency, ...used])]
  // Everything in one currency when possible: exact if nothing needs converting, else an estimate from today's rate.
  const exact = used.every((c) => c === view)
  const one = exact ? (bal.get(view) ?? new Map<string, number>()) : fx ? convertNet(bal, view, fx.rates) : null
  const estimate = !exact && !!one
  const moves = one
    ? simplify(one).map((mv) => ({ cur: view, ...mv }))
    : [...bal].flatMap(([cur, net]) => simplify(net).map((mv) => ({ cur, ...mv }))) // rates unavailable: per currency
  const myNet: (readonly [string, number])[] = one
    ? [[view, one.get(me?.id ?? '') ?? 0] as const].filter(([, v]) => v)
    : [...bal].map(([cur, net]) => [cur, net.get(me?.id ?? '') ?? 0] as const).filter(([, v]) => v)
  const myMove = moves.find((mv) => mv.from === me?.id)
  const approx = estimate ? '≈ ' : ''
  const toView = (minor: number, cur: string) => (cur === view || !fx?.rates[cur] ? null : toMinor(toMajor(minor, cur) * fx.rates[cur], view))

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
          <Link className="hero-pill" to={`/g/${id}/settings`}>👥 {active(members).length} คน</Link>
        </div>
      </section>

      <p className="status">
        {myNet.length === 0 ? '🎉 เคลียร์หมดแล้วในกลุ่มนี้' : myNet.map(([cur, v]) => (
          <span key={cur} className={v > 0 ? 'good' : 'owe'}>{v > 0 ? 'คุณได้คืน' : 'คุณติดอยู่'} {approx}{fmt(Math.abs(v), cur)} </span>
        ))}
      </p>
      {curOptions.length > 1 && (
        <div className="tabs" role="group" aria-label="แสดงยอดเป็น">
          <small className="muted">แสดงเป็น</small>
          {curOptions.map((c) => (
            <button key={c} className={`pill ${c === view ? 'on' : ''}`} aria-pressed={c === view} onClick={() => setViewCur(c)}>{c}</button>
          ))}
        </div>
      )}
      {estimate && <p className="muted fx-note">≈ ประมาณการจากเรทวันที่ {fx!.date} (ธนาคารกลางยุโรป) ยอดจริงในแต่ละบิลยังเป็นสกุลเดิม</p>}

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
              <span>{you(from)} ต้องโอนให้ {you(to)} <b>{approx}{fmt(amount, cur)}</b></span>
              <Link to={`/g/${id}/settle?from=${from}&to=${to}&amount=${toMajor(amount, cur)}&cur=${cur}`}>โอนแล้ว</Link>
            </div>
          ))}
          {!moves.length && <p className="muted">ไม่มียอดค้าง</p>}
        </section>
      )}

      {rows.map((r, i) => (
        <div key={r.bill?.id ?? r.settle!.id}>
          {(i === 0 || month(rows[i - 1].date) !== month(r.date)) && <h2>{month(r.date)}</h2>}
          {r.bill ? <BillLine bill={r.bill} me={me?.id} name={you} toView={toView} view={view} /> : <SettleLine s={r.settle!} name={you} />}
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

function BillLine({ bill, me, name, toView, view }: {
  bill: BillRow; me?: string; name: (id: string) => string; toView: (minor: number, cur: string) => number | null; view: string
}) {
  const cur = bill.currency
  const total = toMinor(bill.grand_total, cur)
  const payers = paidBy(bill)
  const paid = payers.filter(([m]) => m === me).reduce((a, [, v]) => a + v, 0)
  const owed = allocate(bill).filter((p) => p.member_id === me || (p.member_id === UNCLAIMED && bill.paid_by === me)).reduce((a, p) => a + p.total, 0)
  const lent = paid - owed
  const est = toView(total, cur)
  return (
    <Link className="line" to={`/b/${bill.id}`}>
      <DateBox date={bill.spent_on} />
      <span className="icon" aria-hidden>{bill.image_path ? '🧾' : '📝'}</span>
      <span className="grow">
        <b>{bill.title}</b>
        <small className="muted">{payers.length > 1 ? `${payers.length} คนจ่าย` : `${name(bill.paid_by)} จ่าย`} {fmt(total, cur)}{est != null && ` (≈ ${fmt(est, view)})`}</small>
      </span>
      <span className="right">
        {lent > 0 ? <><small className="good">คุณให้ยืม</small><b className="good">{fmt(lent, cur)}</b></>
          : lent < 0 ? <><small className="owe">คุณยืม</small><b className="owe">{fmt(-lent, cur)}</b></>
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
