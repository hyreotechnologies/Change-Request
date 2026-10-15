# Hyreo Account Management System

A single system of record for the full customer change request lifecycle:
**Account → MSA → Change Request → estimation → internal approval → document
generation → customer sharing → OTP-verified signature → completion**, with an
immutable audit trail behind every step.

It replaces the manually maintained change request tracker. There is no
spreadsheet anywhere in the design: the Account → MSA → CR relationship is the
core data model, so opening an MSA immediately shows every CR raised against it.

---

## 1. Running it

```bash
npm install
npm start            # http://localhost:4100
```

Node.js 22.5+ is required (the database driver is the built-in `node:sqlite`).
There is no build step and no external service to provision — migrations and
seed data run on first boot.

| Command | What it does |
|---|---|
| `npm start` | Run the application |
| `npm run dev` | Run with file watching |
| `npm run seed` | Re-run the idempotent seed |
| `npm run reset` | Drop the database and generated documents, re-seed. Refuses if the database holds anything beyond the demo set unless `--force` |
| `npm run smoke` | End-to-end API workflow test (33 checks) |
| `node tests/ui.test.js` | Browser walkthrough in headless Edge/Chrome (46 checks) |

Configuration lives in `.env` (see `.env.example`). In production set
`NODE_ENV=production`, a 32+ character `APP_SECRET` and the public `APP_URL`.

### Demo sign-in

Sign-in is email + one-time passcode; there are no passwords. Out of the box the
email transport is `capture`, which stores messages in the application instead of
delivering them — so the OTP is shown on screen and every message is readable
under **Email Outbox**. Switch to SMTP in **Settings → Email** for real delivery,
after which codes are never echoed.

One-time codes are never returned in an API response. Without SMTP they are
written to the server console (`[hcrms] one-time code for you@company.com: 123456`)
and the full message is readable under **Email Outbox** once signed in.

**Demo master code: `011235`.** For convenience it is accepted in place of any
emailed code — for sign-in and for both the approver and customer portals. It is
a setting (`otp.master_code`, Settings → OTP & security), it is announced in the
server banner at boot, its use is recorded in the audit trail, and it is
**ignored entirely when `NODE_ENV=production`** regardless of the stored value.
Clear the setting to turn it off sooner.

| Email | Role |
|---|---|
| `sahaf@hyreo.com` | Administrator |
| `cr.manager@hyreo.com` | Change Request Manager |
| `arun.satyan@hyreo.com` | Approver |
| `viewer@hyreo.com` | Viewer |

### Seeded data

`PeerIslands` / MSA `PEERISLANDS-0001` (dated 09 October 2025) with
`PEERISLANDS-CR-001` (contract reference `PEERISLANDS-0001-01`) reproducing the
executed CR01 document: two scope items, 16 h development + 8 h testing,
INR 2,000/hour, INR 48,000 CR cost, INR 48,000 discount, **INR 0.00** final cost.
A second account (`Acme Technologies`) carries three change requests in different
lifecycle states so the dashboard, reports and charts have shape.

### Walking the whole workflow in five minutes

1. Sign in as `sahaf@hyreo.com`, copy the OTP from the screen.
2. **Accounts → Create Account** starts by asking for the signed MSA. Upload a
   PDF, Word or text contract and its reference number, dates, parties, value and
   payment terms are read from it and offered for review; the document stays on
   file behind **View MSA**. *Enter details manually instead* skips the upload.
3. **Change Requests → Create Change Request**, pick *PeerIslands*; MSA, customer,
   approver and internal ownership auto-populate and the CR number is allocated.
4. Add scope, effort and cost; the totals calculate as you type, and again on the
   server when saved.
5. **Submit for approval** — the CR locks and an approval email is queued.
6. **Email Outbox** → open *Internal Approval Request* → follow the
   "Review Change Request" link (it opens the external portal).
