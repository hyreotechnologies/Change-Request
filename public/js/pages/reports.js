import { h, render } from '../lib/dom.js';
import { card, icon, pageHeader, loading, apiError, emptyState, notify } from '../lib/ui.js';
import { dataTable } from '../components/table.js';
import { setPage } from '../components/shell.js';
import { money, number, date } from '../lib/format.js';
import api, { qs } from '../lib/api.js';
import store from '../lib/store.js';

/** Ten standard reports with a shared filter panel and Excel / CSV / PDF export. */
export async function reportsPage({ query }) {
  setPage(loading('Loading reports'));

  let reports;
  let accounts;
  try {
    [reports, accounts] = await Promise.all([api.get('/api/reports'), api.get('/api/accounts/lookup').catch(() => [])]);
  } catch (error) {
    apiError(error);
    return;
  }

  const state = {
    code: query.code || reports[0]?.code,
    filters: { accountId: query.accountId || '', status: query.status || '', from: query.from || '', to: query.to || '', minCost: '', maxCost: '' }
  };

  const resultHost = h('div');

  const filterBar = h(
    'div.row.row--tight',
    h(
      'select.select',
      { style: { maxWidth: '200px' }, onChange: (event) => { state.filters.accountId = event.target.value; run(); } },
      h('option', { value: '' }, 'All accounts'),
      ...accounts.map((account) => h('option', { value: account.id, selected: state.filters.accountId === account.id }, account.account_name))
    ),
    h(
      'select.select',
      { style: { maxWidth: '200px' }, onChange: (event) => { state.filters.status = event.target.value; run(); } },
      h('option', { value: '' }, 'All statuses'),
      ...(store.enums?.statuses || []).map((status) => h('option', { value: status.code, selected: state.filters.status === status.code }, status.label))
    ),
    h('input.input', { type: 'date', title: 'From', style: { maxWidth: '150px' }, value: state.filters.from, onChange: (event) => { state.filters.from = event.target.value; run(); } }),
    h('input.input', { type: 'date', title: 'To', style: { maxWidth: '150px' }, value: state.filters.to, onChange: (event) => { state.filters.to = event.target.value; run(); } }),
    h('input.input', { type: 'number', placeholder: 'Min cost', style: { maxWidth: '120px' }, onChange: (event) => { state.filters.minCost = event.target.value; run(); } }),
    h('input.input', { type: 'number', placeholder: 'Max cost', style: { maxWidth: '120px' }, onChange: (event) => { state.filters.maxCost = event.target.value; run(); } }),
    h(
      'button.btn.btn--ghost.btn--sm',
      {
        onClick: () => {
          state.filters = { accountId: '', status: '', from: '', to: '', minCost: '', maxCost: '' };
          reportsPage({ query: { code: state.code } });
        }
      },
      icon('refresh', 14),
      'Reset'
    )
  );

  setPage(
    pageHeader({
      title: 'Reports',
      subtitle: 'Standard management reports with Excel, CSV and PDF export.'
    }),
    h(
      'div.card.mb-3',
      h(
        'div.card__body',
        h(
          'div.row.row--tight',
          ...reports.map((report) =>
            h(
              `button.stepper__step${report.code === state.code ? '.is-active' : ''}`,
              {
                onClick: () => {
                  state.code = report.code;
                  run();
                }
              },
              report.name
            )
          )
        )
      )
    ),
    card({ title: 'Filters', body: filterBar }),
    h('div.mt-3', resultHost)
  );

  await run();

  async function run() {
    render(resultHost, loading('Running report'));
    try {
      const data = await api.get(`/api/reports/${state.code}${qs(state.filters)}`);
      render(
        resultHost,
        card({
          title: data.name,
          subtitle: `${data.description} · ${number(data.total)} record(s)`,
          actions: h(
            'div.row.row--tight',
            ...['xlsx', 'csv', 'pdf'].map((format) =>
              h(
                'button.btn.btn--secondary.btn--sm',
                {
                  onClick: () => {
                    api.download(`/api/reports/${state.code}/export${qs({ ...state.filters, format })}`);
                    notify.info(`Preparing ${format.toUpperCase()} export…`);
                  }
                },
                icon('download', 14),
                format.toUpperCase()
              )
            )
          ),
          flush: true,
          body: data.rows.length
            ? dataTable({
                columns: data.columns.map((column) => ({
                  key: column.key,
                  label: column.label,
                  align: column.type === 'number' ? 'right' : undefined,
                  render: (row) => formatCell(row[column.key], column)
                })),
                rows: data.rows
              })
            : emptyState('No records match these filters', 'Widen the date range or clear the filters.')
        })
      );
    } catch (error) {
      apiError(error);
      render(resultHost, emptyState('Unable to run this report', error.message));
    }
  }

  function formatCell(value, column) {
    if (value === null || value === undefined || value === '') return null;
    if (column.type === 'number') {
      const isMoney = /cost|value|rate|discount|tax/i.test(column.key);
      return isMoney ? money(value, store.currency) : number(value, Number(value) % 1 ? 1 : 0);
    }
    if (/date$/i.test(column.key) && /^\d{4}-\d{2}-\d{2}/.test(String(value))) return date(value);
    return String(value);
  }
}

export default reportsPage;
