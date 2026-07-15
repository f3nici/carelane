import { defineStore } from 'pinia'
import axios from 'axios'

/**
 * Client-portal auth store. Entirely separate from the staff `auth` store: a
 * different session cookie namespace on the server (`portalClientId`, never a
 * staff `userId`), its own CSRF token, and its own axios calls. Keeping the two
 * apart means a portal login can never surface staff state in the SPA.
 */
export const usePortalAuthStore = defineStore('portalAuth', {
  state: () => ({
    participant: null, // { client_id, participant_label, demo }
    csrfToken: null,
    checked: false
  }),
  getters: {
    isAuthenticated: state => !!state.participant,
    isDemo: state => !!state.participant?.demo,
    label: state => state.participant?.participant_label || ''
  },
  actions: {
    async fetchMe () {
      try {
        const res = await axios.get('/api/v1/portal/auth/me', { withCredentials: true })
        this.participant = res.data.data
        this.csrfToken = res.data.data.csrf_token
      } catch {
        this.participant = null
        this.csrfToken = null
      } finally {
        this.checked = true
      }
    },
    async login (username, password) {
      const res = await axios.post('/api/v1/portal/auth/login', { username, password }, { withCredentials: true })
      this.participant = res.data.data
      this.csrfToken = res.data.data.csrf_token
      this.checked = true
    },
    async logout () {
      try {
        await axios.post('/api/v1/portal/auth/logout', {}, { withCredentials: true, headers: { 'x-csrf-token': this.csrfToken } })
      } finally {
        this.participant = null
        this.csrfToken = null
      }
    }
  }
})
