import { ref, computed } from 'vue'
import { useApi } from './useApi.js'
import { useAuthStore } from '../stores/auth.js'

// Shared, module-level integration status so the tip/advice boxes for an
// optional integration only appear when it is actually switched on. Fetched
// once per session and reused across pages — integration config rarely changes
// while the app is open, and saving the Claude card in Settings calls
// `refresh()` so the gating updates without a reload.
const aiConfigured = ref(false)
const aiOn = ref(false)
let inflight = null

// AI tips/UI show only when Claude is both configured (key present) AND switched
// on by the operator — turning the integration off hides it everywhere.
const aiActive = computed(() => aiConfigured.value && aiOn.value)

/**
 * Reactive helpers describing which optional integrations are active, so UI
 * (estimated-token hints, "used for the AI draft" notes, "Ask Claude", …) can be
 * hidden when the relevant integration is off.
 *
 * @returns {{aiActive: import('vue').ComputedRef<boolean>, ensureLoaded: () => Promise<void>, refresh: () => Promise<void>}}
 */
export function useIntegrations () {
  const api = useApi()

  /** Fetch the latest integration status from the server. */
  async function refresh () {
    // Only ask the server once we know there's a session — the AI-status read is
    // available to workers and admins alike, so both see AI features when Claude
    // is configured + enabled (and nothing when it isn't).
    if (!useAuthStore().isAuthenticated) { aiConfigured.value = false; aiOn.value = false; return }
    try {
      // api.get() returns the { success, data, meta } envelope — the status
      // fields live under `.data`.
      const ai = await api.get('/settings/ai/status')
      aiConfigured.value = !!ai.data?.configured
      aiOn.value = !!ai.data?.enabled
    } catch { aiConfigured.value = false; aiOn.value = false }
  }

  /** Load the status once (shared across all callers); cheap to call on mount. */
  function ensureLoaded () {
    if (!inflight) inflight = refresh()
    return inflight
  }

  return { aiActive, ensureLoaded, refresh }
}
