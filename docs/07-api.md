# 07 — API List

Base path `/api`. All responses are JSON: `{ "data": ... }` on success,
`{ "error": { "code", "message", "details" } }` on failure. Authentication is the
`hcrms_session` httpOnly cookie (internal) or `hcrms_portal` (external portal). Every route
below lists the permission it enforces server-side.

## Authentication — `/api/auth`

| Method | Path | Permission | Purpose |
|---|---|---|---|
| POST | `/auth/otp/request` | public (rate-limited) | Send a login OTP to a known, active user. The code is never in the response |
| POST | `/auth/otp/resend` | public | Re-send, subject to cooldown |
| POST | `/auth/otp/verify` | public | Verify code, create session, set cookie |
| GET | `/auth/me` | session | Current user, role, permission list |
| POST | `/auth/logout` | session | Revoke session |

## Users, roles, permissions

| Method | Path | Permission |
|---|---|---|
| GET | `/users` | `user.manage` |
| POST | `/users` | `user.manage` |
| GET | `/users/:id` | `user.manage` |
| PATCH | `/users/:id` | `user.manage` |
| POST | `/users/:id/status` | `user.manage` |
| GET | `/roles` | session |
| GET | `/permissions` | `role.manage` |
| PUT | `/roles/:code/permissions` | `role.manage` |

## Accounts & MSAs

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/accounts` | `account.view` | `?q&status&page&pageSize&sort` |
| POST | `/accounts` | `account.create` | Account + MSA + contacts in one transaction |
| GET | `/accounts/:id` | `account.view` | Account, MSAs, contacts, CR summary |
| PATCH | `/accounts/:id` | `account.edit` | |
| POST | `/accounts/msa-documents` | `account.create` | Upload the signed MSA (base64 JSON, 15 MB) and read its details |
| GET | `/accounts/msa-documents/:id/download` | `account.view` | The stored contract (`?inline=1` to view in the browser) |
| GET | `/msas/:id/document` | `account.view` | Metadata for the MSA on file |
| GET | `/accounts/:id/deletion-impact` | `account.delete` | What a delete would remove, and what blocks it |
| DELETE | `/accounts/:id` | `account.delete` | Cascades draft CRs only; refused if any CR is past draft. `?confirm=<account name>` required when drafts will be cascaded |
| POST | `/accounts/:id/status` | `account.edit` | Activate / deactivate — the reversible alternative to deletion |
| GET | `/accounts/:id/change-requests` | `cr.view` | Account CR history |
| GET | `/accounts/:id/summary` | `account.view` | Cumulative totals |
| POST | `/accounts/:id/msas` | `msa.create` | Additional MSA |
| PATCH | `/msas/:id` | `msa.edit` | |
| GET | `/msas/:id/change-requests` | `cr.view` | MSA-wise CR history |

## Change requests

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/change-requests` | `cr.view` | Filters: account, msa, status, type, priority, owner, from, to, minCost, maxCost |
| POST | `/change-requests` | `cr.create` | Allocates number + reference, snapshots account/MSA |
| GET | `/change-requests/:id` | `cr.view` | Full aggregate incl. items, efforts, costs, approvals, documents |
| PATCH | `/change-requests/:id` | `cr.edit` | Header, timeline, commercial terms |
| PUT | `/change-requests/:id/items` | `cr.edit` | Replace ordered scope list |
| PUT | `/change-requests/:id/efforts` | `cr.edit` | Replace effort lines, recompute total |
| PUT | `/change-requests/:id/costs` | `cr.edit` | Recompute subtotal, discount, tax, total |
| PUT | `/change-requests/:id/assumptions` | `cr.edit` | |
| PUT | `/change-requests/:id/dependencies` | `cr.edit` | |
| POST | `/change-requests/:id/submit` | `cr.submit` | → PENDING_INTERNAL_APPROVAL, mails approver |
| POST | `/change-requests/:id/approve` | `cr.approve` | In-app approval (same engine as portal) |
| POST | `/change-requests/:id/reject` | `cr.approve` | Comments mandatory |
| POST | `/change-requests/:id/revise` | `cr.revise` | Rejected → DRAFT, revision + 1 |
| POST | `/change-requests/:id/hold` · `/resume` | `cr.hold` | ON_HOLD toggle |
| POST | `/change-requests/:id/cancel` | `cr.cancel` | Reason mandatory |
| DELETE | `/change-requests/:id` | `cr.delete` | DRAFT only |
| GET | `/change-requests/:id/timeline` | `cr.view` | Lifecycle stages with actors/timestamps |
| GET | `/change-requests/:id/audit` | `audit.view` | |
| GET | `/change-requests/:id/emails` | `email.view` | |

