# 09 — Email & Notification Matrix

All templates live in the `email_templates` table and are editable by Admin under
Settings → Email Templates. Variables are `{{mustache}}` style and resolved by
`src/services/email.js`. Every message is written to `email_logs` with a tracking token,
whatever the transport.

## 9.1 Template matrix

| # | Code | Trigger | To | CC | Key variables | In-app notification |
|---|---|---|---|---|---|---|
| 1 | `OTP_LOGIN` | Login OTP requested | user | — | `otp_code`, `validity_minutes`, `user_name` | no |
| 2 | `OTP_PORTAL` | Portal OTP requested (approver or customer) | bound email | — | `otp_code`, `cr_number`, `account_name`, `validity_minutes` | no |
| 3 | `INTERNAL_APPROVAL_REQUEST` | CR submitted for approval | internal approver (current level) | CR manager | `cr_number`, `cr_reference`, `account_name`, `msa_number`, `cr_title`, `cr_cost`, `total_effort`, `target_release_date`, `review_url` | Approver: "CR awaiting your approval" |
| 4 | `CR_APPROVED` | All internal levels approved | CR manager | account manager | `cr_number`, `account_name`, `msa_number`, `cr_title`, `cr_cost`, `approved_by`, `approved_date`, `cr_url` | CR manager: "CR approved internally" |
| 5 | `CR_REJECTED` | Internal rejection | CR manager | account manager | `cr_number`, `rejected_by`, `rejected_date`, `rejection_comments`, `cr_url` | CR manager: "CR rejected" |
| 6 | `CUSTOMER_APPROVAL_REQUEST` | Share with customer | customer approver | CR manager + optional CC | `customer_name`, `cr_number`, `cr_reference`, `cr_title`, `cr_cost`, `account_name`, `portal_url`, attachments DOCX + PDF | CR manager: "CR sent to customer" |
| 7 | `CUSTOMER_VIEWED_NOTICE` | Customer opens the portal | CR manager | — | `cr_number`, `viewed_at`, `customer_email` | CR manager: "Customer viewed the CR" |
| 8 | `CUSTOMER_APPROVED` | Customer approves & signs | CR manager | account manager, admin | `cr_number`, `signed_by`, `signed_at`, `signature_name`, `cr_url` | CR manager: "Customer approved" |
| 9 | `CUSTOMER_REJECTED` | Customer rejects | CR manager | account manager | `cr_number`, `rejected_by`, `rejection_comments` | CR manager: "Customer rejected" |
| 10 | `DOCUSIGN_SENT` | Envelope sent | CR manager | — | `cr_number`, `envelope_id`, `recipients` | CR manager: "Envelope sent" |
| 11 | `DOCUSIGN_COMPLETED` | Envelope completed | CR manager | admin | `cr_number`, `envelope_id`, `completed_at`, `signed_doc_url` | CR manager: "Envelope completed" |
| 12 | `DOCUMENT_GENERATED` | Final document generated | CR manager | — | `cr_number`, `version`, `generated_by` | CR manager: "Document v{{version}} generated" |
| 13 | `CR_CANCELLED` | CR cancelled | CR manager, account manager | — | `cr_number`, `cancelled_by`, `reason` | yes |
| 14 | `TEST_EMAIL` | Admin clicks "Send test" | tester | — | `company_name` | no |

## 9.2 Notification lifecycle

An in-app notification is a task, not a record. It is removed automatically once
the task it represents is settled:

| Notification | Closed when |
|---|---|
| `CR_APPROVAL_REQUESTED` | the approver approves or rejects, or a resubmission replaces it |
| `CR_SHARED`, `CUSTOMER_VIEWED` | the customer signs or rejects |

The user can also dismiss any notification, read or unread, or clear the list
entirely. Nothing is lost by doing so — `audit_logs` holds the permanent record.

## 9.3 Notification-only events (no email)

| Event | Recipients |
|---|---|
| CR created | CR manager, account manager |
| CR saved as draft after revision | CR manager |
| Document version superseded | CR manager |
| Portal link clicked | CR manager |
| Approval overdue (> `notifications.ageing_days`, default 3) | CR manager, admin |

## 9.4 Delivery tracking

| Field | Set when |
|---|---|
| `queued_at` | row created |
| `sent_at` | transport accepted the message (SMTP 250 or capture write) |
| `error` / `status=FAILED` | transport threw; surfaced in the Outbox screen |
| `delivered_at` | SMTP accepted with a message id, or provider webhook |
| `opened_at`, `open_count` | tracking pixel `/api/public/track/open/:token` fetched |
| `clicked_at`, `click_count` | `/s/:token` secure link followed |

## 9.5 Transports

| Transport | Setting `email.transport` | Behaviour |
|---|---|---|
| `capture` (default) | — | Nothing leaves the server. Messages are stored and readable in Settings → Email Outbox, and one-time codes are written to the server log so the workflow is demoable without SMTP. Codes are never returned in an API response |
| `smtp` | host, port, secure, user, password (encrypted), from name/address | Real delivery via `nodemailer`; attachments included |

Switching transport is a settings change and requires no redeploy. When `smtp` is active,
OTP codes are never returned in API responses.

## 9.6 Standard footer

Every template inherits the layout in `src/services/emailLayout.js`: Hyreo wordmark,
`company.name` from settings, the CR reference line, and a confidentiality notice. Admin can
override the subject and body per template; the layout wrapper stays consistent.
