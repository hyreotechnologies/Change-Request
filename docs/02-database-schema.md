# 02 — Database Schema

Authoritative DDL: [`src/db/schema.sql`](../src/db/schema.sql). This document explains
intent, keys and constraints. All dates are ISO-8601 `TEXT`; all money is `REAL` rounded to
2dp by `src/lib/money.js`; all booleans are `INTEGER 0|1`.

## Identity & access

### roles
| Column | Type | Notes |
|---|---|---|
| code | TEXT PK | ADMIN, CR_MANAGER, APPROVER, VIEWER |
| name, description | TEXT | |
| is_system | INTEGER | system roles cannot be deleted |

### permissions / role_permissions
`permissions(code PK, module, description)`;
`role_permissions(role_code FK, permission_code FK, PK(role_code, permission_code))`.
The matrix is data, so Admin can re-grant without a deploy.

### users
| Column | Notes |
|---|---|
| id TEXT PK | USR-0001 |
| name, email (UNIQUE, lowercased), department | |
| role_code | FK to roles |
| is_active INTEGER DEFAULT 1 | inactive users cannot obtain a session |
| created_at, last_login_at | |

Constraints: UNIQUE(email); a user may not deactivate themselves; the last active ADMIN
cannot be deactivated or demoted.

### sessions
`id PK, user_id FK, token_hash UNIQUE, created_at, last_seen_at, expires_at, ip,
user_agent, revoked_at`.

### otp_codes
`id PK, email, purpose (LOGIN | APPROVER_PORTAL | CUSTOMER_PORTAL), code_hash, context_id
(cr id for portal), attempts, max_attempts, expires_at, consumed_at, created_at, ip`.
Index on (email, purpose, consumed_at).

### share_links
`id PK, cr_id FK, audience (APPROVER | CUSTOMER), email, token_hash UNIQUE, expires_at,
revoked_at, first_clicked_at, last_clicked_at, click_count, created_by, created_at`.
A portal token is meaningless without the matching email plus an OTP.

## Customer master

### accounts
`id PK (ACC-0001), account_code UNIQUE, account_name, legal_entity_name, customer_type,
industry, country, address, city, state, postal_code, status (ACTIVE | INACTIVE),
account_manager, cr_manager, delivery_manager, internal_approver_name,
internal_approver_email, notes, created_at/by, updated_at/by`.
Constraints: UNIQUE(account_code), UNIQUE(lower(account_name)).

### msa_contracts
`id PK (MSA-0001), account_id FK, msa_reference_number UNIQUE, msa_date,
contract_start_date, contract_end_date, contract_value, currency, billing_entity,
payment_terms, po_required INTEGER, status (ACTIVE | EXPIRED | TERMINATED | DRAFT),
created_at/by, updated_at/by`.
Constraints: UNIQUE(msa_reference_number) is the explicit "no duplicate MSA" rule;
CHECK(contract_end_date IS NULL OR contract_end_date >= contract_start_date).

### msa_documents
`id PK, msa_id FK NULL, account_id FK NULL, file_name, file_path, file_size, content_type,
document_kind (DOCX | PDF | TEXT), extracted_text, extracted_json, uploaded_at, uploaded_by`.
The signed MSA as uploaded. It is stored before the account exists and bound to the MSA it
produced; deleting the account removes it with the rest.

### customer_contacts
`id PK, account_id FK, contact_type (PRIMARY | APPROVER | OTHER), name, designation, email,
phone, is_active`. Index on (account_id, contact_type).

## Change requests

### change_requests
| Column | Notes |
|---|---|
| id TEXT PK | CR-000001 |
| cr_number TEXT UNIQUE | display number, e.g. PEERISLANDS-CR-001 (format configurable) |
| cr_reference TEXT UNIQUE | contractual reference, e.g. PEERISLANDS-0001-01 |
| account_id, msa_id | FK, NOT NULL — every CR must belong to an account and an MSA |
| seq_no INTEGER | per-account sequence; UNIQUE(account_id, seq_no) |
| title, cr_date, effective_date, requested_by, customer_contact_name/email, priority, cr_type | header block |
| status | see docs/08-state-machine.md |
| current_owner_user_id | who must act next |
| revision INTEGER | incremented when a rejected CR re-enters DRAFT |
| snapshot_\* (legal entity, msa number, msa date, contract dates, approver name/email) | frozen copy taken at creation so historical CRs stay legally accurate if the account is later edited |
| dev/test start and completion dates, target_release_date, estimated_timeline, depends_on_po, po_required_date, planned_production_release | timeline block |
| payment_terms, po_required, po_number, invoice_terms | commercial block |
| submitted_at/by, internally_approved_at/by, shared_at/by, customer_viewed_at, customer_decided_at, signed_at, completed_at, cancelled_at | lifecycle stamps used by the visual timeline |
| locked INTEGER | 1 once submitted; only a permitted transition may unlock |
| created_at/by, updated_at/by | |

### change_request_items
`id PK, cr_id FK ON DELETE CASCADE, item_no INTEGER, feature_name, requested_change,
detailed_description, business_justification, current_behaviour, expected_behaviour,
release_date, remarks, sort_order`. UNIQUE(cr_id, item_no).

