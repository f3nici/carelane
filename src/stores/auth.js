import { defineStore } from 'pinia'
import axios from 'axios'
import { startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null,
    csrfToken: null,
    checked: false
  }),
  getters: {
    isAuthenticated: state => !!state.user,
    isAdmin: state => state.user?.role === 'admin'
  },
  actions: {
    async fetchMe () {
      try {
        const res = await axios.get('/api/v1/auth/me', { withCredentials: true })
        this.user = res.data.data
        this.csrfToken = res.data.data.csrf_token
      } catch {
        this.user = null
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
    }
  }
})
