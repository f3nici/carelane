import axios from 'axios'
import { useAuthStore } from '../stores/auth.js'
import { useToastStore } from '../stores/toast.js'
import router from '../router/index.js'

const client = axios.create({
  baseURL: '/api/v1',
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
    if (status === 401 && router.currentRoute.value.name !== 'login') {
      useAuthStore().clear()
      router.push({ name: 'login', query: { redirect: router.currentRoute.value.fullPath } })
    } else if (error?.message) {
      useToastStore().push(error.message, 'error')
    } else if (!err.response) {
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
    del: url => client.delete(url).then(unwrap),
    upload: (url, formData) => client.post(url, formData, { headers: { 'Content-Type': 'multipart/form-data' } }).then(unwrap)
  }
}
