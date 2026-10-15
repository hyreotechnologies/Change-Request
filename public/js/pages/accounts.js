import { h, render, debounce } from '../lib/dom.js';
import { card, icon, pageHeader, skeletonTable, badge, apiError, notify, confirmDialog, modal, alert, field } from '../lib/ui.js';
import { dataTable, pagination } from '../components/table.js';
import { accountSummary } from '../components/accountSummary.js';
import { setPage } from '../components/shell.js';
import { date, money, number, truncate } from '../lib/format.js';
import api, { qs } from '../lib/api.js';
import store from '../lib/store.js';
import router from '../lib/router.js';

export async function accountsPage({ query }) {
  const state = {
    q: query.q || '',
    status: query.status || '',
    page: Number(query.page) || 1,
    pageSize: 25
  };

  const tableHost = h('div#accounts-table', skeletonTable());
  const summaryHost = h('div');

  const searchInput = h('input.input', {
    type: 'search',
    placeholder: 'Search account, code, legal entity or MSA number…',
    value: state.q,
    style: { maxWidth: '360px' }
  });
  searchInput.addEventListener(
    'input',
    debounce(() => {
      state.q = searchInput.value.trim();
      state.page = 1;
      load();
    }, 260)
  );

  const statusSelect = h(
    'select.select',
    {
      style: { maxWidth: '170px' },
      onChange: (event) => {
        state.status = event.target.value;
        state.page = 1;
        load();
      }
    },
    h('option', { value: '' }, 'All statuses'),
    h('option', { value: 'ACTIVE', selected: state.status === 'ACTIVE' }, 'Active'),
    h('option', { value: 'INACTIVE', selected: state.status === 'INACTIVE' }, 'Inactive')
  );

  setPage(
    pageHeader({
      title: 'Accounts',
      subtitle: 'Customer master — every change request is raised against an account and its MSA.',
      actions: store.can('account.create')
        ? h('button.btn.btn--primary', { onClick: () => router.navigate('/accounts/new') }, icon('plus', 15), 'Create Account')
        : null
    }),
    summaryHost,
    card({
      title: 'Customer accounts',
      actions: h('div.row.row--tight', searchInput, statusSelect),
      flush: true,
      body: tableHost
    })
  );

  await Promise.all([load(), loadSummary()]);

  function reload() {
    load();
    loadSummary();
  }

  async function loadSummary() {
    try {
      render(summaryHost, accountSummary(await api.get('/api/accounts/insights')));
    } catch (error) {
      render(summaryHost, null);
      apiError(error);
    }
  }

  async function load() {
    render(tableHost, skeletonTable());
    try {
      const data = await api.get(
        `/api/accounts${qs({ q: state.q, status: state.status, page: state.page, pageSize: state.pageSize })}`
      );
      render(
        tableHost,
        dataTable({
          columns: [
            {
              key: 'account_name',
              label: 'Account',
              render: (row) =>
                h(
                  'div',
                  h('div.cell-strong', row.account_name),
                  h('div.cell-sub', row.legal_entity_name || '')
                )
            },
            { key: 'account_code', label: 'Code', render: (row) => h('span.mono.cell-sub', row.account_code) },
            {
              key: 'msa_reference_number',
              label: 'MSA Number',
              render: (row) =>
                row.msa_reference_number
                  ? h(
                      'div',
                      h('div.mono', row.msa_reference_number),
                      row.msa_count > 1 ? h('div.cell-sub', `+${row.msa_count - 1} more`) : null
                    )
                  : h('span.muted', 'No MSA')
            },
            { key: 'msa_date', label: 'MSA Start', render: (row) => h('span.nowrap', date(row.contract_start_date)) },
            { key: 'contract_end_date', label: 'MSA End', render: (row) => h('span.nowrap', date(row.contract_end_date)) },
            {
              key: 'msa_status',
              label: 'Contract',
              render: (row) =>
                row.msa_status
                  ? badge(
                      row.msa_status.charAt(0) + row.msa_status.slice(1).toLowerCase(),
                      { ACTIVE: 'green', EXPIRED: 'amber', TERMINATED: 'red', DRAFT: 'slate' }[row.msa_status] || 'slate'
                    )
                  : null
            },
            {
              key: 'primary_contact_name',
              label: 'Primary Contact',
              render: (row) =>
                row.primary_contact_name
                  ? h('div', h('div', truncate(row.primary_contact_name, 24)), h('div.cell-sub', truncate(row.primary_contact_email || '', 26)))
                  : null
            },
            { key: 'total_crs', label: 'CRs', align: 'right', render: (row) => number(row.total_crs) },
            {
              key: 'total_cr_value',
              label: 'CR Value',
              align: 'right',
              render: (row) => h('span.cell-strong', money(row.total_cr_value, row.currency || store.currency))
            },
            {
              key: 'status',
              label: 'Status',
              render: (row) => badge(row.status === 'ACTIVE' ? 'Active' : 'Inactive', row.status === 'ACTIVE' ? 'green' : 'slate')
            },
            {
              key: 'actions',
              label: 'Actions',
              render: (row) =>
                h(
                  'div.row.row--tight',
                  iconAction('eye', 'View account', () => router.navigate(`/accounts/${row.id}`)),
                  store.can('account.edit')
                    ? iconAction('edit', 'Edit account', () => router.navigate(`/accounts/${row.id}/edit`))
                    : null,
                  iconAction('history', 'CR history', () => router.navigate(`/accounts/${row.id}#history`)),
                  row.msa_document_id
                    ? iconAction('file', 'View MSA document', () =>
                        window.open(`/api/accounts/msa-documents/${row.msa_document_id}/download?inline=1`, '_blank')
                      )
                    : null,
                  store.can('cr.create') && row.msa_id
                    ? iconAction('plus', 'Create change request', () => router.navigate(`/change-requests/new?account=${row.id}`))
                    : null,
                  store.can('account.edit')
                    ? iconAction(
                        row.status === 'ACTIVE' ? 'lock' : 'check',
                        row.status === 'ACTIVE' ? 'Deactivate account' : 'Activate account',
                        () => toggleStatus(row, reload)
                      )
                    : null,
                  store.can('account.delete')
                    ? iconAction('trash', 'Delete account', () => deleteAccount(row, reload))
                    : null
                )
            }
          ],
          rows: data.rows,
          onRowClick: (row) => router.navigate(`/accounts/${row.id}`)
        }),
        data.total > state.pageSize
          ? pagination({
              total: data.total,
              page: state.page,
              pageSize: state.pageSize,
              onChange: (page) => {
                state.page = page;
                load();
              }
            })
          : null
      );
    } catch (error) {
      apiError(error);
    }
  }
}

