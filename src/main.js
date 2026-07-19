import { createApp } from 'vue'
import { createPinia } from 'pinia'
import axios from 'axios'
import App from './App.vue'
import router from './router/index.js'
import './assets/main.css'
import { isNativeApp, serverBase } from './composables/serverBase.js'

// Native app: point every raw axios call at the configured server. The
// dedicated instances (useApi / usePortalApi) build their own base the same
// way. On the web this stays unset (same-origin).
const base = serverBase()
if (base) axios.defaults.baseURL = base

createApp(App)
  .use(createPinia())
  .use(router)
  .mount('#app')

// Register the service worker so CareLane installs as an Android/desktop web
// app. The native app skips it: the shell is bundled, nothing to cache.
if (!isNativeApp() && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* offline shell is optional */ })
    // Warm the route chunks needed to capture notes offline while we still have a
    // connection, so they're in the service-worker cache before the signal drops.
    if (navigator.onLine) {
      import('./pages/OfflinePage.vue')
      import('./pages/ShiftDetailPage.vue')
    }
  })
}
