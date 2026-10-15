import { h, render, debounce } from '../lib/dom.js';
import { card, icon, pageHeader, skeletonTable, apiError, emptyState, notify, modal, formModal, field, input, select } from '../lib/ui.js';
import { dataTable, pagination, crColumns, statusBadge, slaBadge } from '../components/table.js';
import { setPage, refreshSavedViews } from '../components/shell.js';
import { money, date } from '../lib/format.js';
import { readPref, writePref } from '../lib/prefs.js';
import api, { qs } from '../lib/api.js';
import store from '../lib/store.js';
import router from '../lib/router.js';

/** Board columns: the pipeline from draft to signature. Closed work stays in the list view. */
const BOARD_COLUMNS = [
  { key: 'draft', label: 'Draft & revision', statuses: ['DRAFT', 'REVISION', 'INTERNAL_REJECTED', 'CUSTOMER_REJECTED'] },
  { key: 'internal', label: 'Internal review', statuses: ['PENDING_INTERNAL_APPROVAL'] },
  { key: 'ready', label: 'Ready to share', statuses: ['INTERNALLY_APPROVED', 'READY_FOR_CUSTOMER'] },
  { key: 'customer', label: 'With customer', statuses: ['SENT_TO_CUSTOMER', 'CUSTOMER_VIEWED', 'CUSTOMER_APPROVAL_PENDING'] },
  { key: 'signed', label: 'Signed', statuses: ['CUSTOMER_APPROVED', 'SIGNED', 'COMPLETED'] },
  { key: 'hold', label: 'On hold', statuses: ['ON_HOLD'] }
];

/** Filter keys kept in the address bar, so a filtered list can be bookmarked or saved as a view. */
const URL_KEYS = { q: 'q', status: 'status', statusGroup: 'statusGroup', accountId: 'account', crType: 'crType', priority: 'priority', from: 'from', to: 'to', sort: 'sort', owner: 'owner', due: 'due', view: 'view' };