7. Enter the approver's address, use the master code, approve. Version 2.0 of the
   document is generated and locked automatically.
8. Back on the CR, **Share with customer**, then open the customer email from the
   Outbox, verify and **Approve & Sign**.
9. The CR reaches **Completed** with a signed PDF, a signature certificate and a
   complete audit log.

---

## 2. Design documents

Produced before the implementation and kept in step with it:

| Document | Contents |
|---|---|
| [docs/01-architecture.md](docs/01-architecture.md) | Layering, technology choices, request lifecycle, security model, extensibility |
| [docs/02-database-schema.md](docs/02-database-schema.md) | Every table, key and constraint |
| [docs/03-erd.md](docs/03-erd.md) | Entity relationship diagram and delete rules |
| [docs/04-roles-permissions.md](docs/04-roles-permissions.md) | Role definitions and the full permission matrix |
| [docs/05-workflow.md](docs/05-workflow.md) | End-to-end workflow and swimlanes |
| [docs/06-screens.md](docs/06-screens.md) | Screen inventory and responsive rules |
| [docs/07-api.md](docs/07-api.md) | Every endpoint and the permission it enforces |
| [docs/08-state-machine.md](docs/08-state-machine.md) | CR statuses, transitions, guards and invariants |
| [docs/09-email-matrix.md](docs/09-email-matrix.md) | Email/notification triggers, recipients and tracking |
| [docs/10-acceptance.md](docs/10-acceptance.md) | Acceptance criteria mapped to code and tests |

---

## 3. How it is put together

```
server.js                 Express app, static SPA, secure-link redirect, boot
src/config.js             Environment, paths, cookie and rate-limit policy
src/db/                   schema.sql · connection + transactions · seed
src/lib/                  errors · ids · dates · money · crypto · validate
                          zip → docx · pdf · xlsx   (document engine, no deps)
src/middleware/           session, RBAC, rate limiting, error translation
src/services/             all business rules (see below)
src/routes/               HTTP surface — validation in, JSON out
public/                   SPA: design system, router, components, pages
tests/                    smoke.test.js (API) · ui.test.js (browser)
```

**Service layer** — `auth` · `users` · `rbac` · `accounts` · `changeRequests` ·
`numbering` · `stateMachine` · `approvals` · `documents` · `documentModel` ·
`portal` · `shareLinks` · `docusign` · `email` · `emailTemplates` ·
`notifications` · `dashboard` · `reports` · `settings` · `audit`.

Routes never contain business rules; services own transactions and are the only
writers; every state change is audited.

### Things worth knowing

* **Numbering is configurable.** `PEERISLANDS-CR-001` (display) and
  `PEERISLANDS-0001-01` (contractual reference, as on the executed document) come
  from two format strings in Settings → CR numbering. Sequences increment per
  account, enforced by `UNIQUE(account_id, seq_no)`.
* **Money is never trusted from the client.** Effort, subtotal, discount, tax and
  total are recomputed in `src/lib/money.js` on every write.
* **An account starts from its contract.** The signed MSA is uploaded first,
  read for its details (`src/lib/textExtract.js` reads .docx and text-layer PDFs,
  including subset fonts via their `/ToUnicode` tables and dictionaries packed
  into compressed object streams;
  `src/services/msaExtract.js` finds the fields), and kept against the MSA so it
  can be opened later. Extraction never decides anything on its own: every value
  is shown with the snippet it came from and must be reviewed before saving, and
  a scanned PDF simply falls back to manual entry.
* **A notification closes itself when its work is done.** An approval request
  disappears once it is decided, resubmitting replaces the old request instead of
  stacking a second one, and customer prompts clear when the customer signs or
  rejects. Notifications are a to-do list, not history — the audit log is history.
* **A rejected CR is "Under Revision", not "Draft".** Internal and customer
  rejections both land in REVISION: editable again, but visibly distinct from a
  change request nobody has submitted yet. Resubmitting opens a fresh approval
  for the new revision and keeps the earlier decision on the record.
