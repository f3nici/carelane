import { z } from 'zod'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)')
const time = z.string().regex(/^\d{2}:\d{2}$/, 'must be HH:MM')
const optStr = z.string().trim().max(2000).nullish().transform(v => v || null)
const bool01 = z.union([z.boolean(), z.literal(0), z.literal(1)]).transform(v => (v === true || v === 1) ? 1 : 0)

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
  expiry_date: isoDate.nullish()
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
  claude_model_cheap: z.string().trim().max(120),
  claude_model_quality: z.string().trim().max(120),
  ai_tone: z.string().trim().max(500),
  disclaimer: z.string().trim().max(4000)
}).partial()

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
