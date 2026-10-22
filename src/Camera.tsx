import { useEffect, useRef, useState } from 'react'

export const canUseCamera = () => !!navigator.mediaDevices?.getUserMedia

// In-page camera. The OS camera app (<input capture>) makes Android kill the PWA behind it on low memory,
// so the photo is lost on return; staying inside the page avoids that.
export function Camera({ onShot, onClose }: { onShot: (f: File) => void; onClose: (err?: string) => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const [ready, setReady] = useState(false)
  const close = useRef(onClose) // latest callback without restarting the camera on every parent render
  close.current = onClose

  useEffect(() => {
    let stream: MediaStream | undefined, cancelled = false
    navigator.mediaDevices
      .getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } } })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop())
        stream = s
        video.current!.srcObject = s
        return video.current!.play().then(() => setReady(true))
      })
      .catch((e: Error) => close.current(e.name === 'NotAllowedError' ? 'ไม่ได้อนุญาตให้ใช้กล้อง' : `เปิดกล้องไม่ได้ (${e.name})`))
    return () => { cancelled = true; stream?.getTracks().forEach((t) => t.stop()) }
  }, [])

  const shoot = () => {
    const v = video.current!
    const c = Object.assign(document.createElement('canvas'), { width: v.videoWidth, height: v.videoHeight })
    c.getContext('2d')!.drawImage(v, 0, 0)
    c.toBlob((b) => b && onShot(new File([b], 'receipt.jpg', { type: 'image/jpeg' })), 'image/jpeg', 0.92)
  }

  return (
    <div className="camera" role="dialog" aria-modal aria-label="ถ่ายรูปใบเสร็จ">
      <video ref={video} playsInline muted />
      {!ready && <p className="camera-hint">กำลังเปิดกล้อง…</p>}
      <div className="camera-bar">
        <button type="button" className="ghost" onClick={() => onClose()}>ยกเลิก</button>
        <button type="button" className="shutter" disabled={!ready} onClick={shoot} aria-label="ถ่ายรูป" />
        <span style={{ width: 80 }} />
      </div>
    </div>
  )
}
