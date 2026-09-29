import { blindIndex } from './cryptoService.js'

/**
 * Participant pseudonymisation for Claude calls.
 *
 * Before any prompt leaves the server, the participant's identifying details
 * (names, plan-manager / emergency-contact names, NDIS number, phone, email)
 * are swapped for a stable per-participant code such as `PT-K7QMX`; when the
 * draft comes back, the codes are swapped back to the real values. The worker
 * only ever sees real names — the codes exist solely on the wire to Claude.
 *
 * The code is derived from a keyed HMAC of the participant id (the crypto
 * blind-index key), so it is random-looking, stable across calls (which keeps
 * the prompt cache warm), unguessable without the server secret, and needs no
 * extra storage.
 */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 5
const PREFIX = 'PT-'

// Given names / surnames that double as everyday words. These are only
// matched when capitalised (or ALL CAPS) so "I will" never becomes a code.
const COMMON_WORDS = new Set(`will may june april august rose grace hope faith joy mark bill sue pat ray
dawn eve iris ivy lily ruby amber summer autumn sky rich frank art jack bob don gene guy max sandy rob
brown white black green young wood king hill long day rice reed fox bell cook hunter ward baker grant
love hardy price lane page rain storm river brook dale glen heath penny sunny honey angel bear buddy
chase cash drew miles hunt mason carter nash park parker bishop marsh field ford stone rock star`.split(/\s+/))

const NOT_WORD_BEFORE = '(?<![\\p{L}\\p{N}])'
const NOT_WORD_AFTER = '(?![\\p{L}\\p{N}])'

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The participant's stable pseudonymous code (e.g. `PT-K7QMX`).
 * @param {number} clientId
 * @returns {string}
 */
export function participantCode (clientId) {
  const hex = blindIndex(`ai-pseudonym:${clientId}`)
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[parseInt(hex.slice(i * 2, i * 2 + 2), 16) % ALPHABET.length]
  return PREFIX + code
}

/** Regex source matching a name wherever it appears as a whole word. */
function nameSource (value) {
  const lowerOk = value.length >= 3 && !COMMON_WORDS.has(value.toLowerCase())
  const forms = new Set([value, value.toUpperCase()])
  const title = value.charAt(0).toUpperCase() + value.slice(1)
  forms.add(title)
  const alts = [...forms].map(escapeRe)
  const src = `${NOT_WORD_BEFORE}(?:${alts.join('|')})${NOT_WORD_AFTER}`
  return { src, flags: lowerOk ? 'giu' : 'gu' }
}

/** Regex source matching a number (NDIS / phone) with any spaces or dashes between digits. */
function digitsSource (value) {
  const digits = String(value).replace(/\D/g, '')
  if (digits.length < 6) return null
  return { src: `(?<!\\d)${digits.split('').join('[\\s-]?')}(?!\\d)`, flags: 'g', key: digits }
}

/**
 * Build a masker for one participant. `mask` swaps identifying details for
 * codes in outbound text; `unmask` swaps the codes in Claude's reply back to
 * the real values. Both are safe to call on text without any matches.
 * @param {object} client decrypted participant record (from clientService.getClient)
 * @returns {{code:string, label:string, mask:(text:any)=>any, unmask:(text:any)=>any}}
 */
export function pseudonymiserFor (client) {
  const code = participantCode(client.id)
  const entries = [] // { token, value, matcher:{src, flags} }
  const seen = new Set()

  const addName = (raw, suffix) => {
    const value = (raw || '').trim()
    if (!value) return
    const add = (v, token) => {
      const key = `n:${v.toLowerCase()}`
      if (v.length < 2 || seen.has(key)) return
      seen.add(key)
      entries.push({ token, value: v, matcher: nameSource(v) })
    }
    add(value, suffix ? `${code}-${suffix}` : code)
    // Multi-word names: also catch each word on its own ("Mary" of "Mary Jane").
    const words = value.split(/\s+/)
    if (words.length > 1) words.forEach((w, i) => add(w, `${code}-${suffix || 'P'}${i + 1}`))
  }
  const addDigits = (raw, suffix) => {
    const m = raw && digitsSource(raw)
    if (!m || seen.has(`d:${m.key}`)) return
    seen.add(`d:${m.key}`)
    entries.push({ token: `${code}-${suffix}`, value: String(raw).trim(), matcher: m })
  }

  // The preferred name (or first name) is the plain code; other parts get suffixes.
  const primary = client.preferred_name || client.first_name
  addName(primary, '')
  addName(client.first_name, 'G')
  addName(client.last_name, 'S')
  addName(client.plan_manager_name, 'M')
  addName(client.emergency_contact_name, 'E')
  addDigits(client.ndis_number, 'N')
  addDigits(client.phone, 'T')
  addDigits(client.emergency_contact_phone, 'U')
  if (client.email?.trim()) {
    entries.push({ token: `${code}-X`, value: client.email.trim(), matcher: { src: escapeRe(client.email.trim()), flags: 'gi' } })
  }

  // Longest value first so "Mary Jane" is replaced before "Mary".
  const outbound = [...entries]
    .sort((a, b) => b.value.length - a.value.length)
    .map(e => ({ re: new RegExp(e.matcher.src, e.matcher.flags), token: e.token }))
  const byToken = new Map(entries.map(e => [e.token.toUpperCase(), e.value]))
  const tokenSrc = `${NOT_WORD_BEFORE}${escapeRe(code)}(?:-[A-Z]\\d*)?${NOT_WORD_AFTER}`
  const codeRe = new RegExp(tokenSrc, 'giu')
  const splitRe = new RegExp(`(${tokenSrc})`, 'giu')

  // Replace one value at a time, never inside a code already substituted
  // (so a short surname can't match part of an earlier token).
  const mask = text => {
    if (typeof text !== 'string' || !text) return text
    return outbound.reduce((t, { re, token }) =>
      t.split(splitRe).map((seg, i) => (i % 2 ? seg : seg.replace(re, token))).join(''), text)
  }
  const unmask = text => {
    if (typeof text !== 'string' || !text) return text
    return text.replace(codeRe, m => {
      const upper = m.toUpperCase()
      if (byToken.has(upper)) return byToken.get(upper)
      // Unknown suffix: restore the base code and keep the rest.
      return (byToken.get(code) ?? code) + m.slice(code.length)
    })
  }
  return { code, label: code, mask, unmask }
}
