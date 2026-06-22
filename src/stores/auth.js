import { defineStore } from 'pinia'
import axios from 'axios'
import { startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser'

// Remembers that a session was established so the PWA can keep working offline
// (where /auth/me is unreachable). Only the worker's own display name/role is
// kept — no participant data — and it is cleared the moment we know we are
// logged out (logout or a 401 from the server).
const SESSION_KEY = 'carelane:session'

/** Persist a minimal marker that this device has an authenticated session. */
function rememberSession (user) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ display_name: user.display_name, role: user.role }))
  } catch { /* storage may be unavailable (private mode) */ }
}

/** Forget the persisted session marker. */
function forgetSession () {
  try { localStorage.removeItem(SESSION_KEY) } catch { /* ignore */ }
}

/** Read the persisted session marker, if any. */
function readSession () {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') } catch { return null }
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null,
    csrfToken: null,
    checked: false,
    // True when `user` was restored from the offline marker rather than verified
    // by the server — the UI runs in read-limited offline mode.
    offlineSession: false
  }),
  getters: {
    isAuthenticated: state => !!state.user,
    isAdmin: state => state.user?.role === 'admin',
    // True when the require-2FA policy is on and this account has not yet set up
    // a second factor — the UI funnels them to Settings to enrol.
    mustEnrol2fa: state => !!state.user?.must_enrol_2fa
  },
  actions: {
    async fetchMe () {
      try {
        const res = await axios.get('/api/v1/auth/me', { withCredentials: true })
        this.user = res.data.data
        this.csrfToken = res.data.data.csrf_token
        this.offlineSession = false
        rememberSession(this.user)
      } catch (err) {
        // Offline (no response) with a known prior session: keep the worker
        // signed in so they can still capture notes. A real 401 means logged
        // out — drop the marker and clear.
        const session = readSession()
        if (!err.response && typeof navigator !== 'undefined' && !navigator.onLine && session) {
          this.user = session
          this.offlineSession = true
        } else {
          this.user = null
          this.offlineSession = false
          if (err.response) forgetSession()
        }
      } finally {
        this.checked = true
      }
    },
    /**
     * Attempt login. Returns `{ totpRequired: true }` when the password was
     * correct but a 2FA code is still needed (no session is created yet).
     * @param {string} username
     * @param {string} password
     * @param {string} [token] TOTP or recovery code
     * @returns {Promise<{ totpRequired: boolean }>}
     */
    async login (username, password, token) {
      const res = await axios.post('/api/v1/auth/login', { username, password, token }, { withCredentials: true })
      if (res.data.data?.totp_required) return { totpRequired: true }
      this.user = res.data.data
      this.csrfToken = res.data.data.csrf_token
      this.checked = true
      this.offlineSession = false
      rememberSession(this.user)
      return { totpRequired: false }
    },
    /**
     * Passwordless login via a registered passkey (WebAuthn). Runs the full
     * options → authenticator → verify ceremony and establishes the session.
     * @returns {Promise<void>}
     */
    async loginWithPasskey () {
      const optRes = await axios.post('/api/v1/auth/passkeys/login/options', {}, { withCredentials: true })
      const assertion = await startAuthentication({ optionsJSON: optRes.data.data })
      const res = await axios.post('/api/v1/auth/passkeys/login/verify', { response: assertion }, { withCredentials: true })
      this.user = res.data.data
      this.csrfToken = res.data.data.csrf_token
      this.checked = true
      this.offlineSession = false
      rememberSession(this.user)
    },
    /** Whether this browser can do WebAuthn (gates the passkey UI). */
    supportsPasskeys () {
      return browserSupportsWebAuthn()
    },
    async logout () {
      try {
        await axios.post('/api/v1/auth/logout', {}, { withCredentials: true, headers: { 'x-csrf-token': this.csrfToken } })
      } finally {
        this.clear()
      }
    },
    clear () {
      this.user = null
      this.csrfToken = null
      this.offlineSession = false
      forgetSession()
    }
  }
})
