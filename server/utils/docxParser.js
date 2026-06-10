import mammoth from 'mammoth'

const CODE_RE = /^\d{2}_\d{3,}_\d{4}_\d+_\d+(?:_T)?$/

/** Strip tags/entities from an HTML fragment. */
function cellText (html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#?\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function parsePrice (text) {
  if (!text) return null
  const m = String(text).replace(/,/g, '').match(/\$?\s*(\d+(?:\.\d+)?)/)
  return m ? Math.round(parseFloat(m[1]) * 100) / 100 : null
}

/**
 * Map a header cell to a billing_codes column, matching by header text rather
 * than fixed position (the layout shifts between price-guide versions).
 * @param {string} h lowercased header text
 */
function headerToField (h) {
  if (/item.*number|support item number|^number$|^code$/.test(h)) return 'code'
  if (/item.*name|^name$|^support item$/.test(h)) return 'name'
  if (/category/.test(h)) return 'support_category'
  if (/registration group/.test(h)) return 'registration_group'
  if (/^unit/.test(h)) return 'unit'
  if (/very remote/.test(h)) return 'price_cap_very_remote'
  if (/\bremote\b/.test(h)) return 'price_cap_remote'
  if (/national|standard|act|nsw|qld|vic|wa|sa|tas|nt/.test(h)) return 'price_cap_standard'
  if (/quote/.test(h)) return 'quote_required'
  return null
}

function normaliseUnit (text) {
  const t = (text || '').trim().toUpperCase()
  if (['H', 'E', 'D', 'WK', 'MON'].includes(t)) return t
  if (/HOUR/.test(t)) return 'H'
  if (/EACH/.test(t)) return 'E'
  if (/DAY/.test(t)) return 'D'
  if (/WEEK/.test(t)) return 'WK'
  if (/MON|ANNUAL|YEAR/.test(t)) return 'MON'
  return 'H'
}

/**
 * Walk parsed table rows mapped via a header row into billing-code rows.
 * @param {string[][]} rows table rows as arrays of cell text
 * @param {Array} out accumulator
 */
function walkTable (rows, out) {
  if (!rows.length) return
  const headerIdx = rows.findIndex(r => r.some(c => headerToField(c.toLowerCase()) === 'code'))
  if (headerIdx === -1) return
  const fields = rows[headerIdx].map(c => headerToField(c.toLowerCase()))
  for (const row of rows.slice(headerIdx + 1)) {
    const item = {}
    fields.forEach((f, i) => { if (f && row[i] !== undefined) item[f] = row[i] })
    if (!item.code || !CODE_RE.test(item.code.trim())) continue
    const quote = /y(es)?|true|✓/i.test(item.quote_required || '')
    out.push({
      code: item.code.trim(),
      name: (item.name || '').trim() || item.code.trim(),
      support_category: item.support_category?.trim() || null,
      registration_group: item.registration_group?.trim() || null,
      unit: normaliseUnit(item.unit),
      price_cap_standard: parsePrice(item.price_cap_standard),
      price_cap_remote: parsePrice(item.price_cap_remote),
      price_cap_very_remote: parsePrice(item.price_cap_very_remote),
      quote_required: quote ? 1 : 0,
      confidence: item.name && (parsePrice(item.price_cap_standard) !== null || quote) ? 'high' : 'low'
    })
  }
}

/**
 * Parse the NDIS Pricing Arrangements .docx into candidate billing-code rows.
 * Columns are matched by header text. Parsing is fully local — nothing is
 * sent to any API.
 * @param {Buffer} buffer the uploaded .docx
 * @returns {Promise<Array>} rows for preview (each with a `confidence` flag)
 */
export async function parsePriceGuideDocx (buffer) {
  const { value: html } = await mammoth.convertToHtml({ buffer })
  const out = []
  const tables = html.match(/<table[\s\S]*?<\/table>/g) || []
  for (const table of tables) {
    const rows = (table.match(/<tr[\s\S]*?<\/tr>/g) || [])
      .map(tr => (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/g) || []).map(cellText))
    walkTable(rows, out)
  }
  return out
}

/**
 * Best-effort fallback parse of the price-guide PDF text. Reconstructs rows by
 * locating support-item codes and trailing dollar amounts on each line. Less
 * reliable than the Word document — rows are flagged `low` confidence unless a
 * name and price were both recovered.
 * @param {string} text extracted PDF text
 * @returns {Array}
 */
export function parsePriceGuidePdfText (text) {
  const out = []
  const lineRe = /(\d{2}_\d{3,}_\d{4}_\d+_\d+(?:_T)?)\s+(.+)/g
  let m
  while ((m = lineRe.exec(text)) !== null) {
    const rest = m[2].replace(/\n/g, ' ')
    const prices = [...rest.matchAll(/\$?\s?(\d{1,4}\.\d{2})\b/g)].map(p => parseFloat(p[1]))
    const name = rest.replace(/\$?\s?\d{1,4}\.\d{2}\b/g, '').replace(/\s+/g, ' ').trim()
    const unitMatch = name.match(/\b(H|E|D|WK|MON)\b\s*$/)
    out.push({
      code: m[1],
      name: name.replace(/\b(H|E|D|WK|MON)\b\s*$/, '').trim() || m[1],
      support_category: null,
      registration_group: null,
      unit: unitMatch ? unitMatch[1] : 'H',
      price_cap_standard: prices[0] ?? null,
      price_cap_remote: prices[1] ?? null,
      price_cap_very_remote: prices[2] ?? null,
      quote_required: prices.length === 0 ? 1 : 0,
      confidence: name && prices.length ? 'medium' : 'low'
    })
  }
  return out
}
