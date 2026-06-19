import { defineStore } from 'pinia'
import { useApi } from '../composables/useApi.js'
import { useToastStore } from './toast.js'
import { countDrafts, queueDraft, syncDrafts, offlineSupported } from '../composables/offlineDrafts.js'

/**
 * Tracks connectivity and the offline shift-note draft queue. Initialised once
 * from the app shell; it wires up the browser online/offline events and flushes
 * queued drafts automatically when the connection returns.
 */
export const useOfflineStore = defineStore('offline', {
  state: () => ({
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    pending: 0,
    syncing: false,
    started: false
  }),
  getters: {
    supported: () => offlineSupported()
  },
  actions: {
    /** Begin listening for connectivity changes (idempotent). */
    async init () {
      if (this.started || !offlineSupported()) return
      this.started = true
      window.addEventListener('online', () => { this.online = true; this.flush() })
      window.addEventListener('offline', () => { this.online = false })
      await this.refresh()
      if (this.online) this.flush()
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
