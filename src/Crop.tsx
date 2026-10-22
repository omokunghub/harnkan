import { useRef, useState, type PointerEvent } from 'react'

// A crop box is [ymin, xmin, ymax, xmax] on a 0–1000 scale of the receipt photo (Gemini's box_2d format).
// We store only these 4 numbers per line and cut the one full photo in CSS — no extra images.
export type Box = [number, number, number, number]

// Tidy a box from the AI or a drag: order, clamp, pad a little so text isn't clipped. null if unusable.
export function cleanBox(b: unknown, pad = 8): Box | null {
  if (!Array.isArray(b) || b.length !== 4 || !b.every((v) => Number.isFinite(v))) return null
  const c = (v: number) => Math.max(0, Math.min(1000, Math.round(v)))
  const [y0, y1] = [Math.min(b[0], b[2]), Math.max(b[0], b[2])]
  const [x0, x1] = [Math.min(b[1], b[3]), Math.max(b[1], b[3])]
  const box: Box = [c(y0 - pad), c(x0 - pad), c(y1 + pad), c(x1 + pad)]
  return box[2] - box[0] >= 5 && box[3] - box[1] >= 5 ? box : null
}

// Shows just the boxed part of the photo.
export function CropView({ src, box }: { src: string; box: Box }) {
  const [ratio, setRatio] = useState<number>() // photo width / height
  const [y0, x0, y1, x1] = box.map((v) => v / 1000)
  const w = x1 - x0, h = y1 - y0
  return (
    <div className="crop-view" style={{ aspectRatio: ratio ? `${w * ratio} / ${h}` : '6 / 1' }}>
      <img src={src} alt="" onLoad={(e) => setRatio(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight)}
        style={{ width: `${100 / w}%`, left: `${(-x0 / w) * 100}%`, top: `${(-y0 / h) * 100}%` }} />
    </div>
  )
}

// Full photo; drag a rectangle to set the line's box.
export function CropEditor({ src, box, onSave, onClose }: {
  src: string; box: Box | null; onSave: (b: Box | null) => void; onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<Box | null>(box)
  const [start, setStart] = useState<[number, number]>()
  const at = (e: PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    return [((e.clientY - r.top) / r.height) * 1000, ((e.clientX - r.left) / r.width) * 1000] as [number, number]
  }
  const move = (e: PointerEvent) => {
    if (!start) return
    const [y, x] = at(e)
    setDraft(cleanBox([start[0], start[1], y, x], 0))
  }
  return (
    <div className="crop-modal" role="dialog" aria-modal aria-label="ลากกรอบรอบบรรทัดนี้">
      <p>ลากนิ้วเป็นกรอบรอบบรรทัดของรายการนี้</p>
      <div ref={ref} className="crop-stage"
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setStart(at(e)); setDraft(null) }}
        onPointerMove={move} onPointerUp={(e) => { move(e); setStart(undefined) }}>
        <img src={src} alt="ใบเสร็จ" draggable={false} />
        {draft && <div className="crop-rect" style={{
          top: `${draft[0] / 10}%`, left: `${draft[1] / 10}%`, height: `${(draft[2] - draft[0]) / 10}%`, width: `${(draft[3] - draft[1]) / 10}%`,
        }} />}
      </div>
      <div className="row">
        <button type="button" className="ghost" onClick={onClose}>ยกเลิก</button>
        {box && <button type="button" className="ghost" onClick={() => onSave(null)}>ลบกรอบ</button>}
        <button type="button" disabled={!draft} onClick={() => onSave(draft)}>บันทึก</button>
      </div>
    </div>
  )
}
