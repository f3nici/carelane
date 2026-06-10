/*
 * CareLane service worker.
 * Deliberately minimal: this app handles sensitive health information, so the
 * worker NEVER caches API responses or any document/navigation. It only
 * pre-caches non-sensitive static branding assets so the app shell installs
 * cleanly as an Android/desktop web app. Everything else is network-only.
 */
const CACHE = 'carelane-static-v1'
const ASSETS = [
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/maskable-512.png',
  '/apple-touch-icon.png',
  '/manifest.webmanifest'
]

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)
  // Only serve cached copies of our own static branding assets; never touch
  // API calls, auth, uploads or HTML documents (which may contain PII).
  if (request.method === 'GET' && url.origin === self.location.origin && ASSETS.includes(url.pathname)) {
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request)))
  }
  // Anything else falls through to the network with no caching.
})
