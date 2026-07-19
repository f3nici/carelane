import axios from 'axios'
import { useAuthStore } from '../stores/auth.js'
import { useToastStore } from '../stores/toast.js'
import router from '../router/index.js'
import { serverBase } from './serverBase.js'
import { isOnline } from './connectivity.js'

const client = axios.create({
  // serverBase() is '' on the web; in the native app it is the configured
  // server origin.
  baseURL: serverBase() + '/api/v1',
  withCredentials: true
})

client.interceptors.request.use(config => {
  const auth = useAuthStore()
  if (auth.csrfToken && !['get', 'head', 'options'].includes(config.method)) {
    config.headers['x-csrf-token'] = auth.csrfToken
  }
  return config
})

client.interceptors.response.use(
  res => res,
  err => {
    const status = err.response?.status
    const error = err.response?.data?.error
    const offline = !isOnline()
    // Never hijack navigation into the staff login while the user is in the
    // participant portal — the portal is a separate auth surface with its own
    // 401 handling (see usePortalApi). Keyed off the URL so it is reliable even
    // before the router has resolved its first navigation.
    const inPortal = typeof window !== 'undefined' && window.location.pathname.startsWith('/portal')
    if (status === 401 && !inPortal && router.currentRoute.value.name !== 'login') {
      useAuthStore().clear()
      router.push({ name: 'login', query: { redirect: router.currentRoute.value.fullPath } })
    } else if (error?.message) {
      useToastStore().push(error.message, 'error')
    } else if (!err.response && !offline) {
      // Genuinely offline failures are expected and surfaced by the offline
      // indicator — only flag a network error when we believe we're online.
      useToastStore().push('Network error — is the server running?', 'error')
    }
    return Promise.reject(err)
  }
)

/**
 * Centralized API access. All responses use the `{ success, data, meta }`
 * envelope; these helpers unwrap it.
 */
export function useApi () {
  const unwrap = res => res.data
  return {
    raw: client,
    get: (url, params) => client.get(url, { params }).then(unwrap),
    post: (url, body, config) => client.post(url, body, config).then(unwrap),
    put: (url, body) => client.put(url, body).then(unwrap),
    del: (url, body) => client.delete(url, body ? { data: body } : undefined).then(unwrap),
    upload: (url, formData) => client.post(url, formData, { headers: { 'Content-Type': 'multipart/form-data' } }).then(unwrap)
  }
}
