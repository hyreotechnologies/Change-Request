import { h } from '../lib/dom.js';
import { badge, emptyState, icon } from '../lib/ui.js';
import store from '../lib/store.js';
import { money, hours, date, dateTime, truncate } from '../lib/format.js';

/**
 * Data table.
 * columns: [{ key, label, render(row), align, width, className, hidden }]
 */
export function dataTable({ columns, rows, onRowClick = null, empty = null, footer = null, rowKey = 'id' }) {
  const visible = columns.filter((column) => !column.hidden);

  if (!rows?.length) {
    return empty || emptyState('Nothing to show', 'Records will appear here once they exist.');
  }

  return h(
    'div.table-wrap',
    h(
      'table.data',
      h('thead', h('tr', ...visible.map((column) =>
        h(
          `th${column.align === 'right' ? '.num' : ''}`,
          column.width ? { style: { width: column.width } } : null,
          column.label
        )
      ))),
      h(
        'tbody',
        ...rows.map((row) =>
          h(
            `tr${onRowClick ? '.is-clickable' : ''}`,
            {
              onClick: onRowClick ? (event) => {
                if (event.target.closest('button, a, input, select')) return;
                onRowClick(row);
              } : null,
              dataset: { key: row[rowKey] ?? '' }
            },
            ...visible.map((column) => {
              const content = column.render ? column.render(row) : row[column.key];
              return h(
                `td${column.align === 'right' ? '.num' : ''}${column.className ? `.${column.className}` : ''}`,
                content === null || content === undefined || content === '' ? h('span.muted', '—') : content
              );
            })
          )
        )
      ),
      footer ? h('tfoot', footer) : null
    )
  );
}

export function statusBadge(status) {
  const meta = store.statusMeta(status);
  return badge(meta.label, meta.color);
}

export function pagination({ total, page, pageSize, onChange }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return h(
    'div.pagination',
    h('span', `Showing ${from}–${to} of ${total}`),
    h('div.spacer'),
    h(
      'button.btn.btn--secondary.btn--sm',
      { disabled: page <= 1, onClick: () => onChange(page - 1) },
      icon('chevronLeft', 14),
      'Previous'
    ),
    h('span', { style: { fontWeight: '600' } }, `${page} / ${pages}`),
    h(
      'button.btn.btn--secondary.btn--sm',
      { disabled: page >= pages, onClick: () => onChange(page + 1) },
      'Next',
      icon('chevronRight', 14)
    )
  );
}

/** Shared column definitions so every CR table reads the same way. */
export const crColumns = {
  number: (onOpen) => ({
    key: 'cr_number',
    label: 'CR Reference',
    render: (row) =>
      h(
        'div',
        h('div.cell-strong.mono', { style: { cursor: onOpen ? 'pointer' : 'default' } }, row.cr_number),
        h('div.cell-sub', row.cr_reference || '')
      )
  }),
  account: {
    key: 'account_name',
    label: 'Account',
    render: (row) => h('div', h('div', row.account_name), h('div.cell-sub', row.msa_reference_number || ''))
  },
  title: {
    key: 'title',
    label: 'CR Title',
    render: (row) => h('div', { title: row.title }, truncate(row.title, 46))
  },
  crDate: { key: 'cr_date', label: 'CR Date', render: (row) => h('span.nowrap', date(row.cr_date)) },
  release: {
    key: 'target_release_date',
    label: 'Release',
    render: (row) => h('span.nowrap', date(row.target_release_date))
  },
  effort: { key: 'total_effort', label: 'Effort', align: 'right', render: (row) => hours(row.total_effort) },
  cost: {
    key: 'total_cost',
    label: 'CR Value',
    align: 'right',
    render: (row) => h('span.cell-strong', money(row.total_cost, row.currency || store.currency))
  },
  status: { key: 'status', label: 'Status', render: (row) => statusBadge(row.status) },
  owner: { key: 'owner_name', label: 'Current Owner', render: (row) => row.owner_name || h('span.muted', 'Unassigned') },
  updated: { key: 'updated_at', label: 'Last Updated', render: (row) => h('span.nowrap', dateTime(row.updated_at)) },
  due: { key: 'sla', label: 'Due', render: (row) => slaBadge(row.sla) }
};

/**
 * Where a change request stands against its stage time limit.
 * Overdue and due-today are loud; on-track is quiet; no limit shows nothing.
 */
export function slaBadge(sla, { long = false } = {}) {
  if (!sla || sla.state === 'none') return null;
  const title = `${sla.stage_label}: ${sla.days_in_stage} day(s) in stage, limit ${sla.limit_days} day(s)${sla.due_at ? ` · due ${date(sla.due_at)}` : ''}`;
  if (sla.state === 'overdue') {
    const days = Math.max(1, sla.days_overdue);
    return h('span', { title }, badge(long ? `Overdue by ${days} day${days === 1 ? '' : 's'}` : `Overdue ${days}d`, 'red'));
  }
  if (sla.state === 'due_soon') return h('span', { title }, badge(long ? 'Due within a day' : 'Due today', 'amber'));
  const left = Math.max(0, Math.ceil((new Date(sla.due_at).getTime() - Date.now()) / 86_400_000));
  return h('span.cell-sub.nowrap', { title }, long ? `Due ${date(sla.due_at)} (${left} day${left === 1 ? '' : 's'} left)` : `${left}d left`);
}
