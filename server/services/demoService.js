import cron from 'node-cron'
import fs from 'node:fs'
import path from 'node:path'
import bcrypt from 'bcryptjs'
import { sqlite } from '../db/connection.js'
import config from '../config.js'
import { seed } from '../db/seed.js'
import { services } from './_core.js'
import { setWorkerClients } from './accessService.js'
import { CLIENT_DOC_DIR } from './clientDocumentService.js'
import { logger } from './logger.js'

/**
 * Public demo mode. When `DEMO_MODE=true` CareLane runs as a throwaway public
 * showcase: two shared logins and a rich set of fabricated example data that is
 * wiped and reseeded on a fixed cadence (and once at boot) so any visitor's
 * poking around is rolled back automatically.
 *
 * Everything here is gated on {@link isDemo} and is deliberately destructive —
 * a reset HARD-DELETES all operational data (bypassing the usual soft-delete
 * rule, which does not apply to disposable demo data). It must never run against
 * an install holding real participant records; `config.demoMode` is the single
 * guard, off by default.
 */

/** Shared demo credentials (advertised on the login screen). */
export const DEMO_ADMIN_USERNAME = 'demo'
export const DEMO_WORKER_USERNAME = 'demoworker'
export const DEMO_PASSWORD = 'demo'

const BCRYPT_COST = 12
const nowIso = () => new Date().toISOString()

/** Whether the app is running as a public demo. */
export function isDemo () {
  return config.demoMode
}

/** ISO date (YYYY-MM-DD) `days` from today (negative = past). */
function isoDate (days = 0) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

// Operational tables cleared on every reset, in child→parent order so the
// foreign-key constraints (enabled on the connection) are satisfied. Reference
// data (billing_codes, templates, settings, users) is intentionally preserved.
const WIPE_ORDER = [
  'share_links', 'goal_progress_notes', 'client_goals', 'shift_photos', 'square_invoices',
  'medication_records', 'restrictive_practice_records', 'incident_reports',
  'reports', 'client_documents', 'agreement_line_items', 'service_agreements',
  'client_billing_codes', 'scheduled_shifts', 'shift_recurrences', 'shift_notes',
  'client_assignments', 'clients'
]

/**
 * Delete all operational rows. The append-only `activity_log` triggers block a
 * plain DELETE, so they are dropped for the duration of the wipe and recreated
 * immediately after — the same pattern the audit backfill uses. Demo data is
 * disposable, so resetting the audit trail keeps the showcase clean.
 */
function wipeData () {
  for (const table of WIPE_ORDER) sqlite.exec(`DELETE FROM ${table}`)
  // Blind-index search shadow table (no FK, plain FTS5).
  sqlite.exec('DELETE FROM shift_notes_fts')
  // Reset the append-only audit trail.
  sqlite.exec('DROP TRIGGER IF EXISTS activity_log_no_delete')
  sqlite.exec('DROP TRIGGER IF EXISTS activity_log_no_update')
  sqlite.exec('DELETE FROM activity_log')
  sqlite.exec(`CREATE TRIGGER IF NOT EXISTS activity_log_no_update
    BEFORE UPDATE ON activity_log BEGIN SELECT RAISE(ABORT, 'activity_log is append-only'); END;`)
  sqlite.exec(`CREATE TRIGGER IF NOT EXISTS activity_log_no_delete
    BEFORE DELETE ON activity_log BEGIN SELECT RAISE(ABORT, 'activity_log is append-only'); END;`)
}

/**
 * Create or refresh a shared demo login: password reset to {@link DEMO_PASSWORD},
 * role/active forced, and any second factor (TOTP + passkeys) cleared so a
 * previous visitor cannot have locked the account behind an authenticator.
 * @param {string} username
 * @param {string} displayName
 * @param {'admin'|'worker'} role
 * @returns {number} the user id
 */
