import { z } from 'zod'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)')
const time = z.string().regex(/^\d{2}:\d{2}$/, 'must be HH:MM')
const optStr = z.string().trim().max(2000).nullish().transform(v => v || null)
const bool01 = z.union([z.boolean(), z.literal(0), z.literal(1)]).transform(v => (v === true || v === 1) ? 1 : 0)

/**
 * Whether a host literal is a private, loopback, link-local or otherwise
 * non-public address. Used to keep an operator-set outbound URL (e.g. the ntfy
 * server) from targeting the host's own internal network or a cloud metadata
 * endpoint (169.254.169.254). This checks the literal only — it does not resolve
 * DNS, so a public hostname that resolves to a private IP is not caught by this
 * function alone. The outbound caller pairs it with a resolve-time check that
 * runs this against each resolved address before sending (see the DNS lookup in
 * `ntfyService.publish`), which closes that gap.
 * @param {string} host hostname or IP literal (no port/brackets)
 * @returns {boolean}
 */
export function isPrivateHost (host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  // IPv4 (incl. IPv4-mapped IPv6 like ::ffff:10.0.0.1)
  const v4 = h.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = v4.slice(1).map(Number)
    if (a === 10 || a === 127 || a === 0) return true // private / loopback / this-host
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
    if (a === 192 && b === 168) return true // 192.168.0.0/16
    if (a === 169 && b === 254) return true // link-local (incl. cloud metadata)
    if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
    return false
  }
  // IPv6
  if (h === '::1' || h === '::') return true // loopback / unspecified
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true // fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true // fe80::/10 link-local
  return false
}

/**
 * Whether a URL is a public http(s) address safe to use as an operator-set
 * outbound target. Rejects non-http(s) schemes and private/loopback/link-local
 * hosts (see {@link isPrivateHost}).
 * @param {string} value
 * @returns {boolean}
 */
export function isPublicHttpUrl (value) {
  let u
  try { u = new URL(String(value)) } catch { return false }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  return !isPrivateHost(u.hostname)
}

export const loginSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
  token: z.string().trim().max(20).nullish() // TOTP code or recovery code (when 2FA is enabled)
})

export const totpConfirmSchema = z.object({
  token: z.string().trim().min(6).max(10)
})

export const totpDisableSchema = z.object({
  password: z.string().min(1)
})

export const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  // A self-hosted single-operator admin account — favour length over composition rules.
  new_password: z.string().min(10, 'must be at least 10 characters').max(200)
})

// Passkey (WebAuthn) ceremony bodies. The `response` object is the raw
// attestation/assertion produced by the browser; @simplewebauthn validates its
// internal structure, so here we only assert it is present.
export const passkeyRegisterSchema = z.object({
  response: z.object({}).passthrough(),
  name: z.string().trim().max(60).nullish()
})

export const passkeyLoginSchema = z.object({
  response: z.object({}).passthrough()
})

export const passkeyRenameSchema = z.object({
  name: z.string().trim().min(1).max(60)
})

// Operator second-factor enforcement policy.
export const securityPolicySchema = z.object({
  require_2fa: bool01
})

export const activityQuerySchema = z.object({
  entity_type: z.string().trim().max(40).nullish(),
  entity_id: z.coerce.number().int().positive().nullish(),
  action: z.string().trim().max(40).nullish(),
  user_id: z.coerce.number().int().positive().nullish(),
  from: isoDate.nullish(),
  to: isoDate.nullish(),
  page: z.coerce.number().int().positive().nullish(),
  per_page: z.coerce.number().int().positive().max(100).nullish()
})

export const clientSchema = z.object({
  first_name: z.string().trim().min(1),
  last_name: z.string().trim().min(1),
  preferred_name: optStr,
  ndis_number: z.string().regex(/^\d{9}$/, 'NDIS number must be 9 digits').nullish().or(z.literal('').transform(() => null)),
  date_of_birth: isoDate.nullish(),
  phone: optStr,
  email: z.string().email().nullish().or(z.literal('').transform(() => null)),
  address: optStr,
  suburb: optStr,
  state: z.string().trim().max(3).default('WA'),
  postcode: optStr,
  plan_management_type: z.enum(['self', 'plan_managed', 'ndia_managed']).nullish(),
  plan_manager_name: optStr,
  plan_manager_contact: optStr,
  primary_disability: optStr,
  communication_needs: optStr,
  support_goals: z.string().trim().max(10000).nullish().transform(v => v || null),
  emergency_contact_name: optStr,
  emergency_contact_phone: optStr,
  notes: z.string().trim().max(20000).nullish().transform(v => v || null),
  invoice_due_days: z.coerce.number().int().min(0).max(365).nullish(),
  active: bool01.default(1)
})

