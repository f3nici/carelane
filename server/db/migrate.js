import { sqlite } from './connection.js'
import { encrypt, encryptionSecretMatches } from '../services/cryptoService.js'
import { backfillAuditHashes } from '../services/activityService.js'
import { reindexSearch as reindexShiftSearch } from '../services/shiftService.js'

/**
 * Add a column to a table only if it does not already exist. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, so we inspect the table info first. Keeps the
 * migration idempotent and safe to run on every boot.
 * @param {string} table
 * @param {string} column
 * @param {string} definition full column definition (type + constraints)
 */
function addColumnIfMissing (table, column, definition) {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all()
  if (cols.some(c => c.name === column)) return
  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

/**
 * Drop a column only if it still exists. SQLite has no `DROP COLUMN IF EXISTS`,
 * so we inspect the table info first. Keeps the migration idempotent and safe to
 * run on every boot. Used to retire columns (e.g. NDIS plan dates) that the app
 * no longer tracks — the data is non-regulated scheduling metadata, so dropping
 * it does not breach the never-hard-delete rule for regulated records.
 * @param {string} table
 * @param {string} column
 */
function dropColumnIfExists (table, column) {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all()
  if (!cols.some(c => c.name === column)) return
  sqlite.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`)
}

// Columns promoted to at-rest encryption post-launch. Existing rows hold plain
// text, so back-fill them: any value not already an `enc:` ciphertext is
// re-encrypted in place. Table + column names are internal constants (never user
// input); the value is bound. Runs in every `migrate()` and is idempotent — once
// every row is sealed the guarded SELECT matches nothing.
const ENCRYPT_BACKFILL = [
  { table: 'clients', columns: ['primary_disability', 'communication_needs', 'support_goals'] },
  { table: 'reports', columns: ['body_markdown'] },
  { table: 'service_agreements', columns: ['supports_summary', 'body_markdown'] }
]

/**
 * Re-encrypt any legacy plaintext in the newly-encrypted columns. A no-op once
 * every value carries the `enc:` prefix. Assumes the ENCRYPTION_SECRET is the one
 * existing ciphertext was written with (the same assumption `reindexSearch` and
 * the boot canary already rely on); it only encrypts plaintext, never decrypts,
 * so it cannot corrupt data if run before the canary check.
 */
function encryptLegacyPlaintextColumns () {
  // Never write fresh ciphertext under a wrong secret: if a canary already exists
  // and no longer matches, skip and let the boot canary abort startup cleanly.
  // (On first run there is no canary yet and no legacy ciphertext to mismatch.)
  if (!encryptionSecretMatches()) return
  const tx = sqlite.transaction(() => {
    for (const { table, columns } of ENCRYPT_BACKFILL) {
      for (const col of columns) {
        const rows = sqlite.prepare(
          `SELECT id, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL AND ${col} != '' AND ${col} NOT LIKE 'enc:%'`
        ).all()
        if (!rows.length) continue
        const upd = sqlite.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ?`)
        for (const r of rows) upd.run(encrypt(r.v), r.id)
      }
    }
  })
  tx()
}

/**
 * Idempotent SQL migrations. Creates all tables, indexes and the append-only
 * triggers on activity_log. Safe to run on every boot.
 */
