import { ref } from 'vue'

/*
 * Native-app server selection. The Android app (a Capacitor shell built from
 * this frontend, see the carelane-android repo) bundles the UI locally and
 * talks to a self-hosted CareLane server over HTTPS, so every API call and
 * file URL must be prefixed with the configured server origin. On the web the
 * app is served BY that server, so the base is always '' (same-origin) and
 * none of this applies.
 */

const KEY = 'carelane:server'

/** True when running inside the Capacitor native shell. */
export function isNativeApp () {
  return !!window.Capacitor?.isNativePlatform?.()
}

/** The configured server origin, '' on the web or when not yet set. */
export function serverBase () {
  if (!isNativeApp()) return ''
  try { return localStorage.getItem(KEY) || '' } catch { return '' }
}

/**
 * Persist the chosen server origin. Expects a normalised origin
 * (scheme + host, no trailing slash), see ServerSetupPage.
 * @param {string} origin
 */
export function setServerBase (origin) {
  try { localStorage.setItem(KEY, origin) } catch { /* storage unavailable */ }
}

/**
 * Prefix a root-relative server path (img src, download href) with the
 * configured server origin. A no-op on the web.
 * @param {string} path e.g. '/api/v1/settings/logo'
 */
export function apiUrl (path) {
  return serverBase() + path
}

/**
 * Reactive request to show the server-setup screen (used by the login page's
 * "change server" link; App.vue also shows it when no server is set yet).
 */
export const serverSetupOpen = ref(false)
