import { describe, it, expect, beforeAll } from 'vitest'
import { freshDb } from './helpers/db.js'

let activity, sqlite

beforeAll(async () => {
  ({ sqlite } = await freshDb())
  activity = await import('../server/services/activityService.js')
})

describe('activityService hash chain', () => {
  it('chains each entry off the previous hash', () => {
    activity.logActivity('client', 1, null, 'created')
    activity.logActivity('client', 1, null, 'updated', { changes: [{ field: 'active', from: 1, to: 0 }] })
    const rows = sqlite.prepare('SELECT * FROM activity_log ORDER BY id ASC').all()
    expect(rows.length).toBe(2)
    expect(rows[0].prev_hash).toBe('0'.repeat(64))
    expect(rows[0].hash).toHaveLength(64)
    expect(rows[1].prev_hash).toBe(rows[0].hash)
  })

  it('verifies a clean chain', () => {
    const result = activity.verifyAuditChain()
    expect(result.valid).toBe(true)
    expect(result.verified).toBe(result.total)
    expect(result.broken_at).toBeNull()
  })

  it('detects tampering when a row is silently edited', () => {
    const first = sqlite.prepare('SELECT id FROM activity_log ORDER BY id ASC LIMIT 1').get()
    // Bypass the append-only trigger to simulate an attacker editing the table.
    sqlite.exec('DROP TRIGGER IF EXISTS activity_log_no_update')
    sqlite.prepare('UPDATE activity_log SET details = ? WHERE id = ?').run('{"tampered":true}', first.id)
    sqlite.exec(`CREATE TRIGGER IF NOT EXISTS activity_log_no_update
      BEFORE UPDATE ON activity_log BEGIN SELECT RAISE(ABORT, 'activity_log is append-only'); END;`)
    const result = activity.verifyAuditChain()
    expect(result.valid).toBe(false)
    expect(result.broken_at).toBe(first.id)
  })

  it('the append-only trigger blocks ordinary updates', () => {
    const row = sqlite.prepare('SELECT id FROM activity_log ORDER BY id ASC LIMIT 1').get()
    expect(() => sqlite.prepare('UPDATE activity_log SET action = ? WHERE id = ?').run('hacked', row.id)).toThrow(/append-only/i)
  })
})

describe('activityService field diffs & redaction', () => {
  it('diffChanges only reports fields that actually changed', () => {
    const before = { first_name: 'Sam', suburb: 'Perth', active: 1 }
    const after = { first_name: 'Samuel', suburb: 'Perth', active: 1 }
    const changes = activity.diffChanges(before, after, ['first_name', 'suburb', 'active'])
    expect(changes).toEqual([{ field: 'first_name', from: 'Sam', to: 'Samuel' }])
  })

  it('redacts PII/health change values but keeps safe ones', () => {
    activity.logActivity('client', 7, null, 'updated', {
      changes: [
        { field: 'first_name', from: 'Sam', to: 'Samuel' },
        { field: 'primary_disability', from: 'X', to: 'Y' },
        { field: 'plan_end', from: '2025-01-01', to: '2026-01-01' }
      ]
    })
    const row = sqlite.prepare('SELECT details FROM activity_log WHERE entity_id = 7 ORDER BY id DESC LIMIT 1').get()
    const changes = JSON.parse(row.details).changes
    const byField = Object.fromEntries(changes.map(c => [c.field, c]))
    expect(byField.first_name.to).toBe('[redacted]')
    expect(byField.primary_disability.from).toBe('[redacted]')
    expect(byField.plan_end.to).toBe('2026-01-01')
  })
})
