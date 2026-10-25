import { Link } from 'react-router'
import { ArrowLeft, Check } from 'lucide-react'

// Splitwise-style form top bar: ← leaves (asks first if something was changed), ✓ saves the form `formId`.
export function FormHeader({ title, back, formId, dirty, disabled }: {
  title: string; back: string; formId: string; dirty: boolean; disabled?: boolean
}) {
  return (
    <header className="form-header">
      <Link to={back} className="icon-btn" aria-label="กลับ"
        onClick={(e) => { if (dirty && !confirm('ยังไม่ได้บันทึก ทิ้งสิ่งที่แก้ไว้?')) e.preventDefault() }}><ArrowLeft size={24} /></Link>
      <h1>{title}</h1>
      <button form={formId} className="icon-btn save-btn" disabled={disabled} aria-label="บันทึก"><Check size={26} strokeWidth={2.5} /></button>
    </header>
  )
}
