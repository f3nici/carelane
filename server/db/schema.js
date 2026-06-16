import { sqliteTable, integer, text, real, blob } from 'drizzle-orm/sqlite-core'

/** Columns marked 🔒 in the spec are stored as AES-256-GCM ciphertext (see cryptoService). */

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name'),
  role: text('role').notNull().default('admin'),
  totpSecret: text('totp_secret'), // 🔒 base32 TOTP secret (null until enrolled)
  totpEnabled: integer('totp_enabled').notNull().default(0),
  totpRecoveryCodes: text('totp_recovery_codes'), // 🔒 JSON array of bcrypt-hashed single-use codes
  createdAt: text('created_at'),
  updatedAt: text('updated_at')
})

export const webauthnCredentials = sqliteTable('webauthn_credentials', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().references(() => users.id),
  credentialId: text('credential_id').notNull().unique(), // base64url credential id
  publicKey: blob('public_key').notNull(), // COSE public key bytes
  counter: integer('counter').notNull().default(0), // signature counter (replay defence)
  transports: text('transports'), // JSON array of authenticator transports
  deviceType: text('device_type'), // singleDevice | multiDevice
  backedUp: integer('backed_up').notNull().default(0),
  name: text('name'), // operator-supplied label (e.g. "iPhone")
  createdAt: text('created_at'),
  lastUsedAt: text('last_used_at')
})

export const clients = sqliteTable('clients', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  firstName: text('first_name').notNull(), // 🔒
  lastName: text('last_name').notNull(), // 🔒
  preferredName: text('preferred_name'),
  ndisNumber: text('ndis_number'), // 🔒
  ndisNumberHash: text('ndis_number_hash'), // blind index (HMAC) for exact-match lookup
  dateOfBirth: text('date_of_birth'), // 🔒
  phone: text('phone'), // 🔒
  email: text('email'), // 🔒
  address: text('address'), // 🔒
  suburb: text('suburb'),
  state: text('state').default('WA'),
  postcode: text('postcode'),
  planManagementType: text('plan_management_type'),
  planManagerName: text('plan_manager_name'), // 🔒
  planManagerContact: text('plan_manager_contact'), // 🔒
  primaryDisability: text('primary_disability'),
  communicationNeeds: text('communication_needs'),
  supportGoals: text('support_goals'),
  emergencyContactName: text('emergency_contact_name'), // 🔒
  emergencyContactPhone: text('emergency_contact_phone'), // 🔒
  notes: text('notes'), // 🔒
  active: integer('active').notNull().default(1),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
  deletedAt: text('deleted_at')
})

export const serviceAgreements = sqliteTable('service_agreements', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  clientId: integer('client_id').notNull().references(() => clients.id),
  title: text('title').notNull(),
  status: text('status').notNull().default('draft'),
  startDate: text('start_date'),
  endDate: text('end_date'),
  supportsSummary: text('supports_summary'),
  hourlyRate: real('hourly_rate'),
  totalBudget: real('total_budget'),
  questionnaireJson: text('questionnaire_json'),
  bodyMarkdown: text('body_markdown'),
  signedByClient: integer('signed_by_client').notNull().default(0),
  signedDate: text('signed_date'),
  pdfFilename: text('pdf_filename'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
  deletedAt: text('deleted_at'),
  archivedAt: text('archived_at')
})

export const agreementLineItems = sqliteTable('agreement_line_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  agreementId: integer('agreement_id').notNull().references(() => serviceAgreements.id),
  billingCodeId: integer('billing_code_id').references(() => billingCodes.id),
  description: text('description'),
  unitPrice: real('unit_price'),
  estimatedQuantity: real('estimated_quantity'),
  createdAt: text('created_at')
})

export const billingCodes = sqliteTable('billing_codes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  code: text('code').notNull(),
  name: text('name').notNull(),
  supportCategory: text('support_category'),
  registrationGroup: text('registration_group'),
  unit: text('unit').default('H'),
  priceCapStandard: real('price_cap_standard'),
  priceCapRemote: real('price_cap_remote'),
  priceCapVeryRemote: real('price_cap_very_remote'),
  quoteRequired: integer('quote_required').notNull().default(0),
  priceGuideVersion: text('price_guide_version'),
  active: integer('active').notNull().default(1),
  createdAt: text('created_at'),
  updatedAt: text('updated_at')
})

export const clientBillingCodes = sqliteTable('client_billing_codes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  clientId: integer('client_id').notNull().references(() => clients.id),
  billingCodeId: integer('billing_code_id').notNull().references(() => billingCodes.id),
  customRate: real('custom_rate'),
  createdAt: text('created_at')
})