export function migrate () {
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  preferred_name TEXT,
  ndis_number TEXT,
  ndis_number_hash TEXT,
  date_of_birth TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  suburb TEXT,
  state TEXT DEFAULT 'WA',
  postcode TEXT,
  plan_management_type TEXT,
  plan_manager_name TEXT,
  plan_manager_contact TEXT,
  primary_disability TEXT,
  communication_needs TEXT,
  support_goals TEXT,
  emergency_contact_name TEXT,
  emergency_contact_phone TEXT,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT,
  updated_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_clients_ndis_hash ON clients (ndis_number_hash);

CREATE TABLE IF NOT EXISTS billing_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  support_category TEXT,
  registration_group TEXT,
  unit TEXT DEFAULT 'H',
  price_cap_standard REAL,
  price_cap_remote REAL,
  price_cap_very_remote REAL,
  quote_required INTEGER NOT NULL DEFAULT 0,
  price_guide_version TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_billing_codes_code ON billing_codes (code);

CREATE TABLE IF NOT EXISTS service_agreements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  start_date TEXT,
  end_date TEXT,
  supports_summary TEXT,
  hourly_rate REAL,
  total_budget REAL,
  questionnaire_json TEXT,
  body_markdown TEXT,
  signed_by_client INTEGER NOT NULL DEFAULT 0,
  signed_date TEXT,
  pdf_filename TEXT,
  created_at TEXT,
  updated_at TEXT,
  deleted_at TEXT,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS agreement_line_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agreement_id INTEGER NOT NULL REFERENCES service_agreements(id),
  billing_code_id INTEGER REFERENCES billing_codes(id),
  description TEXT,
  unit_price REAL,
  estimated_quantity REAL,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS client_billing_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  billing_code_id INTEGER NOT NULL REFERENCES billing_codes(id),
  custom_rate REAL,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS shift_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  worker_id INTEGER NOT NULL REFERENCES users(id),
  shift_date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  duration_hours REAL,
  billing_code_id INTEGER REFERENCES billing_codes(id),
  location TEXT,
  support_provided TEXT,
  body TEXT,
  participant_response TEXT,
  incident_flag INTEGER NOT NULL DEFAULT 0,
  incident_details TEXT,
  follow_up_required INTEGER NOT NULL DEFAULT 0,
  billed INTEGER NOT NULL DEFAULT 0,
  finalised INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  deleted_at TEXT,
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_shift_notes_client ON shift_notes (client_id, shift_date);

CREATE TABLE IF NOT EXISTS shift_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_note_id INTEGER NOT NULL REFERENCES shift_notes(id),
  filename TEXT NOT NULL,
  original_name TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  caption TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  report_type TEXT NOT NULL DEFAULT 'progress',
  period_start TEXT,
  period_end TEXT,
  body_markdown TEXT,
  source_shift_ids TEXT,
  pdf_filename TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT,
  updated_at TEXT,
  deleted_at TEXT,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS client_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  title TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'upload',
  source_id INTEGER,
  doc_type TEXT NOT NULL DEFAULT 'other',
  issue_date TEXT,
  expiry_date TEXT,
  filename TEXT NOT NULL,
  original_name TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  created_at TEXT,
  updated_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_client_documents_client ON client_documents (client_id);

-- Structured participant goals + dated progress notes (replaces the free-text
-- support_goals blob; progress note bodies are encrypted in the service layer).
CREATE TABLE IF NOT EXISTS client_goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  title TEXT NOT NULL,
  description TEXT,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  target_date TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_client_goals_client ON client_goals (client_id, status);

CREATE TABLE IF NOT EXISTS goal_progress_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL REFERENCES client_goals(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  note_date TEXT NOT NULL,
  progress_rating INTEGER,
  body TEXT,
  created_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_goal_progress_goal ON goal_progress_notes (goal_id, note_date);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'guideline',
  filename TEXT NOT NULL,
  original_name TEXT,
  page_count INTEGER,
  indexed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS document_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  chunk_index INTEGER NOT NULL,
  page INTEGER,
  content TEXT NOT NULL,
  embedding BLOB,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_chunks_document ON document_chunks (document_id);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  user_id INTEGER,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT,
  prev_hash TEXT,
  hash TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  template_type TEXT NOT NULL DEFAULT 'agreement',
  report_type TEXT,
  description TEXT,
  body_markdown TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT,
  updated_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_templates_type ON templates (template_type, active, deleted_at);

-- Recurring-appointment series. Individual occurrences are materialised into
-- scheduled_shifts on a rolling horizon (see recurrenceService).
CREATE TABLE IF NOT EXISTS shift_recurrences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  worker_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT,
  frequency TEXT NOT NULL DEFAULT 'weekly',
  interval INTEGER NOT NULL DEFAULT 1,
  weekdays TEXT,
  start_date TEXT NOT NULL,
  until_date TEXT,
  start_time TEXT,
  end_time TEXT,
  billing_code_id INTEGER REFERENCES billing_codes(id),
  location TEXT,
  plan_notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT,
  updated_at TEXT,
  deleted_at TEXT
);

-- Forward-looking roster: planned shifts (one-off or generated from a series).
-- A note is created at clock-out and linked via shift_note_id. plan_notes is
-- encrypted at rest in the service layer like shift bodies.
CREATE TABLE IF NOT EXISTS scheduled_shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  worker_id INTEGER NOT NULL REFERENCES users(id),
  recurrence_id INTEGER REFERENCES shift_recurrences(id),
  title TEXT,
  scheduled_date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  billing_code_id INTEGER REFERENCES billing_codes(id),
  location TEXT,
  plan_notes TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled',
  clock_in_at TEXT,
  clock_out_at TEXT,
  shift_note_id INTEGER REFERENCES shift_notes(id),
  google_event_id TEXT,
  created_at TEXT,
  updated_at TEXT,
  deleted_at TEXT,
  cancelled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_scheduled_shifts_date ON scheduled_shifts (scheduled_date, status);
CREATE INDEX IF NOT EXISTS idx_scheduled_shifts_client ON scheduled_shifts (client_id, scheduled_date);
CREATE INDEX IF NOT EXISTS idx_scheduled_shifts_recurrence ON scheduled_shifts (recurrence_id, scheduled_date);

-- Append-only audit trail: block UPDATE and DELETE at the database level.
CREATE TRIGGER IF NOT EXISTS activity_log_no_update
BEFORE UPDATE ON activity_log
BEGIN
  SELECT RAISE(ABORT, 'activity_log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS activity_log_no_delete
BEFORE DELETE ON activity_log
BEGIN
  SELECT RAISE(ABORT, 'activity_log is append-only');
END;

CREATE INDEX IF NOT EXISTS idx_activity_entity ON activity_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log (created_at);
`)

  // Two-factor auth columns on users (added post-launch; encrypted at rest in
  // the service layer — see twoFactorService). totp_recovery_codes holds a JSON
  // array of bcrypt-hashed single-use recovery codes.
  addColumnIfMissing('users', 'totp_secret', 'TEXT')
  addColumnIfMissing('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing('users', 'totp_recovery_codes', 'TEXT')
  // Highest TOTP time-step already accepted at login — prevents replay of a
  // still-valid code within its ~90s window (see twoFactorService.verifyLogin).
  addColumnIfMissing('users', 'totp_last_counter', 'INTEGER')

  // Passkeys / WebAuthn (added post-launch). One row per registered authenticator;
  // a passkey is a passwordless login factor. The public key is non-secret so it
  // is stored as-is (the matching private key never leaves the authenticator);
  // counter is the replay-defence signature counter, bumped on each login.
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  credential_id TEXT NOT NULL UNIQUE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  device_type TEXT,
  backed_up INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  created_at TEXT,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials (user_id);
`)

  // Tamper-evident hash chain on activity_log (added post-launch). Add the
  // columns on existing databases, then seal any legacy rows into the chain.
  addColumnIfMissing('activity_log', 'prev_hash', 'TEXT')
  addColumnIfMissing('activity_log', 'hash', 'TEXT')
  backfillAuditHashes()

  // Archive (hide from active lists without deleting) for shift notes, reports
  // and service agreements — added post-launch.
  addColumnIfMissing('shift_notes', 'archived_at', 'TEXT')
  addColumnIfMissing('reports', 'archived_at', 'TEXT')
  addColumnIfMissing('service_agreements', 'archived_at', 'TEXT')

  // Service-agreement review date (added post-launch). Independent support
  // workers commonly run open-ended agreements that are periodically *reviewed*
  // rather than ended, so the review date — not only a hard end date — drives the
  // "expiring / due for review" dashboard widget and the ntfy plan-review nudge.
  addColumnIfMissing('service_agreements', 'review_date', 'TEXT')

  // Square Invoicing (added post-launch). The participant is mirrored to a Square
  // customer once and the id cached here so repeat invoices reuse it. The
  // square_invoices table tracks each draft we create from a shift note so the
  // UI can show its status / link and we never invoice the same shift twice.
  addColumnIfMissing('clients', 'square_customer_id', 'TEXT')
  // Per-participant invoice payment term (days until due); null → default of 45.
  addColumnIfMissing('clients', 'invoice_due_days', 'INTEGER')
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS square_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  shift_note_id INTEGER REFERENCES shift_notes(id),
  square_invoice_id TEXT,
  square_order_id TEXT,
  invoice_number TEXT,
  status TEXT,
  public_url TEXT,
  amount REAL,
  currency TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_square_invoices_client ON square_invoices (client_id);
CREATE INDEX IF NOT EXISTS idx_square_invoices_shift ON square_invoices (shift_note_id);
`)

  // Hybrid search (added post-launch): a full-text (BM25) index over chunk text
  // sitting alongside the vector embeddings. The two are fused with Reciprocal
  // Rank Fusion at query time so exact terms (NDIS codes, acronyms, proper
  // nouns) and semantic matches both surface. The FTS index is self-contained
  // (stores its own copy of the text) and kept in sync by plain INSERT/DELETE
  // triggers, so all existing chunk read/write paths are unaffected.
  // Track which embedding model a document's vectors were built with, so a
  // model change can warn (and clear) per document as each is re-indexed.
  addColumnIfMissing('documents', 'embedding_model', 'TEXT')

  // Consent & document records (added post-launch): promote completed documents
  // to a trackable type with issue/expiry dates so consent forms (and other
  // expirable paperwork) can be surfaced before they lapse. updated_at lets the
  // metadata be edited (type/dates) without re-uploading the file.
  addColumnIfMissing('client_documents', 'doc_type', "TEXT NOT NULL DEFAULT 'other'")
  addColumnIfMissing('client_documents', 'issue_date', 'TEXT')
  addColumnIfMissing('client_documents', 'expiry_date', 'TEXT')
  addColumnIfMissing('client_documents', 'updated_at', 'TEXT')
  // When set, the operator has acknowledged this (expiring/expired) document, so it
  // stays in the participant record but drops off the dashboard "expiring" surfacing.
  addColumnIfMissing('client_documents', 'acknowledged_at', 'TEXT')
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_client_documents_expiry ON client_documents (expiry_date)')

  // Structured incident reports (added post-launch). A shift note's free-text
  // incident flag/details can be promoted into a structured, exportable NDIS
  // reportable-incident record with a follow-up lifecycle. The narrative fields
  // (description / immediate actions / people / injuries / etc.) are encrypted in
  // the service layer like shift bodies; the short categorical fields stay plain
  // so the register can be listed and filtered. shift_note_id links back to the
  // originating note (nullable for incidents logged directly).
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS incident_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  shift_note_id INTEGER REFERENCES shift_notes(id),
  worker_id INTEGER NOT NULL REFERENCES users(id),
  reference_no TEXT,
  incident_date TEXT NOT NULL,
  incident_time TEXT,
  location TEXT,
  incident_type TEXT NOT NULL DEFAULT 'other',
  severity TEXT NOT NULL DEFAULT 'minor',
  reportable INTEGER NOT NULL DEFAULT 0,
  reportable_category TEXT,
  description TEXT,
  immediate_actions TEXT,
  persons_involved TEXT,
  witnesses TEXT,
  injuries TEXT,
  contributing_factors TEXT,
  reported_to_ndis INTEGER NOT NULL DEFAULT 0,
  reported_to_ndis_date TEXT,
  notified_parties TEXT,
  follow_up_actions TEXT,
  follow_up_due_date TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  closed_at TEXT,
  created_at TEXT,
  updated_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_incident_reports_client ON incident_reports (client_id, incident_date);
CREATE INDEX IF NOT EXISTS idx_incident_reports_status ON incident_reports (status, follow_up_due_date);
CREATE INDEX IF NOT EXISTS idx_incident_reports_shift ON incident_reports (shift_note_id);

-- Restrictive-practice register (added post-launch). NDIS-regulated record of
-- any restrictive practice used; narrative fields encrypted in the service
-- layer. Tracks authorisation (behaviour-support plan) and Commission reporting.
CREATE TABLE IF NOT EXISTS restrictive_practice_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  worker_id INTEGER NOT NULL REFERENCES users(id),
  shift_note_id INTEGER REFERENCES shift_notes(id),
  practice_type TEXT NOT NULL DEFAULT 'environmental',
  used_at_date TEXT NOT NULL,
  used_at_time TEXT,
  duration_minutes INTEGER,
  authorised INTEGER NOT NULL DEFAULT 0,
  authorisation_ref TEXT,
  reported_to_commission INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  antecedent TEXT,
  alternatives_tried TEXT,
  outcome TEXT,
  created_at TEXT,
  updated_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_rp_client ON restrictive_practice_records (client_id, used_at_date);

-- Medication administration record / MAR (added post-launch). Each row is one
-- administration event. The medication name/dose are kept plain so the log is
-- listable; the reason (PRN/refusal) and free-text notes are encrypted.
CREATE TABLE IF NOT EXISTS medication_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  worker_id INTEGER NOT NULL REFERENCES users(id),
  shift_note_id INTEGER REFERENCES shift_notes(id),
  medication_name TEXT NOT NULL,
  dose TEXT,
  route TEXT,
  administered_date TEXT NOT NULL,
  administered_time TEXT,
  prn INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'administered',
  reason TEXT,
  notes TEXT,
  witnessed_by TEXT,
  created_at TEXT,
  updated_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_med_client ON medication_records (client_id, administered_date);

-- DB-backed brute-force throttle / rate-limit buckets (added post-launch). The
-- login throttle and the per-route rate limiters used to keep their counters in
-- a process-local Map, so protection reset on every restart and could not be
-- shared across workers. Persisting them here makes lockouts survive restarts
-- and (with a shared SQLite file) hold across multiple workers. One row per
-- throttle key; epoch-ms timestamps. Expired rows are purged lazily + on a timer.
CREATE TABLE IF NOT EXISTS throttle_hits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  first_at INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_throttle_hits_first ON throttle_hits (first_at);
`)

  // Performance indexes for the largest / fastest-growing query paths. All are
  // additive and idempotent. shift_notes and activity_log dominate over years of
  // a single worker's data; the dashboard fires several of these counts on every
  // app open. Partial `WHERE deleted_at IS NOT NULL` indexes keep the Deleted
  // Items page (which scans every soft-delete table) cheap without bloating the
  // common active-row queries.
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_shift_notes_active ON shift_notes (deleted_at, archived_at, shift_date DESC);
    CREATE INDEX IF NOT EXISTS idx_shift_notes_deleted ON shift_notes (deleted_at) WHERE deleted_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_reports_updated ON reports (deleted_at, archived_at, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reports_deleted ON reports (deleted_at) WHERE deleted_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_agreements_client ON service_agreements (client_id);
    CREATE INDEX IF NOT EXISTS idx_agreements_status ON service_agreements (deleted_at, archived_at, status, end_date);
    CREATE INDEX IF NOT EXISTS idx_agreements_deleted ON service_agreements (deleted_at) WHERE deleted_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_clients_deleted ON clients (deleted_at) WHERE deleted_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_templates_deleted ON templates (deleted_at) WHERE deleted_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_scheduled_shifts_deleted ON scheduled_shifts (deleted_at) WHERE deleted_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_client_documents_deleted ON client_documents (deleted_at) WHERE deleted_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_client_goals_deleted ON client_goals (deleted_at) WHERE deleted_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_incident_reports_deleted ON incident_reports (deleted_at) WHERE deleted_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_rp_deleted ON restrictive_practice_records (deleted_at) WHERE deleted_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_med_deleted ON medication_records (deleted_at) WHERE deleted_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_activity_action ON activity_log (action);
    CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_log (user_id);
  `)

  // Push notifications (added post-launch): track when a per-shift reminder was
  // pushed via ntfy so the every-minute reminder sweep never double-notifies for
  // the same scheduled shift. Null until a reminder is sent.
  addColumnIfMissing('scheduled_shifts', 'reminder_sent_at', 'TEXT')

  // Retire the NDIS plan start/end dates (removed post-launch). Independent
  // support workers track service-agreement expiry, not plan-manager plan
  // periods, so these columns are dropped from existing databases.
  dropColumnIfExists('clients', 'plan_start')
  dropColumnIfExists('clients', 'plan_end')

  // Multi-user access control (added post-launch). CareLane grew from a
  // single-operator tool; these support additional support-worker logins with
  // scoped access. `active` lets an admin deactivate a login without deleting
  // it (users are not hard-deleted so their authored records keep a valid
  // worker_id). `client_assignments` is the many-to-many grant that decides
  // which participants a worker may see — an admin sees every participant, a
  // worker only the ones assigned to them. Rosters are scoped by
  // `scheduled_shifts.worker_id` instead (a worker sees only their own shifts).
  addColumnIfMissing('users', 'active', 'INTEGER NOT NULL DEFAULT 1')
  // Per-user iCal subscription token (added post-launch). A random, unguessable
  // token grants read-only access to that user's roster as an .ics feed served
  // at `/calendar/<token>.ics` — the URL is the credential, so it is never shown
  // to another user and can be rotated to revoke old subscriptions. NULL until
  // the user generates one; see calendarFeedService.
  addColumnIfMissing('users', 'calendar_feed_token', 'TEXT')
  sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_calendar_feed_token ON users (calendar_feed_token) WHERE calendar_feed_token IS NOT NULL')
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS client_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  created_at TEXT,
  created_by INTEGER REFERENCES users(id),
  UNIQUE (user_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_client_assignments_user ON client_assignments (user_id);
CREATE INDEX IF NOT EXISTS idx_client_assignments_client ON client_assignments (client_id);
`)

  // Client-facing share links (added post-launch). A time-limited, audited,
  // read-only link lets a plan manager or the participant themselves fetch ONE
  // specific finalised report or completed document without a CareLane account —
  // the unguessable token in the URL is the only credential (mirroring the
  // calendar feed). Each link is scoped to a single resource + participant,
  // carries an expiry (and an optional view cap), and every fetch is counted and
  // written to the append-only audit trail. Links are revoked (not hard-deleted)
  // so the audit history of a shared item stays intact. See shareLinkService.
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS share_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  resource_type TEXT NOT NULL,
  resource_id INTEGER NOT NULL,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  label TEXT,
  created_by INTEGER REFERENCES users(id),
  expires_at TEXT NOT NULL,
  max_views INTEGER,
  view_count INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TEXT,
  revoked_at TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_share_links_token ON share_links (token);
