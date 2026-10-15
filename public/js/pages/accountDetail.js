import { h, render } from '../lib/dom.js';
import { card, icon, pageHeader, loading, badge, definitionList, apiError, emptyState, alert } from '../lib/ui.js';
import { dataTable, statusBadge } from '../components/table.js';
import { deleteAccount, toggleStatus } from './accounts.js';
import { setPage } from '../components/shell.js';
import { date, money, hours, number, truncate, fileSize } from '../lib/format.js';
import api from '../lib/api.js';
import store from '../lib/store.js';
import router from '../lib/router.js';

/** Account 360: customer, MSA, contract, ownership and the full CR history. */
/** Warn when the primary MSA has ended or ends within the configured window. */
function renewalAlert(msa) {
  const renewal = msa?.renewal;
  if (!renewal || !['expired', 'expiring'].includes(renewal.state)) return null;
  return h(
    'div.mb-2',
    renewal.state === 'expired'
      ? alert('danger', 'This MSA has ended', `MSA ${msa.msa_reference_number} ended on ${date(renewal.end_date)}. New change requests should wait for the renewal.`)
      : alert('warning', `This MSA ends in ${renewal.days_left} day${renewal.days_left === 1 ? '' : 's'}`, `MSA ${msa.msa_reference_number} ends on ${date(renewal.end_date)}. Start the renewal conversation now.`)
  );
}

/** Signed CR value against the contract value, with in-progress work shown on top. */
function budgetMeter(budget) {
  if (!budget?.contract_value) return budget ? h('span.muted', 'No contract value recorded') : null;
  const used = Math.min(100, budget.used_percent || 0);
  const projected = Math.min(100, budget.projected_percent || 0);
  const tone = budget.projected_percent > 100 ? 'red' : budget.projected_percent > 85 ? 'amber' : 'green';
  return h(
    'div.meter-wrap',
    h(
      `div.meter.meter--${tone}`,
      { title: `Signed ${budget.used_percent}% · with in-progress ${budget.projected_percent}%` },
      h('div.meter__projected', { style: { width: `${projected}%` } }),
      h('div.meter__used', { style: { width: `${used}%` } })
    ),
    h(
      'div.cell-sub',
      `${money(budget.committed, budget.currency)} signed`,
      budget.pipeline ? ` + ${money(budget.pipeline, budget.currency)} in progress` : '',
      ` of ${money(budget.contract_value, budget.currency)}`,
      budget.remaining !== null ? ` · ${money(Math.max(0, budget.remaining), budget.currency)} left` : ''
    ),
    budget.projected_percent > 100 ? h('div.cell-sub', { style: { color: 'var(--red-700)' } }, 'In-progress change requests would exceed the contract value.') : null
  );
}

