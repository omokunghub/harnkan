import { memberName, type Member } from './supabase'

export type Entry = { id: number; actor: string | null; action: string; detail: Record<string, any>; created_at: string }
export const ACTIVITY_COLS = 'id, actor, action, detail, created_at'

const FIELDS: Record<string, string> = {
  title: 'ชื่อ', grand_total: 'ยอดสุทธิ', service_charge: 'SC', vat: 'VAT', discount: 'ส่วนลด',
  vat_included: 'รวม VAT', currency: 'สกุลเงิน', paid_by: 'คนจ่าย', line_total: 'ราคา', qty: 'จำนวน', name: 'ชื่อ', spent_on: 'วันที่',
}
const n = (x: unknown) => Number(x).toLocaleString('th-TH')

function describe(e: Entry, name: (memberId: string) => string, actorMember?: Member) {
  const d = e.detail
  const who = (m: string) => (m === actorMember?.id ? '' : ` ให้ ${name(m)}`)
  const changes = () =>
    Object.entries(d.changes ?? {})
      .filter(([k]) => FIELDS[k])
      .map(([k, [a, b]]: [string, any]) => (k === 'paid_by' ? `คนจ่าย ${name(a)} → ${name(b)}` : `${FIELDS[k]} ${a} → ${b}`))
      .join(', ')
  switch (e.action) {
    case 'bill_create': return `สร้างบิล "${d.title}" ${n(d.total)} ${d.currency}`
    case 'bill_update': return `แก้บิล "${d.title}": ${changes()}`
    case 'bill_delete': return `ลบบิล "${d.title}"`
    case 'item_add': return `เพิ่มรายการ "${d.name}" ${n(d.price)}`
    case 'item_update': return `แก้รายการ "${d.name}": ${changes()}`
    case 'item_remove': return `ลบรายการ "${d.name}"`
    case 'share_add': return `ติ๊ก "${d.item}"${who(d.member)}${d.weight > 1 ? ` ×${d.weight}` : ''}`
    case 'share_remove': return d.member === actorMember?.id ? `เอาตัวเองออกจาก "${d.item}"` : `เอา ${name(d.member)} ออกจาก "${d.item}"`
    case 'share_update': return `เปลี่ยนส่วนของ ${name(d.member)} ใน "${d.item}" เป็น ×${d.weight}`
    case 'settle_add': return `บันทึกว่า ${name(d.from)} โอนให้ ${name(d.to)} ${n(d.amount)} ${d.currency}`
    case 'settle_remove': return `ลบการโอน ${name(d.from)} → ${name(d.to)} ${n(d.amount)} ${d.currency}`
    case 'member_remove': return `เอา ${name(d.member)} ออกจากกลุ่ม`
    case 'invite_reset': return 'เปลี่ยนลิงก์เชิญ'
    default: return e.action
  }
}

export function ActivityLog({ entries, members, title = 'ประวัติการแก้ไข' }: { entries: Entry[]; members: Member[]; title?: string }) {
  if (!entries.length) return null
  const name = (id: string) => memberName(members.find((m) => m.id === id))
  return (
    <details className="activity">
      <summary>{title} ({entries.length})</summary>
      <ul>
        {entries.map((e) => {
          const actor = members.find((m) => m.user_id === e.actor)
          return (
            <li key={e.id}>
              <small className="muted">{new Date(e.created_at).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' })}</small>{' '}
              <b>{actor ? memberName(actor) : 'อดีตสมาชิก'}</b> {describe(e, name, actor)}
            </li>
          )
        })}
      </ul>
    </details>
  )
}