CREATE INDEX IF NOT EXISTS idx_share_links_resource ON share_links (resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_share_links_client ON share_links (client_id);
`)

  // Client-portal login accounts (added post-launch). A participant can be given
  // a read-only portal login to view their OWN finalised shift notes and
  // completed documents. Kept in a table entirely separate from the staff
  // `users` table so a portal credential can never satisfy the staff auth
  // middleware or reach another participant's data — the session stores only a
  // `portalClientId`, never a `userId`. One account per participant (UNIQUE
  // client_id); an admin deactivates (not deletes) an account to revoke access.
  // See portalService / routes/portal.js.
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS client_portal_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) UNIQUE,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_client_portal_accounts_username ON client_portal_accounts (username);
CREATE UNIQUE INDEX IF NOT EXISTS idx_client_portal_accounts_client ON client_portal_accounts (client_id);
`)

  migrateChunkFts()

  // Blind-index keyword search over shift notes (added post-launch). The note
  // body is encrypted at rest, so the searchable text cannot live in a plain FTS
  // shadow table or be tokenised by a SQL trigger. Instead each note's words are
  // reduced to keyed per-word HMACs in the app layer (`shiftService.indexShift`)
  // and stored here; a keyword query is hashed the same way and matched via FTS5,
  // so search scales without ever writing note plaintext to the index. Maintained
  // from JS on every create/update — no triggers. `reindexSearch` backfills any
  // note missing a row (all of them on first run) and is a no-op once in sync.
  sqlite.exec('CREATE VIRTUAL TABLE IF NOT EXISTS shift_notes_fts USING fts5(tokens)')
  reindexShiftSearch()

  // Seal any legacy plaintext in columns promoted to at-rest encryption
  // (client health fields, report + agreement bodies). Idempotent.
  encryptLegacyPlaintextColumns()
}

