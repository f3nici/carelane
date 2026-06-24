import Anthropic from '@anthropic-ai/sdk'
import config from '../config.js'
import { ApiError } from '../middleware/errorHandler.js'
import { getSetting } from './settingsService.js'
import { searchChunks } from './ragService.js'
import { logActivity } from './activityService.js'

/**
 * All Claude usage in CareLane is draft generation behind explicit user
 * action. Outputs are drafts the worker must review, edit, and finalise.
 * Token-optimisation rules applied here:
 *  - compact, structured inputs (bullets, initials — never whole records/PDFs)
 *  - retrieve-then-generate: only top-k locally-embedded guideline chunks
 *  - prompt caching on the stable system block
 *  - tight max_tokens per task, usage logged per call
 */

let client = null
function getClient () {
  if (!config.anthropicApiKey) {
    throw new ApiError(503, 'AI_UNAVAILABLE', 'ANTHROPIC_API_KEY is not configured')
  }
  if (!client) client = new Anthropic({ apiKey: config.anthropicApiKey })
  return client
}

const cheapModel = () => getSetting('claude_model_cheap', config.claudeModelCheap)
const qualityModel = () => getSetting('claude_model_quality', config.claudeModelQuality)
const tone = () => getSetting('ai_tone', 'professional, warm, person-centred')

/** Whether the operator has switched AI drafting on (default on when unset). */
const aiEnabled = () => !!getSetting('claude_enabled', 1)

/**
 * Guard the operator-facing draft/ask features: refuse when AI drafting has been
 * turned off in Settings, even though the API key is present. Connectivity
 * testing deliberately bypasses this so the key can still be verified while off.
 */
function assertEnabled () {
  if (!aiEnabled()) throw new ApiError(503, 'AI_DISABLED', 'AI drafting is turned off in Settings')
}

/** Shared persona text — identical across every call, so it anchors the cache. */
function personaText () {
  return `You are a documentation assistant for an independent NDIS support worker in Australia.
You produce DRAFTS only — the worker reviews, edits and finalises everything.
Style: ${tone()}. Write respectfully and person-centredly, in line with the NDIS Code of Conduct:
factual, strengths-based, no diagnoses or judgements beyond what the worker reported, no invented details.
Use the participant's preferred name or initials exactly as given. Australian English.`
}

/** Persona-only system block (cached) — used by the short Haiku tasks. */
function baseSystem () {
  return [{ type: 'text', text: personaText(), cache_control: { type: 'ephemeral' } }]
}

/**
 * Build a system array whose stable prefix (persona + per-feature instructions
 * + template/guidance) is marked for prompt caching, so repetitive drafts —
 * continuation rounds, re-drafts of the same record, several agreements off the
 * same template within the cache TTL — reuse it instead of reprocessing.
 * The volatile per-record data is kept out of here, in the user turn.
 * Caching only engages once the prefix passes the model's minimum (~2048
 * tokens on Sonnet 4.6); below that the marker is a harmless no-op.
 * @param {string} stable feature instructions + template + guidance
 */
function cachedSystem (stable) {
  return [
    { type: 'text', text: personaText() },
    { type: 'text', text: stable, cache_control: { type: 'ephemeral' } }
  ]
}

/** Wrap a user turn as a content block, optionally cached (for repetitive drafts). */
function userMessage (text, cache = false) {
  const block = { type: 'text', text }
  if (cache) block.cache_control = { type: 'ephemeral' }
  return { role: 'user', content: [block] }
}

/**
 * Rough ~4 chars/token estimate over a whole assembled prompt (every system
 * block plus the user turn) — a cheap pre-send indicator, not a billed figure.
 * @param {Array|string} system system array (block form) or text
 * @param {string} user the user turn
 */
function estimatePromptTokens (system, user) {
  const sys = Array.isArray(system) ? system.map(b => b.text || '').join('') : (system || '')
  return Math.ceil((sys.length + (user || '').length) / 4)
}

