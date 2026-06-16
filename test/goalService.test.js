import { describe, it, expect, beforeAll } from 'vitest'
import { freshDb } from './helpers/db.js'

let goalService, clientService, deletedService, sqlite

beforeAll(async () => {
  ({ sqlite } = await freshDb())
  goalService = await import('../server/services/goalService.js')
  clientService = await import('../server/services/clientService.js')
  deletedService = await import('../server/services/deletedService.js')
})

function makeClient () {
  return clientService.createClient({ first_name: 'Goal', last_name: 'Owner', preferred_name: 'GO', active: 1 })
}

describe('goalService', () => {
  it('creates a goal and adds an encrypted progress note', () => {
    const c = makeClient()
    const goal = goalService.createGoal(c.id, { title: 'Travel by bus', status: 'active', target_date: '2026-12-01' })
    expect(goal.title).toBe('Travel by bus')
    expect(goal.sort_order).toBe(0)

    const updated = goalService.addProgressNote(c.id, goal.id, { note_date: '2026-06-01', progress_rating: 3, body: 'Practised at the stop.' })
    expect(updated.progress).toHaveLength(1)
    expect(updated.progress[0].body).toBe('Practised at the stop.')

    // Body is ciphertext at rest, never plaintext.
    const raw = sqlite.prepare('SELECT body FROM goal_progress_notes WHERE goal_id = ?').get(goal.id)
    expect(raw.body).toMatch(/^enc:/)
    expect(raw.body).not.toContain('Practised')
  })

  it('summarises active goals + recent progress for AI reports', () => {
    const c = makeClient()
    const g = goalService.createGoal(c.id, { title: 'Cook a meal', status: 'active' })
    goalService.addProgressNote(c.id, g.id, { note_date: '2026-05-01', progress_rating: 4, body: 'Made pasta with prompting.' })
    const summary = goalService.buildGoalsSummary(c.id)
    expect(summary).toContain('Cook a meal')
    expect(summary).toContain('Made pasta with prompting.')
    expect(summary).toContain('4/5')
  })

  it('returns null summary when there are no structured goals', () => {
    const c = makeClient()
    expect(goalService.buildGoalsSummary(c.id)).toBeNull()
  })

  it('lists goals with a progress summary and orders achieved after active', () => {
    const c = makeClient()
    const a = goalService.createGoal(c.id, { title: 'Active one', status: 'active' })
    goalService.createGoal(c.id, { title: 'Done one', status: 'achieved' })
    goalService.addProgressNote(c.id, a.id, { note_date: '2026-04-04', body: 'note' })
    const list = goalService.listGoals(c.id)
    expect(list[0].status).toBe('active')
    expect(list.find(x => x.id === a.id).progress_count).toBe(1)
    expect(list.find(x => x.id === a.id).last_progress_date).toBe('2026-04-04')
  })

  it('soft-deletes and restores a goal through the deleted registry', () => {
    const c = makeClient()
    const g = goalService.createGoal(c.id, { title: 'Restore me', status: 'active' })
    goalService.deleteGoal(c.id, g.id)
    expect(() => goalService.getGoal(c.id, g.id)).toThrow(/not found/i)

    const entry = deletedService.listDeleted().find(i => i.entity_type === 'goal' && i.id === g.id)
    expect(entry).toBeTruthy()
    expect(entry.label).toBe('Restore me')

    deletedService.restoreDeleted('goal', g.id)
    expect(goalService.getGoal(c.id, g.id).id).toBe(g.id)
  })

  it('removes a single progress note without deleting the goal', () => {
    const c = makeClient()
    const g = goalService.createGoal(c.id, { title: 'Keep goal', status: 'active' })
    const withNote = goalService.addProgressNote(c.id, g.id, { note_date: '2026-03-03', body: 'temp' })
    const noteId = withNote.progress[0].id
    const after = goalService.deleteProgressNote(c.id, g.id, noteId)
    expect(after.progress).toHaveLength(0)
    expect(goalService.getGoal(c.id, g.id).id).toBe(g.id)
  })
})
