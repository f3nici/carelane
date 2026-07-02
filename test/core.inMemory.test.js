import { describe, it, expect, beforeAll } from 'vitest'
import Database from 'better-sqlite3'
import crypto from 'node:crypto'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { createServices, schema } from '@carelane/core'

// Proves `@carelane/core` runs against a host context built by hand — a fresh
// in-memory database and an injected `node:crypto` provider — with no server, no
// `../server/db/connection.js` singleton and no config. This is the exact shape
// the React Native app will reproduce (op-sqlite + react-native-quick-crypto),
// so a green run here is the portability guarantee.
let services, sqlite

beforeAll(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  // Minimal schema the exercised services touch (a subset of the real migration).
  sqlite.exec(`
    CREATE TABLE clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name TEXT NOT NULL, last_name TEXT NOT NULL, preferred_name TEXT,
      ndis_number TEXT, ndis_number_hash TEXT, date_of_birth TEXT, phone TEXT, email TEXT,
      address TEXT, suburb TEXT, state TEXT DEFAULT 'WA', postcode TEXT,
      plan_management_type TEXT, plan_manager_name TEXT, plan_manager_contact TEXT,
      primary_disability TEXT, communication_needs TEXT, support_goals TEXT,
      emergency_contact_name TEXT, emergency_contact_phone TEXT, notes TEXT,
      invoice_due_days INTEGER, active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT, updated_at TEXT, deleted_at TEXT
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, display_name TEXT);
    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id INTEGER,
      user_id INTEGER, action TEXT NOT NULL, details TEXT, created_at TEXT,
      prev_hash TEXT, hash TEXT
    );
  `)
  const db = drizzle(sqlite, { schema })
  // Fixed clock so audit timestamps are deterministic in the test.
  const now = () => Date.parse('2026-07-02T00:00:00.000Z')
  services = createServices({ db, sqlite, crypto, encryptionSecret: 'in-memory-test-secret', now })
})

describe('@carelane/core against an injected in-memory context', () => {
  it('seals and verifies the encryption canary with no server', () => {
    expect(services.crypto.assertEncryptionCanary()).toEqual({ created: true })
    expect(services.crypto.assertEncryptionCanary()).toEqual({ created: false })
  })

  it('creates a client, encrypting PII at rest and decrypting on read', () => {
    const created = services.client.createClient({
      first_name: 'Ada', last_name: 'Citizen', ndis_number: '430000001', suburb: 'Perth', active: 1
    })
    expect(created.first_name).toBe('Ada')
    expect(services.client.getClient(created.id).first_name).toBe('Ada')

    // The stored row holds ciphertext + a blind index, never the plaintext.
    const stored = sqlite.prepare('SELECT * FROM clients WHERE id = ?').get(created.id)
    expect(stored.first_name).toMatch(/^enc:/)
    expect(stored.first_name).not.toContain('Ada')
    expect(stored.ndis_number_hash).toBe(services.crypto.blindIndex('430000001'))

    // Blind-index search finds it without ever storing the NDIS number in the clear.
    const found = services.client.listClients({ perPage: 10, offset: 0 }, { q: '430000001' })
    expect(found.total).toBe(1)
    expect(found.rows[0].id).toBe(created.id)
  })

  it('appends to the tamper-evident audit chain and verifies it', () => {
    services.activity.logActivity('client', 1, null, 'created', { note: 'ok' })
    services.activity.logActivity('client', 1, null, 'updated', { note: 'ok2' })
    const result = services.activity.verifyAuditChain()
    expect(result.valid).toBe(true)
    expect(result.verified).toBeGreaterThanOrEqual(2)
  })
})
