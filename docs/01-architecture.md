# 01 — Application Architecture

## 1.1 Overview

Hyreo CRMS is a server-rendered-API + SPA enterprise application. It is a single deployable
Node.js process that serves a JSON API, static SPA assets, generated documents and public
(tokenised) portal endpoints for external approvers and customers.

```
┌────────────────────────────────────────────────────────────────────────────┐
│                              Browser (SPA)                                 │
│  public/js  ·  router · api client · design system (public/css/app.css)    │
│  Internal app (session cookie)        │   Public portal (portal token+OTP)  │
└───────────────────┬────────────────────┴───────────────────┬───────────────┘
                    │ HTTPS / JSON                           │
┌───────────────────▼────────────────────────────────────────▼───────────────┐
│                          Express 5 HTTP layer                              │
│  security headers · body parse · request id · rate limit · cookie parse    │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ Routes  /api/auth /api/accounts /api/change-requests /api/approvals  │  │
│  │         /api/documents /api/reports /api/settings /api/users         │  │
│  │         /api/notifications /api/portal (public) /api/webhooks        │  │
│  └──────────────────────────┬───────────────────────────────────────────┘  │
│  Middleware: requireSession · requirePermission · validate(schema)         │
├────────────────────────────┬───────────────────────────────────────────────┤
│                     Service layer (business rules)                         │
│  auth · users · accounts · changeRequests · numbering · approvals          │
│  documents · email · notifications · docusign · reports · settings · audit │
├────────────────────────────┬───────────────────────────────────────────────┤
│  Integration adapters      │  Document engine      │  Persistence          │
│  email: smtp | capture     │  zip → docx (OOXML)   │  node:sqlite (WAL)    │
│  esign: docusign | simulated│ pdf (Type1 writer)   │  repositories + tx    │
└────────────────────────────┴───────────────────────┴───────────────────────┘
                                                        │
                                          storage/documents/<cr-id>/<version>
```

## 1.2 Technology choices

| Concern | Choice | Rationale |
|---|---|---|
| Runtime | Node.js >= 22 (built on 24) | `node:sqlite` is built in — no native compilation, no build step |
| HTTP | Express 5 | Stable, async error propagation |
| Database | SQLite (`node:sqlite`) in WAL mode | Relational, ACID, zero-ops. Schema is portable to Postgres (see §1.7) |
| Auth | Email OTP → server-side session, httpOnly cookie | Requirement: no passwords |
| DOCX | Hand-built OOXML (`src/lib/zip.js` + `src/lib/docx.js`) | Byte-exact control of the legal document layout; no third-party template drift |
| PDF | Hand-built PDF 1.7 writer (`src/lib/pdf.js`) | Same document model renders to both formats; no headless browser dependency |
| Email | `nodemailer` (optional) behind a transport interface, `capture` transport by default | App is fully demoable with zero SMTP config; production flips one setting |
| e-Sign | Provider interface: `simulated` (default) / `docusign` (REST) | Integration-ready without blocking on credentials |
| Frontend | ES-module SPA, no build step | Deterministic deploys; the whole app is `node server.js` |

## 1.3 Layering rules

1. **Routes** never contain business rules. They validate input, resolve the actor, call a
   service and shape the HTTP response.
2. **Services** own all business rules, own transactions, and are the only layer that writes
   to the database. Every state-changing service call writes an audit record.
3. **Repositories** (`src/db/repo.js`) are thin, parameterised SQL helpers. No string
   interpolation of user input ever reaches SQL.
4. **Adapters** (email, e-sign) are swappable via settings; services depend on the interface.
5. **Configurable, not hard-coded**: numbering format, billing rate, currency, tax, terms,
   OTP policy, session timeout, approval levels and email templates all live in `settings` /
   `email_templates` / `cr_approval_levels` — never in code branches.

## 1.4 Request lifecycle (internal user)

```
Browser → cookie hcrms_session
  → requestContext (request id, ip, ua)
  → requireSession  → sessions table lookup → sliding expiry → req.user
  → requirePermission('cr.create') → role_permissions lookup
  → validate(schema) → 422 on failure
  → service.method(actor, dto)  ── transaction ──┐
        ├ business rule checks (state machine, locks, uniqueness)
        ├ writes to domain tables
        ├ auditService.record(...)              │
        └ notificationService.emit(...) ────────┘ (email queued after commit)
  → 200 { data }  |  error → problem+json { error: { code, message, details } }
```

## 1.5 Security architecture

* OTP codes are stored as SHA-256(pepper + code); never in plaintext, never returned in a
  response when a real mail transport is configured.
* A configurable demo master OTP (`otp.master_code`) may stand in for any emailed code
  outside production. `masterCode()` short-circuits to `''` when `NODE_ENV=production`, so
  the bypass is structurally impossible in a real deployment; each use is audited and the
  outstanding challenge is consumed so the emailed code cannot be replayed afterwards.
* Sessions: 256-bit random token, only the hash is stored, `httpOnly; SameSite=Lax; Secure`
  (when `APP_URL` is https). Idle timeout + absolute timeout, both configurable.
* Portal links: single-purpose signed tokens (`share_links`) scoped to one CR **and one
  email address**, with expiry, revocation and an independent OTP challenge. A customer can
  never enumerate or reach another CR.
* Documents are served only through `/api/documents/:versionId/download` after an
  authorisation check (internal permission *or* an active portal session for that CR).
  Nothing under `storage/` is statically served.
* Secrets in `settings` (SMTP password, DocuSign key/secret) are encrypted at rest with
  AES-256-GCM using `APP_SECRET`, and are redacted on read.
* `audit_logs` is append-only, enforced by SQLite triggers that `RAISE(ABORT)` on UPDATE
  and DELETE — not merely by convention in the service layer.

## 1.6 Extensibility (explicit requirements)

* **Additional approval levels** — `cr_approval_levels` defines an ordered ladder per
  account (or a global default). `change_request_approvals` rows are created per level;
  the CR advances only when every level at the current step is approved. Adding level 2 is
  a data change, not a code change.
* **Additional customer signatories** — `customer_approvals` and `docusign_envelopes` are
  one-to-many on the CR with a `signer_order`, so a second customer signatory is a row.
* **New CR types / priorities / statuses** — enumerations live in `enums` table seeds.

## 1.7 Portability

Schema uses only portable SQL: `TEXT` ISO-8601 dates, `INTEGER` booleans, `REAL` money with
explicit rounding in `src/lib/money.js`. Moving to Postgres requires swapping
`src/db/index.js` and the three `INSERT ... ON CONFLICT` helpers.

## 1.8 Deployment

```
APP_SECRET=<32+ bytes>  APP_URL=https://crms.hyreo.com  NODE_ENV=production
node server.js            # migrations + seed run on boot, idempotent
```
Backups: `storage/hcrms.db*` (WAL checkpointed on shutdown) + `storage/documents/`.