/**
 * Run a Claude call and log token usage to the audit trail. When the model
 * stops because it hit `max_tokens` partway through a long document, keep
 * going (up to `ctx.maxContinuations` extra rounds) and stitch the pieces
 * together — otherwise agreements/reports get truncated mid-clause. The
 * continuation is asked for in a fresh user turn rather than by prefilling the
 * assistant message, which the quality model (Sonnet 4.6) rejects with a 400.
 * @param {object} params messages API params
 * @param {{userId?:number, feature:string, maxContinuations?:number}} ctx
 */
async function complete (params, ctx) {
  const messages = [...params.messages]
  const parts = []
  const usage = { input_tokens: 0, output_tokens: 0 }
  const maxContinuations = ctx.maxContinuations ?? 0
  for (let round = 0; ; round++) {
    const response = await getClient().messages.create({ ...params, messages })
    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
    parts.push(text)
    // Tally the real token usage the API reports — summed across continuation
    // rounds so callers get the true cost of the whole draft, not a guess.
    usage.input_tokens += response.usage?.input_tokens ?? 0
    usage.output_tokens += response.usage?.output_tokens ?? 0
    logActivity('ai', null, ctx.userId ?? null, 'ai_drafted', {
      feature: ctx.feature,
      model: params.model,
      input_tokens: response.usage?.input_tokens,
      output_tokens: response.usage?.output_tokens,
      truncated: response.stop_reason === 'max_tokens' ? 1 : 0
    })
    if (response.stop_reason !== 'max_tokens' || round >= maxContinuations) break
    messages.push({ role: 'assistant', content: text })
    messages.push({ role: 'user', content: 'That response was cut off before the end. Continue exactly where you left off — do not repeat any text already written and do not add a preamble.' })
  }
  return { text: parts.join(''), usage }
}

/**
 * Shift-note assist (Haiku): turn the worker's structured bullets into a
 * clean, professional progress note draft.
 * @param {{clientLabel:string, shiftDate:string, durationHours?:number, supportProvided:string, participantResponse?:string, incident?:string}} input
 * @param {number} userId
 */
/** Assemble the shift-note prompt. Shared by the draft and the estimate. */
function shiftNoteUserPrompt (input) {
  return `Draft a progress note for a support shift. Participant: ${input.clientLabel}. Date: ${input.shiftDate}.` +
    (input.durationHours ? ` Duration: ${input.durationHours}h.` : '') +
    `\nSupport provided (worker's bullets):\n${input.supportProvided}` +
    (input.participantResponse ? `\nParticipant response:\n${input.participantResponse}` : '') +
    (input.incident ? `\nIncident to document factually:\n${input.incident}` : '') +
    '\nWrite 1-3 short paragraphs. First person ("I supported..."). Only include what is stated above.'
}

export async function draftShiftNote (input, userId) {
  assertEnabled()
  const { text, usage } = await complete({
    model: cheapModel(),
    max_tokens: 600,
    system: baseSystem(),
    messages: [{ role: 'user', content: shiftNoteUserPrompt(input) }]
  }, { userId, feature: 'shift_note' })
  return { body: text, usage }
}

/** Pre-send token estimate for a shift-note draft (whole assembled prompt). */
export function estimateShiftNoteTokens (input) {
  return estimatePromptTokens(baseSystem(), shiftNoteUserPrompt(input))
}

/**
 * Cheaply condense one shift note to 1–2 lines (Haiku) — used before report
 * drafting so full notes are never dumped into one large call.
 * @param {{date:string, note:string}} shift
 * @param {number} userId
 */
export async function condenseShift (shift, userId) {
  const { text } = await complete({
    model: cheapModel(),
    max_tokens: 120,
    system: baseSystem(),
    messages: [{
      role: 'user',
      content: `Condense this shift note to 1-2 factual lines (keep date ${shift.date}):\n${shift.note.slice(0, 4000)}`
    }]
  }, { userId, feature: 'condense_shift' })
  return text
}

/** Default report structure used when no operator template is selected. */
const DEFAULT_REPORT_TEMPLATE = `## Summary
## Supports Provided
## Progress Toward Goals
## Observations
## Recommendations`

