// Push notifications only — no offline caching (the app needs the network anyway).
self.addEventListener('push', (e) => {
  const d = e.data?.json() ?? {}
  e.waitUntil(self.registration.showNotification(d.title ?? 'หารกัน', { body: d.body, data: d.url, icon: '/icon-192.png' }))
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  e.waitUntil(clients.openWindow(e.notification.data ?? '/'))
})
