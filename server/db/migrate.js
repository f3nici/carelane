import { sqlite } from './connection.js'
import { backfillAuditHashes } from '../services/activityService.js'

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
  plan_start TEXT,
  plan_end TEXT,
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
  filename TEXT NOT NULL,
  original_name TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  created_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_client_documents_client ON client_documents (client_id);

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
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
  console.log('migrations applied')
}