export const agreementSchema = z.object({
  client_id: z.number().int().positive(),
  title: z.string().trim().min(1),
  status: z.enum(['draft', 'active', 'expired', 'cancelled']).default('draft'),
  start_date: isoDate.nullish(),
  end_date: isoDate.nullish(),
  review_date: isoDate.nullish(),
  supports_summary: z.string().max(20000).nullish().transform(v => v || null),
  hourly_rate: z.number().nonnegative().nullish(),
  total_budget: z.number().nonnegative().nullish(),
  questionnaire_json: z.record(z.string(), z.any()).nullish(),
  body_markdown: z.string().max(200000).nullish().transform(v => v || null),
  line_items: z.array(z.object({
    billing_code_id: z.number().int().positive().nullish(),
    description: optStr,
    unit_price: z.number().nonnegative().nullish(),
    estimated_quantity: z.number().nonnegative().nullish()
  })).nullish()
})

export const shiftSchema = z.object({
  client_id: z.number().int().positive(),
  shift_date: isoDate,
  start_time: time.nullish(),
  end_time: time.nullish(),
  duration_hours: z.number().positive().max(24).nullish(),
  billing_code_id: z.number().int().positive().nullish(),
  location: optStr,
  support_provided: z.string().max(20000).nullish().transform(v => v || null),
  body: z.string().max(100000).nullish().transform(v => v || null),
  participant_response: z.string().max(20000).nullish().transform(v => v || null),
  incident_flag: bool01.default(0),
  incident_details: z.string().max(50000).nullish().transform(v => v || null),
  follow_up_required: bool01.default(0),
  billed: bool01.default(0),
  finalised: bool01.default(0)
})

const weekdays = z.array(z.number().int().min(0).max(6)).max(7)

export const scheduledShiftSchema = z.object({
  client_id: z.number().int().positive(),
  // Support worker this shift is rostered to. Optional (defaults to the acting
  // user) so the single-operator flow is unchanged; an admin sets it to roster a
  // shift to a specific worker.
  worker_id: z.number().int().positive().nullish(),
  title: optStr,
  scheduled_date: isoDate,
  start_time: time.nullish(),
  end_time: time.nullish(),
  billing_code_id: z.number().int().positive().nullish(),
  location: optStr,
  plan_notes: z.string().max(20000).nullish().transform(v => v || null)
})

export const recurrenceSchema = z.object({
  client_id: z.number().int().positive(),
  worker_id: z.number().int().positive().nullish(),
  title: optStr,
  frequency: z.enum(['daily', 'weekly', 'fortnightly', 'monthly']).default('weekly'),
  interval: z.number().int().positive().max(52).default(1),
  weekdays: weekdays.nullish(),
  start_date: isoDate,
  until_date: isoDate.nullish(),
  start_time: time.nullish(),
  end_time: time.nullish(),
  billing_code_id: z.number().int().positive().nullish(),
  location: optStr,
  plan_notes: z.string().max(20000).nullish().transform(v => v || null),
  active: bool01.default(1)
})

// Note fields supplied at clock-out. client_id is taken from the scheduled
// shift; the date/times default to the clocked values but may be overridden
// when the operator corrects them before saving.
export const scheduleNoteSchema = z.object({
  shift_date: isoDate.nullish(),
  start_time: time.nullish(),
  end_time: time.nullish(),
  billing_code_id: z.number().int().positive().nullish(),
  location: optStr,
  support_provided: z.string().max(20000).nullish().transform(v => v || null),
  body: z.string().max(100000).nullish().transform(v => v || null),
  participant_response: z.string().max(20000).nullish().transform(v => v || null),
  incident_flag: bool01.default(0),
  incident_details: z.string().max(50000).nullish().transform(v => v || null),
  follow_up_required: bool01.default(0)
})

