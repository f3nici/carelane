/*
 * CareLane service worker.
 *
 * This app handles sensitive health information, so the worker NEVER caches API
 * responses, uploads, or anything that can contain PII — those are always
 * network-only. What it DOES cache is the non-sensitive application shell (the
 * built HTML/JS/CSS and static branding assets) so the app installs cleanly as
 * an Android/desktop web app AND still boots when the worker is offline in the
 * field. Once the shell is running offline, shift notes are captured into
 * IndexedDB and synced on reconnect (see composables/offlineDrafts.js).
 */
const CACHE = 'carelane-shell-v2'

// Non-sensitive static assets worth pre-caching on install. The hashed Vite
// build assets (/assets/*.js, *.css) and the app shell are cached at runtime as
// they are first requested online.
const PRECACHE = [
  '/',
  '/favicon.svg',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/maskable-512.png',
  '/apple-touch-icon.png',
  '/manifest.webmanifest'
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // Best-effort: a single missing asset must not abort the whole install.
      .then((c) => Promise.allSettled(PRECACHE.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

/** True for requests that may carry PII and must never be cached. */
function isSensitive (url) {
  return url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/uploads/') ||
    url.pathname === '/healthz'
}

/** Cache-first with a background refresh for non-sensitive static shell assets. */
function staleWhileRevalidate (request) {
  return caches.open(CACHE).then((cache) =>
    cache.match(request).then((hit) => {
      const network = fetch(request)
        .then((res) => {
          if (res && res.ok) cache.put(request, res.clone())
          return res
        })
        .catch(() => hit)
      return hit || network
    })
  )
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  // Only ever handle our own origin; never cache API/uploads/health.
  if (url.origin !== self.location.origin || isSensitive(url)) return

  // SPA navigations: try the network, but fall back to the cached app shell so
  // the app boots offline (vue-router then renders the route client-side).
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/').then((hit) => hit || caches.match(request)))
    )
    return
  }

  // Static build assets + branding: serve from cache, refresh in the background.
  event.respondWith(staleWhileRevalidate(request))
})