function ensureDemoUser (username, displayName, role) {
  const hash = bcrypt.hashSync(DEMO_PASSWORD, BCRYPT_COST)
  const ts = nowIso()
  const existing = sqlite.prepare('SELECT id FROM users WHERE username = ?').get(username)
  if (existing) {
    sqlite.prepare(`UPDATE users SET password_hash = ?, display_name = ?, role = ?, active = 1,
        totp_secret = NULL, totp_enabled = 0, totp_recovery_codes = NULL, totp_last_counter = NULL, updated_at = ?
      WHERE id = ?`).run(hash, displayName, role, ts, existing.id)
    sqlite.prepare('DELETE FROM webauthn_credentials WHERE user_id = ?').run(existing.id)
    return existing.id
  }
  return sqlite.prepare(`INSERT INTO users (username, password_hash, display_name, role, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)`).run(username, hash, displayName, role, ts, ts).lastInsertRowid
}

/** Map of billing `code` → id, for wiring example rates and shifts to real codes. */
function billingCodeIds () {
  const map = {}
  for (const row of sqlite.prepare('SELECT id, code FROM billing_codes').all()) map[row.code] = row.id
  return map
}

// A tiny, valid PDF used as the on-disk file behind every example consent /
// document row, so the auth-gated download actually returns something.
const PLACEHOLDER_PDF = Buffer.from(
  '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 120]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n' +
  '4 0 obj<</Length 68>>stream\nBT /F1 14 Tf 24 60 Td (CareLane demo document) Tj ET\nendstream endobj\n' +
  '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n' +
  'trailer<</Root 1 0 R>>\n%%EOF\n', 'latin1')

const DEMO_DOC_FILENAME = 'demo-document.pdf'

/** Write the shared placeholder document file once (idempotent). */
function ensurePlaceholderDocument () {
  fs.mkdirSync(CLIENT_DOC_DIR, { recursive: true })
  const dest = path.join(CLIENT_DOC_DIR, DEMO_DOC_FILENAME)
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, PLACEHOLDER_PDF)
}

/** Insert a client_documents row directly (metadata + shared placeholder file). */
function addDocument (clientId, { title, doc_type, issue_date, expiry_date }) {
  const ts = nowIso()
  sqlite.prepare(`INSERT INTO client_documents
      (client_id, title, source_type, doc_type, issue_date, expiry_date, filename, original_name, mime_type, size_bytes, created_at, updated_at)
    VALUES (?, ?, 'upload', ?, ?, ?, ?, ?, 'application/pdf', ?, ?, ?)`)
    .run(clientId, title, doc_type, issue_date, expiry_date ?? null, DEMO_DOC_FILENAME,
      `${title}.pdf`, PLACEHOLDER_PDF.length, ts, ts)
}

/**
 * Build the full example dataset. Uses the core domain services so encryption,
 * blind indexes and search indexing all happen exactly as they would for real
 * data. Assumes the data tables were just wiped and the demo users exist.
 * @param {number} adminId
 * @param {number} workerId
 */
