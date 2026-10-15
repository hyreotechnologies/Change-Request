# 05 — Complete Workflow Diagram

## 5.1 End-to-end flow

```
┌── INTERNAL USER ──────────────────────────────────────────────────────────┐
│                                                                           │
│  Login screen ──▶ enter email ──▶ POST /auth/otp/request                   │
│        │                              │ (OTP mailed, hashed at rest)       │
│        └──▶ enter 6-digit OTP ──▶ POST /auth/otp/verify ──▶ session cookie │
│                                                                           │
│  Dashboard (KPIs · charts · recent CRs · global search)                   │
│        │                                                                  │
│        ├──▶ Accounts ──▶ Create Account (+ MSA + contacts + internal owners)│
│        │                      │ generates ACC-000n, MSA reference unique   │
│        │                      └──▶ Account detail = MSA facts + CR history │
│        │                                                                  │
│        └──▶ Create Change Request                                          │
│               STEP 1  select account  ──▶ auto-populate MSA / customer /   │
│                                          approver / internal owners        │
│                                          (read-only snapshot)              │
│               STEP 2  CR header — number auto-generated per account        │
│                       PEERISLANDS-CR-001 / ref PEERISLANDS-0001-01         │
│               STEP 3  scope items (add · edit · delete · reorder)          │
│               STEP 4  effort (dev, test, BA, PM, deployment, other)        │
│                       total effort auto-calculated                         │
│               STEP 5  cost (rate × effort, discount %, tax) auto-calculated│
│               STEP 6  timeline · assumptions · dependencies · commercials  │
│               STEP 7  review summary                                       │
│                         ├── Save Draft   → status DRAFT                    │
│                         ├── Preview      → document engine (v1.x DRAFT)    │
│                         └── Submit for Approval                            │
│                                     │                                      │
└─────────────────────────────────────┼──────────────────────────────────────┘
                                      ▼
                       status = PENDING_INTERNAL_APPROVAL, CR locked
                       approval rows created for every configured level
                       e-mail: INTERNAL_APPROVAL_REQUEST  → approver
                       in-app notification → approver
                                      │
┌── INTERNAL APPROVER ─────────────────▼─────────────────────────────────────┐
│  clicks "Review Change Request" (signed portal link, scoped to 1 CR+email) │
│        ──▶ /portal/<token> ──▶ enter email ──▶ OTP ──▶ verify              │
│        ──▶ read-only CR + document preview/download                        │
│              ├── Approve  ──▶ confirmation dialog                          │
│              │        all levels approved? ──▶ status INTERNALLY_APPROVED  │
│              │        final document version 2.0 FINAL generated & locked  │
│              │        e-mail: CR_APPROVED → CR manager                     │
│              └── Reject   ──▶ mandatory reason (min 5 chars)               │
│                       status INTERNAL_REJECTED → REVISION (rev+1)         │
│                       e-mail: CR_REJECTED → CR manager                     │
└────────────────────────────┬──────────────────────────────────────────────┘
                             ▼
              status READY_FOR_CUSTOMER (auto on internal approval)
                             │
┌── CR MANAGER ───────────────▼─────────────────────────────────────────────┐
│  "Share with Customer" ──▶ email composer (to = customer approver,        │
│     cc optional, editable subject/body, DOCX+PDF attached, secure link)   │
│     ──▶ status SENT_TO_CUSTOMER · email tracked (sent/open/click)          │
│  or "Send via DocuSign" ──▶ envelope created, Hyreo + customer signers     │
└────────────────────────────┬──────────────────────────────────────────────┘
                             ▼
┌── CUSTOMER ─────────────────────────────────────────────────────────────── ┐
│  clicks "Review & Sign Change Request" ──▶ email ──▶ OTP ──▶ verify        │
│     first view ──▶ status CUSTOMER_VIEWED → CUSTOMER_APPROVAL_PENDING     │
│     read-only CR + document                                               │
│        ├── Approve & Sign ──▶ typed signature + consent                   │
│        │        status CUSTOMER_APPROVED ──▶ SIGNED ──▶ COMPLETED          │
│        │        signed document version stored (locked)                   │
│        │        e-mail: CUSTOMER_APPROVED → CR manager                    │
│        └── Reject ──▶ mandatory comments                                  │
│                 status CUSTOMER_REJECTED ──▶ REVISION (editable again)    │
│                 e-mail: CUSTOMER_REJECTED → CR manager                    │
└────────────────────────────┬──────────────────────────────────────────────┘
                             ▼
              DocuSign path: envelope sent → delivered → viewed → signed →
              completed (webhook or poll) ──▶ signed PDF stored, CR COMPLETED
                             ▼
              e-mail: DOCUSIGN_COMPLETED → CR manager + admin
              full audit history retained for the life of the record
```

## 5.2 Swimlane summary

| Step | Actor | System effect | Status after |
|---|---|---|---|
| 1 | CR Manager | Account + MSA created, ids allocated | — |
| 2 | CR Manager | CR created, number + reference allocated, snapshot frozen | DRAFT |
| 3 | CR Manager | Scope / effort / cost / timeline saved, totals recomputed | DRAFT |
| 4 | CR Manager | Preview generates document v1.x (DRAFT) | DRAFT |
| 5 | CR Manager | Submit — CR locked, approval rows created, email sent | PENDING_INTERNAL_APPROVAL |
| 6 | Approver | OTP portal login | unchanged |
| 7 | Approver | Approve — last level closes the ladder, v2.0 FINAL generated | INTERNALLY_APPROVED → READY_FOR_CUSTOMER |
| 7r | Approver | Reject with reason, notification to manager | INTERNAL_REJECTED → REVISION |
| 7e | CR Manager | Edit the CR under revision and resubmit — a new draft document is generated so the approver reviews the edited content | PENDING_INTERNAL_APPROVAL |
| 8 | CR Manager | Share with customer (email + tracked secure link) | SENT_TO_CUSTOMER |
| 9 | Customer | Opens portal, OTP verified, CR viewed | CUSTOMER_VIEWED → CUSTOMER_APPROVAL_PENDING |
| 10 | Customer | Approve & sign (portal signature or DocuSign) | CUSTOMER_APPROVED → SIGNED |
| 10r | Customer | Reject with comments | CUSTOMER_REJECTED → REVISION |
| 11 | System | Signed document stored, manager notified | COMPLETED |

## 5.3 Guarantees at each hop

* No CR can exist without an Account **and** an MSA (FK, NOT NULL).
* No two CRs can share a number or reference (unique indexes).
* Nothing past internal approval can be silently edited (lock + DB trigger).
* Every transition writes `audit_logs` with actor, timestamp, IP, old and new value.
* Every generated document is a new immutable version; approved versions are never
  overwritten.
