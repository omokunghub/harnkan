import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { RotateCcw, RotateCw, ZoomIn, ZoomOut } from 'lucide-react'

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

// Long receipts: photos stacked top-to-bottom at one width, all scaled down together if the stack gets too tall.
export function stackLayout(sizes: [number, number][], width = 1200, maxHeight = 6000) {
  const heights = sizes.map(([w, h]) => (h * width) / w)
  const k = Math.min(1, maxHeight / heights.reduce((a, b) => a + b, 0))
  return { width: Math.round(width * k), heights: heights.map((h) => Math.round(h * k)) }
}

// Shows just the boxed part of the photo, turned `angle`° around its centre first (for tilted receipts).
// The box is measured on that turned photo, so editor and view rotate the same way.
export function CropView({ src, box, angle = 0 }: { src: string; box: Box; angle?: number }) {
  const [ratio, setRatio] = useState<number>() // photo width / height
  const [y0, x0, y1, x1] = box.map((v) => v / 1000)
  const w = x1 - x0, h = y1 - y0
  return (
    <div className="crop-view" style={{ aspectRatio: ratio ? `${w * ratio} / ${h}` : '6 / 1' }}>
      <img src={src} alt="" onLoad={(e) => setRatio(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight)}
        style={{ width: `${100 / w}%`, left: `${(-x0 / w) * 100}%`, top: `${(-y0 / h) * 100}%`, transform: `rotate(${angle}deg)` }} />
    </div>
  )
}

// Full photo; drag a rectangle to set the line's box.
export function CropEditor({ src, box, angle: angle0 = 0, onSave, onClose }: {
  src: string; box: Box | null; angle?: number; onSave: (b: Box | null, angle: number) => void; onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<Box | null>(box)
  const [angle, setAngle] = useState(angle0)
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
      <div className="stack">
        <p>1) หมุนให้บรรทัดตรง 2) ลากนิ้วเป็นกรอบรอบชื่อและราคา</p>
        <label className="angle-row">เอียง {angle > 0 ? '+' : ''}{angle}°
          <input type="range" min={-30} max={30} step={0.5} value={angle} onChange={(e) => setAngle(Number(e.target.value))} />
          <button type="button" className="ghost" onClick={() => setAngle(0)} aria-label="รีเซ็ตมุม"><RotateCcw size={18} /></button>
        </label>
      </div>
      <div ref={ref} className="crop-stage"
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setStart(at(e)); setDraft(null) }}
        onPointerMove={move} onPointerUp={(e) => { move(e); setStart(undefined) }}>
        <img src={src} alt="ใบเสร็จ" draggable={false} style={{ transform: `rotate(${angle}deg)` }} />
        <div className="crop-grid" aria-hidden />
        {draft && <div className="crop-rect" style={{
          top: `${draft[0] / 10}%`, left: `${draft[1] / 10}%`, height: `${(draft[2] - draft[0]) / 10}%`, width: `${(draft[3] - draft[1]) / 10}%`,
        }} />}
      </div>
      <div className="row">
        <button type="button" className="ghost" onClick={onClose}>ยกเลิก</button>
        {box && <button type="button" className="ghost" onClick={() => onSave(null, 0)}>ลบกรอบ</button>}
        <button type="button" disabled={!draft} onClick={() => onSave(draft, angle)}>บันทึก</button>
      </div>
    </div>
  )
}

// Profile photo: drag + zoom + quarter turns under a round mask, output a square JPEG (shown as a circle everywhere).
// ponytail: zoom is a slider only; add pinch if people miss it
export function AvatarCropper({ file, onDone, onClose }: { file: File; onDone: (b: Blob) => void; onClose: () => void }) {
  const D = Math.min(320, innerWidth - 48) // stage size, CSS px
  const OUT = 256
  const img = useRef<HTMLImageElement>(null)
  const drag = useRef<{ px: number; py: number; x: number; y: number }>(undefined)
  const [src, setSrc] = useState<string>()
  const [size, setSize] = useState<[number, number]>()
  const [zoom, setZoom] = useState(1)
  const [rot, setRot] = useState(0)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  useEffect(() => {
    const u = URL.createObjectURL(file)
    setSrc(u)
    return () => URL.revokeObjectURL(u)
  }, [file])

  const [w, h] = size ?? [1, 1]
  const s = (D / Math.min(w, h)) * zoom
  const [rw, rh] = rot % 180 ? [h, w] : [w, h]
  const limit = (v: number, full: number) => { const m = Math.max(0, (full * s - D) / 2); return Math.max(-m, Math.min(m, v)) }
  const x = limit(pos.x, rw), y = limit(pos.y, rh) // re-clamped every render, so zooming out can't expose a gap

  const reset = () => { setZoom(1); setRot(0); setPos({ x: 0, y: 0 }) }
  const apply = () => {
    const c = document.createElement('canvas')
    c.width = c.height = OUT
    const g = c.getContext('2d')!
    g.fillStyle = '#fff'; g.fillRect(0, 0, OUT, OUT) // transparent PNGs would turn black as JPEG
    g.translate(OUT / 2, OUT / 2)
    g.scale(OUT / D, OUT / D)
    g.translate(x, y)
    g.rotate((rot * Math.PI) / 180)
    g.scale(s, s)
    g.drawImage(img.current!, -w / 2, -h / 2)
    c.toBlob((b) => b && onDone(b), 'image/jpeg', 0.9)
  }
  return (
    <div className="crop-modal" role="dialog" aria-modal aria-label="ปรับรูปโปรไฟล์">
      <p>ลากรูปให้อยู่ในวงกลม</p>
      <div className="avatar-stage" style={{ width: D, height: D }}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { px: e.clientX, py: e.clientY, x, y } }}
        onPointerMove={(e) => { const d = drag.current; if (d) setPos({ x: d.x + e.clientX - d.px, y: d.y + e.clientY - d.py }) }}
        onPointerUp={() => { drag.current = undefined }} onPointerCancel={() => { drag.current = undefined }}>
        {src && <img ref={img} src={src} alt="รูปที่เลือก" draggable={false} onLoad={(e) => setSize([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])}
          style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px) rotate(${rot}deg) scale(${s})`, visibility: size ? 'visible' : 'hidden' }} />}
        <div className="avatar-ring" aria-hidden />
      </div>
      <div className="stack">
        <label className="angle-row">
          <ZoomOut size={20} aria-hidden />
          <input type="range" aria-label="ซูม" min={1} max={4} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
          <ZoomIn size={20} aria-hidden />
          <button type="button" className="ghost" aria-label="หมุนรูป 90 องศา" onClick={() => setRot((rot + 90) % 360)}><RotateCw size={18} /></button>
        </label>
        <div className="row">
          <button type="button" className="ghost" onClick={reset}>รีเซ็ต</button>
          <button type="button" className="ghost" onClick={onClose}>ยกเลิก</button>
          <button type="button" disabled={!size} onClick={apply}>ใช้รูปนี้</button>
        </div>
      </div>
    </div>
  )
}