function seedExampleData (adminId, workerId) {
  const { client, agreement, shift, goal, incident, schedule, medication, restrictivePractice, report } = services
  const codes = billingCodeIds()
  const selfCare = codes['01_011_0107_1_1']
  const community = codes['04_104_0125_6_1']
  const cleaning = codes['01_020_0120_1_1']

  // ── Participants ────────────────────────────────────────────────────────
  const aisha = client.createClient({
    first_name: 'Aisha', last_name: 'Rahman', preferred_name: 'Aisha',
    ndis_number: '430000001', date_of_birth: '1996-03-14',
    phone: '0400 111 222', email: 'aisha.demo@example.com',
    address: '12 Marlow Street', suburb: 'Fremantle', state: 'WA', postcode: '6160',
    plan_management_type: 'plan_managed', plan_manager_name: 'Coastal Plan Management',
    plan_manager_contact: 'accounts@coastalplan.example.com',
    primary_disability: 'Autism spectrum disorder',
    communication_needs: 'Prefers written instructions and clear routines; give processing time.',
    emergency_contact_name: 'Priya Rahman (mother)', emergency_contact_phone: '0400 999 000',
    notes: 'Enjoys swimming and art. Sensitive to loud, crowded environments.', active: 1, invoice_due_days: 30
  })
  const tom = client.createClient({
    first_name: 'Thomas', last_name: 'Nguyen', preferred_name: 'Tommy',
    ndis_number: '430000002', date_of_birth: '1988-09-02',
    phone: '0400 333 444', email: 'tommy.demo@example.com',
    address: '5/88 Rokeby Road', suburb: 'Subiaco', state: 'WA', postcode: '6008',
    plan_management_type: 'self_managed', primary_disability: 'Intellectual disability; epilepsy',
    communication_needs: 'Verbal, short sentences. Confirm understanding by asking him to repeat back.',
    emergency_contact_name: 'Linh Nguyen (sister)', emergency_contact_phone: '0400 555 111',
    notes: 'Epilepsy management plan in place. Loves football and cooking.', active: 1, invoice_due_days: 30
  })
  const grace = client.createClient({
    first_name: 'Grace', last_name: "O'Brien", preferred_name: 'Grace',
    ndis_number: '430000003', date_of_birth: '1972-12-20',
    phone: '0400 777 888', email: 'grace.demo@example.com',
    address: '210 Canning Highway', suburb: 'Como', state: 'WA', postcode: '6152',
    plan_management_type: 'ndia_managed', primary_disability: 'Acquired brain injury',
    communication_needs: 'Fatigues easily; keep sessions to planned length and check in often.',
    emergency_contact_name: 'Daniel O\'Brien (husband)', emergency_contact_phone: '0400 222 333',
    notes: 'Working on community re-engagement and independence at home.', active: 1, invoice_due_days: 45
  })
  const clients = [aisha, tom, grace]

  // Per-participant charge rates (slightly under the code caps).
  for (const c of clients) {
    client.setClientBillingCodes(c.id, [
      { billing_code_id: selfCare, custom_rate: 66.5 },
      { billing_code_id: community, custom_rate: 66.5 },
      { billing_code_id: cleaning, custom_rate: 57.0 }
    ])
  }

  // Assign two participants to the demo support worker (Grace stays admin-only,
  // to show the difference between the two logins).
  setWorkerClients(workerId, [aisha.id, tom.id], adminId)

  // ── Service agreements ──────────────────────────────────────────────────
  agreement.createAgreement({
    client_id: aisha.id, title: 'Service Agreement — Aisha Rahman 2025', status: 'active',
    start_date: isoDate(-120), end_date: isoDate(240), review_date: isoDate(25),
    supports_summary: 'Self-care and community access to build independence and social participation.',
    hourly_rate: 66.5, total_budget: 24000,
    body_markdown: '# Service Agreement\nThis agreement covers assistance with self-care and community participation supports.',
    line_items: [{ billing_code_id: selfCare, description: 'Self-care assistance', unit_price: 66.5, estimated_quantity: 200 }]
  })
  agreement.createAgreement({
    client_id: tom.id, title: 'Service Agreement — Tommy Nguyen 2025', status: 'active',
    start_date: isoDate(-60), end_date: isoDate(300), review_date: isoDate(70),
    supports_summary: 'Community access, skill-building around cooking, and household tasks.',
    hourly_rate: 66.5, total_budget: 18000,
    body_markdown: '# Service Agreement\nSupports for community participation and daily living skills.'
  })
  agreement.createAgreement({
    client_id: grace.id, title: 'Service Agreement — Grace O\'Brien 2024', status: 'draft',
    start_date: isoDate(-10), end_date: isoDate(355), review_date: isoDate(180),
    supports_summary: 'Assistance with daily life and graded community re-engagement.',
    hourly_rate: 66.5, total_budget: 21000,
    body_markdown: '# Service Agreement (draft)\nAwaiting participant signature.'
  })

  // ── Shift notes (past) ──────────────────────────────────────────────────
  // A mix of authors (worker + admin), finalised + draft, and one incident.
  const mkShift = (clientId, workerFor, over) => shift.createShift({
    client_id: clientId, billing_code_id: selfCare, location: 'Participant home',
    incident_flag: 0, follow_up_required: 0, billed: 0, finalised: 1,
    support_provided: 'Personal care and daily living support',
    participant_response: 'Engaged well and in good spirits.',
    body: 'Assisted with morning routine, prepared breakfast together and tidied the kitchen. Reviewed the plan for the week ahead.',
    ...over
  }, workerFor)

  mkShift(aisha.id, workerId, { shift_date: isoDate(-14), start_time: '09:00', end_time: '12:00', billing_code_id: selfCare })
  mkShift(aisha.id, workerId, {
    shift_date: isoDate(-9), start_time: '13:00', end_time: '16:00', billing_code_id: community, location: 'Fremantle Arts Centre',
    support_provided: 'Community access — art class', body: 'Supported Aisha to attend her weekly art class and travel by bus. She managed the crowd well with breaks.', billed: 1
  })
  mkShift(aisha.id, workerId, { shift_date: isoDate(-2), start_time: '09:00', end_time: '11:30', finalised: 0, participant_response: 'Draft — pending review.' })
  mkShift(tom.id, workerId, {
    shift_date: isoDate(-11), start_time: '10:00', end_time: '13:00', billing_code_id: community, location: 'Subiaco',
    support_provided: 'Community access — shopping and cooking skills', body: 'Practised a shopping list and budgeting at the supermarket, then cooked lunch together.', billed: 1
  })
  // Incident-flagged note → promoted to a structured incident report below.
  const incidentShift = shift.createShift({
    client_id: tom.id, worker_id: workerId, billing_code_id: selfCare, shift_date: isoDate(-6),
    start_time: '15:00', end_time: '18:00', location: 'Participant home',
    support_provided: 'Personal care and evening routine', participant_response: 'Recovered well after a short rest.',
    body: 'Supported Tommy with his evening routine. He had a brief seizure at approximately 16:20.',
    incident_flag: 1, follow_up_required: 1, finalised: 1, billed: 0,
    incident_details: 'Tommy experienced a brief tonic-clonic seizure lasting under two minutes. Followed his epilepsy management plan, kept him safe, and he recovered without further intervention. Sister notified.'
  }, workerId)
  mkShift(grace.id, adminId, { shift_date: isoDate(-8), start_time: '09:30', end_time: '12:30', location: 'Como', billing_code_id: cleaning, support_provided: 'Household tasks', body: 'Assisted Grace with cleaning and laundry, encouraging her to lead each task at her own pace.' })
  mkShift(grace.id, adminId, { shift_date: isoDate(-3), start_time: '10:00', end_time: '12:00', finalised: 0 })

  // ── Incident report (promoted from the flagged shift) ───────────────────
  const inc = incident.createFromShift(incidentShift.id, workerId)
  incident.updateIncident(inc.id, {
    incident_type: 'injury', severity: 'moderate', reportable: 0,
    immediate_actions: 'Ensured a safe space, timed the seizure, stayed with the participant and monitored recovery per his management plan.',
    persons_involved: 'Tommy Nguyen (participant), demo support worker',
    injuries: 'None sustained during the seizure.',
    contributing_factors: 'Possible missed medication earlier in the day.',
    notified_parties: 'Sister (Linh Nguyen) notified by phone.',
    follow_up_actions: 'Confirm medication routine with plan manager; review management plan at next visit.',
    follow_up_due_date: isoDate(5), status: 'in_progress'
  })

  // ── Goals + progress notes ──────────────────────────────────────────────
  const goalDefs = [
    [aisha.id, { title: 'Travel independently by public transport', category: 'Independence', status: 'active', target_date: isoDate(150) },
      [{ note_date: isoDate(-30), progress_rating: 2, body: 'Practised planning a bus route together.' }, { note_date: isoDate(-9), progress_rating: 3, body: 'Travelled to art class with minimal prompting.' }]],
    [aisha.id, { title: 'Attend a weekly social activity', category: 'Social', status: 'achieved', target_date: isoDate(-20) },
      [{ note_date: isoDate(-20), progress_rating: 5, body: 'Now attending art class consistently each week.' }]],
    [tom.id, { title: 'Prepare three simple meals unassisted', category: 'Daily living', status: 'active', target_date: isoDate(120) },
      [{ note_date: isoDate(-11), progress_rating: 3, body: 'Cooked lunch with step-by-step support.' }]],
    [grace.id, { title: 'Re-engage with community outings', category: 'Community', status: 'on_hold', target_date: isoDate(200) },
      [{ note_date: isoDate(-8), progress_rating: 1, body: 'On hold while building stamina at home first.' }]]
  ]
  for (const [clientId, def, notes] of goalDefs) {
    const g = goal.createGoal(clientId, def)
    for (const n of notes) goal.addProgressNote(clientId, g.id, n)
  }

  // ── Medication + restrictive-practice records ───────────────────────────
  medication.createMedicationRecord(tom.id, {
    medication_name: 'Levetiracetam', dose: '500mg', route: 'Oral',
    administered_date: isoDate(-6), administered_time: '08:00', prn: 0, status: 'administered',
    reason: 'Routine epilepsy management.', witnessed_by: 'Demo support worker'
  }, workerId)
  medication.createMedicationRecord(tom.id, {
    medication_name: 'Paracetamol', dose: '500mg', route: 'Oral',
    administered_date: isoDate(-6), administered_time: '16:45', prn: 1, status: 'administered',
    reason: 'PRN — headache following seizure.', witnessed_by: 'Demo support worker'
  }, workerId)
  restrictivePractice.createRestrictivePractice(grace.id, {
    practice_type: 'environmental', used_at_date: isoDate(-8), used_at_time: '11:00', duration_minutes: 15,
    authorised: 1, authorisation_ref: 'BSP-2024-014', reported_to_commission: 0,
    description: 'Kitchen cupboard with cleaning chemicals kept locked during the session.',
    antecedent: 'Risk of ingestion identified in behaviour support plan.',
    alternatives_tried: 'Supervision and redirection where possible.',
    outcome: 'No incidents; participant engaged safely in household tasks.'
  }, adminId)

  // ── Documents (consent / paperwork, one expiring soon) ──────────────────
  ensurePlaceholderDocument()
  addDocument(aisha.id, { title: 'Media consent form', doc_type: 'media_consent', issue_date: isoDate(-200), expiry_date: isoDate(20) })
  addDocument(aisha.id, { title: 'Consent to share information', doc_type: 'consent_to_share', issue_date: isoDate(-200), expiry_date: isoDate(160) })
  addDocument(tom.id, { title: 'Epilepsy management plan', doc_type: 'risk_assessment', issue_date: isoDate(-90), expiry_date: isoDate(275) })
  addDocument(grace.id, { title: 'Behaviour support plan', doc_type: 'behaviour_support_plan', issue_date: isoDate(-150), expiry_date: isoDate(-5) })

  // ── Reports ─────────────────────────────────────────────────────────────
  report.createReport({
    client_id: aisha.id, report_type: 'progress', period_start: isoDate(-90), period_end: isoDate(0), status: 'draft',
    body_markdown: '## Summary\nAisha has made strong progress toward independent travel and social participation this quarter.\n\n## Progress Toward Goals\nNow attends her weekly art class consistently and travels there with minimal support.'
  })

  // ── Roster / scheduled shifts ───────────────────────────────────────────
  // The demo can be opened at any time and the roster calendar can be paged to
  // any month, so a fixed weekly pattern of shifts is cloned into every month
  // across a wide window either side of today — past months render as completed
  // history (green on the calendar), current/future months as upcoming plans
  // (which also populate the "next 14 days" list). Because the demo reseeds
  // relative to "now" on every reset, this rolling window keeps the roster full
  // no matter when the demo is opened — effectively forever.
  const ROSTER_MONTHS_EACH_WAY = 24
  const todayIso = isoDate(0)
  const base = new Date()
  const baseY = base.getUTCFullYear()
  const baseM = base.getUTCMonth()
  // Date (YYYY-MM-DD) on `day` of the month `monthOffset` months from now.
  // Date.UTC normalises month overflow/underflow, so offsets wrap years cleanly.
  const monthDayIso = (monthOffset, day) =>
    new Date(Date.UTC(baseY, baseM + monthOffset, day)).toISOString().slice(0, 10)

  const mkScheduled = (clientId, scheduledDate, over) => {
    const created = schedule.createScheduled({
      client_id: clientId, worker_id: over.worker_id ?? workerId, billing_code_id: selfCare,
      location: 'Participant home', title: 'Support shift', scheduled_date: scheduledDate, ...over
    }, adminId)
    // A shift before today reads as completed history; today/future stay
    // scheduled so they still surface in the upcoming list and clock-in flow.
    if (scheduledDate < todayIso) {
      sqlite.prepare("UPDATE scheduled_shifts SET status = 'completed', updated_at = ? WHERE id = ?")
        .run(nowIso(), created.id)
    }
    return created
  }

  // Weekly pattern as day-of-month (1–28, present in every month) + overrides,
  // mirroring the example shift notes above. Cloned into each month in range.
  const rosterTemplate = [
    [aisha.id, 4, { start_time: '09:00', end_time: '12:00' }],
    [aisha.id, 8, { start_time: '13:00', end_time: '16:00', billing_code_id: community, location: 'Fremantle Arts Centre', title: 'Art class' }],
    [tom.id, 12, { start_time: '10:00', end_time: '13:00', billing_code_id: community, location: 'Subiaco', title: 'Community access' }],
    [tom.id, 15, { start_time: '15:00', end_time: '18:00' }],
    [grace.id, 20, { start_time: '09:30', end_time: '12:30', worker_id: adminId, location: 'Como' }],
    [grace.id, 24, { start_time: '09:30', end_time: '12:30', worker_id: adminId, location: 'Como' }]
  ]
  for (let m = -ROSTER_MONTHS_EACH_WAY; m <= ROSTER_MONTHS_EACH_WAY; m++) {
    for (const [clientId, day, over] of rosterTemplate) {
      mkScheduled(clientId, monthDayIso(m, day), over)
    }
  }
}