export const googleSettingsSchema = z.object({
  enabled: bool01.optional(),
  calendar_id: z.string().trim().max(200).optional(),
  timezone: z.string().trim().max(60).optional()
})

// ntfy push notifications. All keys optional so the settings card can PATCH just
// the fields it changed. Topic follows ntfy's allowed characters; an empty topic
// clears the connection. Timings drive the digest time and reminder lead.
export const ntfySettingsSchema = z.object({
  enabled: bool01.optional(),
  // Restricted to a public http(s) host so a visitor/operator can't point the
  // outbound push at the host's own network or a cloud metadata endpoint (SSRF).
  server_url: z.string().trim().url().max(300)
    .refine(isPublicHttpUrl, 'server URL must be a public http(s) address').optional(),
  topic: z.string().trim().regex(/^[-_A-Za-z0-9]{0,64}$/, 'topic may use letters, numbers, - and _').optional(),
  priority: z.enum(['min', 'low', 'default', 'high', 'max']).optional(),
  notify_plan_reviews: bool01.optional(),
  notify_incidents: bool01.optional(),
  notify_unbilled: bool01.optional(),
  notify_shift_reminders: bool01.optional(),
  digest_time: time.optional(),
  plan_review_days: z.coerce.number().int().min(0).max(365).optional(),
  unbilled_days: z.coerce.number().int().min(0).max(365).optional(),
  shift_reminder_minutes: z.coerce.number().int().min(0).max(1440).optional(),
  timeout_ms: z.coerce.number().int().min(1000).max(120000).optional()
})

export const squareSettingsSchema = z.object({
  enabled: bool01.optional(),
  location_id: z.string().trim().max(64).optional(),
  currency: z.string().trim().length(3).optional()
})

export const reportSchema = z.object({
  client_id: z.number().int().positive(),
  report_type: z.enum(['progress', 'plan_review', 'incident', 'general']).default('progress'),
  period_start: isoDate.nullish(),
  period_end: isoDate.nullish(),
  body_markdown: z.string().max(500000).nullish().transform(v => v || null),
  source_shift_ids: z.array(z.number().int().positive()).nullish(),
  status: z.enum(['draft', 'final']).default('draft')
})

// Client-facing share link. A time-limited, audited, read-only link to ONE
// finalised report or completed document, for a plan manager or the participant
// to fetch without an account. `expires_in_days` bounds its lifetime (default 2
// weeks); an optional `max_views` caps how many times the item can be fetched.
export const shareLinkSchema = z.object({
  resource_type: z.enum(['report', 'client_document']),
  resource_id: z.coerce.number().int().positive(),
  client_id: z.coerce.number().int().positive(),
  label: z.string().trim().max(200).nullish().transform(v => v || null),
  expires_in_days: z.coerce.number().int().min(1).max(365).default(14),
  max_views: z.coerce.number().int().min(1).max(10000).nullish().transform(v => v ?? null)
})

export const billingCodeSchema = z.object({
  code: z.string().trim().min(1),
  name: z.string().trim().min(1),
  support_category: optStr,
  registration_group: optStr,
  unit: z.enum(['H', 'E', 'D', 'WK', 'MON']).default('H'),
  price_cap_standard: z.number().nonnegative().nullish(),
  price_cap_remote: z.number().nonnegative().nullish(),
  price_cap_very_remote: z.number().nonnegative().nullish(),
  quote_required: bool01.default(0),
  price_guide_version: optStr,
  active: bool01.default(1)
})

export const billingImportCommitSchema = z.object({
  price_guide_version: z.string().trim().min(1),
  rows: z.array(billingCodeSchema.omit({ price_guide_version: true, active: true })).min(1),
  deactivate_missing: bool01.default(0)
})

// Editable metadata for a completed/consent document. issue_date/expiry_date
// drive the expiry surfacing; the file itself is uploaded separately (multipart).
export const clientDocumentMetaSchema = z.object({
  title: z.string().trim().min(1).max(200),
  doc_type: z.enum(['media_consent', 'consent_to_share', 'consent_general', 'service_agreement',
    'behaviour_support_plan', 'risk_assessment', 'insurance', 'identification', 'other']).default('other'),
  issue_date: isoDate.nullish(),
  expiry_date: isoDate.nullish(),
  // Acknowledge an expiring/expired document so it stops surfacing on the dashboard.
  acknowledged: bool01.optional()
})

