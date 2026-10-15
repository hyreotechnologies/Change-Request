# 06 — Page / Screen List

Shell: fixed left sidebar (Dashboard · Accounts · Change Requests · Approvals · Documents ·
Reports · Notifications · Settings) + top bar (global search · notification bell · user
menu). Desktop-first, collapses to a drawer below 1024px.

## 6.1 Public / unauthenticated

| # | Route | Screen | Notes |
|---|---|---|---|
| P1 | `/login` | Login — email capture | "Hyreo Account Management", single email field, **Send OTP** |
| P2 | `/login` (step 2) | OTP verification | 6 boxes, masked destination, **Verify OTP**, **Resend OTP** with cooldown |
| P3 | `/portal/:token` | Portal gate | Shows CR number + account, asks for the bound email, sends OTP |
| P4 | `/portal/:token` (verified) | Approver review | Read-only CR, document preview/download, **Approve CR** / **Reject CR** |
| P5 | `/portal/:token` (verified) | Customer review & sign | Read-only CR, document, **Approve & Sign** (typed signature + consent) / **Reject** |
| P6 | `/portal/:token` (done) | Decision receipt | Confirmation, timestamp, download of the signed copy |

## 6.2 Authenticated application

| # | Route | Screen | Key elements |
|---|---|---|---|
| A1 | `/dashboard` | Executive dashboard | 12 KPI cards, 6 charts, Recent Change Requests table |
| A2 | `/accounts` | Account list | Search, status filter, columns per spec §5, row actions: View · Edit · CR History · Create CR |
| A3 | `/accounts/new` | Create account | Sections: Account · MSA · Customer contact · Approval contact · Internal · Notes |
| A4 | `/accounts/:id` | Account detail | Customer / MSA / contract / internal ownership / contacts, CR history table, cumulative summary tiles |
| A5 | `/accounts/:id/edit` | Edit account | Same form as A3, pre-filled; MSA reference uniqueness re-checked |
| A6 | `/change-requests` | CR register | Filters (account, status, type, priority, owner, date range), export |
| A7 | `/change-requests/new` | Create CR wizard | 7 steps: Account → Header → Scope → Effort → Cost → Timeline & terms → Review |
| A8 | `/change-requests/:id` | CR detail | Header, status badge, visual lifecycle timeline, tabs: Overview · Scope · Effort & Cost · Approvals · Documents · Emails · Audit Log |
| A9 | `/change-requests/:id/edit` | Edit CR | Same wizard in edit mode; blocked unless DRAFT/REVISION |
| A10 | `/approvals` | Approval queue | My pending approvals + ageing; approve/reject inline with confirmation dialogs |
| A11 | `/documents` | Document library | All versions, filter by CR/account/status, download DOCX/PDF, preview |
| A12 | `/reports` | Reports | 10 report types, filter panel, Excel / CSV / PDF export |
| A13 | `/notifications` | Notification centre | Unread first, mark read, deep-links to the CR |
| A14 | `/settings` | Admin settings | Tabs: Company · Defaults · CR numbering · Standard terms · Email · OTP & security · DocuSign · Email templates · Approval levels · Users · Roles |
| A15 | `/settings/users` | User management | Name, email, role, department, active, created, last login |
| A16 | `/outbox` | Email outbox | Every message with status (queued/sent/opened/clicked) and full HTML preview |
| A17 | `/search?q=` | Global search results | Grouped: Accounts · MSAs · CRs · Contacts |

## 6.3 Shared components

`AppShell` · `DataTable` (sort, paginate, empty state) · `KpiCard` · `Chart` (bar, line,
donut, horizontal bar, stacked) · `StatusBadge` · `Timeline` · `Tabs` · `Modal` ·
`ConfirmDialog` · `Drawer` · `FormField` (text, number, date, select, textarea, toggle,
currency) · `RepeaterTable` (scope items, assumptions, dependencies) · `Toast` ·
`EmptyState` · `FilterBar` · `OtpInput` · `Stepper` · `MoneyInput` · `AuditFeed`.

## 6.4 Responsive rules

* ≥1280px — full sidebar, 4-up KPI grid, 2-up charts.
* 1024–1279px — icon sidebar, 3-up KPI grid.
* <1024px — sidebar becomes an overlay drawer, tables switch to stacked cards, wizard steps
  stack vertically, KPI grid 2-up then 1-up at <560px.
