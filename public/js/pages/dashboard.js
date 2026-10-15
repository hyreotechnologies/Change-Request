import { h } from '../lib/dom.js';
import { card, icon, loading, pageHeader, apiError, badge, emptyState } from '../lib/ui.js';
import { barChart, donutChart, horizontalBarChart, lineChart, groupedBarChart, STATUS_COLORS } from '../lib/charts.js';
import { dataTable, crColumns, statusBadge, slaBadge } from '../components/table.js';
import { setPage } from '../components/shell.js';
import { compactMoney, money, number, date, pluralise } from '../lib/format.js';
import api from '../lib/api.js';
import store from '../lib/store.js';
import router from '../lib/router.js';

export async function dashboardPage() {
  setPage(loading('Loading your dashboard'));
  let data;
  try {
    data = await api.get('/api/dashboard');
  } catch (error) {
    apiError(error);
    return;
  }

  const { kpis, charts, recent, my_work: work, my_queue: queue, time_limits: limits, renewals } = data;
  const currency = kpis.currency || store.currency;

  setPage(
    pageHeader({
      title: `Good ${greeting()}, ${store.user.name.split(' ')[0]}`,
      subtitle: 'Portfolio position across accounts, MSA contracts and change requests.',
      actions: [
        h(
          'button.btn.btn--secondary',
          { onClick: () => router.navigate('/reports') },
          icon('reports', 15),
          'Reports'
        ),
        store.can('cr.create')
          ? h(
              'button.btn.btn--primary',
              { onClick: () => router.navigate('/change-requests/new') },
              icon('plus', 15),
              'Create Change Request'
            )
          : null
      ]
    }),

    waitingOnYou(queue),

    limits.overdue || limits.due_soon
      ? h(
          'div.grid.grid--kpi.mb-3',
          kpi('Overdue', number(limits.overdue), 'red', 'Past their stage time limit', () => router.navigate('/change-requests?due=overdue')),
          kpi('Due today', number(limits.due_soon), 'amber', 'Reach their limit within a day', () => router.navigate('/change-requests?due=due_soon'))
        )
      : null,

    h(
      'div.grid.grid--kpi.mb-3',
      kpi('Total Accounts', number(kpis.total_accounts), 'navy', 'Customer master', () => router.navigate('/accounts')),
      kpi('Active MSAs', number(kpis.active_msas), 'navy', 'In-force contracts', () => router.navigate('/accounts')),
      kpi('Total CRs', number(kpis.total_crs), 'navy', 'All time', () => router.navigate('/change-requests')),
      kpi('Draft CRs', number(kpis.draft_crs), 'slate', 'Being prepared', () => go('DRAFT')),
      kpi('Pending Internal Approval', number(kpis.pending_internal), 'amber', 'Awaiting decision', () => go('PENDING_INTERNAL')),
      kpi('Approved CRs', number(kpis.approved_crs), 'green', 'Ready to share', () => go('APPROVED')),
      kpi(
        'Rejected CRs',
        number(kpis.rejected_crs),
        'red',
        kpis.revision_crs ? `${number(kpis.revision_crs)} under revision` : 'Internal or customer',
        () => go('REJECTED')
      ),
      kpi('Pending Customer Approval', number(kpis.pending_customer), 'blue', 'With the customer', () => go('PENDING_CUSTOMER')),
      kpi('Signed CRs', number(kpis.signed_crs), 'green', 'Signature captured', () => go('SIGNED')),
      kpi('Completed CRs', number(kpis.completed_crs), 'green', 'Closed out', () => go('COMPLETED')),
      kpi('Total CR Value', compactMoney(kpis.total_cr_value, currency), 'navy', `Signed: ${compactMoney(kpis.signed_cr_value, currency)}`),
      kpi('CRs Created This Month', number(kpis.crs_this_month), 'blue', 'Rolling month')
    ),

    h(
      'div.grid.grid--2.mb-3',
      card({
        title: 'Change requests by status',
        subtitle: 'Where the portfolio currently sits',
        body: donutChart(
          charts.by_status.map((row) => ({ ...row, color: STATUS_COLORS[row.color] || STATUS_COLORS.slate })),
          { centerLabel: 'Change requests' }
        )
      }),
      card({
        title: 'Change requests by month',
        subtitle: 'Volume raised over the last 12 months',
        body: lineChart(charts.by_month, { color: '#2a4a82' })
      })
    ),

    h(
      'div.grid.grid--2.mb-3',
      card({
        title: 'Change requests by customer',
        subtitle: 'Top accounts by volume',
        body: horizontalBarChart(charts.by_customer, { color: '#2e90fa' })
      }),
      card({
        title: 'CR value by customer',
        subtitle: 'Top accounts by contracted change value',
        body: horizontalBarChart(charts.value_by_customer, {
          color: '#12b76a',
          formatter: (value) => compactMoney(value, currency)
        })
      })
    ),

    h(
      'div.grid.grid--2.mb-3',
      card({
        title: 'Pending approval ageing',
        subtitle: 'How long approvals have been outstanding',
        body: barChart(
          charts.approval_ageing.map((bucket, index) => ({
            ...bucket,
            color: ['#12b76a', '#f79009', '#fb6514', '#f04438'][index]
          })),
          { height: 200 }
        )
      }),
      card({
        title: 'Development vs testing effort',
        subtitle: 'Person hours estimated per account',
        body: groupedBarChart(
          charts.effort_split,
          [
            { key: 'development', label: 'Development', color: '#2a4a82' },
            { key: 'testing', label: 'Testing', color: '#2e90fa' }
          ],
          { formatter: (value) => `${value}h` }
        )
      })
    ),

    h(
      'div.grid.grid--2.mb-3',
      renewalsCard(renewals),
      card({
        title: 'Average time in each stage',
        subtitle: 'From the audit trail; open stages count up to today',
        body: limits.stage_durations.length
          ? horizontalBarChart(
              limits.stage_durations.map((row) => ({ label: row.label, value: row.average_days })),
              { color: '#2a4a82', formatter: (value) => `${value} days` }
            )
          : h('div.muted', 'Not enough history yet.')
      })
    ),

    card({
      title: 'Recent change requests',
      actions: h(
        'button.btn.btn--secondary.btn--sm',
        { onClick: () => router.navigate('/change-requests') },
        'View all',
        icon('chevronRight', 14)
      ),
      flush: true,
      body: dataTable({
        columns: [
          crColumns.number(),
          crColumns.account,
          crColumns.title,
          crColumns.crDate,
          crColumns.release,
          crColumns.cost,
          crColumns.status,
          crColumns.owner,
          crColumns.updated
        ],
        rows: recent,
        onRowClick: (row) => router.navigate(`/change-requests/${row.id}`)
      })
    })
  );

  function go(group) {
    router.navigate(`/change-requests?statusGroup=${group}`);
  }
}