// Structured participant goal. The free-text description is plain text (like
// support_goals / supports_summary); detailed progress observations live in
// encrypted progress notes.
export const goalSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().max(10000).nullish().transform(v => v || null),
  category: z.string().trim().max(100).nullish().transform(v => v || null),
  status: z.enum(['active', 'achieved', 'on_hold', 'discontinued']).default('active'),
  target_date: isoDate.nullish(),
  sort_order: z.coerce.number().int().min(0).max(9999).default(0)
})

export const goalProgressSchema = z.object({
  note_date: isoDate.nullish(),
  progress_rating: z.coerce.number().int().min(1).max(5).nullish(),
  body: z.string().trim().max(20000).nullish().transform(v => v || null)
})

// Structured incident report. The categorical fields (type/severity/reportable
// category) drive the register and dashboard; the narrative fields are encrypted
// at rest in the service layer. NDIS reportable categories follow the five
// classes of reportable incident under the NDIS Commission rules.
export const incidentReportSchema = z.object({
  client_id: z.number().int().positive(),
  shift_note_id: z.number().int().positive().nullish(),
  reference_no: z.string().trim().max(60).nullish().transform(v => v || null),
  incident_date: isoDate,
  incident_time: time.nullish(),
  location: optStr,
  incident_type: z.enum(['injury', 'illness', 'medication_error', 'behaviour',
    'property_damage', 'abuse_neglect', 'restrictive_practice', 'death', 'absconding', 'other']).default('other'),
  severity: z.enum(['minor', 'moderate', 'major', 'critical']).default('minor'),
  reportable: bool01.default(0),
  reportable_category: z.enum(['death', 'serious_injury', 'abuse_or_neglect',
    'unlawful_contact', 'sexual_misconduct', 'unauthorised_restrictive_practice']).nullish(),
  description: z.string().max(50000).nullish().transform(v => v || null),
  immediate_actions: z.string().max(50000).nullish().transform(v => v || null),
  persons_involved: z.string().max(20000).nullish().transform(v => v || null),
  witnesses: z.string().max(20000).nullish().transform(v => v || null),
  injuries: z.string().max(20000).nullish().transform(v => v || null),
  contributing_factors: z.string().max(20000).nullish().transform(v => v || null),
  reported_to_ndis: bool01.default(0),
  reported_to_ndis_date: isoDate.nullish(),
  notified_parties: z.string().max(20000).nullish().transform(v => v || null),
  follow_up_actions: z.string().max(50000).nullish().transform(v => v || null),
  follow_up_due_date: isoDate.nullish(),
  status: z.enum(['open', 'in_progress', 'closed']).default('open')
})

// Restrictive-practice use record (NDIS-regulated). Narrative fields encrypted.
export const restrictivePracticeSchema = z.object({
  practice_type: z.enum(['chemical', 'physical', 'mechanical', 'environmental', 'seclusion']).default('environmental'),
  used_at_date: isoDate,
  used_at_time: time.nullish(),
  duration_minutes: z.coerce.number().int().min(0).max(10000).nullish(),
  authorised: bool01.default(0),
  authorisation_ref: z.string().trim().max(120).nullish().transform(v => v || null),
  reported_to_commission: bool01.default(0),
  shift_note_id: z.number().int().positive().nullish(),
  description: z.string().max(20000).nullish().transform(v => v || null),
  antecedent: z.string().max(20000).nullish().transform(v => v || null),
  alternatives_tried: z.string().max(20000).nullish().transform(v => v || null),
  outcome: z.string().max(20000).nullish().transform(v => v || null)
})

// Medication administration record (MAR). Name/dose plain (listable); the PRN /
// refusal reason and notes are encrypted at rest.
export const medicationRecordSchema = z.object({
  medication_name: z.string().trim().min(1).max(200),
  dose: z.string().trim().max(120).nullish().transform(v => v || null),
  route: z.enum(['oral', 'topical', 'inhaled', 'injection', 'sublingual', 'other']).nullish(),
  administered_date: isoDate,
  administered_time: time.nullish(),
  prn: bool01.default(0),
  status: z.enum(['administered', 'refused', 'missed', 'withheld', 'self_administered']).default('administered'),
  shift_note_id: z.number().int().positive().nullish(),
  reason: z.string().max(20000).nullish().transform(v => v || null),
  notes: z.string().max(20000).nullish().transform(v => v || null),
  witnessed_by: z.string().trim().max(120).nullish().transform(v => v || null)
})

