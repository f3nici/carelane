/*
 * Shared connectivity tracking, backed by the browser's online/offline
 * events. Centralised here so the offline store, router guard and API
 * interceptor all read the same value instead of checking navigator.onLine
 * separately in three places.
 */

let online = typeof navigator === 'undefined' ? true : navigator.onLine
const listeners = new Set()

/** Current connectivity (best known; see initConnectivity). */
export function isOnline () {
  return online
}

/**
 * Subscribe to connectivity changes.
 * @param {(online: boolean) => void} fn
 */
export function onConnectivityChange (fn) {
  listeners.add(fn)
}

function set (value) {
  if (value === online) return
  online = value
  listeners.forEach(fn => fn(value))
}

/** Start watching connectivity (idempotent via the offline store's init). */
export async function initConnectivity () {
  if (typeof window === 'undefined') return
  window.addEventListener('online', () => set(true))
  window.addEventListener('offline', () => set(false))
}
