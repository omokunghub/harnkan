import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import type { Session } from '@supabase/supabase-js'
import { active, BILL_COLS, CURRENCIES, MEMBER_COLS, memberName, must, sb, share, shrink, useIsAdmin, useRates, type Member } from './supabase'
import { balances, convertNet, fmt } from './money'
import { Avatar } from './Avatar'

export type Group = { id: string; name: string; invite_code: string; type: string; start_on: string | null; end_on: string | null; cover_url: string | null; currency: string }
export const GROUP_TYPES: Record<string, [string, string]> = { trip: ['✈️', 'ทริป'], home: ['🏠', 'บ้าน'], couple: ['❤️', 'คู่รัก'], other: ['📋', 'อื่น ๆ'] }
export const tripDates = (g: Group) =>
  g.start_on && [g.start_on, g.end_on].filter(Boolean).map((d) => new Date(d!).toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })).join(' – ')

// Cover photo, or the group type's icon.
export function GroupIcon({ group, size = 64 }: { group: Pick<Group, 'type' | 'cover_url'>; size?: number }) {
  return (
    <span className="group-avatar" style={{ width: size, height: size, fontSize: size / 2 }} aria-hidden>
      {(GROUP_TYPES[group.type] ?? GROUP_TYPES.other)[0]}
      {group.cover_url && <img src={group.cover_url} alt="" onError={(e) => e.currentTarget.remove()} />}
    </span>
  )
}

