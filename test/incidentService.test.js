import { describe, it, expect, beforeAll } from 'vitest'
import { freshDb } from './helpers/db.js'

let incidentService, shiftService, clientService, deletedService, sqlite, workerId

beforeAll(async () => {
  ({ sqlite } = await freshDb())
  workerId = sqlite.prepare("INSERT INTO users (username, password_hash, role) VALUES ('w', 'x', 'admin')").run().lastInsertRowid
  incidentService = await import('../server/services/incidentService.js')
  shiftService = await import('../server/services/shiftService.js')
  clientService = await import('../server/services/clientService.js')
  deletedService = await import('../server/services/deletedService.js')
})

function makeClient () {
  return clientService.createClient({ first_name: 'Inc', last_name: 'Subject', preferred_name: 'IS', active: 1 })
}

const base = (over = {}) => ({
  client_id: over.client_id, incident_date: '2026-06-01', incident_type: 'injury',
  severity: 'moderate', reportable: 0, status: 'open', description: 'Tripped on a step.', ...over
})

describe('incidentService', () => {
  it('creates a report and encrypts the narrative at rest', () => {
    const c = makeClient()
    const inc = incidentService.createIncident(base({ client_id: c.id }), workerId)
    expect(inc.description).toBe('Tripped on a step.')
    expect(inc.client_display_name).toBe('IS')

    const raw = sqlite.prepare('SELECT description FROM incident_reports WHERE id = ?').get(inc.id)
    expect(raw.description).toMatch(/^enc:/)
    expect(raw.description).not.toContain('Tripped')
  })

  it('counts open and unreported-reportable incidents', () => {
    const c = makeClient()
    incidentService.createIncident(base({ client_id: c.id, reportable: 1, reported_to_ndis: 0 }), workerId)
    expect(incidentService.countOpenIncidents()).toBeGreaterThan(0)
    expect(incidentService.countUnreportedReportable()).toBeGreaterThan(0)
  })

  it('sets closed_at when an incident is closed and clears it when reopened', () => {
    const c = makeClient()
    const inc = incidentService.createIncident(base({ client_id: c.id }), workerId)
    const closed = incidentService.updateIncident(inc.id, { status: 'closed' })
    expect(closed.closed_at).toBeTruthy()
    const reopened = incidentService.updateIncident(inc.id, { status: 'open' })
    expect(reopened.closed_at).toBeNull()
  })

  it('promotes an incident-flagged shift note, prefilling the description, and refuses duplicates', () => {
    const c = makeClient()
    const shift = shiftService.createShift({
      client_id: c.id, shift_date: '2026-06-05', incident_flag: 1, incident_details: 'Bumped head, no injury.',
      follow_up_required: 0, billed: 0, finalised: 0
    }, workerId)
    const inc = incidentService.createFromShift(shift.id, workerId)
    expect(inc.shift_note_id).toBe(shift.id)
    expect(inc.description).toBe('Bumped head, no injury.')
    expect(() => incidentService.createFromShift(shift.id, workerId)).toThrow(/already/i)
  })

  it('refuses to promote a shift note that is not incident-flagged', () => {
    const c = makeClient()
    const shift = shiftService.createShift({
      client_id: c.id, shift_date: '2026-06-06', incident_flag: 0, follow_up_required: 0, billed: 0, finalised: 0
    }, workerId)
    expect(() => incidentService.createFromShift(shift.id, workerId)).toThrow(/not flagged/i)
  })

  it('builds an exportable markdown body with the key sections', () => {
    const c = makeClient()
    const inc = incidentService.createIncident(base({ client_id: c.id, reportable: 1, reportable_category: 'serious_injury', immediate_actions: 'Applied first aid.' }), workerId)
    const md = incidentService.buildIncidentMarkdown(incidentService.getIncident(inc.id))
    expect(md).toContain('## What happened')
    expect(md).toContain('Tripped on a step.')
    expect(md).toContain('Applied first aid.')
    expect(md).toContain('Serious injury')
  })

  it('soft-deletes and restores through the deleted registry', () => {
    const c = makeClient()
    const inc = incidentService.createIncident(base({ client_id: c.id }), workerId)
    incidentService.deleteIncident(inc.id)
    expect(() => incidentService.getIncident(inc.id)).toThrow(/not found/i)

    const entry = deletedService.listDeleted().find(i => i.entity_type === 'incident' && i.id === inc.id)
    expect(entry).toBeTruthy()

    deletedService.restoreDeleted('incident', inc.id)
    expect(incidentService.getIncident(inc.id).id).toBe(inc.id)
  })
})
