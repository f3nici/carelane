import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '../stores/auth.js'
import DefaultLayout from '../layouts/DefaultLayout.vue'

const routes = [
  { path: '/login', name: 'login', component: () => import('../pages/LoginPage.vue'), meta: { public: true } },
  {
    path: '/',
    component: DefaultLayout,
    children: [
      { path: 'offline', name: 'offline', component: () => import('../pages/OfflinePage.vue'), meta: { offlineReady: true } },
      { path: '', name: 'dashboard', component: () => import('../pages/DashboardPage.vue') },
      { path: 'clients', name: 'clients', component: () => import('../pages/ClientListPage.vue') },
      { path: 'clients/new', name: 'client-new', component: () => import('../pages/ClientEditPage.vue') },
      { path: 'clients/:id', name: 'client-detail', component: () => import('../pages/ClientDetailPage.vue') },
      { path: 'clients/:id/edit', name: 'client-edit', component: () => import('../pages/ClientEditPage.vue') },
      { path: 'agreements', name: 'agreements', component: () => import('../pages/AgreementListPage.vue') },
      { path: 'agreements/new', name: 'agreement-new', component: () => import('../pages/AgreementDetailPage.vue') },
      { path: 'agreements/:id', name: 'agreement-detail', component: () => import('../pages/AgreementDetailPage.vue') },
      { path: 'documents', name: 'documents', component: () => import('../pages/DocumentsPage.vue') },
      { path: 'roster', name: 'roster', component: () => import('../pages/RosterPage.vue') },
      { path: 'shifts', name: 'shifts', component: () => import('../pages/ShiftListPage.vue') },
      { path: 'shifts/new', name: 'shift-new', component: () => import('../pages/ShiftDetailPage.vue'), meta: { offlineReady: true } },
      { path: 'shifts/:id', name: 'shift-detail', component: () => import('../pages/ShiftDetailPage.vue') },
      { path: 'incidents', name: 'incidents', component: () => import('../pages/IncidentListPage.vue') },
      { path: 'incidents/new', name: 'incident-new', component: () => import('../pages/IncidentDetailPage.vue') },
      { path: 'incidents/:id', name: 'incident-detail', component: () => import('../pages/IncidentDetailPage.vue') },
      { path: 'reports', name: 'reports', component: () => import('../pages/ReportListPage.vue') },
      { path: 'reports/new', name: 'report-new', component: () => import('../pages/ReportDetailPage.vue') },
      { path: 'reports/:id', name: 'report-detail', component: () => import('../pages/ReportDetailPage.vue') },
      { path: 'templates', name: 'templates', component: () => import('../pages/TemplateListPage.vue') },
      { path: 'templates/new', name: 'template-new', component: () => import('../pages/TemplateDetailPage.vue') },
      { path: 'templates/:id', name: 'template-detail', component: () => import('../pages/TemplateDetailPage.vue') },
      { path: 'billing-codes', name: 'billing-codes', component: () => import('../pages/BillingCodesPage.vue') },
      { path: 'knowledge', name: 'knowledge', component: () => import('../pages/KnowledgePage.vue') },
      { path: 'audit', name: 'audit', component: () => import('../pages/AuditLogPage.vue') },
      { path: 'deleted', name: 'deleted', component: () => import('../pages/DeletedItemsPage.vue') },
      { path: 'settings', name: 'settings', component: () => import('../pages/SettingsPage.vue') }
    ]
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

router.beforeEach(async to => {
  if (to.meta.public) return true
  const auth = useAuthStore()
  if (!auth.checked) await auth.fetchMe()
  if (!auth.isAuthenticated) return { name: 'login', query: { redirect: to.fullPath } }
  // Policy: a second factor is required but this account has none yet. Funnel
  // every page to Settings (where the 2FA/passkey setup lives) until they enrol.
  if (auth.mustEnrol2fa && to.name !== 'settings') return { name: 'settings', query: { enrol: '2fa' } }
  // Offline, the only pages that work are note capture and the offline home —
  // everything else fans out to the API and just renders connection errors.
  const offline = typeof navigator !== 'undefined' && !navigator.onLine
  if (offline && !to.meta.offlineReady) return { name: 'offline' }
  return true
})

export default router
