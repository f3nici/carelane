import { defineStore } from 'pinia'
import axios from 'axios'

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
    async login (username, password) {
      const res = await axios.post('/api/v1/auth/login', { username, password }, { withCredentials: true })
      this.user = res.data.data
      this.csrfToken = res.data.data.csrf_token
      this.checked = true
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
