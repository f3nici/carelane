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

/** Stable system block shared across calls — marked for prompt caching. */
function baseSystem () {
  return [{
    type: 'text',
    text: `You are a documentation assistant for an independent NDIS support worker in Australia.
You produce DRAFTS only — the worker reviews, edits and finalises everything.
Style: ${tone()}. Write respectfully and person-centredly, in line with the NDIS Code of Conduct:
factual, strengths-based, no diagnoses or judgements beyond what the worker reported, no invented details.
Use the participant's preferred name or initials exactly as given. Australian English.`,
    cache_control: { type: 'ephemeral' }
  }]
}

/**
 * Run a non-streaming Claude call and log token usage to the audit trail.
 * @param {object} params messages API params
 * @param {{userId?:number, feature:string}} ctx
 */
async function complete (params, ctx) {
  const response = await getClient().messages.create(params)
  logActivity('ai', null, ctx.userId ?? null, 'ai_drafted', {
    feature: ctx.feature,
    model: params.model,
    input_tokens: response.usage?.input_tokens,
    output_tokens: response.usage?.output_tokens
  })
  return response.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
}

/**
 * Shift-note assist (Haiku): turn the worker's structured bullets into a
 * clean, professional progress note draft.
 * @param {{clientLabel:string, shiftDate:string, durationHours?:number, supportProvided:string, participantResponse?:string, incident?:string}} input
 * @param {number} userId
 */
export async function draftShiftNote (input, userId) {
  const user = `Draft a progress note for a support shift. Participant: ${input.clientLabel}. Date: ${input.shiftDate}.` +
    (input.durationHours ? ` Duration: ${input.durationHours}h.` : '') +
    `\nSupport provided (worker's bullets):\n${input.supportProvided}` +
    (input.participantResponse ? `\nParticipant response:\n${input.participantResponse}` : '') +
    (input.incident ? `\nIncident to document factually:\n${input.incident}` : '') +
    '\nWrite 1-3 short paragraphs. First person ("I supported..."). Only include what is stated above.'
  return complete({
    model: cheapModel(),
    max_tokens: 600,
    system: baseSystem(),
    messages: [{ role: 'user', content: user }]
  }, { userId, feature: 'shift_note' })
}

/**
 * Cheaply condense one shift note to 1–2 lines (Haiku) — used before report
 * drafting so full notes are never dumped into one large call.
 * @param {{date:string, note:string}} shift
 * @param {number} userId
 */
export async function condenseShift (shift, userId) {
  return complete({
    model: cheapModel(),
    max_tokens: 120,
    system: baseSystem(),
    messages: [{
      role: 'user',
      content: `Condense this shift note to 1-2 factual lines (keep date ${shift.date}):\n${shift.note.slice(0, 4000)}`
    }]
  }, { userId, feature: 'condense_shift' })
}

/**
 * Report assist (Sonnet): draft a progress / plan-review report from
 * pre-condensed shift summaries, aligned to the participant's goals.
 * @param {{clientLabel:string, reportType:string, periodStart:string, periodEnd:string, goals?:string, shiftSummaries:string[]}} input
 * @param {number} userId
 */
export async function draftReport (input, userId) {
  const user = `Draft a ${input.reportType.replace('_', ' ')} report for participant ${input.clientLabel}, period ${input.periodStart} to ${input.periodEnd}.` +
    (input.goals ? `\nParticipant goals:\n${input.goals}` : '') +
    `\nCondensed shift summaries:\n- ${input.shiftSummaries.join('\n- ')}` +
    '\nStructure (markdown): ## Summary, ## Supports Provided, ## Progress Toward Goals, ## Observations, ## Recommendations.' +
    ' Base everything strictly on the summaries and goals above.'
  return complete({
    model: qualityModel(),
    max_tokens: 1800,
    system: baseSystem(),
    messages: [{ role: 'user', content: user }]
  }, { userId, feature: 'report' })
}

/**
 * Service agreement assist (Sonnet): fill the server-side template from the
 * intake questionnaire plus top-k retrieved guideline chunks.
 * @param {{clientLabel:string, questionnaire:object}} input
 * @param {number} userId
 */
export async function draftAgreement (input, userId) {
  const chunks = await searchChunks('NDIS service agreement requirements cancellation consent complaints', 3)
    .catch(() => [])
  const guidance = chunks.length
    ? `\nRelevant guideline excerpts (cite nothing, just align with them):\n${chunks.map(c => `[${c.title} p.${c.page}] ${c.content.slice(0, 700)}`).join('\n')}`
    : ''
  const template = `# Service Agreement
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
  const user = `Fill this service agreement template for participant ${input.clientLabel}. Keep the headings exactly; write plain-English clauses under each.\nTemplate:\n${template}\nQuestionnaire answers (JSON):\n${JSON.stringify(input.questionnaire)}${guidance}\nLeave signature lines blank. Do not invent prices or terms not given.`
  return complete({
    model: qualityModel(),
    max_tokens: 2500,
    system: baseSystem(),
    messages: [{ role: 'user', content: user }]
  }, { userId, feature: 'agreement' })
}

/**
 * Grounded guideline Q&A (Sonnet): retrieve top-k chunks locally, answer with
 * citations (document title + page). Read-only helper.
 * @param {string} question
 * @param {number} userId
 * @returns {Promise<{answer:string, sources:Array}>}
 */
export async function askGuidelines (question, userId) {
  const chunks = await searchChunks(question, 5)
  if (!chunks.length) {
    return { answer: 'No indexed guideline documents found. Upload NDIS guideline PDFs to the Knowledge Base first.', sources: [] }
  }
  const context = chunks.map((c, i) => `[${i + 1}] (${c.title}, p.${c.page}) ${c.content}`).join('\n\n')
  const answer = await complete({
    model: qualityModel(),
    max_tokens: 800,
    system: baseSystem(),
    messages: [{
      role: 'user',
      content: `Answer using ONLY these excerpts from the worker's NDIS document library. Cite as (Title, p.X). If the excerpts don't answer it, say so.\n\n${context}\n\nQuestion: ${question}`
    }]
  }, { userId, feature: 'guideline_qa' })
  return { answer, sources: chunks.map(c => ({ title: c.title, page: c.page, snippet: c.content.slice(0, 300) })) }
}

/**
 * Rough token estimate for the cost indicator shown before sending.
 * @param {string} text
 */
export function estimateTokens (text) {
  return Math.ceil((text || '').length / 4)
}
