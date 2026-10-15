# 03 — Entity Relationship Diagram

## 3.1 Core spine (the single source of truth)

```
                     ┌───────────────┐
                     │   accounts    │  ACC-0001
                     │ account_code  │
                     └───┬───────┬───┘
                    1:N  │       │  1:N
        ┌────────────────▼──┐  ┌─▼──────────────────┐
        │   msa_contracts   │  │ customer_contacts  │
        │ msa_reference UQ  │  │ PRIMARY / APPROVER │
        └─────────┬─────────┘  └────────────────────┘
                  │ 1:N   (each CR hangs off exactly one account AND one MSA)
        ┌─────────▼──────────────────────────────────────────┐
        │                  change_requests                   │
        │   cr_number UQ · cr_reference UQ · UQ(account,seq)  │
        └─┬──────┬──────┬───────┬───────┬───────┬───────┬────┘
   1:N    │      │      │       │       │       │       │
 ┌────────▼─┐ ┌──▼──────────┐ ┌─▼───────────────┐ ┌─────▼──────────────┐
 │ cr_items │ │ cr_efforts  │ │ cr_assumptions  │ │ cr_dependencies    │
 └──────────┘ └─────────────┘ └─────────────────┘ └────────────────────┘
        1:1 ┌────────────┐        1:N ┌──────────────────────────┐
            │  cr_costs  │            │ change_request_approvals │ level 1..n
            └────────────┘            └──────────────────────────┘
        1:N ┌────────────────────┐ 1:N ┌───────────┐ 1:N ┌───────────────────┐
            │ customer_approvals │     │ documents │────▶│ document_versions │
            └────────────────────┘     └───────────┘     └───────────────────┘
        1:N ┌─────────────┐ ┌────────────────────┐ ┌─────────────┐
            │ email_logs  │ │ docusign_envelopes │ │ audit_logs  │
            └─────────────┘ └────────────────────┘ └─────────────┘
```

## 3.2 Identity & configuration

```
roles ──1:N── role_permissions ──N:1── permissions
  │ 1:N
users ──1:N── sessions          users ──1:N── notifications
      ──1:N── audit_logs (as actor)

otp_codes (email, purpose, context_id) ┈┈▶ change_requests   (portal challenges)
share_links ──N:1── change_requests

settings · email_templates · enums · sequences · cr_approval_levels   [configuration]
```

## 3.3 Cardinality and delete rules

| Parent | Child | Cardinality | On delete |
|---|---|---|---|
| accounts | msa_contracts | 1:N | RESTRICT when any CR exists |
| accounts | customer_contacts | 1:N | CASCADE |
| accounts | change_requests | 1:N | RESTRICT |
| msa_contracts | change_requests | 1:N | RESTRICT |
| change_requests | change_request_items | 1:N | CASCADE (drafts only) |
| change_requests | change_request_efforts | 1:6 | CASCADE |
| change_requests | change_request_costs | 1:1 | CASCADE |
| change_requests | change_request_assumptions / _dependencies | 1:N | CASCADE |
| change_requests | change_request_approvals | 1:N (one per level) | RESTRICT |
| change_requests | customer_approvals | 1:N (one per signatory) | RESTRICT |
| change_requests | documents | 1:N | RESTRICT |
| documents | document_versions | 1:N | RESTRICT (locked versions immutable) |
| change_requests | email_logs / docusign_envelopes / audit_logs | 1:N | RESTRICT |

## 3.4 The lifecycle chain required by the brief

```
Account → MSA → Change Request → CR Items → Approvals → Documents
                                                 ↓
                         Customer Approval → Signature (DocuSign) → Completed
```

Every arrow above is a real foreign key, and every hop writes an audit record.
