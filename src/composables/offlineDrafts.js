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
 * removed on success. Stops on the first network failure (still offline) so the
 * remaining drafts are retried next time; a non-network error (e.g. validation)
 * drops that one draft so it can't wedge the queue forever.
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
      // No response → still offline / unreachable: keep the queue and retry later.
      if (!err.response) break
      // The server rejected it (validation/auth): drop it so it can't block sync.
      await deleteDraft(draft.id)
    }
  }
  return { synced, remaining: await countDrafts() }
}