export async function changeRequestsPage({ query }) {
  const state = {
    q: query.q || '',
    status: query.status || '',
    statusGroup: query.statusGroup || '',
    accountId: query.account || '',
    crType: query.crType || '',
    priority: query.priority || '',
    from: query.from || '',
    to: query.to || '',
    sort: query.sort || 'recent',
    owner: query.owner || '',
    due: query.due || '',
    view: query.view || readPref('crListView', 'list'),
    page: 1,
    pageSize: 25
  };
  const selected = new Set();
  let currentRows = [];

  const tableHost = h('div', skeletonTable(6));
  const bulkHost = h('div');
  const viewActionsHost = h('div.row.row--tight');
  const accounts = await api.get('/api/accounts/lookup').catch(() => []);
  let savedViews = await api.get('/api/saved-views').catch(() => []);
  const enums = store.enums || {};
  const canBulk = store.can('cr.edit');

  const searchInput = h('input.input', {
    type: 'search',
    placeholder: 'CR number, reference, title, account…',
    value: state.q,
    style: { minWidth: '250px' }
  });
  searchInput.addEventListener('input', debounce(() => update('q', searchInput.value.trim()), 260));

  const filters = h(
    'div.row.row--tight',
    searchInput,
    picker('accountId', [{ value: '', label: 'All accounts' }, ...accounts.map((a) => ({ value: a.id, label: a.account_name }))]),
    picker('status', [
      { value: '', label: 'All statuses' },
      ...(enums.statuses || []).map((s) => ({ value: s.code, label: s.label }))
    ]),
    picker('crType', [{ value: '', label: 'All types' }, ...(enums.cr_types || []).map((t) => ({ value: t.code, label: t.label }))]),
    picker('priority', [{ value: '', label: 'All priorities' }, ...(enums.priorities || []).map((p) => ({ value: p.code, label: p.label }))]),
    picker('due', [
      { value: '', label: 'Any due date' },
      { value: 'overdue', label: 'Overdue' },
      { value: 'due_soon', label: 'Due today' },
      { value: 'at_risk', label: 'Overdue or due today' }
    ]),
    picker('owner', [
      { value: '', label: 'Any owner' },
      { value: 'me', label: 'Owned by me' }
    ]),
    h('input.input', {
      type: 'date',
      value: state.from,
      title: 'CR date from',
      style: { maxWidth: '150px' },
      onChange: (event) => update('from', event.target.value)
    }),
    h('input.input', {
      type: 'date',
      value: state.to,
      title: 'CR date to',
      style: { maxWidth: '150px' },
      onChange: (event) => update('to', event.target.value)
    }),
    h(
      'button.btn.btn--ghost.btn--sm',
      { onClick: () => router.navigate(`/change-requests${state.view === 'board' ? '?view=board' : ''}`) },
      icon('refresh', 14),
      'Reset'
    )
  );

  setPage(
    pageHeader({
      title: 'Change Requests',
      subtitle: subtitle(),
      actions: [
        viewToggle(),
        viewActionsHost,
        store.can('report.export')
          ? h(
              'button.btn.btn--secondary',
              { onClick: () => api.download(`/api/reports/cr-register/export?format=xlsx${state.accountId ? `&accountId=${state.accountId}` : ''}`) },
              icon('download', 15),
              'Export register'
            )
          : null,
        store.can('cr.create')
          ? h('button.btn.btn--primary', { onClick: () => router.navigate('/change-requests/new') }, icon('plus', 15), 'Create Change Request')
          : null
      ]
    }),
    bulkHost,
    card({ actions: filters, flush: true, body: tableHost })
  );

  drawViewActions();
  await load();

  /* ------------------------------------------------------------ filters -- */

  function subtitle() {
    if (state.statusGroup) return `Filtered by ${state.statusGroup.replace('_', ' ').toLowerCase()}`;
    return 'Every change request across all accounts and MSAs.';
  }

  function picker(key, options) {
    return h(
      'select.select',
      {
        style: { maxWidth: '180px' },
        onChange: (event) => update(key, event.target.value)
      },
      ...options.map((option) => h('option', { value: option.value, selected: String(state[key]) === String(option.value) }, option.label))
    );
  }

  function queryString() {
    const params = new URLSearchParams();
    for (const [key, param] of Object.entries(URL_KEYS)) {
      const value = state[key];
      if (!value || (key === 'sort' && value === 'recent') || (key === 'view' && value === 'list')) continue;
      params.set(param, value);
    }
    return params.toString();
  }

  function syncUrl() {
    const search = queryString();
    history.replaceState({}, '', `/change-requests${search ? `?${search}` : ''}`);
    drawViewActions();
  }

  function update(key, value) {
    state[key] = value;
    state.page = 1;
    if (key === 'status') state.statusGroup = '';
    selected.clear();
    syncUrl();
    load();
  }

  /* -------------------------------------------------------- saved views -- */

  function matchingView() {
    const search = queryString();
    return savedViews.find((view) => view.query === search) || null;
  }

  function drawViewActions() {
    const current = matchingView();
    render(
      viewActionsHost,
      current
        ? h(
            'button.btn.btn--secondary',
            { title: `Delete the saved view "${current.name}"`, onClick: () => deleteView(current) },
            icon('trash', 15),
            'Delete view'
          )
        : h('button.btn.btn--secondary', { onClick: saveView, disabled: !queryString() }, icon('bookmark', 15), 'Save view')
    );
  }

  async function saveView() {
    const saved = await formModal({
      title: 'Save this view',
      subtitle: 'The current filters are kept in your sidebar under Saved views.',
      fields: [field('Name', input('name', { placeholder: 'e.g. My overdue CRs', maxLength: 60 }), { required: true })],
      submitLabel: 'Save view',
      onSubmit: (data) => api.post('/api/saved-views', { name: data.name, query: queryString() })
    });
    if (!saved) return;
    savedViews = await api.get('/api/saved-views').catch(() => savedViews);
    notify.success(`Saved "${saved.name}" to your sidebar.`);
    await refreshSavedViews();
    drawViewActions();
  }

  async function deleteView(view) {
    try {
      await api.del(`/api/saved-views/${view.id}`);
      savedViews = savedViews.filter((v) => v.id !== view.id);
      notify.success(`Deleted the view "${view.name}".`);
      await refreshSavedViews();
      drawViewActions();
    } catch (error) {
      apiError(error);
    }
  }

  /* ------------------------------------------------------- list / board -- */

  function viewToggle() {
    const host = h('div.segmented');
    const draw = () =>
      render(
        host,
        ...[
          { value: 'list', label: 'List', icon: 'list' },
          { value: 'board', label: 'Board', icon: 'board' }
        ].map((option) =>
          h(
            `button.segmented__item${state.view === option.value ? '.is-active' : ''}`,
            {
              type: 'button',
              'aria-pressed': String(state.view === option.value),
              onClick: () => {
                if (state.view === option.value) return;
                state.view = option.value;
                writePref('crListView', option.value);
                selected.clear();
                draw();
                syncUrl();
                load();
              }
            },
            icon(option.icon, 14),
            option.label
          )
        )
      );
    draw();
    return host;
  }

  function filterParams(extra = {}) {
    return qs({
      q: state.q,
      status: state.status,
      statusGroup: state.statusGroup,
      accountId: state.accountId,
      crType: state.crType,
      priority: state.priority,
      from: state.from,
      to: state.to,
      sort: state.sort,
      owner: state.owner,
      due: state.due,
      ...extra
    });
  }

  async function load() {
    render(tableHost, skeletonTable(6));
    drawBulkBar();
    try {
      if (state.view === 'board') {
        const data = await api.get(`/api/change-requests${filterParams({ page: 1, pageSize: 200, sort: 'stage_age' })}`);
        currentRows = data.rows;
        render(tableHost, board(data.rows, data.total));
        return;
      }

      const data = await api.get(`/api/change-requests${filterParams({ page: state.page, pageSize: state.pageSize })}`);
      currentRows = data.rows;
      render(
        tableHost,
        data.rows.length
          ? dataTable({
              columns: [
                canBulk ? selectColumn() : null,
                crColumns.number(),
                crColumns.account,
                crColumns.title,
                crColumns.crDate,
                crColumns.release,
                crColumns.effort,
                crColumns.cost,
                crColumns.status,
                crColumns.due,
                crColumns.owner,
                crColumns.updated
              ].filter(Boolean),
              rows: data.rows,
              onRowClick: (row) => router.navigate(`/change-requests/${row.id}`)
            })
          : noResults(),
        data.total > state.pageSize
          ? pagination({
              total: data.total,
              page: state.page,
              pageSize: state.pageSize,
              onChange: (page) => {
                state.page = page;
                selected.clear();
                load();
              }
            })
          : null
      );
    } catch (error) {
      apiError(error);
    }
  }

  function noResults() {
    return emptyState(
      'No change requests match these filters',
      'Adjust the filters, or create a new change request against an account.',
      store.can('cr.create')
        ? h('button.btn.btn--primary', { onClick: () => router.navigate('/change-requests/new') }, icon('plus', 15), 'Create Change Request')
        : null
    );
  }

  function board(rows, total) {
    if (!rows.length) return noResults();
    const columns = BOARD_COLUMNS.map((column) => ({ ...column, rows: rows.filter((row) => column.statuses.includes(row.status)) }));
    const hidden = rows.length - columns.reduce((sum, column) => sum + column.rows.length, 0);
    return h(
      'div',
      h(
        'div.board',
        ...columns.map((column) =>
          h(
            'div.board__column',
            h(
              'div.board__head',
              h('span', column.label),
              h('span.board__count', String(column.rows.length)),
              column.rows.length
                ? h('span.board__value', money(column.rows.reduce((sum, row) => sum + Number(row.total_cost || 0), 0), column.rows[0].currency || store.currency))
                : null
            ),
            h(
              'div.board__cards',
              ...(column.rows.length ? column.rows.map(boardCard) : [h('div.board__empty', 'Nothing here')])
            )
          )
        )
      ),
      hidden || total > rows.length
        ? h(
            'div.board__note',
            `${total > rows.length ? `Showing the ${rows.length} longest-waiting of ${total}. ` : ''}${hidden ? `${hidden} closed (cancelled or expired) not shown — use the list view to see them.` : ''}`
          )
        : null
    );
  }

  function boardCard(row) {
    return h(
      'a.board-card',
      { href: `/change-requests/${row.id}` },
      h('div.board-card__top', h('span.mono.cell-strong', row.cr_number), slaBadge(row.sla)),
      h('div.board-card__title', row.title),
      h('div.cell-sub', row.account_name),
      h(
        'div.board-card__foot',
        statusBadge(row.status),
        h('span.cell-strong', money(row.total_cost, row.currency || store.currency))
      ),
      row.owner_name ? h('div.cell-sub', `Owner: ${row.owner_name}`) : null
    );
  }

  /* -------------------------------------------------------- bulk actions -- */

  function selectColumn() {
    const allChecked = () => currentRows.length > 0 && currentRows.every((row) => selected.has(row.id));
    const header = h('input', {
      type: 'checkbox',
      'aria-label': 'Select all on this page',
      checked: allChecked(),
      onClick: (event) => event.stopPropagation(),
      onChange: (event) => {
        for (const row of currentRows) {
          if (event.target.checked) selected.add(row.id);
          else selected.delete(row.id);
        }
        for (const box of tableHost.querySelectorAll('input[data-select]')) box.checked = event.target.checked;
        drawBulkBar();
      }
    });
    return {
      key: 'select',
      label: header,
      width: '36px',
      render: (row) =>
        h('input', {
          type: 'checkbox',
          'aria-label': `Select ${row.cr_number}`,
          dataset: { select: row.id },
          checked: selected.has(row.id),
          onChange: (event) => {
            if (event.target.checked) selected.add(row.id);
            else selected.delete(row.id);
            header.checked = allChecked();
            drawBulkBar();
          }
        })
    };
  }

  function drawBulkBar() {
    if (!selected.size || state.view !== 'list') {
      render(bulkHost);
      return;
    }
    render(
      bulkHost,
      h(
        'div.bulk-bar',
        h('span.cell-strong', `${selected.size} selected`),
        h('div.spacer'),
        h('button.btn.btn--secondary.btn--sm', { onClick: bulkRemind }, icon('bell', 14), 'Send reminder'),
        h('button.btn.btn--secondary.btn--sm', { onClick: bulkReassign }, icon('user', 14), 'Reassign'),
        h('button.btn.btn--secondary.btn--sm', { onClick: exportSelected }, icon('download', 14), 'Export CSV'),
        h(
          'button.btn.btn--ghost.btn--sm',
          {
            onClick: () => {
              selected.clear();
              for (const box of tableHost.querySelectorAll('input[type=checkbox]')) box.checked = false;
              drawBulkBar();
            }
          },
          'Clear'
        )
      )
    );
  }

  function reportOutcome(results, verb) {
    const failed = results.filter((r) => !r.ok);
    const done = results.length - failed.length;
    if (done) notify.success(`${verb} ${done} change request${done === 1 ? '' : 's'}.`);
    if (failed.length) {
      const numbers = new Map(currentRows.map((row) => [row.id, row.cr_number]));
      modal({
        title: `${failed.length} could not be ${verb.toLowerCase()}`,
        body: h(
          'ul.plain-list',
          ...failed.map((r) => h('li', h('span.mono.cell-strong', numbers.get(r.id) || r.id), ' — ', r.error))
        )
      });
    }
  }

  async function bulkRemind() {
    try {
      const { results } = await api.post('/api/change-requests/bulk/remind', { ids: [...selected] });
      reportOutcome(results, 'Reminded');
      selected.clear();
      load();
    } catch (error) {
      apiError(error);
    }
  }

  async function bulkReassign() {
    const users = await api.get('/api/users/pick-list').catch(() => []);
    const result = await formModal({
      title: `Reassign ${selected.size} change request${selected.size === 1 ? '' : 's'}`,
      subtitle: 'The new owner is notified. Closed change requests are skipped.',
      fields: [
        field(
          'New owner',
          select('userId', [{ value: '', label: 'Choose a person…' }, ...users.map((u) => ({ value: u.id, label: `${u.name} · ${u.email}` }))]),
          { required: true }
        )
      ],
      submitLabel: 'Reassign',
      onSubmit: (data) => api.post('/api/change-requests/bulk/reassign', { ids: [...selected], userId: data.userId })
    });
    if (!result) return;
    reportOutcome(result.results, 'Reassigned');
    selected.clear();
    load();
  }

  function exportSelected() {
    const rows = currentRows.filter((row) => selected.has(row.id));
    const columns = [
      ['CR number', (r) => r.cr_number],
      ['CR reference', (r) => r.cr_reference],
      ['Account', (r) => r.account_name],
      ['MSA', (r) => r.msa_reference_number],
      ['Title', (r) => r.title],
      ['Status', (r) => r.status_label],
      ['Priority', (r) => r.priority],
      ['CR date', (r) => r.cr_date],
      ['Target release', (r) => r.target_release_date],
      ['Effort (hours)', (r) => r.total_effort],
      ['CR value', (r) => r.total_cost],
      ['Currency', (r) => r.currency],
      ['Owner', (r) => r.owner_name],
      ['Due', (r) => (r.sla?.due_at ? date(r.sla.due_at) : '')],
      ['Due state', (r) => (r.sla ? r.sla.state.replace('_', ' ') : '')]
    ];
    const escape = (value) => {
      const text = value === null || value === undefined ? '' : String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const csv = [columns.map(([label]) => label), ...rows.map((row) => columns.map(([, get]) => get(row)))]
      .map((line) => line.map(escape).join(','))
      .join('\r\n');
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
    const link = h('a', { href: url, download: `change-requests-${new Date().toISOString().slice(0, 10)}.csv` });
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify.success(`Exported ${rows.length} change request${rows.length === 1 ? '' : 's'}.`);
  }
}

export default changeRequestsPage;
