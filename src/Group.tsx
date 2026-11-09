import { useCallback, useEffect, useState } from 'react'
import { ArrowDownLeft, ArrowLeft, ArrowUpRight, Banknote, CalendarDays, ChevronRight, CircleCheck, NotebookPen, Plus, ReceiptText, Settings, Trash2, Users } from 'lucide-react'
import { Link, useParams } from 'react-router'
import type { Session } from '@supabase/supabase-js'
import { active, BILL_COLS, MEMBER_COLS, memberName, must, sb, useRates, useSignedUrl, type Member } from './supabase'
import { Avatar } from './Avatar'
import { TypeIcon, tripDates, type Group } from './GroupSettings'
import { ACTIVITY_COLS, ActivityLog, type Entry } from './Activity'
import { allocate, balances, fmt, inOne, memberNet, paidBy, shortName, simplify, toMajor, toMinor, UNCLAIMED, type Bill, type Settlement } from './money'

type BillRow = Bill & { id: string; title: string; spent_on: string; created_at: string; image_path: string | null }
type SettlementRow = Settlement & { id: string; slip_path: string | null; created_at: string }
type Row = { date: string; at: string; bill?: BillRow; settle?: SettlementRow }

export default function GroupPage({ session }: { session: Session }) {
  const { id } = useParams() as { id: string }
  const [group, setGroup] = useState<Group>()
  const [members, setMembers] = useState<Member[]>([])
  const [bills, setBills] = useState<BillRow[]>([])
  const [settles, setSettles] = useState<SettlementRow[]>([])
  const [log, setLog] = useState<Entry[]>([])
  const [panel, setPanel] = useState<'' | 'balances' | 'pay'>('')
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
  const mem = (mid: string) => members.find((m) => m.id === mid)
  const name = (mid: string) => shortName(memberName(mem(mid)))
  const me = members.find((m) => m.user_id === session.user.id)
  const you = (mid: string) => (mid === me?.id ? 'คุณ' : name(mid))
  const bal = balances(bills, settles)
  const used = [...bal.keys()]
  const curOptions = [...new Set([group.currency, ...used])]
  // Everything in one currency when possible: exact if nothing needs converting, else an estimate from today's rate.
  const exact = used.every((c) => c === view)
  const one = inOne(bal, view, fx?.rates)
  const estimate = !exact && !!one
  const moves = one
    ? simplify(one).map((mv) => ({ cur: view, ...mv }))
    : [...bal].flatMap(([cur, net]) => simplify(net).map((mv) => ({ cur, ...mv }))) // rates unavailable: per currency
  const myNet = memberNet(bal, one, view, me?.id ?? '')
  const approx = estimate ? '≈ ' : ''
  const toView = (minor: number, cur: string) => (cur === view || !fx?.rates[cur] ? null : toMinor(toMajor(minor, cur) * fx.rates[cur], view))

  const rows: Row[] = [
    ...bills.map((bill) => ({ date: bill.spent_on, at: bill.created_at, bill })),
    ...settles.map((settle) => ({ date: new Date(settle.created_at).toLocaleDateString('sv'), at: settle.created_at, settle })),
  ].sort((a, b) => b.date.localeCompare(a.date) || +new Date(b.at) - +new Date(a.at)) // same day: last added on top
  const month = (d: string) => new Date(d).toLocaleDateString('th-TH', { month: 'long', year: 'numeric' })

  return (
    <main className="has-fab">
      <section className={`hero ${group.cover_url ? 'has-cover' : ''}`}
        style={group.cover_url ? { backgroundImage: `linear-gradient(transparent 30%, rgba(0,0,0,.65)), url("${group.cover_url}")` } : undefined}>
        <div className="hero-bar">
          <Link to="/" className="round" aria-label="กลับ"><ArrowLeft size={22} /></Link>
          <Link to={`/g/${id}/settings`} className="round" aria-label="ตั้งค่ากลุ่ม"><Settings size={22} /></Link>
        </div>
        <h1 className="group-title">{!group.cover_url && <span className="title-icon"><TypeIcon type={group.type} size={26} /></span>}{group.name}</h1>
        <div className="tabs">
          {group.type === 'trip' && <Link className="hero-pill" to={`/g/${id}/edit`}><CalendarDays size={18} aria-hidden /> {tripDates(group) || 'ใส่วันที่ทริป'}</Link>}
          <Link className="hero-pill" to={`/g/${id}/settings`}><Users size={18} aria-hidden /> {active(members).length} คน</Link>
        </div>
      </section>

      <p className="status">
        {myNet.length === 0 ? <span className="good"><CircleCheck size={20} aria-hidden /> เคลียร์หมดแล้วในกลุ่มนี้</span> : myNet.map(([cur, v]) => (
          <span key={cur} className={v > 0 ? 'good' : 'owe'}>
            {v > 0 ? <ArrowDownLeft size={20} aria-hidden /> : <ArrowUpRight size={20} aria-hidden />}
            {v > 0 ? 'คุณได้คืน' : 'คุณติดอยู่'} {approx}{fmt(Math.abs(v), cur)}
          </span>
        ))}
      </p>
      {moves.some((mv) => mv.from === me?.id || mv.to === me?.id) && (
        <ul className="my-moves">
          {moves.filter((mv) => mv.from === me?.id || mv.to === me?.id).map((mv) => (
            <li key={mv.from + mv.to + mv.cur}>
              {mv.from === me?.id ? <Link to={`/g/${id}/settle?from=${mv.from}&to=${mv.to}&amount=${toMajor(mv.amount, mv.cur)}&cur=${mv.cur}`}>
                ติด <span className="who"><Avatar member={mem(mv.to)} size={24} /><b>{name(mv.to)}</b></span> <span className="owe">{approx}{fmt(mv.amount, mv.cur)}</span> — โอนเลย
              </Link> : <><span className="who"><Avatar member={mem(mv.from)} size={24} /><b>{name(mv.from)}</b></span> ติดคุณ <span className="good">{approx}{fmt(mv.amount, mv.cur)}</span></>}
            </li>
          ))}
        </ul>
      )}
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
        <button className={panel === 'pay' ? '' : 'ghost'} aria-expanded={panel === 'pay'}
          onClick={() => setPanel(panel === 'pay' ? '' : 'pay')}>โอนคืน</button>
        <button className={panel === 'balances' ? '' : 'ghost'} aria-expanded={panel === 'balances'}
          onClick={() => setPanel(panel === 'balances' ? '' : 'balances')}>ยอดคงเหลือ</button>
      </div>

      {panel === 'pay' && (
        <section className="card" aria-label="ต้องโอนให้ใคร">
          {moves.filter((mv) => mv.from === me?.id).map((mv) => (
            <Link key={mv.cur + mv.to} className="line" to={`/g/${id}/settle?from=${mv.from}&to=${mv.to}&amount=${toMajor(mv.amount, mv.cur)}&cur=${mv.cur}`}>
              <Avatar member={mem(mv.to)} size={40} />
              <b className="grow">{name(mv.to)}</b>
              <b className="owe">{approx}{fmt(mv.amount, mv.cur)}</b>
              <ChevronRight size={20} aria-hidden />
            </Link>
          ))}
          {!moves.some((mv) => mv.from === me?.id) && <p className="muted">คุณไม่มียอดต้องโอน</p>}
        </section>
      )}

      {panel === 'balances' && (
        <section className="card stack">
          {moves.map(({ cur, from, to, amount }) => (
            <div key={cur + from + to} className={`row ${from === me?.id || to === me?.id ? 'mine' : ''}`}>
              <span><Avatar member={mem(from)} size={24} /> {you(from)} ต้องโอนให้ <Avatar member={mem(to)} size={24} /> {you(to)} <b>{approx}{fmt(amount, cur)}</b></span>
              <Link to={`/g/${id}/settle?from=${from}&to=${to}&amount=${toMajor(amount, cur)}&cur=${cur}`}>โอนแล้ว</Link>
            </div>
          ))}
          {!moves.length && <p className="muted">ไม่มียอดค้าง</p>}
        </section>
      )}

      {rows.map((r, i) => (
        <div key={r.bill?.id ?? r.settle!.id}>
          {(i === 0 || month(rows[i - 1].date) !== month(r.date)) && <h2>{month(r.date)}</h2>}
          {r.bill ? <BillLine bill={r.bill} me={me?.id} name={you} toView={toView} view={view} /> : <SettleLine s={r.settle!} name={you} onDeleted={load} />}
        </div>
      ))}
      {!rows.length && <p className="muted center-text">ยังไม่มีค่าใช้จ่าย กด "เพิ่มค่าใช้จ่าย" ด้านล่างได้เลย</p>}

      <ActivityLog entries={log} members={members} title="ความเคลื่อนไหวล่าสุด" />

      <Link className="button fab" to={`/g/${id}/add`}><Plus size={22} aria-hidden /> เพิ่มค่าใช้จ่าย</Link>
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
      <span className="icon bill" aria-hidden>{bill.image_path ? <ReceiptText size={22} /> : <NotebookPen size={22} />}</span>
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

function SettleLine({ s, name, onDeleted }: { s: SettlementRow; name: (id: string) => string; onDeleted: () => void }) {
  const slip = useSignedUrl(s.slip_path)
  // the activity log keeps a record of the deleted transfer (DB trigger)
  const del = async () => {
    if (!confirm(`ลบรายการโอน ${name(s.from_member)} → ${name(s.to_member)} ${fmt(toMinor(s.amount, s.currency), s.currency)}?`)) return
    must(await sb.from('settlements').delete().eq('id', s.id))
    if (s.slip_path) await sb.storage.from('receipts').remove([s.slip_path])
    onDeleted()
  }
  return (
    <div className="line">
      <DateBox date={s.created_at} />
      <span className="icon" aria-hidden><Banknote size={22} /></span>
      <span className="grow">{name(s.from_member)} โอนให้ {name(s.to_member)} {fmt(toMinor(s.amount, s.currency), s.currency)}</span>
      {slip && <a className="right" href={slip} target="_blank">สลิป</a>}
      <button className="icon-btn" aria-label="ลบรายการโอนนี้" onClick={del}><Trash2 size={18} /></button>
    </div>
  )
}
