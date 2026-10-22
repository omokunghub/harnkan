import { memberName, type Member } from './supabase'

// Profile photo, or the first letter of the name (guests, no photo, or a broken URL).
export function Avatar({ member, url, name, size = 32 }: { member?: Member; url?: string | null; name?: string; size?: number }) {
  const src = url ?? member?.profiles?.avatar_url
  const label = name ?? memberName(member)
  return (
    <span className="avatar-img" style={{ width: size, height: size, fontSize: size * 0.45 }} aria-hidden>
      {[...label][0]?.toUpperCase()}
      {src && <img src={src} alt="" referrerPolicy="no-referrer" onError={(e) => e.currentTarget.remove()} />}
    </span>
  )
}
