import axios from 'axios'
import { isNativeApp, apiUrl, serverBase } from './serverBase.js'
import { useToastStore } from '../stores/toast.js'

/**
 * Open an auth-gated server file (PDF export, document download, zip).
 *
 * On the web this is a plain new-tab navigation and the session cookie rides
 * along. In the native app a new tab would open in an external browser with no
 * session, so the file is fetched with credentials instead, written to the app
 * cache and handed to the Android share sheet (open / save / send).
 * @param {string} path root-relative server path, e.g. '/api/v1/reports/1/pdf'
 * @param {string} [suggestedName] filename fallback when the server sends no
 *   Content-Disposition
 */
export async function openServerFile (path, suggestedName) {
  if (!isNativeApp()) {
    window.open(apiUrl(path), '_blank')
    return
  }
  try {
    const res = await axios.get(path, { baseURL: serverBase(), responseType: 'blob', withCredentials: true })
    const name = filenameFrom(res.headers['content-disposition']) || suggestedName || path.split('/').pop() || 'download'
    const data = await blobToBase64(res.data)
    const { Filesystem, Share } = window.Capacitor.Plugins
    const file = await Filesystem.writeFile({ path: name, data, directory: 'CACHE' })
    await Share.share({ title: name, url: file.uri })
  } catch (err) {
    // The user dismissing the share sheet is not an error.
    if (err?.message?.includes('canceled') || err?.message?.includes('cancelled')) return
    useToastStore().push('Could not download the file, please try again.', 'error')
  }
}

/** Pull a filename out of a Content-Disposition header, if present. */
function filenameFrom (disposition) {
  const m = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition || '')
  return m ? decodeURIComponent(m[1].trim()) : null
}

/** Base64-encode a Blob (the Filesystem plugin writes base64 strings). */
function blobToBase64 (blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}