/**
 * Deleting an account is destructive, so the dialog states exactly what will go.
 * Anything past draft blocks the delete and offers deactivation instead.
 */
export async function deleteAccount(account, onDone) {
  let impact;
  try {
    impact = await api.get(`/api/accounts/${account.id}/deletion-impact`);
  } catch (error) {
    apiError(error);
    return;
  }

  if (!impact.can_delete) {
    modal({
      title: `Cannot delete ${impact.account_name}`,
      body: h(
        'div',
        alert('warning', 'This account has change requests on record', impact.reason),
        h(
          'div.mt-2',
          h('div.form-section__title', 'Change requests blocking the delete'),
          h(
            'ul',
            { style: { margin: 0, paddingLeft: '18px' } },
            ...impact.blocking_change_requests
              .slice(0, 8)
              .map((cr) => h('li', `${cr.cr_number} — ${cr.title} (${cr.status.replace(/_/g, ' ').toLowerCase()})`))
          ),
          impact.blocking_change_requests.length > 8
            ? h('div.cell-sub.mt-1', `and ${impact.blocking_change_requests.length - 8} more`)
            : null
        )
      ),
      actions: [
        { label: 'Close', variant: 'secondary' },
        impact.status === 'ACTIVE'
          ? {
              label: 'Deactivate instead',
              variant: 'primary',
              onClick: async () => {
                await api.post(`/api/accounts/${account.id}/status`, { status: 'INACTIVE' });
                notify.success(`${impact.account_name} deactivated — no new change requests can be raised against it.`);
                if (onDone) onDone();
              }
            }
          : null
      ].filter(Boolean)
    });
    return;
  }

  const confirmInput = impact.requires_confirmation
    ? h('input.input', { placeholder: impact.account_name, autocomplete: 'off' })
    : null;

  modal({
    title: `Delete ${impact.account_name}`,
    subtitle: 'This cannot be undone',
    body: h(
      'div',
      h('p', 'Deleting this account permanently removes:'),
      h(
        'ul',
        { style: { marginTop: 0, paddingLeft: '18px' } },
        h('li', `The account record and ${impact.contact_count} contact(s)`),
        h('li', `${impact.msa_count} MSA contract(s)`),
        impact.draft_change_requests.length
          ? h(
              'li',
              `${impact.draft_change_requests.length} draft change request(s): ${impact.draft_change_requests
                .map((cr) => cr.cr_number)
                .join(', ')}`
            )
          : h('li', 'No change requests — this account has none')
      ),
      alert(
        'info',
        'The audit trail is kept',
        'Audit records are append-only and survive the deletion, including a record of the deletion itself.'
      ),
      confirmInput
        ? h('div.mt-2', field(`Type "${impact.account_name}" to confirm`, confirmInput, { required: true }))
        : null
    ),
    actions: [
      { label: 'Cancel', variant: 'secondary' },
      {
        label: 'Delete account',
        variant: 'danger',
        onClick: async () => {
          try {
            const query = confirmInput ? `?confirm=${encodeURIComponent(confirmInput.value.trim())}` : '';
            const result = await api.del(`/api/accounts/${account.id}${query}`);
            notify.success(
              result.deleted_change_requests
                ? `${result.account_name} and ${result.deleted_change_requests} draft change request(s) deleted.`
                : `${result.account_name} deleted.`
            );
            if (onDone) onDone();
          } catch (error) {
            if (confirmInput) confirmInput.classList.add('is-invalid');
            apiError(error);
            return false;
          }
          return true;
        }
      }
    ]
  });
}

/** Deactivation is the reversible alternative when a delete is not allowed. */
export async function toggleStatus(account, onDone) {
  const deactivating = account.status === 'ACTIVE';
  const confirmed = await confirmDialog({
    title: deactivating ? `Deactivate ${account.account_name}` : `Activate ${account.account_name}`,
    message: deactivating
      ? 'Existing change requests stay untouched and readable, but no new change request can be raised against this account.'
      : 'The account becomes available again for new change requests.',
    confirmLabel: deactivating ? 'Deactivate' : 'Activate',
    variant: deactivating ? 'danger' : 'primary'
  });
  if (!confirmed) return;
  try {
    await api.post(`/api/accounts/${account.id}/status`, { status: deactivating ? 'INACTIVE' : 'ACTIVE' });
    notify.success(deactivating ? 'Account deactivated.' : 'Account activated.');
    if (onDone) onDone();
  } catch (error) {
    apiError(error);
  }
}

function iconAction(name, title, onClick) {
  return h(
    'button.btn.btn--ghost.btn--sm.btn--icon',
    {
      title,
      'aria-label': title,
      onClick: (event) => {
        event.stopPropagation();
        onClick();
      }
    },
    icon(name, 15)
  );
}

export default accountsPage;
