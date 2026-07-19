import axios from 'axios'
import { usePortalAuthStore } from '../stores/portalAuth.js'
import { useToastStore } from '../stores/toast.js'
import router from '../router/index.js'
import { serverBase } from './serverBase.js'

/**
 * API access for the client portal. A dedicated axios instance (separate from
 * the staff `useApi`) so the portal carries its OWN CSRF token and, on a 401,
 * funnels to the portal login rather than the staff one.
 */
const client = axios.create({
  baseURL: serverBase() + '/api/v1/portal',
  withCredentials: true
})

client.interceptors.request.use(config => {
  const portal = usePortalAuthStore()
  if (portal.csrfToken && !['get', 'head', 'options'].includes(config.method)) {
    config.headers['x-csrf-token'] = portal.csrfToken
  }
  return config
})

client.interceptors.response.use(
  res => res,
  err => {
    const status = err.response?.status
    const error = err.response?.data?.error
    if (status === 401 && router.currentRoute.value.name !== 'portal-login') {
      usePortalAuthStore().$reset()
      router.push({ name: 'portal-login', query: { redirect: router.currentRoute.value.fullPath } })
    } else if (error?.message) {
      useToastStore().push(error.message, 'error')
    } else if (!err.response) {
      useToastStore().push('Network error — please try again.', 'error')
    }
    return Promise.reject(err)
  }
)

/**
 * Portal API helpers. Responses use the same `{ success, data, meta }` envelope
 * as the staff API; these unwrap it.
 */
export function usePortalApi () {
  const unwrap = res => res.data
  return {
    raw: client,
    get: (url, params) => client.get(url, { params }).then(unwrap),
    post: (url, body) => client.post(url, body).then(unwrap)
  }
}