export const shiftNotes = sqliteTable('shift_notes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  clientId: integer('client_id').notNull().references(() => clients.id),
  workerId: integer('worker_id').notNull().references(() => users.id),
  shiftDate: text('shift_date').notNull(),
  startTime: text('start_time'),
  endTime: text('end_time'),
  durationHours: real('duration_hours'),
  billingCodeId: integer('billing_code_id').references(() => billingCodes.id),
  location: text('location'),
  supportProvided: text('support_provided'),
  body: text('body'), // 🔒
  participantResponse: text('participant_response'),
  incidentFlag: integer('incident_flag').notNull().default(0),
  incidentDetails: text('incident_details'), // 🔒
  followUpRequired: integer('follow_up_required').notNull().default(0),
  billed: integer('billed').notNull().default(0),
  finalised: integer('finalised').notNull().default(0),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
  deletedAt: text('deleted_at'),
  archivedAt: text('archived_at')
})

export const shiftPhotos = sqliteTable('shift_photos', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  shiftNoteId: integer('shift_note_id').notNull().references(() => shiftNotes.id),
  filename: text('filename').notNull(),
  originalName: text('original_name'),
  mimeType: text('mime_type'),
  sizeBytes: integer('size_bytes'),
  caption: text('caption'),
  createdAt: text('created_at')
})

export const reports = sqliteTable('reports', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  clientId: integer('client_id').notNull().references(() => clients.id),
  reportType: text('report_type').notNull().default('progress'),
  periodStart: text('period_start'),
  periodEnd: text('period_end'),
  bodyMarkdown: text('body_markdown'),
  sourceShiftIds: text('source_shift_ids'),
  pdfFilename: text('pdf_filename'),
  status: text('status').notNull().default('draft'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
  deletedAt: text('deleted_at'),
  archivedAt: text('archived_at')
})

export const clientDocuments = sqliteTable('client_documents', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  clientId: integer('client_id').notNull().references(() => clients.id),
  title: text('title').notNull(),
  sourceType: text('source_type').notNull().default('upload'), // agreement | report | upload
  sourceId: integer('source_id'),
  // First-class document classification (media_consent, consent_to_share, …) so
  // consent forms and other expirable paperwork are trackable, not generic
  // uploads. issue_date/expiry_date drive the expiry surfacing on the dashboard.
  docType: text('doc_type').notNull().default('other'),
  issueDate: text('issue_date'),
  expiryDate: text('expiry_date'),
  filename: text('filename').notNull(),
  originalName: text('original_name'),
  mimeType: text('mime_type'),
  sizeBytes: integer('size_bytes'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
  deletedAt: text('deleted_at')
})

// Structured participant goals — discrete, trackable outcomes that replace the
// free-text support_goals blob. Each goal accrues dated progress notes
// (goal_progress_notes) so participant outcomes can be demonstrated over time
// and fed to the AI report drafter as structured input.
export const clientGoals = sqliteTable('client_goals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  clientId: integer('client_id').notNull().references(() => clients.id),
  title: text('title').notNull(),
  description: text('description'),
  category: text('category'),
  status: text('status').notNull().default('active'), // active | achieved | on_hold | discontinued
  targetDate: text('target_date'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
  deletedAt: text('deleted_at')
})

export const goalProgressNotes = sqliteTable('goal_progress_notes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  goalId: integer('goal_id').notNull().references(() => clientGoals.id),
  clientId: integer('client_id').notNull().references(() => clients.id),
  noteDate: text('note_date').notNull(),
  progressRating: integer('progress_rating'), // optional 1-5 self-assessed progress
  body: text('body'), // 🔒 encrypted like shift bodies
  createdAt: text('created_at'),
  deletedAt: text('deleted_at')
})

export const documents = sqliteTable('documents', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  category: text('category').notNull().default('guideline'),
  filename: text('filename').notNull(),
  originalName: text('original_name'),
  pageCount: integer('page_count'),
  indexed: integer('indexed').notNull().default(0),
  createdAt: text('created_at')
})

export const documentChunks = sqliteTable('document_chunks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  documentId: integer('document_id').notNull().references(() => documents.id),
  chunkIndex: integer('chunk_index').notNull(),
  page: integer('page'),
  content: text('content').notNull(),
  embedding: blob('embedding'),
  createdAt: text('created_at')
})

export const activityLog = sqliteTable('activity_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  entityType: text('entity_type').notNull(),
  entityId: integer('entity_id'),
  userId: integer('user_id'),
  action: text('action').notNull(),
  details: text('details'),
  createdAt: text('created_at'),
  // Tamper-evident hash chain: each entry's hash incorporates the previous
  // entry's hash, so any silent edit/deletion breaks the chain. Combined with
  // the append-only triggers this makes the audit trail verifiable.
  prevHash: text('prev_hash'),
  hash: text('hash')
})

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value')
})

export const templates = sqliteTable('templates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  templateType: text('template_type').notNull().default('agreement'), // agreement | report
  reportType: text('report_type'), // optional sub-type when template_type = report
  description: text('description'),
  bodyMarkdown: text('body_markdown').notNull(), // structure + wording Claude follows when drafting
  isDefault: integer('is_default').notNull().default(0),
  active: integer('active').notNull().default(1),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
  deletedAt: text('deleted_at')
})
