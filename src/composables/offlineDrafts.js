/*
 * Offline shift-note draft queue (PWA field capture).
 *
 * Support workers often write notes with no signal. When the app is offline (or
 * a save hits a network error) the note payload is parked in IndexedDB and
 * flushed to the server automatically when connectivity returns. This is the one
 * place CareLane stores participant data client-side, so drafts are deleted the
 * instant they sync and never leave the device's same-origin IndexedDB.
 *
 * Implemented directly on the native IndexedDB API — no extra dependency — to
 * match the deliberately minimal service worker (which still caches nothing).
 */
const DB_NAME = 'carelane-offline'
const STORE = 'shiftDrafts'
const VERSION = 1

/** Open (and lazily create) the IndexedDB database. */
function openDb () {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Run a transaction against the draft store and resolve with `result`. */
async function tx (mode, fn) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const store = t.objectStore(STORE)
    let out
    Promise.resolve(fn(store)).then(v => { out = v })
    t.oncomplete = () => { db.close(); resolve(out) }
    t.onerror = () => { db.close(); reject(t.error) }
    t.onabort = () => { db.close(); reject(t.error) }
  })
}

/** True when this browser can persist offline drafts. */
export function offlineSupported () {
  return typeof indexedDB !== 'undefined'
}

/**
 * Queue a shift-note draft for later sync.
 * @param {{endpoint:string, payload:object, label?:string, shiftDate?:string}} draft
 * @returns {Promise<number>} the stored draft id
 */
export function queueDraft (draft) {
  const record = { ...draft, savedAt: new Date().toISOString() }
  return tx('readwrite', store => new Promise((resolve, reject) => {
    const req = store.add(record)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  }))
}

/** List all queued drafts (oldest first). */
export function listDrafts () {
  return tx('readonly', store => new Promise((resolve, reject) => {
    const req = store.getAll()
    req.onsuccess = () => resolve(req.result || [])
    req.onerror = () => reject(req.error)
  }))
}

/** Count queued drafts. */
export async function countDrafts () {
  if (!offlineSupported()) return 0
  try {
    return await tx('readonly', store => new Promise((resolve, reject) => {
      const req = store.count()
      req.onsuccess = () => resolve(req.result || 0)
      req.onerror = () => reject(req.error)
    }))
  } catch { return 0 }
}

/** Delete a queued draft by id. */
export function deleteDraft (id) {
  return tx('readwrite', store => new Promise((resolve, reject) => {
    const req = store.delete(id)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  }))
}

/**
 * Flush queued drafts to the server. Each draft is POSTed to its endpoint and
 * removed on success. Transient failures (still offline, auth lapsed, server
 * error) keep the queue intact and stop the run so nothing is lost; only a
 * genuine client rejection (a malformed payload that will never succeed) drops
 * the offending draft so it can't wedge the queue forever.
 * @param {{post:Function}} api the useApi() helper
 * @returns {Promise<{synced:number, remaining:number}>}
 */
export async function syncDrafts (api) {
  if (!offlineSupported()) return { synced: 0, remaining: 0 }
  const drafts = await listDrafts()
  let synced = 0
  for (const draft of drafts) {
    try {
      await api.post(draft.endpoint, draft.payload)
      await deleteDraft(draft.id)
      synced++
    } catch (err) {
      const status = err.response?.status
      // No response → still offline / unreachable: keep the queue, retry later.
      // 401/403 (session lapsed) or 5xx (server problem) are transient too —
      // stop and keep every draft so a captured note is never lost.
      if (!status || status === 401 || status === 403 || status >= 500) break
      // A real client error (e.g. 400/422 validation) will never succeed: drop
      // this one draft so it can't permanently block the rest of the queue.
      await deleteDraft(draft.id)
    }
  }
  return { synced, remaining: await countDrafts() }
}
