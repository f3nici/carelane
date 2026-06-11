import { describe, it, expect, beforeAll } from 'vitest'
import { freshDb } from './helpers/db.js'

let templateService, sqlite

const pg = { page: 1, perPage: 20, offset: 0 }

beforeAll(async () => {
  ({ sqlite } = await freshDb())
  templateService = await import('../server/services/templateService.js')
})

describe('templateService', () => {
  it('creates a template and lists it', () => {
    const t = templateService.createTemplate({
      name: 'My agreement', template_type: 'agreement', report_type: null,
      description: 'house style', body_markdown: '# Service Agreement\n## Parties', is_default: 0, active: 1
    })
    expect(t.id).toBeTruthy()
    expect(t.name).toBe('My agreement')
    const { rows, total } = templateService.listTemplates(pg, { template_type: 'agreement' })
    expect(total).toBeGreaterThan(0)
    expect(rows.some(r => r.id === t.id)).toBe(true)
  })

  it('enforces a single default per type', () => {
    const a = templateService.createTemplate({ name: 'A', template_type: 'report', report_type: 'progress', body_markdown: '## Summary', is_default: 1, active: 1 })
    const b = templateService.createTemplate({ name: 'B', template_type: 'report', report_type: 'progress', body_markdown: '## Summary', is_default: 1, active: 1 })
    expect(templateService.getTemplate(a.id).is_default).toBe(0)
    expect(templateService.getTemplate(b.id).is_default).toBe(1)
  })

  it('resolves an explicit template by id and rejects a type mismatch', () => {
    const agree = templateService.createTemplate({ name: 'Agree', template_type: 'agreement', body_markdown: '# X', is_default: 0, active: 1 })
    const resolved = templateService.resolveTemplateForDraft('agreement', { templateId: agree.id })
    expect(resolved.id).toBe(agree.id)
    expect(resolved.body_markdown).toBe('# X')
    expect(() => templateService.resolveTemplateForDraft('report', { templateId: agree.id })).toThrow(/not report/i)
  })

  it('falls back to the matching default when no id is given', () => {
    const def = templateService.resolveTemplateForDraft('report', { reportType: 'progress' })
    expect(def).not.toBeNull()
    expect(def.body_markdown).toContain('## Summary')
  })

  it('returns null when no default exists for the type', () => {
    expect(templateService.resolveTemplateForDraft('agreement')).toBeNull()
  })

  it('soft-deletes rather than hard-deleting', () => {
    const t = templateService.createTemplate({ name: 'Temp', template_type: 'agreement', body_markdown: '# X', is_default: 0, active: 1 })
    templateService.deleteTemplate(t.id)
    const raw = sqlite.prepare('SELECT deleted_at FROM templates WHERE id = ?').get(t.id)
    expect(raw.deleted_at).toBeTruthy()
    expect(() => templateService.getTemplate(t.id)).toThrow(/not found/i)
  })

  it('refuses to resolve an inactive template', () => {
    const t = templateService.createTemplate({ name: 'Off', template_type: 'agreement', body_markdown: '# X', is_default: 0, active: 0 })
    expect(() => templateService.resolveTemplateForDraft('agreement', { templateId: t.id })).toThrow(/inactive/i)
  })
})
