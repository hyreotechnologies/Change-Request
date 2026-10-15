import { h, render, debounce } from '../lib/dom.js';
import { card, icon, pageHeader, skeletonTable, badge, apiError, emptyState, modal } from '../lib/ui.js';
import { dataTable, pagination, statusBadge } from '../components/table.js';
import { setPage } from '../components/shell.js';
import { dateTime, fileSize, titleCase, APPROVAL_COLORS } from '../lib/format.js';
import api, { qs } from '../lib/api.js';
import router from '../lib/router.js';

/** Library of every generated document version across all change requests. */
export async function documentsPage({ query }) {
  const state = { q: query.q || '', status: query.status || '', page: 1, pageSize: 50 };
  const tableHost = h('div', skeletonTable(6));

  const searchInput = h('input.input', {
    type: 'search',
    placeholder: 'CR number, title or account…',
    value: state.q,
    style: { maxWidth: '300px' }
  });
  searchInput.addEventListener('input', debounce(() => {
    state.q = searchInput.value.trim();
    state.page = 1;
    load();
  }, 260));

  const statusSelect = h(
    'select.select',
    {
      style: { maxWidth: '180px' },
      onChange: (event) => {
        state.status = event.target.value;
        state.page = 1;
        load();
      }
    },
    ...[
      { value: '', label: 'All versions' },
      { value: 'DRAFT', label: 'Draft' },
      { value: 'FINAL', label: 'Final' },
      { value: 'SIGNED', label: 'Signed' },
      { value: 'SUPERSEDED', label: 'Superseded' }
    ].map((option) => h('option', { value: option.value, selected: state.status === option.value }, option.label))
  );

  setPage(
    pageHeader({
      title: 'Documents',
      subtitle: 'Every version ever generated is retained. Approved and signed versions are immutable.'
    }),
    card({ title: 'Document library', actions: h('div.row.row--tight', searchInput, statusSelect), flush: true, body: tableHost })
  );

  await load();

  async function load() {
    render(tableHost, skeletonTable(6));
    try {
      const data = await api.get(`/api/documents${qs({ q: state.q, status: state.status, page: state.page, pageSize: state.pageSize })}`);
      render(
        tableHost,
        data.rows.length
          ? dataTable({
              columns: [
                {
                  key: 'cr_number',
                  label: 'Change request',
                  render: (row) => h('div', h('div.cell-strong.mono', row.cr_number), h('div.cell-sub', row.cr_title))
                },
                { key: 'account_name', label: 'Account' },
                {
                  key: 'version',
                  label: 'Version',
                  render: (row) => h('div', h('div.cell-strong', `v${row.version}`), h('div.cell-sub', row.doc_type === 'SIGNED_CR' ? 'Signed copy' : 'Change request'))
                },
                { key: 'format', label: 'Format', render: (row) => badge(row.format, row.format === 'PDF' ? 'red' : 'blue', { plain: true }) },
                { key: 'status', label: 'Status', render: (row) => badge(titleCase(row.status), APPROVAL_COLORS[row.status] || 'slate') },
                { key: 'cr_status', label: 'CR status', render: (row) => statusBadge(row.cr_status) },
                { key: 'generated_at', label: 'Generated', render: (row) => dateTime(row.generated_at) },
                { key: 'generated_by_name', label: 'By', render: (row) => row.generated_by_name || 'System' },
                { key: 'file_size', label: 'Size', align: 'right', render: (row) => fileSize(row.file_size) },
                {
                  key: 'actions',
                  label: '',
                  render: (row) =>
                    h(
                      'div.row.row--tight',
                      h('button.btn.btn--ghost.btn--sm', { onClick: () => preview(row) }, icon('eye', 14)),
                      h(
                        'button.btn.btn--secondary.btn--sm',
                        { onClick: () => api.download(`/api/documents/versions/${row.id}/download`) },
                        icon('download', 14),
                        row.format
                      )
                    )
                }
              ],
              rows: data.rows,
              onRowClick: (row) => router.navigate(`/change-requests/${row.cr_id}?tab=documents`)
            })
          : emptyState('No documents yet', 'Documents appear here once a change request generates one.'),
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

  async function preview(row) {
    try {
      const data = await api.get(`/api/documents/versions/${row.id}/preview`);
      modal({
        title: `${row.cr_number} — version ${row.version}`,
        subtitle: `${row.format} · ${titleCase(row.status)}`,
        size: 'xl',
        body: h('div.doc-preview', h('div', { html: data.html })),
        actions: [
          { label: 'Close', variant: 'secondary' },
          { label: `Download ${row.format}`, variant: 'primary', onClick: () => api.download(`/api/documents/versions/${row.id}/download`) }
        ]
      });
    } catch (error) {
      apiError(error);
    }
  }
}

export default documentsPage;
