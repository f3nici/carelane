import { ApiError } from '../errors.js'

/**
 * Operator-defined, reusable drafting templates. A template is a markdown
 * skeleton (headings + house wording) that Claude follows when drafting a
 * service agreement or report, so generated documents stay consistent.
 * Templates hold no participant PII, so they are not encrypted at rest.
 */

const COLUMNS = ['name', 'template_type', 'report_type', 'description', 'body_markdown', 'is_default', 'active']

/**
 * Build the template service bound to a host context.
 * @param {import('./index.js').CoreContext} ctx
 */
export function createTemplateService (ctx) {
  const { sqlite } = ctx
  const now = () => new Date(ctx.now()).toISOString()

  /**
   * List templates with optional type / active filters.
   * @param {{page:number, perPage:number, offset:number}} pg
   * @param {{template_type?:string, active?:string}} filters
   */
  function listTemplates (pg, filters = {}) {
    const where = ['deleted_at IS NULL']
    const params = []
    if (filters.template_type) { where.push('template_type = ?'); params.push(filters.template_type) }
    if (filters.active !== undefined && filters.active !== '') {
      where.push('active = ?'); params.push(filters.active === 'true' || filters.active === '1' || filters.active === 1 ? 1 : 0)
    }
    const whereSql = 'WHERE ' + where.join(' AND ')
    const total = sqlite.prepare(`SELECT COUNT(*) AS c FROM templates ${whereSql}`).get(...params).c
    const rows = sqlite.prepare(`SELECT * FROM templates ${whereSql}
      ORDER BY template_type, is_default DESC, name LIMIT ? OFFSET ?`)
      .all(...params, pg.perPage, pg.offset)
    return { rows, total }
  }

  /**
   * Fetch one template or throw 404.
   * @param {number} id
   */
  function getTemplate (id) {
    const row = sqlite.prepare('SELECT * FROM templates WHERE id = ? AND deleted_at IS NULL').get(id)
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Template not found')
    return row
  }

  /**
   * Ensure at most one default template exists per (template_type, report_type)
   * by clearing the flag on the others. Runs inside the caller's transaction.
   * @param {string} templateType
   * @param {string|null} reportType
   * @param {number} [exceptId]
   */
  function clearOtherDefaults (templateType, reportType, exceptId) {
    sqlite.prepare(`UPDATE templates SET is_default = 0, updated_at = ?
      WHERE template_type = ? AND COALESCE(report_type, '') = COALESCE(?, '')
        AND is_default = 1 AND id != ? AND deleted_at IS NULL`)
      .run(now(), templateType, reportType ?? null, exceptId ?? 0)
  }

  /**
   * Create a template.
   * @param {object} data validated payload
   */
  function createTemplate (data) {
    const ts = now()
    const values = COLUMNS.map(c => data[c] ?? null)
    const cols = [...COLUMNS, 'created_at', 'updated_at']
    const tx = sqlite.transaction(() => {
      const result = sqlite.prepare(`INSERT INTO templates (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...values, ts, ts)
      if (data.is_default) clearOtherDefaults(data.template_type, data.report_type ?? null, Number(result.lastInsertRowid))
      return result.lastInsertRowid
    })
    return getTemplate(tx())
  }

  /**
   * Update a template.
   * @param {number} id
   * @param {object} data
   */
  function updateTemplate (id, data) {
    const existing = getTemplate(id)
    const sets = []
    const params = []
    for (const col of COLUMNS) {
      if (!(col in data)) continue
      sets.push(`${col} = ?`)
      params.push(data[col] ?? null)
    }
    if (!sets.length) return existing
    const templateType = data.template_type ?? existing.template_type
    const reportType = 'report_type' in data ? data.report_type : existing.report_type
    const tx = sqlite.transaction(() => {
      sets.push('updated_at = ?')
      params.push(now(), id)
      sqlite.prepare(`UPDATE templates SET ${sets.join(', ')} WHERE id = ?`).run(...params)
      if (data.is_default) clearOtherDefaults(templateType, reportType ?? null, id)
    })
    tx()
    return getTemplate(id)
  }

  /**
   * Soft-delete a template (kept for audit/record retention — never hard-deleted).
   * @param {number} id
   */
  function deleteTemplate (id) {
    getTemplate(id)
    sqlite.prepare('UPDATE templates SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id)
  }

  /**
   * Restore a soft-deleted template. Throws 404 if it does not exist or is not
   * currently deleted.
   * @param {number} id
   */
  function restoreTemplate (id) {
    const row = sqlite.prepare('SELECT id FROM templates WHERE id = ? AND deleted_at IS NOT NULL').get(id)
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Deleted template not found')
    sqlite.prepare('UPDATE templates SET deleted_at = NULL, updated_at = ? WHERE id = ?').run(now(), id)
    return getTemplate(id)
  }

  /**
   * Resolve the template body Claude should follow for a draft. An explicit
   * `templateId` wins; otherwise the active default for the type (and report
   * sub-type, when given) is used. Returns null when nothing is configured, so
   * the AI service falls back to its built-in structure.
   * @param {'agreement'|'report'} templateType
   * @param {{templateId?:number, reportType?:string}} [opts]
   * @returns {{id:number, name:string, body_markdown:string}|null}
   */
  function resolveTemplateForDraft (templateType, opts = {}) {
    if (opts.templateId) {
      const t = getTemplate(opts.templateId)
      if (t.template_type !== templateType) {
        throw new ApiError(409, 'TEMPLATE_TYPE_MISMATCH', `Template is for ${t.template_type}, not ${templateType}`)
      }
      if (!t.active) throw new ApiError(409, 'TEMPLATE_INACTIVE', 'Template is inactive')
      return { id: t.id, name: t.name, body_markdown: t.body_markdown }
    }
    // Prefer a default matching the report sub-type, then a generic default.
    const candidates = sqlite.prepare(`SELECT * FROM templates
      WHERE template_type = ? AND is_default = 1 AND active = 1 AND deleted_at IS NULL
      ORDER BY CASE WHEN COALESCE(report_type, '') = COALESCE(?, '') THEN 0 ELSE 1 END LIMIT 1`)
      .get(templateType, opts.reportType ?? null)
    return candidates ? { id: candidates.id, name: candidates.name, body_markdown: candidates.body_markdown } : null
  }

  return {
    listTemplates,
    getTemplate,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    restoreTemplate,
    resolveTemplateForDraft
  }
}