export const clientBillingCodesSchema = z.object({
  codes: z.array(z.object({
    billing_code_id: z.number().int().positive(),
    custom_rate: z.number().nonnegative().nullish()
  }))
})

export const templateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  template_type: z.enum(['agreement', 'report']).default('agreement'),
  report_type: z.enum(['progress', 'plan_review', 'incident', 'general']).nullish(),
  description: z.string().trim().max(2000).nullish().transform(v => v || null),
  body_markdown: z.string().trim().min(1).max(200000),
  is_default: bool01.default(0),
  active: bool01.default(1)
})

// Explicit allow-list of operator-editable settings. Zod strips unknown keys by
// default, so the Settings page can keep POSTing the whole settings object back
// while any key not listed here (e.g. logo_filename, enc_canary,
// google_refresh_token_enc, integration status fields) is silently dropped
// rather than written. Logo is set only via the dedicated upload endpoint;
// integration toggles only via their dedicated settings endpoints.
const hexColor = z.string().trim().regex(/^#[0-9a-fA-F]{3,8}$/, 'must be a hex colour')
export const settingsSchema = z.object({
  business_name: z.string().trim().max(200),
  abn: z.string().trim().max(50),
  business_address: z.string().trim().max(500),
  business_phone: z.string().trim().max(50),
  business_email: z.string().trim().max(200),
  brand_primary_color: hexColor,
  brand_accent_color: hexColor,
  default_price_region: z.string().trim().max(50),
  public_api_enabled: bool01,
  claude_enabled: bool01,
  claude_model_cheap: z.string().trim().max(120),
  claude_model_quality: z.string().trim().max(120),
  ai_tone: z.string().trim().max(500),
  disclaimer: z.string().trim().max(4000)
}).partial()

// Multi-user account management (admin only). A worker login is a username +
// display name + role, created with an initial password the worker can later
// change. Usernames are lower-cased/trimmed to keep the login lookup stable.
const username = z.string().trim().toLowerCase().min(3, 'must be at least 3 characters').max(60)
  .regex(/^[a-z0-9._-]+$/, 'letters, numbers, dot, underscore and hyphen only')
const userPassword = z.string().min(10, 'must be at least 10 characters').max(200)

export const userCreateSchema = z.object({
  username,
  display_name: z.string().trim().min(1).max(120),
  password: userPassword,
  role: z.enum(['admin', 'worker']).default('worker')
})

export const userUpdateSchema = z.object({
  display_name: z.string().trim().min(1).max(120).optional(),
  role: z.enum(['admin', 'worker']).optional(),
  active: bool01.optional()
})

export const userPasswordResetSchema = z.object({
  new_password: userPassword
})

// Replace the full set of participant ids a worker is assigned to (admin only).
export const assignmentsSchema = z.object({
  client_ids: z.array(z.number().int().positive()).max(2000)
})

// Replace the full set of worker (user) ids assigned to a participant.
export const clientWorkersSchema = z.object({
  user_ids: z.array(z.number().int().positive()).max(2000)
})

// Client-portal login (participant-facing). Mirrors the staff login shape but is
// a wholly separate surface (see routes/portal.js).
export const portalLoginSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1)
})

// Admin-managed client-portal account. `username` reuses the same character
// rules as a staff login; `password` is optional on update (present only when
// (re)setting it). `active` toggles access without removing the account.
export const portalAccountSchema = z.object({
  username,
  password: userPassword.optional(),
  active: bool01.optional()
})

export const portalPasswordSchema = z.object({
  new_password: userPassword
})

export const askSchema = z.object({
  question: z.string().trim().min(3).max(2000)
})

export const shiftDraftSchema = z.object({
  bullets: z.string().trim().min(3).max(10000).nullish(),
  tone: z.string().trim().max(200).nullish()
})

export const agreementDraftSchema = z.object({
  template_id: z.number().int().positive().nullish()
})

export const reportDraftSchema = z.object({
  shift_ids: z.array(z.number().int().positive()).nullish(),
  template_id: z.number().int().positive().nullish()
})
