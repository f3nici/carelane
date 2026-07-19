import { defineStore } from 'pinia'
import router from '../router/index.js'
import { useApi } from '../composables/useApi.js'
import { useAuthStore } from './auth.js'
import { useToastStore } from './toast.js'
import { countDrafts, queueDraft, syncDrafts, offlineSupported } from '../composables/offlineDrafts.js'
import { isOnline, onConnectivityChange, initConnectivity } from '../composables/connectivity.js'

// A minimal participant roster cached so the new-note form can still pick a
// participant with no signal. Only id + names are kept (no PII beyond what the
// note form already shows) and it is refreshed every time the app loads online.
const CLIENTS_KEY = 'carelane:clients'

/** Read the cached participant list (id + names only). */
function readClients () {
  try { return JSON.parse(localStorage.getItem(CLIENTS_KEY) || '[]') } catch { return [] }
}

/** Persist the cached participant list. */
function writeClients (clients) {
  try { localStorage.setItem(CLIENTS_KEY, JSON.stringify(clients)) } catch { /* storage may be unavailable */ }
}

/**
 * Tracks connectivity and the offline shift-note draft queue. Initialised once
 * from the app shell; it wires up the browser online/offline events and flushes
 * queued drafts automatically when the connection returns.
 */
export const useOfflineStore = defineStore('offline', {
  state: () => ({
    online: isOnline(),
    pending: 0,
    syncing: false,
    started: false,
    clients: readClients()
  }),
  getters: {
    supported: () => offlineSupported()
  },
  actions: {
    /** Begin listening for connectivity changes (idempotent). */
    async init () {
      if (this.started || !offlineSupported()) return
      // Offline note capture is a staff-only feature; it must stay completely
      // inert in the participant portal (a separate /portal URL space). Its
      // staff API calls (`/clients`) would 401 for a portal visitor and the
      // staff axios interceptor would hijack navigation to the staff login.
      if (typeof window !== 'undefined' && window.location.pathname.startsWith('/portal')) return
      this.started = true
      onConnectivityChange((online) => {
        this.online = online
        if (online) { this.flush(); this.cacheClients(); return }
        // Drop the worker onto the offline-safe screen so they don't sit on a
        // page that can only render connection errors.
        if (!router.currentRoute.value.meta.offlineReady && !router.currentRoute.value.meta.public) {
          router.replace({ name: 'offline' })
        }
      })
      await initConnectivity()
      this.online = isOnline()
      await this.refresh()
      if (this.online) { this.flush(); this.cacheClients() }
    },
    /**
     * Refresh the cached participant roster from the server (online only, best
     * effort) so the new-note form can pick a participant while offline.
     */
    async cacheClients () {
      if (!this.online) return
      try {
        const res = await useApi().get('/clients', { active: 'true', per_page: 200 })
        this.clients = res.data.map(c => ({
          id: c.id, preferred_name: c.preferred_name, first_name: c.first_name, last_name: c.last_name
        }))
        writeClients(this.clients)
      } catch { /* cache stays as-is until next online load */ }
    },
    /** Recount queued drafts. */
    async refresh () {
      this.pending = await countDrafts()
    },
    /**
     * Park a shift-note draft for later sync.
     * @param {{endpoint:string, payload:object, label?:string, shiftDate?:string}} draft
     */
    async enqueue (draft) {
      await queueDraft(draft)
      await this.refresh()
    },
    /** Flush queued drafts to the server (best-effort). */
    async flush ({ silent = true } = {}) {
      if (this.syncing || !this.pending) { await this.refresh(); if (!this.pending) return }
      // After an offline boot the session was restored from the local marker
      // and carries no CSRF token; the queued POSTs would all be rejected.
      // Re-fetch /auth/me first (a no-op when the token is already there).
      const auth = useAuthStore()
      if (!auth.csrfToken) await auth.fetchMe()
      this.syncing = true
      try {
        const { synced } = await syncDrafts(useApi())
        await this.refresh()
        if (synced && !silent) useToastStore().push(`Synced ${synced} offline note${synced === 1 ? '' : 's'}`, 'success')
        else if (synced) useToastStore().push(`${synced} offline note${synced === 1 ? '' : 's'} synced`, 'success')
      } finally {
        this.syncing = false
      }
    }
  }
})