// Gear page: everyone's balance in the group, invite, guests.
export function GroupSettings({ session }: { session: Session }) {
  const { id } = useParams() as { id: string }
  const [group, setGroup] = useState<Group>()
  const [members, setMembers] = useState<Member[]>([])
  const [net, setNet] = useState<Map<string, Map<string, number>>>(new Map())
  const [guest, setGuest] = useState('')
  const [adding, setAdding] = useState(false)
  const admin = useIsAdmin()
  const fx = useRates(group?.currency ?? 'THB')

  const load = async () => {
    const [g, m, b, s] = await Promise.all([
      sb.from('groups').select('*').eq('id', id).single(),
      sb.from('members').select(MEMBER_COLS).eq('group_id', id),
      sb.from('bills').select(BILL_COLS).eq('group_id', id),
      sb.from('settlements').select('*').eq('group_id', id),
    ])
    setGroup(must(g)); setMembers(must(m) as unknown as Member[]); setNet(balances(must(b), must(s)))
  }
  useEffect(() => { load() }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  const addGuest = async (e: FormEvent) => {
    e.preventDefault()
    must(await sb.from('members').insert({ group_id: id, guest_name: guest.trim() }))
    setGuest(''); setAdding(false); load()
  }
  const remove = async (m: Member, owes: boolean) => {
    const warn = owes ? '\n\n⚠ คนนี้ยังมียอดค้างอยู่ ควรเคลียร์ก่อน' : ''
    if (!confirm(`เอา ${memberName(m)} ออกจากกลุ่ม?${warn}\n\nชื่อจะยังอยู่ในบิลเก่า แต่จะเข้ากลุ่มไม่ได้อีกจนกว่าจะได้ลิงก์เชิญใหม่`)) return
    must(await sb.rpc('remove_member', { m: m.id }))
    load()
  }
  const resetInvite = async () => {
    if (!confirm('เปลี่ยนลิงก์เชิญ? ลิงก์เก่าที่เคยส่งไปจะใช้ไม่ได้ทันที')) return
    must(await sb.rpc('reset_invite', { g: id }))
    load(); alert('เปลี่ยนลิงก์แล้ว กด "ชวนเพื่อนด้วยลิงก์" เพื่อส่งลิงก์ใหม่')
  }
  if (!group) return null
  const typeName = (GROUP_TYPES[group.type] ?? GROUP_TYPES.other)[1]

  return (
    <main>
      <header>
        <Link to={`/g/${id}`} className="icon-btn" aria-label="กลับ">←</Link>
        <h1>ตั้งค่ากลุ่ม</h1>
      </header>

      <div className="line settings-head">
        <GroupIcon group={group} />
        <span className="grow">
          <b>{group.name}</b>
          <small className="muted">{typeName}{tripDates(group) ? ` · ${tripDates(group)}` : ''}</small>
        </span>
        <Link className="icon-btn" to={`/g/${id}/edit`} aria-label="แก้ไขกลุ่ม">✏️</Link>
      </div>

      <h2>สมาชิกในกลุ่ม</h2>
      <button className="list-row" aria-expanded={adding} onClick={() => setAdding(!adding)}>
        <span className="row-icon" aria-hidden>👤＋</span>เพิ่มเพื่อนที่ไม่ใช้แอป
      </button>
      {adding && (
        <form onSubmit={addGuest} className="row">
          <input required autoFocus maxLength={40} placeholder="ชื่อเพื่อน (guest)" value={guest} onChange={(e) => setGuest(e.target.value)} />
          <button>เพิ่ม</button>
        </form>
      )}
      <button className="list-row" onClick={() => share(`เข้ากลุ่ม ${group.name} ในหารกัน`, `${location.origin}/join/${group.invite_code}`)}>
        <span className="row-icon" aria-hidden>🔗</span>ชวนเพื่อนด้วยลิงก์
      </button>
      {admin && (
        <button className="list-row" onClick={resetInvite}>
          <span className="row-icon" aria-hidden>♻️</span>เปลี่ยนลิงก์เชิญ (ลิงก์เก่าใช้ไม่ได้)
        </button>
      )}

      {active(members).map((m) => {
        const mine = [...net].map(([cur, n]) => [cur, n.get(m.id) ?? 0] as const).filter(([, v]) => v)
        const est = mine.length > 1 && fx ? convertNet(net, group.currency, fx.rates).get(m.id) ?? 0 : null
        return (
          <div key={m.id} className="line">
            <Avatar member={m} size={48} />
            <span className="grow">
              <b>{memberName(m)}{m.user_id === session.user.id ? ' (คุณ)' : ''}</b>
              {!m.user_id && <small className="muted">guest</small>}
            </span>
            <span className="right">
              {mine.length ? mine.map(([cur, v]) => (
                <span key={cur} className="right">
                  <small className={v > 0 ? 'good' : 'owe'}>{v > 0 ? 'ได้คืน' : 'ติดอยู่'}</small>
                  <b className={v > 0 ? 'good' : 'owe'}>{fmt(Math.abs(v), cur)}</b>
                </span>
              )) : <small className="muted">เคลียร์แล้ว</small>}
              {est != null && <small className="muted">รวม ≈ {fmt(est, group.currency)}</small>}
            </span>
            {admin && m.user_id !== session.user.id && (
              <button className="icon-btn" aria-label={`เอา ${memberName(m)} ออกจากกลุ่ม`} onClick={() => remove(m, mine.length > 0)}>✕</button>
            )}
          </div>
        )
      })}
    </main>
  )
}

// Pencil page: name, type, trip dates.
export function EditGroup() {
  const { id } = useParams() as { id: string }
  const nav = useNavigate()
  const [f, setF] = useState<Group>()
  const [hasDates, setHasDates] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    sb.from('groups').select('*').eq('id', id).single().then((r) => { const g = must(r); setF(g); setHasDates(!!g.start_on) })
  }, [id])
  if (!f) return null

  // Cover saves right away, like the profile photo; the old upload is removed.
  const setCover = async (file?: File) => {
    setBusy(true); setErr('')
    try {
      let cover_url = null
      if (file) {
        const path = `${id}/${Date.now()}.jpg`
        must(await sb.storage.from('covers').upload(path, await shrink(file, 1200), { contentType: 'image/jpeg' }))
        cover_url = sb.storage.from('covers').getPublicUrl(path).data.publicUrl
      }
      must(await sb.from('groups').update({ cover_url }).eq('id', id))
      if (f.cover_url) await sb.storage.from('covers').remove([f.cover_url.split('/covers/')[1]])
      setF({ ...f, cover_url })
    } catch (e) {
      setErr(`เปลี่ยนรูปปกไม่สำเร็จ: ${(e as Error).message}`)
    }
    setBusy(false)
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    const dates = f.type === 'trip' && hasDates ? { start_on: f.start_on || null, end_on: f.end_on || null } : { start_on: null, end_on: null }
    const r = await sb.from('groups').update({ name: f.name.trim(), type: f.type, currency: f.currency, ...dates }).eq('id', id)
    if (r.error) return setErr(r.error.message.includes('trip_dates') ? 'วันสิ้นสุดต้องไม่ก่อนวันเริ่ม' : r.error.message)
    nav(`/g/${id}/settings`, { replace: true })
  }

  return (
    <main>
      <form onSubmit={save} className="stack">
        <header>
          <Link to={`/g/${id}/settings`} aria-label="ยกเลิก">✕</Link>
          <h1>แก้ไขกลุ่ม</h1>
          <button>เสร็จ</button>
        </header>
        <div className="cover-edit">
          <GroupIcon group={f} size={88} />
          <label className="button ghost">
            {busy ? 'กำลังอัปโหลด…' : f.cover_url ? 'เปลี่ยนรูปปก' : 'ใส่รูปปก'}
            <input hidden type="file" accept="image/*" disabled={busy} onChange={(e) => setCover(e.target.files?.[0])} />
          </label>
          {f.cover_url && <button type="button" className="ghost" disabled={busy} onClick={() => setCover()}>ลบรูปปก</button>}
        </div>
        <label>ชื่อกลุ่ม
          <input required maxLength={60} className="big-title" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </label>
        <label>สกุลเงินหลัก (ใช้สรุปยอดรวม)
          <select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>
            {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <fieldset className="type-grid">
          <legend className="muted">ประเภท</legend>
          {Object.entries(GROUP_TYPES).map(([t, [icon, label]]) => (
            <label key={t} className={`type-card ${f.type === t ? 'on' : ''}`}>
              <input type="radio" name="type" value={t} checked={f.type === t} onChange={() => setF({ ...f, type: t })} />
              <span aria-hidden>{icon}</span>{label}
            </label>
          ))}
        </fieldset>
        {f.type === 'trip' && <>
          <label className="check split-row">ใส่วันที่ของทริป
            <input type="checkbox" role="switch" checked={hasDates} onChange={(e) => setHasDates(e.target.checked)} />
          </label>
          {hasDates && (
            <div className="row">
              <label>เริ่ม<input type="date" value={f.start_on ?? ''} onChange={(e) => setF({ ...f, start_on: e.target.value })} /></label>
              <label>สิ้นสุด<input type="date" min={f.start_on ?? undefined} value={f.end_on ?? ''} onChange={(e) => setF({ ...f, end_on: e.target.value })} /></label>
            </div>
          )}
        </>}
        {err && <p className="bad">{err}</p>}
      </form>
    </main>
  )
}
