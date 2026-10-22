import { createClient, type Session } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'

export const sb = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY)

export type Member = { id: string; user_id: string | null; guest_name: string | null; profiles: { display_name: string; promptpay: string | null; avatar_url: string | null } | null }
export const MEMBER_COLS = 'id, user_id, guest_name, profiles(display_name, promptpay, avatar_url)'
export const memberName = (m?: Member) => (m ? (m.guest_name ?? m.profiles?.display_name ?? '?') : '?')

export const BILL_COLS = '*, bill_items(*, item_shares(*))'

// undefined = still loading, null = signed out
export function useSession() {
  const [session, setSession] = useState<Session | null>()
  useEffect(() => {
    sb.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = sb.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])
  return session
}

// Private bucket → short-lived URL for <img>/<a>.
export function useSignedUrl(path?: string | null) {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    if (path) sb.storage.from('receipts').createSignedUrl(path, 3600).then((r) => setUrl(r.data?.signedUrl))
  }, [path])
  return url
}

// LINE etc. via the OS share sheet; desktop falls back to clipboard.
export async function share(title: string, url: string) {
  if (navigator.share) await navigator.share({ title, url }).catch(() => {})
  else await navigator.clipboard.writeText(url).then(() => alert('คัดลอกลิงก์แล้ว'))
}

// Shrink to ~1600px JPEG: smaller upload, fewer Gemini tokens, ~250KB in storage.
export async function shrink(file: File, max = 1600): Promise<Blob> {
  const img = await createImageBitmap(file)
  const s = Math.min(1, max / Math.max(img.width, img.height))
  const c = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * s), height: Math.round(img.height * s) })
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
  return new Promise((res) => c.toBlob((b) => res(b!), 'image/jpeg', 0.8))
}

// Throw on Supabase errors so callers can't silently ignore them.
export function must<T>(r: { data: T; error: { message: string } | null }) {
  if (r.error) throw new Error(r.error.message)
  return r.data as NonNullable<T>
}
