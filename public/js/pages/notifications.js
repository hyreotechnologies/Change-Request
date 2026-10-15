import { h, render, debounce } from '../lib/dom.js';
import { card, icon, pageHeader, loading, badge, apiError, notify, emptyState, modal, confirmDialog } from '../lib/ui.js';
import { dataTable } from '../components/table.js';
import { setPage } from '../components/shell.js';
import { dateTime, relative, titleCase, APPROVAL_COLORS } from '../lib/format.js';
import api, { qs } from '../lib/api.js';
import store from '../lib/store.js';
import router from '../lib/router.js';

export async function notificationsPage() {
  setPage(loading('Loading notifications'));

  let data;
  try {
    data = await api.get('/api/notifications?limit=100');
  } catch (error) {
    apiError(error);
    return;
  }

  setPage(
    pageHeader({
      title: 'Notifications',
      subtitle: `${data.unread} unread of ${data.total}`,
      actions: [
        data.unread
          ? h(
              'button.btn.btn--secondary',
              {
                onClick: async () => {
                  try {
                    await api.post('/api/notifications/read-all');
                    await store.refreshUnread();
                    notify.success('All notifications marked as read.');
                    notificationsPage();
                  } catch (error) {
                    apiError(error);
                  }
                }
              },
              icon('check', 15),
              'Mark all as read'
            )
          : null,
        data.total
          ? h(
              'button.btn.btn--secondary',
              {
                onClick: async () => {
                  const confirmed = await confirmDialog({
                    title: 'Clear all notifications',
                    message: `Remove all ${data.total} notification(s), read and unread? They are only a to-do list — the audit trail is untouched.`,
                    confirmLabel: 'Clear all',
                    variant: 'danger'
                  });
                  if (!confirmed) return;
                  try {
                    const result = await api.del('/api/notifications');
                    await store.refreshUnread();
                    notify.success(`${result.cleared} notification(s) cleared.`);
                    notificationsPage();
                  } catch (error) {
                    apiError(error);
                  }
                },
                title: 'Remove every notification'
              },
              icon('trash', 15),
              'Clear all'
            )
          : null
      ]
    }),
    card({
      flush: true,
      body: data.rows.length
        ? h(
            'div',
            ...data.rows.map((row) =>
              h(
                'div.feed__item',
                {
                  style: {
                    padding: '14px 20px',
                    cursor: row.link ? 'pointer' : 'default',
                    background: row.is_read ? 'transparent' : 'var(--accent-soft)'
                  },
                  onClick: async () => {
                    if (!row.is_read) {
                      await api.post(`/api/notifications/${row.id}/read`);
                      await store.refreshUnread();
                    }
                    if (row.link) router.navigate(row.link);
                    else notificationsPage();
                  }
                },
                h(
                  `div.feed__icon.feed__icon--${toneFor(row.severity)}`,
                  icon(iconFor(row.type), 14)
                ),
                h(
                  'div.feed__body',
                  h('div.feed__title', row.title),
                  row.body ? h('div.feed__meta', row.body) : null,
                  h('div.feed__meta', `${relative(row.created_at)}${row.cr_number ? ` · ${row.cr_number}` : ''}`)
                ),
                row.is_read ? null : h('span.badge.badge--navy.badge--plain', 'New'),
                h(
                  'button.btn.btn--ghost.btn--sm.btn--icon',
                  {
                    title: 'Clear this notification',
                    'aria-label': 'Clear this notification',
                    onClick: async (event) => {
                      event.stopPropagation();
                      try {
                        await api.del(`/api/notifications/${row.id}`);
                        await store.refreshUnread();
                        notificationsPage();
                      } catch (error) {
                        apiError(error);
                      }
                    }
                  },
                  icon('x', 15)
                )
              )
            )
          )
        : emptyState('You are all caught up', 'Notifications about approvals, customer activity and signatures appear here.')
    })
  );
}

