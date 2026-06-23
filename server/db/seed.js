import bcrypt from 'bcryptjs'
import { sqlite } from './connection.js'
import { migrate } from './migrate.js'
import config from '../config.js'
import { NTFY_DEFAULTS } from '../services/ntfyService.js'

const now = () => new Date().toISOString()

/** Hand-curated starter set of common Core support items (2024-25 price guide). */
const starterBillingCodes = [
  { code: '01_011_0107_1_1', name: 'Assistance With Self-Care Activities - Standard - Weekday Daytime', category: 'Assistance with Daily Life (Core)', unit: 'H', cap: 67.56 },
  { code: '01_015_0107_1_1', name: 'Assistance With Self-Care Activities - Standard - Weekday Evening', category: 'Assistance with Daily Life (Core)', unit: 'H', cap: 74.44 },
  { code: '01_013_0107_1_1', name: 'Assistance With Self-Care Activities - Standard - Saturday', category: 'Assistance with Daily Life (Core)', unit: 'H', cap: 95.07 },
  { code: '01_014_0107_1_1', name: 'Assistance With Self-Care Activities - Standard - Sunday', category: 'Assistance with Daily Life (Core)', unit: 'H', cap: 122.59 },
  { code: '01_012_0107_1_1', name: 'Assistance With Self-Care Activities - Standard - Public Holiday', category: 'Assistance with Daily Life (Core)', unit: 'H', cap: 150.10 },
  { code: '04_104_0125_6_1', name: 'Access Community Social And Rec Activities - Standard - Weekday Daytime', category: 'Assistance with Social, Economic and Community Participation (Core)', unit: 'H', cap: 67.56 },
  { code: '04_105_0125_6_1', name: 'Access Community Social And Rec Activities - Standard - Weekday Evening', category: 'Assistance with Social, Economic and Community Participation (Core)', unit: 'H', cap: 74.44 },
  { code: '04_106_0125_6_1', name: 'Access Community Social And Rec Activities - Standard - Saturday', category: 'Assistance with Social, Economic and Community Participation (Core)', unit: 'H', cap: 95.07 },
  { code: '01_020_0120_1_1', name: 'House Cleaning And Other Household Activities', category: 'Assistance with Daily Life (Core)', unit: 'H', cap: 58.17 },
  { code: '01_799_0107_1_1', name: 'Provider Travel - Non-Labour Costs', category: 'Assistance with Daily Life (Core)', unit: 'E', cap: 1.00 }
]

/**
 * Starter drafting templates — the built-in agreement/report structures made
 * visible and editable. Marked default so they apply automatically until the
 * operator customises or replaces them.
 */
const starterTemplates = [
  {
    name: 'Standard service agreement',
    template_type: 'agreement',
    report_type: null,
    description: 'Default NDIS service agreement structure used for new agreements.',
    body_markdown: `# Service Agreement
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
  },
  {
    name: 'Standard progress report',
    template_type: 'report',
    report_type: 'progress',
    description: 'Default progress / plan-review report structure.',
    body_markdown: `## Summary
## Supports Provided
## Progress Toward Goals
## Observations
## Recommendations`
  }
]

const defaultSettings = {
  business_name: 'CareLane Support Services',
  abn: '',
  business_address: '',
  business_phone: '',
  business_email: '',
  logo_filename: '',
  brand_primary_color: '#2563eb',
  brand_accent_color: '#14b8a6',
  default_price_region: config.defaultPriceRegion,
  public_api_enabled: config.publicApiEnabled,
  claude_model_cheap: config.claudeModelCheap,
  claude_model_quality: config.claudeModelQuality,
  ai_tone: 'professional, warm, person-centred',
  square_invoicing_enabled: 0,
  square_currency: 'AUD',
  // ntfy push notification defaults (server URL, topic, toggles, timings).
  ...NTFY_DEFAULTS,
  disclaimer: 'CareLane is a documentation tool. It does not replace your obligations under the NDIS Practice Standards and Code of Conduct. AI outputs are drafts and must be reviewed before use.'
}

/**
 * First-run seed: default admin user, default settings, starter billing codes.
 * Idempotent — only inserts what is missing.
 */
export function seed () {
  migrate()
  const ts = now()

  const userCount = sqlite.prepare('SELECT COUNT(*) AS c FROM users').get().c
  if (userCount === 0) {
    const hash = bcrypt.hashSync(config.defaultPassword, 12)
    sqlite.prepare(`INSERT INTO users (username, password_hash, display_name, role, created_at, updated_at)
      VALUES (?, ?, ?, 'admin', ?, ?)`).run(config.defaultUsername, hash, 'Administrator', ts, ts)
    console.log(`seeded default admin user '${config.defaultUsername}'`)
  }

  const insertSetting = sqlite.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
  for (const [key, value] of Object.entries(defaultSettings)) {
    insertSetting.run(key, JSON.stringify(value))
  }

  const codeCount = sqlite.prepare('SELECT COUNT(*) AS c FROM billing_codes').get().c
  if (codeCount === 0) {
    const insert = sqlite.prepare(`INSERT INTO billing_codes
      (code, name, support_category, unit, price_cap_standard, quote_required, price_guide_version, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, 'starter-seed 2024-25', 1, ?, ?)`)
    for (const c of starterBillingCodes) insert.run(c.code, c.name, c.category, c.unit, c.cap, ts, ts)
    console.log(`seeded ${starterBillingCodes.length} starter billing codes`)
  }

  const templateCount = sqlite.prepare('SELECT COUNT(*) AS c FROM templates').get().c
  if (templateCount === 0) {
    const insert = sqlite.prepare(`INSERT INTO templates
      (name, template_type, report_type, description, body_markdown, is_default, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)`)
    for (const t of starterTemplates) insert.run(t.name, t.template_type, t.report_type, t.description, t.body_markdown, ts, ts)
    console.log(`seeded ${starterTemplates.length} starter templates`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed()
  console.log('seed complete')
}
