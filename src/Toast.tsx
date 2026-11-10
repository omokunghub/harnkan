import { useEffect, useState } from 'react'

// A short message that floats near the bottom and fades away. Call toast('...') from anywhere, even right before navigating.
export const toast = (text: string) => dispatchEvent(new CustomEvent('toast', { detail: text }))

export function Toaster() {
  const [text, setText] = useState('')
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>
    const on = (e: Event) => {
      setText((e as CustomEvent<string>).detail)
      clearTimeout(t)
      t = setTimeout(() => setText(''), 2500)
    }
    addEventListener('toast', on)
    return () => { removeEventListener('toast', on); clearTimeout(t) }
  }, [])
  return <div className={`toast ${text ? 'show' : ''}`} role="status" aria-live="polite">{text}</div>
}
