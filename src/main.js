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
  })
}