/**
 * Create/repair the FTS5 keyword index over document_chunks. Idempotent.
 *
 * Earlier builds used an *external-content* FTS5 table whose delete trigger
 * used the special `('delete', rowid, content)` command. If that shadow index
 * ever drifted from document_chunks it raised `SQLITE_CORRUPT_VTAB` ("database
 * disk image is malformed") on the next delete/re-index. A self-contained FTS5
 * table with plain `DELETE FROM ... WHERE rowid = ?` triggers cannot reach that
 * state, so we migrate any external-content (or missing) table to this form and
 * rebuild it from the base data — the chunk rows themselves are never affected.
 */
function migrateChunkFts () {
  const existing = sqlite.prepare("SELECT sql FROM sqlite_master WHERE name = 'document_chunks_fts'").get()?.sql || ''
  const isSelfContained = existing && !/content\s*=/.test(existing)
  if (isSelfContained) return // already the robust form

  sqlite.exec(`
    DROP TRIGGER IF EXISTS document_chunks_ai;
    DROP TRIGGER IF EXISTS document_chunks_ad;
    DROP TRIGGER IF EXISTS document_chunks_au;
  `)
  try {
    sqlite.exec('DROP TABLE IF EXISTS document_chunks_fts')
  } catch {
    // A corrupt vtable can refuse a normal drop; clear its schema + shadow
    // tables directly, then recreate from scratch.
    sqlite.pragma('writable_schema = ON')
    sqlite.exec("DELETE FROM sqlite_master WHERE name LIKE 'document_chunks_fts%'")
    sqlite.pragma('writable_schema = OFF')
    for (const suffix of ['_data', '_idx', '_docsize', '_content', '_config']) {
      try { sqlite.exec(`DROP TABLE IF EXISTS document_chunks_fts${suffix}`) } catch { /* already gone */ }
    }
  }

  sqlite.exec(`
CREATE VIRTUAL TABLE document_chunks_fts USING fts5(content);
CREATE TRIGGER document_chunks_ai AFTER INSERT ON document_chunks BEGIN
  INSERT INTO document_chunks_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER document_chunks_ad AFTER DELETE ON document_chunks BEGIN
  DELETE FROM document_chunks_fts WHERE rowid = old.id;
END;
CREATE TRIGGER document_chunks_au AFTER UPDATE ON document_chunks BEGIN
  DELETE FROM document_chunks_fts WHERE rowid = old.id;
  INSERT INTO document_chunks_fts(rowid, content) VALUES (new.id, new.content);
END;
`)
  sqlite.exec('INSERT INTO document_chunks_fts(rowid, content) SELECT id, content FROM document_chunks')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
  console.log('migrations applied')
}
