# 10 — Acceptance Criteria Traceability

Each criterion from the brief, where it is implemented, and the automated check
that proves it. `smoke` = `tests/smoke.test.js` (API), `ui` = `tests/ui.test.js`
(headless browser walkthrough).

| # | Criterion | Implementation | Verified by |
|---|---|---|---|
| 1 | User can login using email OTP | `src/services/auth.js`, `public/js/pages/login.js` | smoke 1 · ui 1–3 |
| 2 | Admin can create an account | `accountService.create`, `/accounts/new` — upload the MSA or enter manually | smoke 3, 3b · ui "creating an account starts by uploading the MSA" |
| 3 | Admin can create an MSA | same transaction as the account; `POST /accounts/:id/msas` for further MSAs | smoke 3 |
| 4 | User can view all CRs associated with an MSA | `GET /msas/:id/change-requests`, account detail history table | ui "account detail" |
| 5 | User can create a CR by selecting an account | 7-step wizard, `changeRequests.create` | ui wizard 1–7 |
| 6 | Account/MSA information auto-populates | `accounts.lookup` + snapshot columns on `change_requests` | smoke 5 · ui wizard step 1 |
| 7 | User can add multiple CR scope items | `change_request_items`, repeater UI with reorder and delete | smoke 6 · ui wizard step 3 |
| 8 | Effort calculates automatically | `lib/money.computeCosts`, live client preview | smoke 7 · ui wizard step 4 |
| 9 | Cost calculates automatically | server-side recompute on every write | smoke 7 · ui wizard step 5 |
| 10 | User can save CR as draft | draft created at step 2; "Save draft" throughout | ui wizard step 2 |
| 11 | User can submit CR for internal approval | `approvals.submit` — locks the CR, builds the ladder | smoke 9 · ui "submit for approval" |
| 12 | Manager receives email | `INTERNAL_APPROVAL_REQUEST` with a secure review link | smoke 10 · ui "approval email carries a secure review link" |
| 13 | Manager verifies using OTP | `portal.requestOtp` / `verifyOtp`, purpose `APPROVER_PORTAL` | smoke 11–12 · ui "approver verifies OTP" |
| 14 | Manager can view the CR | `portal.viewChangeRequest` (read-only projection) | smoke 12 · ui same |
| 15 | Manager can approve or reject | `approvals.decide` — one engine for portal and in-app | smoke 12 · ui "approver approves" |
| 16 | Rejection requires comments | guard in `approvals.decide`, mandatory comment dialog | smoke 13 |
| 17 | Approved CR becomes ready for customer sharing | auto transition `INTERNALLY_APPROVED → READY_FOR_CUSTOMER` + v2.0 FINAL document | smoke 12 · ui "ready for customer" |
| 18 | Word document can be generated | `lib/docx.js` (OOXML built in-process) | smoke 8 · ui "document preview" |
| 19 | PDF can be generated | `lib/pdf.js` (PDF 1.7 writer) | smoke 8, 21 |
| 20 | Customer receives CR through email | `portal.shareWithCustomer` with DOCX + PDF attached | smoke 14 · ui "share with customer" |
| 21 | Customer must verify through OTP | purpose `CUSTOMER_PORTAL`, bound to the share link's email | smoke 15 · ui "customer verifies OTP" |
| 22 | Customer can view the CR | customer projection hides internal ownership | smoke 15 · ui same |
| 23 | Customer can approve/reject | `portal.customerSign` / `customerReject` | smoke 16 · ui "customer signs" |
| 24 | Customer rejection requires comments | validated (min 5 characters) before the transition | smoke 15b |
| 25 | DocuSign integration is available | `src/services/docusign.js` — `SIMULATED` and `DOCUSIGN` providers, Connect webhook | smoke 22 · ui settings → DocuSign |
| 26 | Signed documents are stored | `documents.storeSignedDocument` + signature certificate page | smoke 16 · ui "COMPLETED with a signed document" |
| 27 | CR status updates automatically | `stateMachine` + `changeRequests.applyTransition` | smoke 9, 12, 15, 16 |
| 28 | Complete audit trail is maintained | `audit_logs` (append-only triggers), Audit Log tab | smoke 18 · ui "every CR detail tab" |
| 29 | Account-wise CR history is available | account detail page + `account-cr-history` report | ui "account detail" |
| 30 | MSA-wise CR history is available | `GET /msas/:id/change-requests` + `msa-cr-summary` report | smoke 20 |
| 31 | Reports can be exported | Excel (`lib/xlsx.js`), CSV, PDF | smoke 20 · ui "reports run and export" |
| 32 | Approved/completed CRs cannot be silently modified or deleted | `locked` flag, state guards, `cr_no_edit_when_closed` / `cr_no_delete_when_approved` triggers | smoke 17 |

## Additional guarantees proven by the suites

| Guarantee | Verified by |
|---|---|
| Duplicate MSA reference numbers are rejected | smoke 4 |
| CR numbers increment independently per account | smoke 5 · ui wizard step 2 (`PEERISLANDS-CR-002`) |
| Cost arithmetic is server-authoritative (subtotal, % discount, tax) | smoke 7 |
| A locked CR rejects edits | smoke 9 |
| A portal link cannot be used from another email address | smoke 11 |
| The CR is not readable before OTP verification | smoke 11 · ui "portal blocks access" |
| Audit records cannot be updated or deleted, even in raw SQL | smoke 18 |
| A Viewer cannot create a change request but can still read | smoke 19 |
| Documents are never publicly downloadable (401 without a session) | smoke 21 |
| The seeded CR reproduces the source document exactly (24 h, INR 0.00) | smoke 2 |
| The UI raises no console errors across the whole lifecycle | ui final check |
| The demo master OTP signs in, an arbitrary code still fails, and production ignores the bypass | smoke 1b · ui 3 |
| Downloading a document saves a real file and never navigates the SPA away | ui "downloading a document" |
| Generating a document produces only the requested format | ui "generating a document" |
| An account with contractual CRs cannot be deleted; deactivation is offered instead | smoke 17b · ui "deleting an account with contractual CRs" |
| An account with only drafts deletes after typed confirmation, taking its drafts and their documents | smoke 17c · ui "an account with only drafts" |
| A rejected CR can be edited and resubmitted, and the approver reviews the edited document | smoke 13b · ui "a rejected change request opens in the edit wizard" |
| A rejected CR reads as "Under Revision" and stays visible in the rejected dashboard lens and register filter | smoke 13b · ui "a rejected change request opens in the edit wizard" |
| An uploaded MSA populates the account form and stays viewable afterwards | smoke 3b · ui "creating an account starts by uploading the MSA", "the stored MSA can be opened again" |
| One-time codes are never returned over HTTP | smoke `login()` · ui 3 |
| A multi-megabyte MSA uploads, and unknown API routes answer with JSON rather than the SPA shell | smoke 3c |
| Unreadable PDF text is refused instead of being offered as extracted data | smoke 3d |
| A PDF whose fonts are subset and whose dictionaries sit in object streams is still decoded | smoke 3e |
| The generated document keeps the agreed table layout and prints no tooling footer | smoke 8 |
| Automatic generation produces one document, and a companion format joins the same approved version | smoke 9, 12 |
| A decided approval closes its own notification, and resubmission replaces rather than stacks | smoke 13c |
| The change request detail highlights the tab you are actually on | ui "every CR detail tab renders and highlights" |
| Notifications can be dismissed individually and cleared entirely | smoke 18b · ui "notifications can be dismissed" |

## Running the suites

```bash
npm run smoke            # 33 checks
node tests/ui.test.js    # 46 checks (needs Edge or Chrome installed)
```