/**
 * Report assist (Sonnet): draft a progress / plan-review report from
 * pre-condensed shift summaries, aligned to the participant's goals. When an
 * operator template is supplied, Claude follows its structure and wording.
 * @param {{clientLabel:string, reportType:string, periodStart:string, periodEnd:string, goals?:string, shiftSummaries:string[], template?:{name:string, body_markdown:string}}} input
 * @param {number} userId
 */
/**
 * Assemble the report prompt as a cacheable stable system prefix (instructions
 * + template) plus a volatile user turn (the participant's period, goals and
 * shift summaries). Shared by the draft and the pre-send estimate.
 * @param {{clientLabel:string, reportType:string, periodStart:string, periodEnd:string, goals?:string, shiftSummaries:string[], template?:{name:string, body_markdown:string}}} input
 */
function reportPrompt (input) {
  const structure = input.template?.body_markdown || DEFAULT_REPORT_TEMPLATE
  const stable = `Task: draft a ${input.reportType.replace('_', ' ')} report from the worker's condensed shift summaries, aligned to the participant's goals.\n` +
    `Follow this template${input.template ? ` ("${input.template.name}")` : ''} exactly — keep its headings and house wording, and fill each section only from the material provided. Base everything strictly on the summaries and goals; do not invent details.\n` +
    `Template:\n${structure}`
  const user = `Participant: ${input.clientLabel}. Reporting period: ${input.periodStart} to ${input.periodEnd}.` +
    (input.goals ? `\nParticipant goals:\n${input.goals}` : '') +
    `\nCondensed shift summaries:\n- ${(input.shiftSummaries || []).join('\n- ')}`
  return { system: cachedSystem(stable), user }
}

export async function draftReport (input, userId) {
  assertEnabled()
  const { system, user } = reportPrompt(input)
  const { text } = await complete({
    model: qualityModel(),
    max_tokens: 6000,
    system,
    messages: [userMessage(user, true)]
  }, { userId, feature: 'report', maxContinuations: 2 })
  return text
}

/**
 * Pre-send token estimate for a report draft (whole assembled prompt).
 * @param {object} input same shape as draftReport; pass note proxies as shiftSummaries
 */
export function estimateReportTokens (input) {
  const { system, user } = reportPrompt(input)
  return estimatePromptTokens(system, user)
}

/** Default service-agreement structure used when no operator template is selected. */
const DEFAULT_AGREEMENT_TEMPLATE = `# Service Agreement
## Parties
## Supports Provided
## Schedule of Supports and Prices
## Invoicing and Payment
## Cancellations and Notice
## Responsibilities of the Provider
## Responsibilities of the Participant
## Privacy and Consent
## Feedback, Complaints and Disputes
## Ending or Changing this Agreement
## Agreement Period and Review
## Signatures`

/**
 * Service agreement assist (Sonnet): fill the operator's template (or the
 * built-in default) from the intake questionnaire plus top-k retrieved
 * guideline chunks.
 * @param {{clientLabel:string, questionnaire:object, template?:{name:string, body_markdown:string}}} input
 * @param {number} userId
 */
/** Retrieve the fixed top-k guideline excerpts used to ground agreement drafts. */
async function agreementGuidance () {
  const chunks = await searchChunks('NDIS service agreement requirements cancellation consent complaints', 3)
    .catch(() => [])
  return chunks.length
    ? `\nRelevant guideline excerpts (cite nothing, just align with them):\n${chunks.map(c => `[${c.title} p.${c.page}] ${c.content.slice(0, 700)}`).join('\n')}`
    : ''
}

/**
 * Assemble the agreement prompt as a cacheable stable system prefix (the
 * template-adherence instructions + template + guideline excerpts — identical
 * across every agreement off the same template) plus a volatile user turn (the
 * participant label + questionnaire). Shared by the draft and the estimate.
 * @param {{clientLabel:string, questionnaire:object, template?:{name:string, body_markdown:string}}} input
 * @param {string} guidance retrieved guideline excerpts (from agreementGuidance)
 */