export async function accountDetailPage({ params }) {
  setPage(loading('Loading account'));

  let account;
  let changeRequests;
  try {
    [account, changeRequests] = await Promise.all([
      api.get(`/api/accounts/${params.id}`),
      api.get(`/api/accounts/${params.id}/change-requests`)
    ]);
  } catch (error) {
    apiError(error);
    router.navigate('/accounts');
    return;
  }

  const msa = account.primary_msa;
  const summary = account.summary;
  const currency = summary.currency || store.currency;

  setPage(
    pageHeader({
      breadcrumb: [h('a', { href: '/accounts' }, 'Accounts'), icon('chevronRight', 12), account.account_name],
      title: account.account_name,
      subtitle: `${account.legal_entity_name} · ${account.account_code}`,
      actions: [
        badge(account.status === 'ACTIVE' ? 'Active' : 'Inactive', account.status === 'ACTIVE' ? 'green' : 'slate'),
        store.can('account.edit')
          ? h('button.btn.btn--secondary', { onClick: () => router.navigate(`/accounts/${account.id}/edit`) }, icon('edit', 15), 'Edit')
          : null,
        store.can('cr.create') && msa
          ? h(
              'button.btn.btn--primary',
              { onClick: () => router.navigate(`/change-requests/new?account=${account.id}`) },
              icon('plus', 15),
              'Create Change Request'
            )
          : null,
        store.canAny('account.edit', 'account.delete') ? accountMenu() : null
      ]
    }),

    renewalAlert(msa),

    h(
      'div.grid.grid--kpi.mb-3',
      tile('Total CRs', number(summary.total_crs), 'navy'),
      tile('Approved', number(summary.approved_crs), 'green'),
      tile('Pending internal', number(summary.pending_internal), 'amber'),
      tile('Pending customer', number(summary.pending_customer), 'blue'),
      tile('Rejected', number(summary.rejected_crs), 'red'),
      tile('Completed', number(summary.completed_crs), 'green'),
      tile('Total CR value', money(summary.total_cr_value, currency), 'navy'),
      tile('Development hours', `${number(summary.development_hours)} h`, 'slate'),
      tile('Testing hours', `${number(summary.testing_hours)} h`, 'slate')
    ),

    h(
      'div.grid.grid--2.mb-3',
      card({
        title: 'Customer information',
        body: definitionList([
          ['Account name', account.account_name],
          ['Account code', account.account_code],
          ['Legal entity', account.legal_entity_name],
          ['Customer type', account.customer_type],
          ['Industry', account.industry],
          ['Country', account.country],
          ['City / State', [account.city, account.state].filter(Boolean).join(', ')],
          ['Postal code', account.postal_code],
          ['Address', account.address]
        ])
      }),
      card({
        title: 'MSA & contract',
        subtitle: msa ? `Reference ${msa.msa_reference_number}` : 'No MSA registered',
        actions: h(
          'div.row.row--tight',
          msa?.document
            ? h(
                'button.btn.btn--secondary.btn--sm',
                {
                  title: `Open ${msa.document.file_name}`,
                  onClick: () => window.open(`/api/accounts/msa-documents/${msa.document.id}/download?inline=1`, '_blank')
                },
                icon('file', 14),
                'View MSA'
              )
            : null,
          msa
            ? badge(
                msa.status.charAt(0) + msa.status.slice(1).toLowerCase(),
                { ACTIVE: 'green', EXPIRED: 'amber', TERMINATED: 'red', DRAFT: 'slate' }[msa.status] || 'slate'
              )
            : null
        ),
        body: msa
          ? definitionList([
              ['MSA reference', h('span.mono', msa.msa_reference_number)],
              ['MSA date', date(msa.msa_date)],
              ['Contract start', date(msa.contract_start_date)],
              ['Contract end', date(msa.contract_end_date)],
              ['Contract value', msa.contract_value ? money(msa.contract_value, msa.currency) : null],
              ['Currency', msa.currency],
              ['Billing entity', msa.billing_entity],
              ['Payment terms', msa.payment_terms],
              ['PO required', msa.po_required ? 'Yes' : 'No'],
              ['Contract used', budgetMeter(msa.budget)],
              [
                'Signed MSA on file',
                msa.document
                  ? h(
                      'a',
                      {
                        href: `/api/accounts/msa-documents/${msa.document.id}/download?inline=1`,
                        target: '_blank',
                        rel: 'noopener'
                      },
                      `${msa.document.file_name} (${fileSize(msa.document.file_size)})`
                    )
                  : null
              ],
              account.msas.length > 1 ? ['Other MSAs', `${account.msas.length - 1} additional`] : null
            ])
          : emptyState('No MSA registered', 'Add an MSA before raising change requests for this account.')
      })
    ),

    h(
      'div.grid.grid--2.mb-3',
      card({
        title: 'Customer contacts',
        body: h(
          'div',
          contactBlock('Primary contact', account.primary_contact),
          h('div.form-section', contactBlock('Approval contact (signs the CR)', account.approval_contact))
        )
      }),
      card({
        title: 'Internal ownership',
        body: definitionList([
          ['Account manager', account.account_manager],
          ['CR manager', account.cr_manager],
          ['Delivery manager', account.delivery_manager],
          ['Internal approver', account.internal_approver_name],
          ['Approver email', account.internal_approver_email],
          ['Created', date(account.created_at)],
          ['Notes', account.notes]
        ])
      })
    ),

    card({
      id: 'history',
      title: 'Change request history',
      subtitle: `Every change request raised under ${msa?.msa_reference_number || 'this account'}`,
      actions: h(
        'div.row.row--tight',
        h('span.cell-sub', `${changeRequests.length} record(s)`),
        store.can('report.export')
          ? h(
              'button.btn.btn--secondary.btn--sm',
              { onClick: () => api.download(`/api/reports/account-cr-history/export?format=xlsx&accountId=${account.id}`) },
              icon('download', 14),
              'Export'
            )
          : null
      ),
      flush: true,
      body: changeRequests.length
        ? dataTable({
            columns: [
              {
                key: 'cr_number',
                label: 'CR Number',
                render: (row) => h('div', h('div.cell-strong.mono', row.cr_number), h('div.cell-sub', row.cr_reference))
              },
              { key: 'title', label: 'CR Title', render: (row) => truncate(row.title, 42) },
              { key: 'cr_date', label: 'Created', render: (row) => h('span.nowrap', date(row.cr_date)) },
              { key: 'target_release_date', label: 'Release', render: (row) => h('span.nowrap', date(row.target_release_date)) },
              { key: 'total_effort', label: 'Effort', align: 'right', render: (row) => hours(row.total_effort) },
              {
                key: 'total_cost',
                label: 'CR Cost',
                align: 'right',
                render: (row) => h('span.cell-strong', money(row.total_cost, row.currency))
              },
              { key: 'status', label: 'Status', render: (row) => statusBadge(row.status) },
              {
                key: 'internal_approval_status',
                label: 'Internal Approval',
                render: (row) => approvalChip(row.internal_approval_status, 'Not started')
              },
              {
                key: 'customer_approval_status',
                label: 'Customer Signature',
                render: (row) => approvalChip(row.customer_approval_status || row.signature_status, 'Not sent')
              },
              {
                key: 'actions',
                label: '',
                render: (row) =>
                  h(
                    'button.btn.btn--ghost.btn--sm',
                    { onClick: () => router.navigate(`/change-requests/${row.id}`) },
                    'Open',
                    icon('chevronRight', 13)
                  )
              }
            ],
            rows: changeRequests,
            onRowClick: (row) => router.navigate(`/change-requests/${row.id}`)
          })
        : emptyState(
            'No change requests yet',
            'This solves the visibility problem: every CR raised under this MSA will be listed here.',
            store.can('cr.create') && msa
              ? h(
                  'button.btn.btn--primary',
                  { onClick: () => router.navigate(`/change-requests/new?account=${account.id}`) },
                  icon('plus', 15),
                  'Create the first change request'
                )
              : null
          )
    })
  );

  /** Destructive actions sit behind an overflow menu, away from the primary flow. */
  function accountMenu() {
    return h(
      'button.btn.btn--secondary.btn--icon',
      {
        title: 'More actions',
        'aria-label': 'More actions',
        onClick: (event) => {
          event.stopPropagation();
          const menu = h(
            'div.dropdown',
            store.can('account.edit')
              ? h(
                  'div.dropdown__item',
                  {
                    onClick: () => {
                      menu.remove();
                      toggleStatus(account, () => accountDetailPage({ params }));
                    }
                  },
                  icon(account.status === 'ACTIVE' ? 'lock' : 'check', 15),
                  account.status === 'ACTIVE' ? 'Deactivate account' : 'Activate account'
                )
              : null,
            store.can('account.delete')
              ? h(
                  'div.dropdown__item',
                  {
                    onClick: () => {
                      menu.remove();
                      deleteAccount(account, () => router.navigate('/accounts'));
                    }
                  },
                  icon('trash', 15),
                  'Delete account'
                )
              : null
          );
          document.body.appendChild(menu);
          setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
        }
      },
      '\u22ef'
    );
  }

  if (location.hash === '#history') {
    setTimeout(() => document.getElementById('history')?.scrollIntoView({ behavior: 'smooth' }), 120);
  }
}