/** Everything blocked on the signed-in user, oldest first. */
function waitingOnYou(queue) {
  const items = queue?.items || [];
  const others = queue?.waiting_on_others || [];
  if (!items.length && !others.length) return null;

  const row = (item, action) =>
    h(
      'a.queue-row',
      { href: `/change-requests/${item.id}` },
      h('div.queue-row__main', h('div', h('span.mono.cell-strong', item.cr_number), ' ', h('span', item.title)), h('div.cell-sub', item.account_name)),
      h('div.queue-row__action', action),
      h('div.queue-row__meta', statusBadge(item.status)),
      h('div.queue-row__meta', item.sla ? slaBadge(item.sla) : h('span.cell-sub', `${item.waiting_days}d`)),
      h('div.queue-row__meta.cell-sub.nowrap', item.waiting_days ? `${item.waiting_days}d waiting` : 'today')
    );

  return card({
    title: items.length ? `Waiting on you (${items.length})` : 'Nothing is waiting on you',
    subtitle: items.length ? 'Oldest first. Clear these and nothing is stuck on you.' : 'Your change requests are with other people.',
    actions: items.some((item) => item.kind === 'APPROVE')
      ? h('button.btn.btn--secondary.btn--sm', { onClick: () => router.navigate('/approvals') }, 'Approvals queue', icon('chevronRight', 14))
      : null,
    flush: true,
    body: h(
      'div.mb-3',
      items.length ? h('div.queue', ...items.slice(0, 8).map((item) => row(item, h('span.cell-strong', item.action)))) : null,
      items.length > 8 ? h('div.queue__more', `+ ${items.length - 8} more`) : null,
      others.length
        ? h(
            'details.queue__others',
            h('summary', `Waiting on others (${others.length})`),
            h('div.queue', ...others.map((item) => row(item, h('span.cell-sub', `With ${item.sla?.waiting_on?.toLowerCase() || 'someone else'}`))))
          )
        : null
    )
  });
}

function renewalsCard(renewals = []) {
  return card({
    title: 'Contracts ending soon',
    subtitle: `MSAs ending within ${store.settings?.renewals?.warning_days ?? 90} days, or already ended`,
    flush: true,
    body: renewals.length
      ? dataTable({
          columns: [
            { key: 'account_name', label: 'Account', render: (r) => h('div', h('div.cell-strong', r.account_name), h('div.cell-sub.mono', r.msa_reference_number)) },
            { key: 'contract_end_date', label: 'Ends', render: (r) => h('span.nowrap', date(r.contract_end_date)) },
            {
              key: 'state',
              label: 'Status',
              render: (r) =>
                r.state === 'expired'
                  ? badge(`Ended ${Math.abs(r.days_left)}d ago`, 'red')
                  : badge(`${r.days_left} day${r.days_left === 1 ? '' : 's'} left`, r.days_left <= 30 ? 'amber' : 'blue')
            },
            { key: 'open_crs', label: 'Open CRs', align: 'right', render: (r) => pluralise(r.open_crs, 'CR') }
          ],
          rows: renewals,
          onRowClick: (r) => router.navigate(`/accounts/${r.account_id}`)
        })
      : emptyState('No contracts ending soon', 'Every active MSA runs beyond the warning window.')
  });
}

function kpi(label, value, tone, meta, onClick) {
  return h(
    `div.kpi${onClick ? '.kpi--clickable' : ''}`,
    { onClick: onClick || null },
    h(`div.kpi__bar.kpi__bar--${tone}`),
    h('div.kpi__label', label),
    h('div.kpi__value', value),
    meta ? h('div.kpi__meta', meta) : null
  );
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

export default dashboardPage;
