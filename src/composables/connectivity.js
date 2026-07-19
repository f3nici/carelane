import { isNativeApp } from './serverBase.js'

/*
 * Connectivity tracking that works in the native app. Android WebView's
 * navigator.onLine is unreliable (it can stay true in airplane mode), so the
 * native app asks the Capacitor Network plugin instead. The web app keeps
 * using the browser online/offline events.
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
  const Network = isNativeApp() && window.Capacitor?.Plugins?.Network
  if (Network) {
    Network.addListener('networkStatusChange', s => set(!!s.connected))
    try { set((await Network.getStatus()).connected) } catch { /* keep default */ }
  } else if (typeof window !== 'undefined') {
    window.addEventListener('online', () => set(true))
    window.addEventListener('offline', () => set(false))
  }
}