function agreementPrompt (input, guidance) {
  const template = input.template?.body_markdown || DEFAULT_AGREEMENT_TEMPLATE
  const stable = `Task: fill out an NDIS service agreement from the template below${input.template ? ` ("${input.template.name}")` : ''}.\n` +
    'Follow the template EXACTLY:\n' +
    '- Reproduce every heading verbatim, in the same order, with the same heading levels. Do not add, remove, rename, merge, or reorder any section.\n' +
    '- Preserve all fixed/house wording exactly as written; only fill in the clause text that belongs under each heading.\n' +
    '- Where the template has a placeholder or blank, complete it from the questionnaire; if the answer is not provided, write "[to be confirmed]" rather than inventing it.\n' +
    'Write clauses in plain English. Leave signature lines blank. Do not invent prices or terms not given.\n' +
    `Template:\n${template}${guidance}`
  const user = `Produce the agreement above for participant ${input.clientLabel}.\nQuestionnaire answers (JSON):\n${JSON.stringify(input.questionnaire)}`
  return { system: cachedSystem(stable), user }
}

export async function draftAgreement (input, userId) {
  assertEnabled()
  const guidance = await agreementGuidance()
  const { system, user } = agreementPrompt(input, guidance)
  const { text } = await complete({
    model: qualityModel(),
    max_tokens: 8000,
    system,
    messages: [userMessage(user, true)]
  }, { userId, feature: 'agreement', maxContinuations: 2 })
  return text
}

/**
 * Pre-send token estimate for an agreement draft (whole assembled prompt,
 * including the retrieved guideline excerpts).
 * @param {{clientLabel:string, questionnaire:object, template?:{name:string, body_markdown:string}}} input
 */
export async function estimateAgreementTokens (input) {
  const guidance = await agreementGuidance()
  const { system, user } = agreementPrompt(input, guidance)
  return estimatePromptTokens(system, user)
}

/**
 * Whether the Claude API is configured (the key is an env secret, never stored),
 * whether the operator has switched drafting on, plus the active model ids.
 * Powers the Settings integration card and gates AI tips/UI across the app.
 * @returns {{configured:boolean, enabled:boolean, model_cheap:string, model_quality:string}}
 */
export function aiStatus () {
  return {
    configured: !!config.anthropicApiKey,
    enabled: aiEnabled(),
    model_cheap: cheapModel(),
    model_quality: qualityModel()
  }
}

/**
 * Lightweight connectivity check for the Claude API: send a tiny prompt to the
 * cheap model and report whether the configured key + model are reachable.
 * Backs the Settings "Test connection" button. Never stores anything; the
 * request is intentionally minimal (a few tokens) to keep it ~free.
 * @returns {Promise<{ok:boolean, model?:string, error?:string}>}
 */
export async function testConnection () {
  if (!config.anthropicApiKey) return { ok: false, error: 'ANTHROPIC_API_KEY is not configured' }
  const model = cheapModel()
  try {
    await getClient().messages.create({
      model,
      max_tokens: 4,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }]
    })
    return { ok: true, model }
  } catch (err) {
    return { ok: false, model, error: err?.message || 'Request failed' }
  }
}

/**
 * Grounded guideline Q&A (Sonnet): retrieve top-k chunks locally, answer with
 * citations (document title + page). Read-only helper.
 * @param {string} question
 * @param {number} userId
 * @returns {Promise<{answer:string, sources:Array, usage?:{input_tokens:number, output_tokens:number}}>}
 */
export async function askGuidelines (question, userId) {
  assertEnabled()
  const chunks = await searchChunks(question, 5)
  if (!chunks.length) {
    return { answer: 'No indexed guideline documents found. Upload NDIS guideline PDFs to the Knowledge Base first.', sources: [] }
  }
  const context = chunks.map((c, i) => `[${i + 1}] (${c.title}, p.${c.page}) ${c.content}`).join('\n\n')
  const { text, usage } = await complete({
    model: qualityModel(),
    max_tokens: 800,
    system: baseSystem(),
    messages: [{
      role: 'user',
      content: `Answer using ONLY these excerpts from the worker's NDIS document library. Cite as (Title, p.X). If the excerpts don't answer it, say so.\n\n${context}\n\nQuestion: ${question}`
    }]
  }, { userId, feature: 'guideline_qa' })
  return { answer: text, sources: chunks.map(c => ({ document_id: c.document_id, title: c.title, page: c.page, snippet: c.content.slice(0, 300) })), usage }
}