function tile(label, value, tone) {
  return h('div.kpi', h(`div.kpi__bar.kpi__bar--${tone}`), h('div.kpi__label', label), h('div.kpi__value', value));
}

function contactBlock(title, contact) {
  if (!contact) {
    return h('div', h('div.form-section__title', title), h('div.muted', 'Not provided'));
  }
  return h(
    'div',
    h('div.form-section__title', title),
    h(
      'div.row',
      h('span.avatar', (contact.name || '?').slice(0, 1).toUpperCase()),
      h(
        'div',
        h('div.cell-strong', contact.name || 'Not provided'),
        h('div.cell-sub', contact.designation || ''),
        h('div.cell-sub', contact.email || ''),
        contact.phone ? h('div.cell-sub', contact.phone) : null
      )
    )
  );
}

function approvalChip(status, fallback) {
  if (!status) return h('span.muted', fallback);
  const colors = {
    PENDING: 'amber',
    APPROVED: 'green',
    REJECTED: 'red',
    SKIPPED: 'slate',
    VIEWED: 'blue',
    COMPLETED: 'green',
    SENT: 'blue',
    SIGNED: 'green',
    DECLINED: 'red',
    VOIDED: 'slate',
    CREATED: 'slate',
    DELIVERED: 'blue'
  };
  return badge(status.charAt(0) + status.slice(1).toLowerCase(), colors[status] || 'slate');
}

export default accountDetailPage;