### change_request_efforts
`id PK, cr_id FK, category (DEVELOPMENT | TESTING | BUSINESS_ANALYSIS | PROJECT_MANAGEMENT |
DEPLOYMENT | OTHER), label, hours REAL, sort_order`, UNIQUE(cr_id, category).
Total effort is derived (SUM(hours)) and never stored twice.

### change_request_costs
`id PK, cr_id FK UNIQUE, billing_rate, currency, development_cost, testing_cost, other_cost,
subtotal, discount_type (NONE | PERCENT | FIXED), discount_value, discount_amount,
tax_percent, tax_amount, total_cost`.
All derived values are recomputed server-side on every write; client-supplied totals are
never trusted.

### change_request_assumptions
`id PK, cr_id FK, text, sort_order`.

### change_request_dependencies
`id PK, cr_id FK, dependency_type (CUSTOMER | INTERNAL | THIRD_PARTY | RISK | REMARK), text,
sort_order`.

## Approvals

### cr_approval_levels
`id PK, account_id FK NULL (NULL = global default), level INTEGER, name, approver_name,
approver_email, is_active`. An ordered ladder — multi-level approval is configuration, not
code.

### change_request_approvals
`id PK, cr_id FK, level INTEGER, approver_name, approver_email, status (PENDING | APPROVED |
REJECTED | SKIPPED), requested_at, decided_at, comments, decided_via (PORTAL | APP),
ip_address`. Indexes on (cr_id, level) and (approver_email, status).

### customer_approvals
`id PK, cr_id FK, signer_order INTEGER, contact_name, contact_email, designation, status
(PENDING | VIEWED | APPROVED | REJECTED), sent_at, viewed_at, decided_at, comments,
signature_name, signature_method (PORTAL | DOCUSIGN), signed_at, ip_address`.

## Documents

### documents
`id PK, cr_id FK, doc_type (CR_DOCUMENT | SIGNED_CR | ATTACHMENT), title,
current_version_id`.

### document_versions
`id PK, document_id FK, cr_id FK, version TEXT (1.0, 1.1, 2.0), major/minor INTEGER, format
(DOCX | PDF), file_path, file_size, sha256, status (DRAFT | FINAL | SIGNED | SUPERSEDED),
is_locked INTEGER, generated_by, generated_at, notes`.
Rule: rows with `is_locked = 1` (every FINAL/SIGNED version) may never be updated or
deleted — enforced by trigger. Generation always inserts a new version.

## Communication and integration

### email_logs
`id PK, cr_id FK NULL, template_code, to_email, cc_emails, subject, body_html, body_text,
status (QUEUED | SENT | FAILED | DELIVERED | OPENED | CLICKED), provider_message_id, error,
queued_at, sent_at, delivered_at, opened_at, clicked_at, open_count, click_count,
tracking_token UNIQUE, attachments_json`.

### docusign_envelopes
`id PK, cr_id FK, provider (SIMULATED | DOCUSIGN), envelope_id, status (CREATED | SENT |
DELIVERED | VIEWED | SIGNED | DECLINED | COMPLETED | VOIDED), sent_at, delivered_at,
viewed_at, signed_at, declined_at, completed_at, decline_reason, signed_document_path,
recipients_json, raw_json, created_by, created_at, updated_at`.

### notifications
`id PK, user_id FK, cr_id FK NULL, type, title, body, link, is_read, created_at, read_at`.

### audit_logs (append-only)
`id PK, entity_type, entity_id, cr_id, action, actor_type (USER | CUSTOMER | APPROVER |
SYSTEM), actor_id, actor_label, field, old_value, new_value, comments, ip_address,
user_agent, created_at`.
Triggers `audit_logs_no_update` and `audit_logs_no_delete` abort any mutation.

## Configuration

### settings
`key PK, value, value_type (STRING | NUMBER | BOOLEAN | JSON), category, label, description,
is_secret INTEGER, updated_at, updated_by`. Secrets are AES-256-GCM encrypted at rest.

### email_templates
`code PK, name, description, subject, body_html, variables_json, is_active, updated_at,
updated_by`.

### enums
`id PK, enum_type, code, label, sort_order, is_active, color` — drives CR types, priorities,
statuses, customer types and industries without code changes.

### sequences
`name PK, next_value` — atomic allocation for ACC-, MSA-, CR- and USR- identifiers.

## Global integrity rules (database-enforced)

1. UNIQUE(msa_reference_number), UNIQUE(cr_number), UNIQUE(cr_reference), UNIQUE(account_code).
2. `change_requests.account_id` and `msa_id` are NOT NULL with ON DELETE RESTRICT.
3. UNIQUE(account_id, seq_no) guarantees non-colliding per-account numbering.
4. Trigger `cr_no_delete_when_approved` aborts deletion of any CR at or past INTERNALLY_APPROVED.
   Deleting an account cascades only its DRAFT change requests (with their unlocked
   document versions); a single CR past draft blocks the delete entirely. `audit_logs`
   holds no foreign key, so the history of a deleted record survives it.
5. Trigger `cr_no_edit_when_completed` aborts updates to COMPLETED CRs.
6. Triggers make `audit_logs` and locked `document_versions` immutable.
7. `PRAGMA foreign_keys = ON` on every connection.
