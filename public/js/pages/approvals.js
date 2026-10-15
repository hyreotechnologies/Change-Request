import { h, render } from '../lib/dom.js';
import { card, icon, pageHeader, loading, badge, apiError, notify, confirmDialog, emptyState, modal } from '../lib/ui.js';
import { dataTable } from '../components/table.js';
import { setPage } from '../components/shell.js';
import { dateTime, money, hours, titleCase, PRIORITY_COLORS } from '../lib/format.js';
import api from '../lib/api.js';
import store from '../lib/store.js';
import router from '../lib/router.js';

/** The approver's queue: everything waiting on a decision, oldest first. */
export async function approvalsPage() {
  setPage(loading('Loading approvals'));

  let rows;
  try {
    rows = await api.get('/api/approvals/pending');
  } catch (error) {
    apiError(error);
    return;
  }

  const mine = rows.filter((row) => row.is_mine);
  const others = rows.filter((row) => !row.is_mine);

  setPage(
    pageHeader({
      title: 'Approvals',
      subtitle: store.user.role_code === 'ADMIN'
        ? 'Every change request awaiting an internal decision.'
        : 'Change requests assigned to you for approval.'
    }),

    h(
      'div.grid.grid--kpi.mb-3',
      tile('Awaiting my decision', String(mine.length), 'amber'),
      tile('Overdue (> 3 days)', String(rows.filter((r) => r.ageing_days > 3).length), 'red'),
      tile('Total in queue', String(rows.length), 'navy'),
      tile(
        'Value in queue',
        money(rows.reduce((sum, row) => sum + Number(row.total_cost || 0), 0), rows[0]?.currency || store.currency),
        'navy'
      )
    ),

    card({
      title: 'Awaiting my approval',
      subtitle: 'Approve or reject directly, or open the change request for the full detail.',
      flush: true,
      body: mine.length
        ? queueTable(mine)
        : emptyState('Nothing waiting on you', 'Change requests assigned to you for approval will appear here.')
    }),

    others.length
      ? h('div.mt-3', card({
          title: 'Other pending approvals',
          subtitle: 'Visible to administrators for oversight',
          flush: true,
          body: queueTable(others)
        }))
      : null
  );

  function queueTable(list) {
    return dataTable({
      columns: [
        {
          key: 'cr_number',
          label: 'CR',
          render: (row) => h('div', h('div.cell-strong.mono', row.cr_number), h('div.cell-sub', row.cr_reference))
        },
        {
          key: 'account_name',
          label: 'Account',
          render: (row) => h('div', h('div', row.account_name), h('div.cell-sub', row.msa_reference_number))
        },
        { key: 'title', label: 'CR Title' },
        { key: 'priority', label: 'Priority', render: (row) => badge(titleCase(row.priority), PRIORITY_COLORS[row.priority] || 'slate') },
        { key: 'total_effort', label: 'Effort', align: 'right', render: (row) => hours(row.total_effort) },
        { key: 'total_cost', label: 'CR Cost', align: 'right', render: (row) => h('span.cell-strong', money(row.total_cost, row.currency)) },
        { key: 'requested_at', label: 'Submitted', render: (row) => dateTime(row.requested_at) },
        {
          key: 'ageing_days',
          label: 'Ageing',
          align: 'right',
          render: (row) => badge(`${row.ageing_days}d`, row.ageing_days > 5 ? 'red' : row.ageing_days > 2 ? 'amber' : 'green')
        },
        { key: 'approver_name', label: 'Approver', render: (row) => h('div', h('div', row.approver_name || '—'), h('div.cell-sub', row.approver_email)) },
        {
          key: 'actions',
          label: '',
          render: (row) =>
            h(
              'div.row.row--tight',
              h('button.btn.btn--ghost.btn--sm', { onClick: () => router.navigate(`/change-requests/${row.id}`) }, 'Open'),
              store.can('cr.approve')
                ? h('button.btn.btn--danger.btn--sm', { onClick: () => decide(row, 'REJECT') }, 'Reject')
                : null,
              store.can('cr.approve')
                ? h('button.btn.btn--success.btn--sm', { onClick: () => decide(row, 'APPROVE') }, 'Approve')
                : null
            )
        }
      ],
      rows: list,
      onRowClick: (row) => router.navigate(`/change-requests/${row.id}`)
    });
  }

  async function decide(row, decision) {
    const isReject = decision === 'REJECT';
    const result = await confirmDialog({
      title: isReject ? `Reject ${row.cr_number}` : `Approve ${row.cr_number}`,
      message: isReject
        ? 'The change request returns to the CR manager for revision and they are notified with your reason.'
        : `Are you sure you want to approve this change request?\n${row.account_name} · ${money(row.total_cost, row.currency)}`,
      confirmLabel: isReject ? 'Reject CR' : 'Approve CR',
      variant: isReject ? 'danger' : 'success',
      requireComment: isReject,
      commentLabel: 'Please provide the reason for rejection'
    });
    if (!result) return;
    try {
      await api.post(`/api/change-requests/${row.id}/${isReject ? 'reject' : 'approve'}`, { comments: result.comments || null });
      notify.success(isReject ? 'Rejected. The CR manager has been notified.' : 'Approved. The final document has been generated.');
      await store.refreshUnread();
      approvalsPage();
    } catch (error) {
      apiError(error);
    }
  }
}

function tile(label, value, tone) {
  return h('div.kpi', h(`div.kpi__bar.kpi__bar--${tone}`), h('div.kpi__label', label), h('div.kpi__value', value));
}

export default approvalsPage;
