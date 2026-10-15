-- ===========================================================================
-- Hyreo Account Management System — schema
-- Engine: SQLite (node:sqlite). Portable SQL only.
-- Dates: ISO-8601 TEXT. Money: REAL rounded to 2dp. Booleans: INTEGER 0|1.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TEXT NOT NULL
);

-- --------------------------------------------------------------------------
-- Configuration & identity
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sequences (
  name        TEXT PRIMARY KEY,
  next_value  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  value_type  TEXT NOT NULL DEFAULT 'STRING' CHECK (value_type IN ('STRING','NUMBER','BOOLEAN','JSON')),
  category    TEXT NOT NULL DEFAULT 'GENERAL',
  label       TEXT,
  description TEXT,
  is_secret   INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT,
  updated_by  TEXT
);

CREATE TABLE IF NOT EXISTS enums (
  id          TEXT PRIMARY KEY,
  enum_type   TEXT NOT NULL,
  code        TEXT NOT NULL,
  label       TEXT NOT NULL,
  color       TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1,
  UNIQUE (enum_type, code)
);

CREATE TABLE IF NOT EXISTS roles (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  is_system   INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS permissions (
  code        TEXT PRIMARY KEY,
  module      TEXT NOT NULL,
  description TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_code       TEXT NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
  permission_code TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_code, permission_code)
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  role_code     TEXT NOT NULL REFERENCES roles(code) ON DELETE RESTRICT,
  department    TEXT,
  designation   TEXT,
  phone         TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  created_by    TEXT,
  updated_at    TEXT,
  updated_by    TEXT,
  last_login_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email ON users (lower(email));
CREATE INDEX IF NOT EXISTS ix_users_role ON users (role_code);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  ip           TEXT,
  user_agent   TEXT,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS otp_codes (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL,
  purpose      TEXT NOT NULL CHECK (purpose IN ('LOGIN','APPROVER_PORTAL','CUSTOMER_PORTAL')),
  context_id   TEXT,
  code_hash    TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  expires_at   TEXT NOT NULL,
  consumed_at  TEXT,
  created_at   TEXT NOT NULL,
  ip           TEXT
);
CREATE INDEX IF NOT EXISTS ix_otp_lookup ON otp_codes (lower(email), purpose, consumed_at);

CREATE TABLE IF NOT EXISTS portal_sessions (
  id            TEXT PRIMARY KEY,
  share_link_id TEXT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
  cr_id         TEXT NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  audience      TEXT NOT NULL CHECK (audience IN ('APPROVER','CUSTOMER')),
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT,
  ip            TEXT,
  user_agent    TEXT
);

CREATE TABLE IF NOT EXISTS share_links (
  id               TEXT PRIMARY KEY,
  cr_id            TEXT NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  audience         TEXT NOT NULL CHECK (audience IN ('APPROVER','CUSTOMER')),
  email            TEXT NOT NULL,
  recipient_name   TEXT,
  token_hash       TEXT NOT NULL UNIQUE,
  approval_id      TEXT,
  expires_at       TEXT NOT NULL,
  revoked_at       TEXT,
  first_clicked_at TEXT,
  last_clicked_at  TEXT,
  click_count      INTEGER NOT NULL DEFAULT 0,
  created_by       TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_share_links_cr ON share_links (cr_id, audience);

-- --------------------------------------------------------------------------
-- Customer master
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS accounts (
  id                      TEXT PRIMARY KEY,
  account_code            TEXT NOT NULL,
  account_name            TEXT NOT NULL,
  legal_entity_name       TEXT NOT NULL,
  customer_type           TEXT,
  industry                TEXT,
  country                 TEXT,
  address                 TEXT,
  city                    TEXT,
  state                   TEXT,
  postal_code             TEXT,
  status                  TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  account_manager         TEXT,
  cr_manager              TEXT,
  delivery_manager        TEXT,
  internal_approver_name  TEXT,
  internal_approver_email TEXT,
  go_live_date            TEXT,
  next_renewal_date       TEXT,
  notes                   TEXT,
  created_at              TEXT NOT NULL,
  created_by              TEXT,
  updated_at              TEXT,
  updated_by              TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_accounts_code ON accounts (upper(account_code));
CREATE UNIQUE INDEX IF NOT EXISTS ux_accounts_name ON accounts (lower(account_name));

CREATE TABLE IF NOT EXISTS msa_contracts (
  id                    TEXT PRIMARY KEY,
  account_id            TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  msa_reference_number  TEXT NOT NULL,
  msa_date              TEXT NOT NULL,
  contract_start_date   TEXT NOT NULL,
  contract_end_date     TEXT,
  contract_value        REAL,
  currency              TEXT NOT NULL DEFAULT 'INR',
  billing_entity        TEXT,
  payment_terms         TEXT,
  po_required           INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','EXPIRED','TERMINATED','DRAFT')),
  is_primary            INTEGER NOT NULL DEFAULT 1,
  notes                 TEXT,
  created_at            TEXT NOT NULL,
  created_by            TEXT,
  updated_at            TEXT,
  updated_by            TEXT,
  CHECK (contract_end_date IS NULL OR contract_end_date >= contract_start_date)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_msa_reference ON msa_contracts (upper(msa_reference_number));
CREATE INDEX IF NOT EXISTS ix_msa_account ON msa_contracts (account_id);

CREATE TABLE IF NOT EXISTS customer_contacts (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_type TEXT NOT NULL DEFAULT 'PRIMARY' CHECK (contact_type IN ('PRIMARY','APPROVER','OTHER')),
  name         TEXT,
  designation  TEXT,
  email        TEXT,
  phone        TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT
);
CREATE INDEX IF NOT EXISTS ix_contacts_account ON customer_contacts (account_id, contact_type);

-- The signed MSA as uploaded, kept alongside the contract it created.
CREATE TABLE IF NOT EXISTS msa_documents (
  id              TEXT PRIMARY KEY,
  msa_id          TEXT REFERENCES msa_contracts(id) ON DELETE SET NULL,
  account_id      TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  file_name       TEXT NOT NULL,
  file_path       TEXT NOT NULL,
  file_size       INTEGER NOT NULL DEFAULT 0,
  content_type    TEXT,
  document_kind   TEXT,
  extracted_text  TEXT,
  extracted_json  TEXT,
  uploaded_at     TEXT NOT NULL,
  uploaded_by     TEXT
);
CREATE INDEX IF NOT EXISTS ix_msa_documents_msa ON msa_documents (msa_id);
CREATE INDEX IF NOT EXISTS ix_msa_documents_account ON msa_documents (account_id);

-- --------------------------------------------------------------------------
-- Change requests
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS change_requests (
  id                         TEXT PRIMARY KEY,
  cr_number                  TEXT NOT NULL,
  cr_reference               TEXT NOT NULL,
  seq_no                     INTEGER NOT NULL,
  account_id                 TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  msa_id                     TEXT NOT NULL REFERENCES msa_contracts(id) ON DELETE RESTRICT,

  title                      TEXT NOT NULL,
  cr_date                    TEXT NOT NULL,
  effective_date             TEXT,
  requested_by               TEXT,
  customer_contact_name      TEXT,
  customer_contact_email     TEXT,
  priority                   TEXT NOT NULL DEFAULT 'MEDIUM',
  cr_type                    TEXT NOT NULL DEFAULT 'ENHANCEMENT',
  description                TEXT,

  status                     TEXT NOT NULL DEFAULT 'DRAFT',
  previous_status            TEXT,
  revision                   INTEGER NOT NULL DEFAULT 0,
  locked                     INTEGER NOT NULL DEFAULT 0,
  current_owner_user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,

  -- snapshot of account / MSA at creation time (legal accuracy of history)
  snapshot_account_name      TEXT,
  snapshot_account_code      TEXT,
  snapshot_legal_entity      TEXT,
  snapshot_msa_number        TEXT,
  snapshot_msa_date          TEXT,
  snapshot_contract_start    TEXT,
  snapshot_contract_end      TEXT,
  snapshot_customer_approver TEXT,
  snapshot_customer_approver_email TEXT,
  snapshot_customer_approver_designation TEXT,
  snapshot_account_manager   TEXT,
  snapshot_cr_manager        TEXT,
  snapshot_internal_approver TEXT,
  snapshot_internal_approver_email TEXT,

  -- timeline
  dev_start_date             TEXT,
  dev_completion_date        TEXT,
  test_start_date            TEXT,
  test_completion_date       TEXT,
  target_release_date        TEXT,
  estimated_timeline         TEXT,
  estimated_business_days    REAL,
  depends_on_po              INTEGER NOT NULL DEFAULT 0,
  po_required_date           TEXT,
  planned_production_release TEXT,

  -- commercial
  payment_terms              TEXT,
  po_required                INTEGER NOT NULL DEFAULT 0,
  po_number                  TEXT,
  invoice_terms              TEXT,
  general_terms              TEXT,

  -- lifecycle stamps
  submitted_at               TEXT,
  submitted_by               TEXT,
  internally_approved_at     TEXT,
  internally_approved_by     TEXT,
  internal_rejected_at       TEXT,
  internal_rejected_by       TEXT,
  internal_rejection_comments TEXT,
  shared_at                  TEXT,
  shared_by                  TEXT,
  customer_viewed_at         TEXT,
  customer_decided_at        TEXT,
  customer_rejection_comments TEXT,
  signed_at                  TEXT,
  completed_at               TEXT,
  cancelled_at               TEXT,
  cancelled_by               TEXT,
  cancel_reason              TEXT,
  hold_reason                TEXT,

  created_at                 TEXT NOT NULL,
  created_by                 TEXT,
  updated_at                 TEXT,
  updated_by                 TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cr_number ON change_requests (upper(cr_number));
CREATE UNIQUE INDEX IF NOT EXISTS ux_cr_reference ON change_requests (upper(cr_reference));
CREATE UNIQUE INDEX IF NOT EXISTS ux_cr_account_seq ON change_requests (account_id, seq_no);
CREATE INDEX IF NOT EXISTS ix_cr_status ON change_requests (status);
CREATE INDEX IF NOT EXISTS ix_cr_account ON change_requests (account_id);
CREATE INDEX IF NOT EXISTS ix_cr_msa ON change_requests (msa_id);
CREATE INDEX IF NOT EXISTS ix_cr_date ON change_requests (cr_date);

CREATE TABLE IF NOT EXISTS change_request_items (
  id                   TEXT PRIMARY KEY,
  cr_id                TEXT NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  item_no              INTEGER NOT NULL,
  feature_name         TEXT NOT NULL,
  requested_change     TEXT,
  detailed_description TEXT,
  business_justification TEXT,
  current_behaviour    TEXT,
  expected_behaviour   TEXT,
  release_date         TEXT,
  remarks              TEXT,
  sort_order           INTEGER NOT NULL DEFAULT 0,
  UNIQUE (cr_id, item_no)
);
CREATE INDEX IF NOT EXISTS ix_items_cr ON change_request_items (cr_id, sort_order);

CREATE TABLE IF NOT EXISTS change_request_efforts (
  id         TEXT PRIMARY KEY,
  cr_id      TEXT NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  category   TEXT NOT NULL CHECK (category IN ('DEVELOPMENT','TESTING','BUSINESS_ANALYSIS','PROJECT_MANAGEMENT','DEPLOYMENT','OTHER')),
  label      TEXT NOT NULL,
  hours      REAL NOT NULL DEFAULT 0,
  notes      TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (cr_id, category)
);

CREATE TABLE IF NOT EXISTS change_request_costs (
  id               TEXT PRIMARY KEY,
  cr_id            TEXT NOT NULL UNIQUE REFERENCES change_requests(id) ON DELETE CASCADE,
  billing_rate     REAL NOT NULL DEFAULT 0,
  currency         TEXT NOT NULL DEFAULT 'INR',
  total_effort     REAL NOT NULL DEFAULT 0,
  development_cost REAL NOT NULL DEFAULT 0,
  testing_cost     REAL NOT NULL DEFAULT 0,
  other_cost       REAL NOT NULL DEFAULT 0,
  subtotal         REAL NOT NULL DEFAULT 0,
  discount_type    TEXT NOT NULL DEFAULT 'NONE' CHECK (discount_type IN ('NONE','PERCENT','FIXED')),
  discount_value   REAL NOT NULL DEFAULT 0,
  discount_amount  REAL NOT NULL DEFAULT 0,
  tax_percent      REAL NOT NULL DEFAULT 0,
  tax_amount       REAL NOT NULL DEFAULT 0,
  total_cost       REAL NOT NULL DEFAULT 0,
  updated_at       TEXT
);

CREATE TABLE IF NOT EXISTS change_request_assumptions (
  id         TEXT PRIMARY KEY,
  cr_id      TEXT NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS change_request_dependencies (
  id              TEXT PRIMARY KEY,
  cr_id           TEXT NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  dependency_type TEXT NOT NULL DEFAULT 'INTERNAL' CHECK (dependency_type IN ('CUSTOMER','INTERNAL','THIRD_PARTY','RISK','REMARK')),
  text            TEXT NOT NULL,
  sort_order      INTEGER NOT NULL DEFAULT 0
);

-- --------------------------------------------------------------------------
-- Approvals
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cr_approval_levels (
  id             TEXT PRIMARY KEY,
  account_id     TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  level          INTEGER NOT NULL DEFAULT 1,
  name           TEXT NOT NULL,
  approver_name  TEXT,
  approver_email TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT
);

CREATE TABLE IF NOT EXISTS change_request_approvals (
  id             TEXT PRIMARY KEY,
  cr_id          TEXT NOT NULL REFERENCES change_requests(id) ON DELETE RESTRICT,
  level          INTEGER NOT NULL DEFAULT 1,
  level_name     TEXT,
  approver_name  TEXT,
  approver_email TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','SKIPPED')),
  requested_at   TEXT NOT NULL,
  decided_at     TEXT,
  comments       TEXT,
  decided_via    TEXT,
  ip_address     TEXT,
  revision       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_approvals_cr ON change_request_approvals (cr_id, level);
CREATE INDEX IF NOT EXISTS ix_approvals_email ON change_request_approvals (lower(approver_email), status);

CREATE TABLE IF NOT EXISTS customer_approvals (
  id               TEXT PRIMARY KEY,
  cr_id            TEXT NOT NULL REFERENCES change_requests(id) ON DELETE RESTRICT,
  signer_order     INTEGER NOT NULL DEFAULT 1,
  contact_name     TEXT,
  contact_email    TEXT NOT NULL,
  designation      TEXT,
  status           TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','VIEWED','APPROVED','REJECTED')),
  sent_at          TEXT,
  viewed_at        TEXT,
  decided_at       TEXT,
  comments         TEXT,
  signature_name   TEXT,
  signature_method TEXT,
  signed_at        TEXT,
  ip_address       TEXT,
  user_agent       TEXT
);
CREATE INDEX IF NOT EXISTS ix_custapprovals_cr ON customer_approvals (cr_id);

-- --------------------------------------------------------------------------
-- Documents
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS documents (
  id                 TEXT PRIMARY KEY,
  cr_id              TEXT NOT NULL REFERENCES change_requests(id) ON DELETE RESTRICT,
  doc_type           TEXT NOT NULL DEFAULT 'CR_DOCUMENT' CHECK (doc_type IN ('CR_DOCUMENT','SIGNED_CR','ATTACHMENT')),
  title              TEXT NOT NULL,
  current_version_id TEXT,
  created_at         TEXT NOT NULL,
  created_by         TEXT
);
CREATE INDEX IF NOT EXISTS ix_documents_cr ON documents (cr_id);

CREATE TABLE IF NOT EXISTS document_versions (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  cr_id        TEXT NOT NULL REFERENCES change_requests(id) ON DELETE RESTRICT,
  version      TEXT NOT NULL,
  major        INTEGER NOT NULL DEFAULT 1,
  minor        INTEGER NOT NULL DEFAULT 0,
  format       TEXT NOT NULL CHECK (format IN ('DOCX','PDF')),
  file_path    TEXT NOT NULL,
  file_size    INTEGER NOT NULL DEFAULT 0,
  sha256       TEXT,
  status       TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','FINAL','SIGNED','SUPERSEDED')),
  is_locked    INTEGER NOT NULL DEFAULT 0,
  generated_by TEXT,
  generated_at TEXT NOT NULL,
  notes        TEXT
);
CREATE INDEX IF NOT EXISTS ix_docversions_doc ON document_versions (document_id, major, minor);
CREATE INDEX IF NOT EXISTS ix_docversions_cr ON document_versions (cr_id);

-- --------------------------------------------------------------------------
-- Communication & integration
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS email_logs (
  id                  TEXT PRIMARY KEY,
  cr_id               TEXT REFERENCES change_requests(id) ON DELETE SET NULL,
  template_code       TEXT,
  to_email            TEXT NOT NULL,
  cc_emails           TEXT,
  from_email          TEXT,
  subject             TEXT NOT NULL,
  body_html           TEXT,
  body_text           TEXT,
  status              TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SENT','FAILED','DELIVERED','OPENED','CLICKED')),
  provider            TEXT,
  provider_message_id TEXT,
  error               TEXT,
  queued_at           TEXT NOT NULL,
  sent_at             TEXT,
  delivered_at        TEXT,
  opened_at           TEXT,
  clicked_at          TEXT,
  open_count          INTEGER NOT NULL DEFAULT 0,
  click_count         INTEGER NOT NULL DEFAULT 0,
  tracking_token      TEXT UNIQUE,
  attachments_json    TEXT,
  created_by          TEXT
);
CREATE INDEX IF NOT EXISTS ix_emails_cr ON email_logs (cr_id, queued_at);

CREATE TABLE IF NOT EXISTS docusign_envelopes (
  id                   TEXT PRIMARY KEY,
  cr_id                TEXT NOT NULL REFERENCES change_requests(id) ON DELETE RESTRICT,
  provider             TEXT NOT NULL DEFAULT 'SIMULATED' CHECK (provider IN ('SIMULATED','DOCUSIGN')),
  envelope_id          TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED','SENT','DELIVERED','VIEWED','SIGNED','DECLINED','COMPLETED','VOIDED')),
  environment          TEXT,
  sent_at              TEXT,
  delivered_at         TEXT,
  viewed_at            TEXT,
  signed_at            TEXT,
  declined_at          TEXT,
  completed_at         TEXT,
  voided_at            TEXT,
  decline_reason       TEXT,
  signed_document_path TEXT,
  recipients_json      TEXT,
  raw_json             TEXT,
  created_by           TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT
);
CREATE INDEX IF NOT EXISTS ix_envelopes_cr ON docusign_envelopes (cr_id);

CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cr_id      TEXT REFERENCES change_requests(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT,
  link       TEXT,
  severity   TEXT NOT NULL DEFAULT 'INFO',
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  read_at    TEXT
);
CREATE INDEX IF NOT EXISTS ix_notifications_user ON notifications (user_id, is_read, created_at);

CREATE TABLE IF NOT EXISTS email_templates (
  code           TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT,
  subject        TEXT NOT NULL,
  body_html      TEXT NOT NULL,
  variables_json TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1,
  updated_at     TEXT,
  updated_by     TEXT
);

-- --------------------------------------------------------------------------
-- Workflow automation & personal workspace
-- --------------------------------------------------------------------------

-- One row per reminder or escalation sent, so the scheduler never repeats itself.
CREATE TABLE IF NOT EXISTS workflow_reminders (
  id          TEXT PRIMARY KEY,
  cr_id       TEXT NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('APPROVAL','CUSTOMER')),
  target_id   TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('REMINDER','ESCALATION')),
  recipient   TEXT,
  trigger_type TEXT NOT NULL DEFAULT 'AUTO' CHECK (trigger_type IN ('AUTO','MANUAL')),
  sent_by     TEXT,
  sent_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_reminders_target ON workflow_reminders (target_type, target_id, kind, sent_at);
CREATE INDEX IF NOT EXISTS ix_reminders_cr ON workflow_reminders (cr_id, sent_at);

-- What a change request contained each time it was submitted, for version comparison.
CREATE TABLE IF NOT EXISTS cr_snapshots (
  id          TEXT PRIMARY KEY,
  cr_id       TEXT NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  revision    INTEGER NOT NULL DEFAULT 0,
  data_json   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  created_by  TEXT
);
CREATE INDEX IF NOT EXISTS ix_snapshots_cr ON cr_snapshots (cr_id, created_at);

-- A user's saved change-request filters, shown in the sidebar.
CREATE TABLE IF NOT EXISTS saved_views (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  query       TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_saved_views_user ON saved_views (user_id, sort_order);

-- --------------------------------------------------------------------------
-- Audit (append-only)
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_logs (
  id          TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id   TEXT,
  cr_id       TEXT,
  action      TEXT NOT NULL,
  actor_type  TEXT NOT NULL DEFAULT 'USER' CHECK (actor_type IN ('USER','CUSTOMER','APPROVER','SYSTEM')),
  actor_id    TEXT,
  actor_label TEXT,
  field       TEXT,
  old_value   TEXT,
  new_value   TEXT,
  comments    TEXT,
  ip_address  TEXT,
  user_agent  TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_cr ON audit_logs (cr_id, created_at);
CREATE INDEX IF NOT EXISTS ix_audit_entity ON audit_logs (entity_type, entity_id, created_at);

-- --------------------------------------------------------------------------
-- Integrity triggers
-- --------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS audit_logs_no_update
BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only and cannot be updated');
END;

CREATE TRIGGER IF NOT EXISTS audit_logs_no_delete
BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only and cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS cr_no_delete_when_approved
BEFORE DELETE ON change_requests
FOR EACH ROW WHEN OLD.status <> 'DRAFT'
BEGIN
  SELECT RAISE(ABORT, 'Only draft change requests may be deleted');
END;

CREATE TRIGGER IF NOT EXISTS cr_no_edit_when_closed
BEFORE UPDATE ON change_requests
FOR EACH ROW WHEN OLD.status IN ('COMPLETED','CANCELLED','EXPIRED')
BEGIN
  SELECT RAISE(ABORT, 'Completed, cancelled or expired change requests cannot be modified');
END;

CREATE TRIGGER IF NOT EXISTS cr_items_locked
BEFORE INSERT ON change_request_items
FOR EACH ROW WHEN (SELECT locked FROM change_requests WHERE id = NEW.cr_id) = 1
BEGIN
  SELECT RAISE(ABORT, 'Change request is locked for editing');
END;

CREATE TRIGGER IF NOT EXISTS cr_items_locked_delete
BEFORE DELETE ON change_request_items
FOR EACH ROW WHEN (SELECT locked FROM change_requests WHERE id = OLD.cr_id) = 1
BEGIN
  SELECT RAISE(ABORT, 'Change request is locked for editing');
END;

CREATE TRIGGER IF NOT EXISTS docversion_locked_no_delete
BEFORE DELETE ON document_versions
FOR EACH ROW WHEN OLD.is_locked = 1
BEGIN
  SELECT RAISE(ABORT, 'Locked document versions cannot be deleted');
END;

-- Locked versions may only change status (FINAL -> SUPERSEDED) and notes.
CREATE TRIGGER IF NOT EXISTS docversion_locked_immutable
BEFORE UPDATE ON document_versions
FOR EACH ROW WHEN OLD.is_locked = 1 AND NOT (
      NEW.id = OLD.id
  AND NEW.document_id = OLD.document_id
  AND NEW.cr_id = OLD.cr_id
  AND NEW.version = OLD.version
  AND NEW.format = OLD.format
  AND NEW.file_path = OLD.file_path
  AND NEW.file_size = OLD.file_size
  AND IFNULL(NEW.sha256,'') = IFNULL(OLD.sha256,'')
  AND IFNULL(NEW.generated_by,'') = IFNULL(OLD.generated_by,'')
  AND NEW.generated_at = OLD.generated_at
  AND NEW.is_locked = 1
)
BEGIN
  SELECT RAISE(ABORT, 'Locked document versions are immutable');
END;

-- --------------------------------------------------------------------------
-- Integrations: one organisation-wide OAuth connection per provider
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS integrations (
  provider       TEXT PRIMARY KEY,
  account_label  TEXT,
  account_email  TEXT,
  access_token   TEXT,
  refresh_token  TEXT,
  expires_at     TEXT,
  scopes         TEXT,
  settings_json  TEXT,
  last_error     TEXT,
  last_used_at   TEXT,
  connected_by   TEXT,
  connected_at   TEXT NOT NULL,
  updated_at     TEXT
);

CREATE TABLE IF NOT EXISTS integration_oauth_states (
  state       TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