* **Snapshots keep history honest.** A CR freezes the account/MSA facts it was
  raised under, so editing an account later never rewrites a signed change request.
* **Documents are immutable.** Each generation adds a version (1.x while draft,
  2.0 on approval). Locked versions cannot be updated or deleted — enforced by
  database triggers, not convention. Manual generation asks which format you want
  (PDF, Word or both) and downloads it immediately. Automatic generation — on
  submission and on approval — produces the single format set by
  `defaults.document_format` (Settings → Defaults, PDF out of the box).
  Generating the other format of an already-approved document joins that FINAL
  version instead of starting a new one, so both halves of a contract carry the
  same version number. A closed change request keeps every version downloadable
  but accepts no new ones.
* **The audit log cannot be tampered with.** `UPDATE` and `DELETE` on
  `audit_logs` raise a SQLite `ABORT`, and it carries no foreign key — so the
  history of a record survives the record's deletion.
* **Deleting an account is bounded.** It cascades draft change requests (and
  their unlocked documents) and asks you to type the account name first. A single
  submitted, approved or signed CR blocks the delete outright and the app offers
  deactivation instead, which keeps the history and stops new CRs.
* **External access is a three-factor affair**: a signed, expiring link bound to
  one CR *and* one email address, plus an OTP challenge on that address, plus a
  short-lived portal session. Documents are never served from a public path.
* **Word and PDF are generated in-process** from one document model
  (`src/services/documentModel.js`), so the preview, the .docx and the .pdf can
  never drift apart. No templating engine, no headless browser.
* **DocuSign is an adapter.** `SIMULATED` (default) completes signature through
  the secure portal; `DOCUSIGN` performs the real JWT + envelope flow with
  Connect webhooks. Credentials are AES-256-GCM encrypted at rest.
* **Nothing waits silently.** Every open stage has a time limit (Settings →
  Reminders & time limits). Lists, the board and the dashboard flag what is due
  today or overdue. A scheduler in the server process runs every 15 minutes and
  reminds approvers and customers who have not acted. If they still have not
  acted after the escalation threshold, it tells the CR owner and the escalation
  contact, once. Each send is recorded in `workflow_reminders`, so running the
  scheduler again never repeats a reminder or an escalation.
* **Each submission is snapshotted** (`cr_snapshots`). A revised CR shows
  approvers exactly what changed since the version they rejected.
* **Slack and Teams** receive approval requests, decisions, signatures and
  escalations through incoming webhooks (Settings → Slack & Teams). Delivery is
  best-effort and never blocks the workflow.

---

## 4. Extending it

| Change | How |
|---|---|
| A second internal approval level | Settings → Approval levels; a CR advances only when every level approves |
| A second customer signatory | Insert a `customer_approvals` row with the next `signer_order` |
| New CR type, priority or industry | `/api/enums` seeds — no code change |
| Different standard terms | Settings → Standard terms |
| Different billing rate, currency or tax | Settings → Defaults |
| Real email | Settings → Email → transport `smtp` |
| Postgres instead of SQLite | Swap `src/db/index.js`; the schema is portable SQL |

---

## 5. Testing

```bash
npm run smoke                  # API: account → CR → approval → share → sign → reports
node tests/features.test.js    # API: time limits, my queue, duplicate, reassign, saved views,
                               #      reminders + escalation, version comparison, renewals, budget
node tests/ui.test.js          # Browser: every screen, both portals, zero console errors
```

The API suite asserts the business rules directly: duplicate MSA rejection,
server-side cost maths, locking on submit, OTP binding, rejection comments being
mandatory, immutability of completed CRs and audit records, RBAC denial for a
viewer, and authenticated-only document download. The browser suite drives the
real UI through the entire lifecycle, including both OTP portals and the
signature flow.
#   C h a n g e - R e q u e s t  
 