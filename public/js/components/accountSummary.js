import { h } from '../lib/dom.js';
import { card, badge, emptyState } from '../lib/ui.js';
import { barChart } from '../lib/charts.js';
import { dataTable } from './table.js';
import { compactMoney, date, number, pluralise } from '../lib/format.js';
import router from '../lib/router.js';

/**
 * Portfolio summary shown above the accounts table: how many accounts are
 * active, what they are worth, and when each one comes up for renewal.
 */
export function accountSummary(data) {
  const { counts, renewals, values, gaps } = data;
  const primary = values[0] || { currency: data.currency, account_value: 0, contract_value: 0, signed_cr_value: 0, pipeline_cr_value: 0 };
  const others = values.slice(1);
  const months = data.horizon_months;

  return h(
    'div.mb-3',
    h(
      'div.grid.grid--kpi-row.mb-3',
      kpi(
        'Active accounts',
        number(counts.active),
        'navy',
        [
          counts.inactive ? `${number(counts.inactive)} inactive` : null,
          counts.onboarding ? `${number(counts.onboarding)} onboarding` : null,
          counts.go_live_not_set ? `${number(counts.go_live_not_set)} go-live not set` : null
        ].filter(Boolean).join(' · ') || 'All live'
      ),
      kpi(
        'Account value',
        compactMoney(primary.account_value, primary.currency),
        'green',
        [
          `MSA ${compactMoney(primary.contract_value, primary.currency)} + signed CRs ${compactMoney(primary.signed_cr_value, primary.currency)}`,
          ...others.map((v) => `+ ${compactMoney(v.account_value, v.currency)}`)
        ].join(' ')
      ),
      kpi(
        `Renewals in next ${months} months`,
        number(renewals.due_soon_count),
        renewals.due_soon_count ? 'amber' : 'slate',
        renewals.next
          ? `Next: ${renewals.next.account_name}, ${date(renewals.next.renewal_date)}`
          : 'No renewal dates ahead'
      ),
      kpi(
        'Overdue renewals',
        number(renewals.overdue_count),
        renewals.overdue_count ? 'red' : 'green',
        renewals.overdue_count ? 'Renewal date has passed' : 'Nothing past its renewal date'
      ),
      kpi(
        'CR pipeline',
        compactMoney(primary.pipeline_cr_value, primary.currency),
        'blue',
        'Awaiting approval or signature'
      ),
      kpi(
        'Quiet accounts',
        number(counts.dormant),
        counts.dormant ? 'amber' : 'slate',
        `No CR raised in ${data.dormant_days} days`
      )
    ),
    h(
      'div.grid.grid--2',
      renewalTable(data),
      h(
        'div.stack',
        card({
          title: 'Renewals by month',
          subtitle: 'Active accounts renewing over the next 12 months',
          body: renewals.by_month.some((m) => m.value)
            ? barChart(
                renewals.by_month.map((m) => ({ label: m.label.replace(/ \d{2}(\d{2})$/, " '$1"), value: m.value })),
                {
                  height: 190,
                  color: '#2a4a82',
                  valueLabel: (v) => pluralise(v, 'account'),
                  formatter: (v) => (Number.isInteger(v) ? v : '')
                }
              )
            : emptyState('No renewals in the next 12 months', 'Add a next renewal date to an account to see it here.')
        }),
        dataGaps(gaps)
      )
    )
  );
}

function renewalTable(data) {
  return card({
    title: 'Renewal information',
    subtitle: 'Active accounts, soonest renewal first',
    flush: true,
    body: dataTable({
      columns: [
        {
          key: 'account_name',
          label: 'Account',
          render: (r) => h('div', h('div.cell-strong', r.account_name), h('div.cell-sub', r.account_manager || r.account_code))
        },
        {
          key: 'go_live_date',
          label: 'Go-live',
          render: (r) =>
            r.go_live_date
              ? h('div', h('div.nowrap', date(r.go_live_date)), h('div.cell-sub', liveFor(r.go_live_date, data.today)))
              : h('span.muted', 'Not set')
        },
        {
          key: 'renewal_date',
          label: 'Next renewal',
          render: (r) =>
            r.renewal_date
              ? h(
                  'div',
                  h('div.nowrap', date(r.renewal_date)),
                  r.renewal_source === 'msa' ? h('div.cell-sub', 'MSA end date') : null
                )
              : h('span.muted', 'Not set')
        },
        { key: 'renewal_state', label: 'Status', render: (r) => renewalBadge(r) },
        {
          key: 'account_value',
          label: 'Value',
          align: 'right',
          render: (r) => h('span.cell-strong.nowrap', compactMoney(r.account_value, r.currency))
        },
        { key: 'open_crs', label: 'Open CRs', align: 'right', render: (r) => number(r.open_crs) }
      ],
      rows: data.accounts,
      onRowClick: (r) => router.navigate(`/accounts/${r.id}`),
      empty: emptyState('No active accounts', 'Create an account to start tracking renewals.')
    })
  });
}

function renewalBadge(r) {
  if (r.renewal_state === 'not_set') return badge('Not set', 'slate');
  if (r.renewal_state === 'overdue') return badge(`Overdue ${Math.abs(r.days_left)}d`, 'red');
  if (r.renewal_state === 'due_soon') return badge(r.days_left === 0 ? 'Due today' : `In ${r.days_left}d`, r.days_left <= 30 ? 'red' : 'amber');
  return badge(`In ${r.days_left}d`, 'green');
}

/** Accounts missing the dates or values the summary relies on. */
function dataGaps(gaps) {
  const items = [
    ['No go-live date', gaps.no_go_live],
    ['No renewal date', gaps.no_renewal],
    ['Renewal taken from MSA end date', gaps.renewal_from_msa],
    ['No MSA contract value', gaps.no_contract_value]
  ].filter(([, list]) => list.length);

  return card({
    title: 'Data to complete',
    subtitle: 'Fill these in to make the summary accurate',
    body: items.length
      ? h(
          'div.stack',
          { style: { gap: '12px' } },
          ...items.map(([label, list]) =>
            h(
              'div',
              h('div.cell-strong.mb-1', `${label} (${list.length})`),
              h(
                'div.row.row--tight',
                { style: { flexWrap: 'wrap' } },
                ...list.map((account) =>
                  h(
                    'a.chip',
                    { href: `/accounts/${account.id}/edit`, title: `Edit ${account.account_name}` },
                    account.account_name
                  )
                )
              )
            )
          )
        )
      : h('div.muted', 'Every active account has a go-live date, renewal date and contract value.')
  });
}

function liveFor(goLive, today) {
  if (goLive > today) return 'Onboarding';
  const [y1, m1] = goLive.split('-').map(Number);
  const [y2, m2] = today.split('-').map(Number);
  const months = (y2 - y1) * 12 + (m2 - m1);
  if (months < 1) return 'Live this month';
  if (months < 12) return `Live ${pluralise(months, 'month')}`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return `Live ${pluralise(years, 'year')}${rest ? ` ${pluralise(rest, 'month')}` : ''}`;
}

function kpi(label, value, tone, meta) {
  return h(
    'div.kpi',
    h(`div.kpi__bar.kpi__bar--${tone}`),
    h('div.kpi__label', label),
    h('div.kpi__value', value),
    meta ? h('div.kpi__meta', meta) : null
  );
}

export default accountSummary;