/** Admin view of every message the system has produced. */
export async function outboxPage({ query }) {
  const state = { q: query.q || '', status: query.status || '', page: 1, pageSize: 50 };
  const tableHost = h('div', loading('Loading outbox'));

  const searchInput = h('input.input', {
    type: 'search',
    placeholder: 'Recipient or subject…',
    value: state.q,
    style: { maxWidth: '280px' }
  });
  searchInput.addEventListener('input', debounce(() => {
    state.q = searchInput.value.trim();
    load();
  }, 250));

  setPage(
    pageHeader({
      title: 'Email outbox',
      subtitle: 'Every message the system has produced, with delivery, open and click tracking.'
    }),
    h(
      'div.mb-3',
      h(
        'div.alert.alert--info',
        icon('info', 17),
        h(
          'div',
          h('div.alert__title', 'Transport'),
          store.settings?.email?.transport === 'smtp'
            ? 'SMTP delivery is active — messages are sent to real mailboxes and logged here.'
            : 'Capture transport is active — messages are stored here instead of being delivered. Switch to SMTP in Settings to send real email.'
        )
      )
    ),
    card({
      title: 'Messages',
      actions: h(
        'div.row.row--tight',
        searchInput,
        h(
          'select.select',
          {
            style: { maxWidth: '160px' },
            onChange: (event) => {
              state.status = event.target.value;
              load();
            }
          },
          ...[
            { value: '', label: 'All statuses' },
            { value: 'QUEUED', label: 'Queued' },
            { value: 'SENT', label: 'Sent' },
            { value: 'DELIVERED', label: 'Delivered' },
            { value: 'OPENED', label: 'Opened' },
            { value: 'CLICKED', label: 'Clicked' },
            { value: 'FAILED', label: 'Failed' }
          ].map((option) => h('option', { value: option.value, selected: state.status === option.value }, option.label))
        )
      ),
      flush: true,
      body: tableHost
    })
  );

  await load();

  async function load() {
    render(tableHost, loading('Loading'));
    try {
      const data = await api.get(`/api/emails${qs({ q: state.q, status: state.status, page: state.page, pageSize: state.pageSize })}`);
      render(
        tableHost,
        data.rows.length
          ? dataTable({
              columns: [
                { key: 'template_code', label: 'Template', render: (row) => titleCase(row.template_code || 'Custom') },
                { key: 'to_email', label: 'To', render: (row) => h('div', h('div', row.to_email), row.cc_emails ? h('div.cell-sub', `cc ${row.cc_emails}`) : null) },
                { key: 'subject', label: 'Subject' },
                { key: 'cr_number', label: 'CR', render: (row) => (row.cr_number ? h('span.mono.fs-12', row.cr_number) : null) },
                { key: 'status', label: 'Status', render: (row) => badge(titleCase(row.status), APPROVAL_COLORS[row.status] || 'slate') },
                { key: 'queued_at', label: 'Queued', render: (row) => dateTime(row.queued_at) },
                { key: 'opened_at', label: 'Opened', render: (row) => (row.opened_at ? `${dateTime(row.opened_at)} (${row.open_count})` : h('span.muted', '—')) },
                { key: 'clicked_at', label: 'Clicked', render: (row) => (row.clicked_at ? dateTime(row.clicked_at) : h('span.muted', '—')) },
                {
                  key: 'actions',
                  label: '',
                  render: (row) => h('button.btn.btn--ghost.btn--sm', { onClick: () => view(row.id) }, icon('eye', 14), 'Open')
                }
              ],
              rows: data.rows,
              onRowClick: (row) => view(row.id)
            })
          : emptyState('No messages yet', 'Messages appear as change requests move through the workflow.')
      );
    } catch (error) {
      apiError(error);
    }
  }

  async function view(id) {
    try {
      const email = await api.get(`/api/emails/${id}`);
      modal({
        title: email.subject,
        subtitle: `To ${email.to_email}${email.cc_emails ? ` · cc ${email.cc_emails}` : ''} · ${dateTime(email.sent_at || email.queued_at)}`,
        size: 'lg',
        body: h(
          'div',
          email.error ? h('div.alert.alert--danger.mb-2', icon('alert', 17), h('div', email.error)) : null,
          h('div', {
            style: { background: 'var(--ink-100)', padding: '12px', borderRadius: '8px', maxHeight: '58vh', overflow: 'auto' },
            html: email.body_html
          })
        ),
        actions: [{ label: 'Close', variant: 'primary' }]
      });
    } catch (error) {
      apiError(error);
    }
  }
}

function iconFor(type) {
  if (!type) return 'bell';
  if (type.includes('APPROV')) return 'check';
  if (type.includes('REJECT')) return 'x';
  if (type.includes('SIGN') || type.includes('ENVELOPE')) return 'signature';
  if (type.includes('SHARED') || type.includes('EMAIL')) return 'mail';
  if (type.includes('VIEWED')) return 'eye';
  return 'bell';
}

function toneFor(severity) {
  return { SUCCESS: 'green', WARNING: 'red', ACTION: 'amber', INFO: 'blue' }[severity] || 'blue';
}

export default notificationsPage;
