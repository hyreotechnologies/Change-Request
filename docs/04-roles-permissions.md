# 04 — User Roles and Permissions Matrix

Permissions are data (`permissions` + `role_permissions` tables), seeded from this matrix.
Every API route declares the permission it requires; the SPA hides what the user cannot do,
but **authorisation is always re-checked server-side** — hiding a button is never the
control.

## 4.1 Roles

| Code | Name | Intent |
|---|---|---|
| `ADMIN` | Administrator | Full control, including users, roles, settings and integrations |
| `CR_MANAGER` | Change Request Manager | Owns the CR lifecycle up to customer signature |
| `APPROVER` | Internal Approver | Reviews and decides on CRs assigned to them |
| `VIEWER` | Viewer | Read-only across accounts, CRs and reports |

Two non-authenticated-user actors also exist and are **not** roles:

| Actor | How it is authorised |
|---|---|
| External Approver | `share_links` token (audience `APPROVER`) + OTP on the bound email |
| Customer Signatory | `share_links` token (audience `CUSTOMER`) + OTP on the bound email |

## 4.2 Permission matrix

Legend: ● granted · ○ not granted · ◐ granted, restricted to records assigned to the user.

| Permission | Module | ADMIN | CR_MANAGER | APPROVER | VIEWER |
|---|---|:--:|:--:|:--:|:--:|
| `dashboard.view` | Dashboard | ● | ● | ● | ● |
| `account.view` | Accounts | ● | ● | ● | ● |
| `account.create` | Accounts | ● | ● | ○ | ○ |
| `account.edit` | Accounts | ● | ● | ○ | ○ |
| `account.delete` | Accounts | ● | ○ | ○ | ○ |
| `msa.create` | MSA | ● | ● | ○ | ○ |
| `msa.edit` | MSA | ● | ● | ○ | ○ |
| `cr.view` | Change Requests | ● | ● | ◐ | ● |
| `cr.create` | Change Requests | ● | ● | ○ | ○ |
| `cr.edit` | Change Requests | ● | ● | ○ | ○ |
| `cr.delete` | Change Requests | ● | ○ | ○ | ○ |
| `cr.submit` | Change Requests | ● | ● | ○ | ○ |
| `cr.revise` | Change Requests | ● | ● | ○ | ○ |
| `cr.cancel` | Change Requests | ● | ● | ○ | ○ |
| `cr.hold` | Change Requests | ● | ● | ○ | ○ |
| `cr.approve` | Approvals | ● | ○ | ◐ | ○ |
| `document.generate` | Documents | ● | ● | ○ | ○ |
| `document.view` | Documents | ● | ● | ◐ | ● |
| `document.download` | Documents | ● | ● | ◐ | ● |
| `customer.share` | Customer | ● | ● | ○ | ○ |
| `docusign.send` | Integration | ● | ● | ○ | ○ |
| `docusign.void` | Integration | ● | ○ | ○ | ○ |
| `report.view` | Reports | ● | ● | ● | ● |
| `report.export` | Reports | ● | ● | ● | ● |
| `notification.view` | Notifications | ● | ● | ● | ● |
| `audit.view` | Audit | ● | ● | ◐ | ● |
| `email.view` | Communication | ● | ● | ○ | ○ |
| `user.manage` | Administration | ● | ○ | ○ | ○ |
| `role.manage` | Administration | ● | ○ | ○ | ○ |
| `settings.manage` | Administration | ● | ○ | ○ | ○ |
| `integration.manage` | Administration | ● | ○ | ○ | ○ |

### Row-level scoping (the ◐ cells)

`APPROVER` only sees a CR when a `change_request_approvals` row exists for their email, or
they are recorded as the CR's internal approver. This is applied as a SQL predicate in
`changeRequestService.scopeFor(actor)`, not as a post-filter.

## 4.3 Action guards beyond permissions

Even with the permission, an action must also satisfy the state machine and lock rules:

| Action | Additional guard |
|---|---|
| `cr.edit` | CR status ∈ {DRAFT, REVISION} **or** actor is ADMIN and status ∈ {ON_HOLD}; never when COMPLETED/SIGNED |
| `cr.submit` | status ∈ {DRAFT, REVISION}; at least one scope item; total effort > 0; billing rate set |
| `cr.approve` | status = PENDING_INTERNAL_APPROVAL and a PENDING approval row for the actor's email at the current level |
| `customer.share` | status ∈ {INTERNALLY_APPROVED, READY_FOR_CUSTOMER, SENT_TO_CUSTOMER, CUSTOMER_VIEWED, CUSTOMER_APPROVAL_PENDING} and a FINAL document version exists |
| `docusign.send` | status ∈ {READY_FOR_CUSTOMER, SENT_TO_CUSTOMER, CUSTOMER_VIEWED, CUSTOMER_APPROVAL_PENDING, CUSTOMER_APPROVED} |
| `cr.delete` | status = DRAFT only (DB trigger blocks the rest regardless of role) |
| `account.delete` | every CR under the account must be DRAFT; those drafts are cascaded. The account name must be typed to confirm when drafts will be removed. Otherwise the action is refused and deactivation is offered |
| rejection | comment is mandatory, minimum 5 characters |

## 4.4 Session policy

| Setting | Default | Key |
|---|---|---|
| Idle timeout | 60 min | `security.session_idle_minutes` |
| Absolute session lifetime | 12 h | `security.session_absolute_hours` |
| OTP length | 6 | `otp.length` |
| OTP validity | 10 min | `otp.validity_minutes` |
| OTP max attempts | 5 | `otp.max_attempts` |
| OTP resend cooldown | 60 s | `otp.resend_cooldown_seconds` |
| Demo master OTP | `011235` (non-production only) | `otp.master_code` |
| Portal link validity | 14 days | `security.portal_link_days` |

The master OTP is a demo convenience: it substitutes for any emailed code, it
consumes the outstanding challenge so the real code cannot be replayed, every use
is written to `audit_logs`, and `authService.masterCode()` returns an empty string
whenever `NODE_ENV=production` — so the bypass cannot exist in a real deployment.
