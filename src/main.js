import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router/index.js'
import './assets/main.css'

createApp(App)
  .use(createPinia())
  .use(router)
  .mount('#app')

// Register the service worker so CareLane installs as an Android/desktop web app.
if ('serviceWorker' in navigator) {
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
