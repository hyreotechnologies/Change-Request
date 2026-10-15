# 08 — CR Status / State Machine

Implemented in [`src/services/stateMachine.js`](../src/services/stateMachine.js). Every
transition is guarded, audited, and rejected with `INVALID_STATE` (409) when not permitted.

## 8.1 States

| Code | Label | Editable | Terminal |
|---|---|---|---|
| `DRAFT` | Draft | yes | no |
| `PENDING_INTERNAL_APPROVAL` | Pending Internal Approval | no | no |
| `INTERNAL_REJECTED` | Internally Rejected | no (auto-moves to REVISION) | no |
| `INTERNALLY_APPROVED` | Internally Approved | no | no |
| `READY_FOR_CUSTOMER` | Ready for Customer | no | no |
| `SENT_TO_CUSTOMER` | Sent to Customer | no | no |
| `CUSTOMER_VIEWED` | Customer Viewed | no | no |
| `CUSTOMER_APPROVAL_PENDING` | Customer Approval Pending | no | no |
| `CUSTOMER_REJECTED` | Customer Rejected | no | no |
| `REVISION` | Under Revision | yes | no |
| `CUSTOMER_APPROVED` | Customer Approved | no | no |
| `SIGNED` | Signed | no | no |
| `COMPLETED` | Completed | no | **yes** |
| `CANCELLED` | Cancelled | no | **yes** |
| `ON_HOLD` | On Hold | no | no |
| `EXPIRED` | Expired | no | **yes** |

## 8.2 Transition diagram

```
                    ┌─────────┐
          ┌────────▶│  DRAFT  │◀───────────────┐
          │         └────┬────┘                │
          │              │ submit              │ revise
          │              ▼                     │
          │  ┌───────────────────────────┐     │
          │  │ PENDING_INTERNAL_APPROVAL │─────┼── reject ──▶ INTERNAL_REJECTED
          │  └────────────┬──────────────┘     │                    │ (auto)
          │               │ approve (all levels)                    ▼
          │               ▼                    └──────────────  REVISION
          │      ┌─────────────────────┐
          │      │ INTERNALLY_APPROVED │  (final document v2.0 locked)
          │      └──────────┬──────────┘
          │                 │ auto
          │                 ▼
          │      ┌──────────────────────┐
          │      │  READY_FOR_CUSTOMER  │
          │      └──────────┬───────────┘
          │                 │ share / docusign send
          │                 ▼
          │      ┌──────────────────────┐
          │      │   SENT_TO_CUSTOMER   │
          │      └──────────┬───────────┘
          │                 │ portal opened / envelope delivered
          │                 ▼
          │      ┌──────────────────────┐
          │      │   CUSTOMER_VIEWED    │
          │      └──────────┬───────────┘
          │                 │ auto
          │                 ▼
          │    ┌────────────────────────────┐
          │    │ CUSTOMER_APPROVAL_PENDING  │
          │    └───────┬────────────┬───────┘
          │    reject  │            │ approve & sign
          │            ▼            ▼
          │   ┌───────────────────┐ ┌─────────────────────┐
          │   │ CUSTOMER_REJECTED │ │  CUSTOMER_APPROVED  │
          │   └─────────┬─────────┘ └──────────┬──────────┘
          │             │ auto                 │ signature captured
          │             ▼                      ▼
          │       ┌──────────┐            ┌─────────┐
          └───────│ REVISION │            │ SIGNED  │
        (editable)└──────────┘            └────┬────┘
                                               │ signed copy stored
                                               ▼
                                         ┌───────────┐
                                         │ COMPLETED │  (terminal)
                                         └───────────┘

  Cross-cutting: any non-terminal state ──▶ ON_HOLD ──▶ back to prior state
                 any non-terminal state ──▶ CANCELLED (terminal, reason required)
                 SENT_TO_CUSTOMER / CUSTOMER_* ──▶ EXPIRED (link validity elapsed)
```

## 8.3 Transition table

| From | Event | To | Guard | Side effects |
|---|---|---|---|---|
| DRAFT / REVISION | `submit` | PENDING_INTERNAL_APPROVAL | ≥1 scope item, effort > 0, rate set, approver email present | lock CR, create approval rows, mail approver, notify |
| PENDING_INTERNAL_APPROVAL | `approve` (last level) | INTERNALLY_APPROVED | pending row for actor at current level | stamp approver, generate v2.0 FINAL (locked), mail CR manager |
| PENDING_INTERNAL_APPROVAL | `approve` (level < n) | PENDING_INTERNAL_APPROVAL | | mail next level |
| PENDING_INTERNAL_APPROVAL | `reject` | INTERNAL_REJECTED → REVISION | comments ≥ 5 chars | store reason, unlock, revision + 1, mail CR manager. The CR is editable again and `submit` starts a fresh approval for the new revision; the earlier decision stays in the approval history |
| INTERNALLY_APPROVED | `auto` | READY_FOR_CUSTOMER | FINAL document exists | — |
| READY_FOR_CUSTOMER | `share` / `docusign.send` | SENT_TO_CUSTOMER | customer approver email present | create share link, send email, log tracking |
| SENT_TO_CUSTOMER | `portal.view` / envelope delivered | CUSTOMER_VIEWED | valid portal session | stamp `customer_viewed_at` |
| CUSTOMER_VIEWED | `auto` | CUSTOMER_APPROVAL_PENDING | — | — |
| CUSTOMER_APPROVAL_PENDING | `customer.approve` | CUSTOMER_APPROVED | consent + typed signature | record `customer_approvals` |
| CUSTOMER_APPROVED | `sign` | SIGNED | signature or DocuSign completion | store signed document version |
| SIGNED | `auto` | COMPLETED | signed document stored | mail CR manager, notify |
| CUSTOMER_APPROVAL_PENDING | `customer.reject` | CUSTOMER_REJECTED → REVISION | comments ≥ 5 chars | unlock for revision, mail CR manager |
| any non-terminal | `hold` | ON_HOLD | reason | remembers previous state |
| ON_HOLD | `resume` | previous state | — | — |
| any non-terminal | `cancel` | CANCELLED | reason | terminal |
| SENT_TO_CUSTOMER / CUSTOMER_* | `expire` | EXPIRED | portal link elapsed | revoke links |

## 8.4 Invariants

1. `COMPLETED`, `CANCELLED` and `EXPIRED` accept no further transitions (DB trigger + guard).
2. `locked = 1` for every state except DRAFT and REVISION.
   A rejection — internal or customer — always lands in REVISION rather than DRAFT, so the
   register distinguishes "never submitted" from "sent back". `STATUS_GROUPS.REJECTED`
   therefore includes REVISION, keeping rejected work visible on the dashboard.
3. Approved document versions are never regenerated in place — a superseding version is
   created and the previous one is marked `SUPERSEDED` while remaining downloadable.
4. Rejection (internal or customer) always carries a stored, non-empty comment.
5. Each transition writes exactly one `audit_logs` row with `old_value` and `new_value`.
