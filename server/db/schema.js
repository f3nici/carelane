import { sqliteTable, integer, text, real, blob } from 'drizzle-orm/sqlite-core'

/** Columns marked 🔒 in the spec are stored as AES-256-GCM ciphertext (see cryptoService). */

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name'),
  role: text('role').notNull().default('admin'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at')
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
  planStart: text('plan_start'),
  planEnd: text('plan_end'),
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
  deletedAt: text('deleted_at')
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
  deletedAt: text('deleted_at')
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
  createdAt: text('created_at')
})

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value')
})
