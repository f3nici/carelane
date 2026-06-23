import { ref } from 'vue'
import { useApi } from './useApi.js'

// Shared, module-level integration status so the tip/advice boxes for an
// optional integration only appear when it is actually switched on. Fetched
// once per session and reused across pages — integration config rarely changes
// while the app is open, and a manual save in Settings calls `refresh()`.
const aiConfigured = ref(false)
let inflight = null

/**
 * Reactive helpers describing which optional integrations are enabled, so UI
 * (estimated-token hints, "Ask Claude", Square invoicing, …) can be hidden when
 * the relevant integration is turned off.
 *
 * @returns {{aiConfigured: import('vue').Ref<boolean>, ensureLoaded: () => Promise<void>, refresh: () => Promise<void>}}
 */
export function useIntegrations () {
  const api = useApi()

  /** Fetch the latest integration status from the server. */
  async function refresh () {
    try {
      const ai = await api.get('/settings/ai/status')
      aiConfigured.value = !!ai.configured
    } catch { aiConfigured.value = false }
  }

  /** Load the status once (shared across all callers); cheap to call on mount. */
  function ensureLoaded () {
    if (!inflight) inflight = refresh()
    return inflight
  }

  return { aiConfigured, ensureLoaded, refresh }
}
