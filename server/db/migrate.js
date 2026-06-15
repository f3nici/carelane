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
  migrateChunkFts()
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