/**
 * Reset the demo to its pristine state: ensure the two shared logins exist (with
 * fresh credentials and no lingering second factor), wipe all operational data,
 * and reseed the example dataset. Runs inside a single transaction so the demo is
 * never left half-reset. No-op unless demo mode is on.
 */
export function resetDemoData () {
  if (!isDemo()) return
  // Make sure reference data (billing codes, templates, settings) is present.
  seed()
  const run = sqlite.transaction(() => {
    const adminId = ensureDemoUser(DEMO_ADMIN_USERNAME, 'Demo Administrator', 'admin')
    const workerId = ensureDemoUser(DEMO_WORKER_USERNAME, 'Demo Support Worker', 'worker')
    wipeData()
    seedExampleData(adminId, workerId)
  })
  run()
  logger.info('demo data reset', { every_hours: config.demoResetHours })
}

/**
 * Reset now (at boot) and then on a fixed interval so any visitor's changes are
 * rolled back. The cron expression fires at minute 0 of every Nth hour. No-op
 * unless demo mode is on.
 */
export function scheduleDemoReset () {
  if (!isDemo()) return
  try { resetDemoData() } catch (err) { logger.error('demo reset failed', { error: err.message }) }
  const hours = Math.min(Math.max(config.demoResetHours, 1), 24)
  cron.schedule(`0 */${hours} * * *`, () => {
    try { resetDemoData() } catch (err) { logger.error('scheduled demo reset failed', { error: err.message }) }
  })
}