## Documents

| Method | Path | Permission |
|---|---|---|
| POST | `/change-requests/:id/documents/generate` | `document.generate` — `{format: DOCX\|PDF\|BOTH, notes}`; refused once the CR is COMPLETED, CANCELLED or EXPIRED |
| GET | `/change-requests/:id/documents` | `document.view` |
| GET | `/documents` | `document.view` |
| GET | `/documents/versions/:id/preview` | `document.view` (HTML render of the exact document model) |
| GET | `/documents/versions/:id/download` | `document.download` |

## Customer sharing & e-signature

| Method | Path | Permission |
|---|---|---|
| POST | `/change-requests/:id/share` | `customer.share` (`{to, cc[], subject, message, attachDocx, attachPdf}`) |
| POST | `/change-requests/:id/share/resend` | `customer.share` |
| POST | `/change-requests/:id/docusign/send` | `docusign.send` |
| POST | `/change-requests/:id/docusign/refresh` | `docusign.send` |
| POST | `/change-requests/:id/docusign/void` | `docusign.void` |

## Approvals, dashboard, search, reports, notifications

| Method | Path | Permission |
|---|---|---|
| GET | `/approvals/pending` | `cr.view` |
| GET | `/dashboard` | `dashboard.view` |
| GET | `/search?q=` | `dashboard.view` |
| GET | `/reports/:code` | `report.view` |
| GET | `/reports/:code/export?format=xlsx\|csv\|pdf` | `report.export` |
| GET | `/notifications` | `notification.view` |
| POST | `/notifications/:id/read` · `/notifications/read-all` | `notification.view` |
| DELETE | `/notifications/:id` | `notification.view` — dismiss one, read or unread |
| DELETE | `/notifications?readOnly=1` | `notification.view` — clear all, or only those already read |

Report codes: `cr-register`, `account-cr-history`, `msa-cr-summary`, `monthly-cr`,
`pending-approval`, `cr-cost`, `effort`, `customer-pending`, `rejected-cr`, `completed-cr`.

## Administration

| Method | Path | Permission |
|---|---|---|
| GET / PUT | `/settings` | `settings.manage` |
| GET | `/settings/public` | session (company name, currency, defaults for forms) |
| GET / PUT | `/settings/email-templates[/:code]` | `settings.manage` |
| POST | `/settings/email/test` | `settings.manage` |
| GET / PUT | `/settings/docusign` | `integration.manage` (secrets redacted on read) |
| POST | `/settings/docusign/test` | `integration.manage` |
| GET / PUT | `/settings/approval-levels` | `settings.manage` |
| GET | `/enums` | session |
| GET | `/emails` · `/emails/:id` | `email.view` |
| GET | `/audit` | `audit.view` |

## Public portal (token + OTP, no session cookie required to start)

| Method | Path | Notes |
|---|---|---|
| GET | `/s/:token` | Click-tracked redirect into the SPA portal route |
| GET | `/api/portal/:token` | Link metadata: CR number, account, audience, masked email, state |
| POST | `/api/portal/:token/otp/request` | Email must match the bound address |
| POST | `/api/portal/:token/otp/verify` | Issues a portal session scoped to that one CR |
| GET | `/api/portal/:token/cr` | Read-only CR aggregate |
| GET | `/api/portal/:token/documents/:versionId` | Download within the portal session |
| POST | `/api/portal/:token/approve` | Approver approve |
| POST | `/api/portal/:token/reject` | Approver / customer reject — comments mandatory |
| POST | `/api/portal/:token/sign` | Customer approve & sign (typed signature + consent) |
| GET | `/api/public/track/open/:trackingToken` | 1×1 tracking pixel |
| POST | `/api/webhooks/docusign` | DocuSign Connect callback (HMAC verified) |

## Error codes

`AUTH_REQUIRED` 401 · `FORBIDDEN` 403 · `NOT_FOUND` 404 · `VALIDATION_FAILED` 422 ·
`INVALID_STATE` 409 · `DUPLICATE` 409 · `RATE_LIMITED` 429 · `OTP_INVALID` 400 ·
`OTP_EXPIRED` 400 · `LOCKED` 423 · `INTEGRATION_ERROR` 502 · `INTERNAL` 500.
