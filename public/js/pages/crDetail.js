import { h, render, readForm } from '../lib/dom.js';
import {
  card, icon, pageHeader, loading, badge, definitionList, apiError, notify,
  alert, modal, confirmDialog, emptyState, tabs, field, input, textarea, select, switchControl
} from '../lib/ui.js';
import { dataTable, statusBadge, slaBadge } from '../components/table.js';
import { DOCUMENT_FORMATS, generateAndDownload } from '../components/documentActions.js';
import { setPage } from '../components/shell.js';
import { date, dateTime, relative, money, hours, number, titleCase, fileSize, APPROVAL_COLORS, PRIORITY_COLORS } from '../lib/format.js';
import api from '../lib/api.js';
import store from '../lib/store.js';
import router from '../lib/router.js';

export async function crDetailPage({ params, query }) {
  setPage(loading('Loading change request'));

  let cr;
  try {
    cr = await api.get(`/api/change-requests/${params.id}`);
  } catch (error) {
    apiError(error);
    router.navigate('/change-requests');
    return;
  }

  let activeTab = query.tab || 'overview';
  const currency = cr.costs?.currency || store.currency;
  const bodyHost = h('div');
  // the strip is re-rendered on every change: re-rendering only the body left
  // the previous tab highlighted, so the user could not tell where they were
  const tabsHost = h('div');

  const reload = async () => {
    cr = await api.get(`/api/change-requests/${params.id}`);
    draw();
  };

  function draw() {
    setPage(
      pageHeader({
        breadcrumb: [
          h('a', { href: '/change-requests' }, 'Change Requests'),
          icon('chevronRight', 12),
          h('a', { href: `/accounts/${cr.account_id}` }, cr.account?.account_name),
          icon('chevronRight', 12),
          cr.cr_number
        ],
        title: cr.cr_number,
        subtitle: cr.title,
        actions: actionButtons()
      }),

      h(
        'div.card.mb-3',
        h(
          'div.card__body',
          h(
            'div.row.mb-2',
            statusBadge(cr.status),
            badge(titleCase(cr.priority), PRIORITY_COLORS[cr.priority] || 'slate'),
            badge(titleCase(cr.cr_type), 'navy'),
            cr.revision > 0 ? badge(`Revision ${cr.revision}`, 'orange') : null,
            cr.locked ? badge('Locked', 'slate') : null,
            slaBadge(cr.sla, { long: true }),
            h('div.spacer'),
            h('span.cell-sub', `Contract reference ${cr.cr_reference} · MSA ${cr.snapshot_msa_number}`)
          ),
          renderTimeline(cr.timeline)
        )
      ),

      stateBanner(),
      contractBanner(),

      tabsHost,
      h('div.mt-2', bodyHost)
    );
    drawTabs();
    drawTab();
  }

  function drawTabs() {
    render(
      tabsHost,
      tabs(
        [
          { key: 'overview', label: 'Overview' },
          { key: 'scope', label: 'Scope', count: cr.items?.length || 0 },
          { key: 'effort', label: 'Effort & Cost' },
          { key: 'approvals', label: 'Approvals', count: cr.approvals?.length || 0 },
          { key: 'documents', label: 'Documents', count: cr.documents?.length || 0 },
          { key: 'emails', label: 'Emails' },
          { key: 'audit', label: 'Audit Log' }
        ],
        activeTab,
        (key) => {
          activeTab = key;
          history.replaceState({}, '', `/change-requests/${cr.id}?tab=${key}`);
          drawTabs();
          drawTab();
        }
      )
    );
  }

  function drawTab() {
    const renderers = {
      overview: overviewTab,
      scope: scopeTab,
      effort: effortTab,
      approvals: approvalsTab,
      documents: documentsTab,
      emails: emailsTab,
      audit: auditTab
    };
    render(bodyHost, loading());
    Promise.resolve(renderers[activeTab]()).then((node) => render(bodyHost, node));
  }

  /* ------------------------------------------------------------- actions -- */

  function actionButtons() {
    const actions = [];
    const can = cr.permissions_context;

    if (can.can_edit && store.can('cr.edit')) {
      actions.push(h('button.btn.btn--secondary', { onClick: () => router.navigate(`/change-requests/${cr.id}/edit`) }, icon('edit', 15), 'Edit'));
    }
    if (store.can('document.generate')) {
      actions.push(h('button.btn.btn--secondary', { onClick: generateDocument }, icon('file', 15), 'Generate document'));
    }
    if (can.can_submit && store.can('cr.submit')) {
      actions.push(h('button.btn.btn--primary', { onClick: submit }, icon('send', 15), 'Submit for approval'));
    }
    if (can.can_approve && store.can('cr.approve')) {
      actions.push(h('button.btn.btn--danger', { onClick: () => decide('REJECT') }, icon('x', 15), 'Reject'));
      actions.push(h('button.btn.btn--success', { onClick: () => decide('APPROVE') }, icon('check', 15), 'Approve'));
    }
    if (can.can_share && store.can('customer.share')) {
      actions.push(h('button.btn.btn--primary', { onClick: shareWithCustomer }, icon('mail', 15), 'Share with customer'));
    }
    if (can.can_sign && store.can('docusign.send')) {
      actions.push(h('button.btn.btn--secondary', { onClick: sendForSignature }, icon('signature', 15), 'Send via DocuSign'));
    }
    if (['INTERNAL_REJECTED', 'CUSTOMER_REJECTED'].includes(cr.status) && store.can('cr.revise')) {
      actions.push(h('button.btn.btn--primary', { onClick: revise }, icon('refresh', 15), 'Revise'));
    }
    if (isWaitingOnSomeone() && store.can('cr.edit')) {
      actions.push(h('button.btn.btn--secondary', { onClick: sendReminder, title: 'Email whoever this change request is waiting on' }, icon('bell', 15), 'Send reminder'));
    }

    const overflow = [];
    if (store.can('cr.create')) overflow.push({ label: 'Duplicate as new draft', icon: 'copy', onClick: duplicate });
    if (can.can_cancel && store.can('cr.edit')) overflow.push({ label: 'Reassign owner', icon: 'user', onClick: reassign });
    if (cr.revision > 0) overflow.push({ label: 'Compare with previous version', icon: 'diff', onClick: showComparison });
    if (can.can_cancel && store.can('cr.cancel')) overflow.push({ label: 'Cancel change request', icon: 'x', onClick: cancel });
    if (cr.status === 'ON_HOLD' && store.can('cr.hold')) overflow.push({ label: 'Resume', icon: 'refresh', onClick: resume });
    else if (can.can_cancel && store.can('cr.hold')) overflow.push({ label: 'Put on hold', icon: 'clock', onClick: hold });
    if (cr.status === 'DRAFT' && store.can('cr.delete')) overflow.push({ label: 'Delete draft', icon: 'trash', onClick: remove });

    if (overflow.length) {
      actions.push(
        h(
          'button.btn.btn--secondary.btn--icon',
          {
            title: 'More actions',
            onClick: (event) => {
              event.stopPropagation();
              const menu = h(
                'div.dropdown',
                ...overflow.map((item) =>
                  h('div.dropdown__item', { onClick: () => { menu.remove(); item.onClick(); } }, icon(item.icon, 15), item.label)
                )
              );
              document.body.appendChild(menu);
              setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
            }
          },
          '⋯'
        )
      );
    }

    return actions;
  }

  function isWaitingOnSomeone() {
    return cr.status === 'PENDING_INTERNAL_APPROVAL' || ['SENT_TO_CUSTOMER', 'CUSTOMER_VIEWED', 'CUSTOMER_APPROVAL_PENDING'].includes(cr.status);
  }

  async function sendReminder() {
    try {
      const result = await api.post(`/api/change-requests/${cr.id}/remind`);
      notify.success(`Reminder sent to ${result.recipients.join(', ')}.`);
      if (activeTab === 'approvals') drawTab();
    } catch (error) {
      apiError(error);
    }
  }

  async function duplicate() {
    const confirmed = await confirmDialog({
      title: `Duplicate ${cr.cr_number}?`,
      message: 'A new draft is created for the same account with this scope, effort, cost and terms. Dates, the PO number and the approval history are not copied.',
      confirmLabel: 'Duplicate'
    });
    if (!confirmed) return;
    try {
      const copy = await api.post(`/api/change-requests/${cr.id}/duplicate`);
      notify.success(`${copy.cr_number} created from ${cr.cr_number}. Review it before submitting.`);
      router.navigate(`/change-requests/${copy.id}/edit`);
    } catch (error) {
      apiError(error);
    }
  }

  async function reassign() {
    const users = await api.get('/api/users/pick-list').catch(() => []);
    let chosen = null;
    const picker = select(
      'userId',
      [{ value: '', label: 'Choose a person…' }, ...users.map((u) => ({ value: u.id, label: `${u.name} · ${u.email}` }))],
      cr.current_owner_user_id || ''
    );
    modal({
      title: `Reassign ${cr.cr_number}`,
      subtitle: cr.owner ? `Currently owned by ${cr.owner.name}` : 'Currently unassigned',
      body: field('New owner', picker, { required: true }),
      actions: [
        { label: 'Cancel', variant: 'secondary' },
        {
          label: 'Reassign',
          variant: 'primary',
          onClick: async () => {
            chosen = picker.value;
            if (!chosen) {
              notify.warning('Choose who should own this change request.');
              return false;
            }
            try {
              const { results } = await api.post('/api/change-requests/bulk/reassign', { ids: [cr.id], userId: chosen });
              if (!results[0].ok) throw new Error(results[0].error);
              notify.success('Owner updated. They have been notified.');
              await reload();
              return true;
            } catch (error) {
              apiError(error);
              return false;
            }
          }
        }
      ]
    });
  }

  async function showComparison() {
    let data;
    try {
      data = await api.get(`/api/change-requests/${cr.id}/compare`);
    } catch (error) {
      apiError(error);
      return;
    }
    modal({
      title: data.mode === 'since_last_submission' ? 'Changes since the last submission' : 'Changes in this submission',
      subtitle: data.available
        ? `Revision ${data.base.revision} (submitted ${dateTime(data.base.submitted_at)}) compared with ${data.target.submitted_at ? `revision ${data.target.revision}, submitted ${dateTime(data.target.submitted_at)}` : 'the current draft'}`
        : null,
      size: 'lg',
      body: comparisonBody(data)
    });
  }

  function comparisonBody(data) {
    if (!data.available) return h('div.muted', data.message);
    if (!data.changes.length) return h('div.muted', 'Nothing changed between these versions.');
    const show = (value, label) => {
      if (value === null || value === undefined || value === '') return h('span.muted', '—');
      if (/cost|rate|discount/i.test(label) && !/type/i.test(label) && Number.isFinite(Number(value))) return money(value, data.currency || currency);
      return String(value);
    };
    const sections = [...new Set(data.changes.map((c) => c.section))];
    return h(
      'div.stack',
      ...sections.map((section) =>
        h(
          'div',
          h('div.diff__section', section),
          h(
            'table.diff',
            h('thead', h('tr', h('th', 'Field'), h('th', 'Before'), h('th', 'After'))),
            h(
              'tbody',
              ...data.changes
                .filter((c) => c.section === section)
                .map((c) =>
                  h(
                    'tr',
                    h('td.cell-strong', c.label),
                    h('td.diff__before', show(c.before, c.label)),
                    h('td.diff__after', show(c.after, c.label))
                  )
                )
            )
          )
        )
      )
    );
  }

  /** MSA expiry and contract budget, when either needs attention. */
  function contractBanner() {
    const contract = cr.contract;
    if (!contract || stateIsClosed()) return null;
    const notes = [];
    const renewal = contract.renewal;
    if (renewal?.state === 'expired') {
      notes.push(alert('danger', 'The MSA has ended', `MSA ${cr.msa?.msa_reference_number} ended on ${date(renewal.end_date)}. Confirm the contract is renewed before this change request goes further.`));
    } else if (renewal?.state === 'expiring') {
      notes.push(alert('warning', `The MSA ends in ${renewal.days_left} day${renewal.days_left === 1 ? '' : 's'}`, `MSA ${cr.msa?.msa_reference_number} ends on ${date(renewal.end_date)}.`));
    }
    const budget = contract.budget;
    if (budget?.contract_value) {
      const thisValue = Number(cr.costs?.total_cost || 0);
      const counted = ['CUSTOMER_APPROVED', 'SIGNED', 'COMPLETED', 'PENDING_INTERNAL_APPROVAL', 'INTERNALLY_APPROVED', 'READY_FOR_CUSTOMER', 'SENT_TO_CUSTOMER', 'CUSTOMER_VIEWED', 'CUSTOMER_APPROVAL_PENDING'].includes(cr.status);
      const projected = budget.committed + budget.pipeline + (counted ? 0 : thisValue);
      if (projected > budget.contract_value) {
        notes.push(
          alert(
            'warning',
            'This would take the MSA over its contract value',
            `Signed ${money(budget.committed, budget.currency)} + in progress ${money(budget.pipeline + (counted ? 0 : thisValue), budget.currency)} against a contract value of ${money(budget.contract_value, budget.currency)}.`
          )
        );
      }
    }
    return notes.length ? h('div.stack.mb-2', ...notes) : null;
  }

  function stateIsClosed() {
    return ['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(cr.status);
  }

  function stateBanner() {
    // a CR under revision may carry both an internal and a customer rejection;
    // show whichever happened last, so the banner is never a stale reason
    const internalAt = cr.internal_rejected_at ? Date.parse(cr.internal_rejected_at) : 0;
    const customerAt = cr.customer_rejection_comments && cr.customer_decided_at ? Date.parse(cr.customer_decided_at) : 0;

    if (cr.status === 'CUSTOMER_REJECTED' || (customerAt && customerAt >= internalAt && cr.status === 'REVISION')) {
      return h('div.mb-2', alert('danger', 'Rejected by the customer', cr.customer_rejection_comments));
    }
    if (cr.status === 'INTERNAL_REJECTED' || (cr.internal_rejection_comments && cr.status === 'REVISION')) {
      return h(
        'div.mb-2',
        alert(
          'danger',
          'Rejected during internal review — under revision',
          cr.internal_rejection_comments || 'See the approvals tab for the reason.'
        )
      );
    }
    if (cr.status === 'PENDING_INTERNAL_APPROVAL') {
      const pending = (cr.approvals || []).find((a) => a.status === 'PENDING');
      return h(
        'div.mb-2.banner-with-action',
        alert('warning', 'Awaiting internal approval', pending ? `With ${pending.approver_name || pending.approver_email} since ${dateTime(pending.requested_at)}` : ''),
        cr.revision > 0
          ? h('button.btn.btn--secondary.btn--sm', { onClick: showComparison }, icon('diff', 14), 'What changed in this revision?')
          : null
      );
    }
    if (cr.status === 'READY_FOR_CUSTOMER') {
      return h('div.mb-2', alert('success', 'Approved internally', 'The final document is generated and ready to share with the customer.'));
    }
    if (cr.status === 'COMPLETED') {
      return h('div.mb-2', alert('success', 'Completed', `Signed on ${dateTime(cr.signed_at)} and stored with the audit trail.`));
    }
    if (cr.status === 'ON_HOLD') {
      return h('div.mb-2', alert('warning', 'On hold', cr.hold_reason || ''));
    }
    if (cr.status === 'CANCELLED') {
      return h('div.mb-2', alert('warning', 'Cancelled', cr.cancel_reason || ''));
    }
    return null;
  }

  /* ---------------------------------------------------------------- tabs -- */

  function overviewTab() {
    return h(
      'div.stack',
      h(
        'div.grid.grid--2',
        card({
          title: 'Change request',
          body: definitionList([
            ['CR number', h('span.mono', cr.cr_number)],
            ['Contract reference', h('span.mono', cr.cr_reference)],
            ['Title', cr.title],
            ['Type', titleCase(cr.cr_type)],
            ['Priority', titleCase(cr.priority)],
            ['CR date', date(cr.cr_date)],
            ['Effective date', date(cr.effective_date)],
            ['Requested by', cr.requested_by],
            ['Current owner', cr.owner?.name],
            ['Created', `${dateTime(cr.created_at)}`],
            ['Last updated', relative(cr.updated_at)]
          ])
        }),
        card({
          title: 'Account & MSA',
          actions: h(
            'button.btn.btn--ghost.btn--sm',
            { onClick: () => router.navigate(`/accounts/${cr.account_id}`) },
            'Open account',
            icon('chevronRight', 13)
          ),
          body: definitionList([
            ['Account', cr.account?.account_name],
            ['Legal entity (Licensee)', cr.snapshot_legal_entity],
            ['MSA reference', h('span.mono', cr.snapshot_msa_number)],
            ['MSA date', date(cr.snapshot_msa_date)],
            ['Contract start', date(cr.snapshot_contract_start)],
            ['Contract end', date(cr.snapshot_contract_end)],
            ['Customer contact', cr.customer_contact_name],
            ['Customer contact email', cr.customer_contact_email],
            ['Customer approver', cr.snapshot_customer_approver],
            ['Customer approver email', cr.snapshot_customer_approver_email]
          ])
        })
      ),
      h(
        'div.grid.grid--2',
        card({
          title: 'Timeline',
          body: definitionList([
            ['Development start', date(cr.dev_start_date)],
            ['Development completion', date(cr.dev_completion_date)],
            ['Testing start', date(cr.test_start_date)],
            ['Testing completion', date(cr.test_completion_date)],
            ['Target release date', date(cr.target_release_date)],
            ['Planned production release', date(cr.planned_production_release)],
            ['Estimated timeline', cr.estimated_timeline],
            ['Estimated business days', cr.estimated_business_days ? `${cr.estimated_business_days} days` : null],
            ['Depends on PO', cr.depends_on_po ? 'Yes' : 'No'],
            ['PO required date', date(cr.po_required_date)]
          ])
        }),
        card({
          title: 'Commercial terms',
          body: definitionList([
            ['Payment terms', cr.payment_terms],
            ['PO required', cr.po_required ? 'Yes' : 'No'],
            ['PO number', cr.po_number],
            ['Invoice terms', cr.invoice_terms],
            ['Internal approver', cr.snapshot_internal_approver],
            ['Account manager', cr.snapshot_account_manager],
            ['CR manager', cr.snapshot_cr_manager]
          ])
        })
      ),
      h(
        'div.grid.grid--2',
        card({
          title: 'Assumptions',
          body: cr.assumptions?.length
            ? h('ul', { style: { margin: 0, paddingLeft: '18px' } }, ...cr.assumptions.map((a) => h('li', a.text)))
            : h('div.muted', 'Nil')
        }),
        card({
          title: 'Dependencies & risks',
          body: cr.dependencies?.length
            ? h(
                'div.stack',
                ...cr.dependencies.map((dependency) =>
                  h('div.row', badge(titleCase(dependency.dependency_type), 'slate'), h('span', dependency.text))
                )
              )
            : h('div.muted', 'Nil')
        })
      ),
      cr.general_terms
        ? card({
            title: 'General terms',
            body: h('ul', { style: { margin: 0, paddingLeft: '18px' } }, ...String(cr.general_terms).split('\n').filter(Boolean).map((term) => h('li', term)))
          })
        : null
    );
  }

  function scopeTab() {
    if (!cr.items?.length) {
      return emptyState('No scope items', 'Add change items from the edit wizard.');
    }
    return h(
      'div.stack',
      ...cr.items.map((item) =>
        card({
          title: `${item.item_no}. ${item.feature_name}`,
          actions: item.release_date ? badge(`Release ${date(item.release_date)}`, 'blue') : null,
          body: definitionList([
            ['Requested change', item.requested_change],
            ['Detailed description', item.detailed_description],
            ['Business justification', item.business_justification],
            ['Current behaviour', item.current_behaviour],
            ['Expected behaviour', item.expected_behaviour],
            ['Remarks', item.remarks]
          ])
        })
      )
    );
  }

  function effortTab() {
    return h(
      'div.grid.grid--2',
      card({
        title: 'Estimated effort',
        subtitle: 'Person hours',
        flush: true,
        body: dataTable({
          columns: [
            { key: 'label', label: 'Category' },
            { key: 'hours', label: 'Hours', align: 'right', render: (row) => hours(row.hours) },
            {
              key: 'cost',
              label: 'Cost',
              align: 'right',
              render: (row) => money(Number(row.hours || 0) * Number(cr.costs?.billing_rate || 0), currency)
            }
          ],
          rows: cr.efforts || [],
          footer: h(
            'tr',
            h('td.cell-strong', 'Total effort'),
            h('td.num.cell-strong', hours(cr.total_effort)),
            h('td.num.cell-strong', money(cr.costs?.subtotal, currency))
          )
        })
      }),
      card({
        title: 'Cost evaluation',
        body: h(
          'div.totals',
          h('div.totals__row', h('span.totals__label', 'Billing rate'), h('span.totals__value', `${money(cr.costs?.billing_rate, currency)} / hour`)),
          h('div.totals__row', h('span.totals__label', 'Total effort'), h('span.totals__value', hours(cr.total_effort))),
          h('div.totals__row.totals__row--divider', h('span.totals__label', 'Subtotal'), h('span.totals__value', money(cr.costs?.subtotal, currency))),
          h(
            'div.totals__row',
            h('span.totals__label', `Discount${cr.costs?.discount_type === 'PERCENT' ? ` (${cr.costs.discount_value}%)` : ''}`),
            h('span.totals__value', `- ${money(cr.costs?.discount_amount, currency)}`)
          ),
          h('div.totals__row', h('span.totals__label', `Tax (${number(cr.costs?.tax_percent)}%)`), h('span.totals__value', money(cr.costs?.tax_amount, currency))),
          h('div.totals__row.totals__row--grand', h('span', 'Total CR cost'), h('span', money(cr.costs?.total_cost, currency)))
        )
      })
    );
  }

  async function approvalsTab() {
    const [comparison, reminders] = await Promise.all([
      cr.revision > 0 ? api.get(`/api/change-requests/${cr.id}/compare`).catch(() => null) : null,
      api.get(`/api/change-requests/${cr.id}/reminders`).catch(() => [])
    ]);
    return h(
      'div.stack',
      comparison
        ? card({
            title: comparison.mode === 'since_last_submission' ? 'Changes since the last submission' : 'Changes in this submission',
            subtitle: comparison.available ? `${comparison.changes.length} change${comparison.changes.length === 1 ? '' : 's'} compared with revision ${comparison.base.revision}` : null,
            body: comparisonBody(comparison)
          })
        : null,
      card({
        title: 'Internal approval',
        subtitle: 'Approval ladder for this change request',
        flush: true,
        body: cr.approvals?.length
          ? dataTable({
              columns: [
                { key: 'level', label: 'Level', render: (row) => `${row.level}. ${row.level_name || 'Approval'}` },
                {
                  key: 'approver_name',
                  label: 'Approver',
                  render: (row) => h('div', h('div.cell-strong', row.approver_name || '—'), h('div.cell-sub', row.approver_email))
                },
                { key: 'status', label: 'Decision', render: (row) => badge(titleCase(row.status), APPROVAL_COLORS[row.status] || 'slate') },
                { key: 'requested_at', label: 'Requested', render: (row) => dateTime(row.requested_at) },
                { key: 'decided_at', label: 'Decided', render: (row) => (row.decided_at ? dateTime(row.decided_at) : h('span.muted', 'Pending')) },
                { key: 'decided_via', label: 'Channel', render: (row) => (row.decided_via ? titleCase(row.decided_via) : '—') },
                { key: 'comments', label: 'Comments', render: (row) => row.comments || '—' }
              ],
              rows: cr.approvals
            })
          : emptyState('Not submitted yet', 'The approval ladder is created when the change request is submitted.')
      }),
      card({
        title: 'Customer approval & signature',
        flush: true,
        body: cr.customer_approvals?.length
          ? dataTable({
              columns: [
                { key: 'signer_order', label: '#', render: (row) => String(row.signer_order) },
                {
                  key: 'contact_name',
                  label: 'Signatory',
                  render: (row) => h('div', h('div.cell-strong', row.contact_name || '—'), h('div.cell-sub', row.contact_email))
                },
                { key: 'status', label: 'Status', render: (row) => badge(titleCase(row.status), APPROVAL_COLORS[row.status] || 'slate') },
                { key: 'sent_at', label: 'Sent', render: (row) => dateTime(row.sent_at) },
                { key: 'viewed_at', label: 'Viewed', render: (row) => (row.viewed_at ? dateTime(row.viewed_at) : h('span.muted', 'Not viewed')) },
                { key: 'signed_at', label: 'Signed', render: (row) => (row.signed_at ? dateTime(row.signed_at) : h('span.muted', '—')) },
                { key: 'signature_name', label: 'Signature', render: (row) => row.signature_name || '—' },
                { key: 'comments', label: 'Comments', render: (row) => row.comments || '—' }
              ],
              rows: cr.customer_approvals
            })
          : emptyState('Not shared with the customer yet', 'Use "Share with customer" once the change request is internally approved.')
      }),
      card({
        title: 'e-Signature envelopes',
        flush: true,
        body: cr.envelopes?.length
          ? dataTable({
              columns: [
                { key: 'envelope_id', label: 'Envelope', render: (row) => h('span.mono.fs-12', row.envelope_id) },
                { key: 'provider', label: 'Provider', render: (row) => badge(titleCase(row.provider), 'navy') },
                { key: 'status', label: 'Status', render: (row) => badge(titleCase(row.status), APPROVAL_COLORS[row.status] || 'slate') },
                { key: 'sent_at', label: 'Sent', render: (row) => dateTime(row.sent_at) },
                { key: 'completed_at', label: 'Completed', render: (row) => (row.completed_at ? dateTime(row.completed_at) : h('span.muted', '—')) }
              ],
              rows: cr.envelopes
            })
          : emptyState('No envelope created', 'Send the change request for e-signature once it is internally approved.')
      }),
      reminders.length
        ? card({
            title: 'Reminders & escalations',
            subtitle: 'Automatic and manual follow-ups sent for this change request',
            flush: true,
            body: dataTable({
              columns: [
                { key: 'kind', label: 'Type', render: (row) => badge(row.kind === 'ESCALATION' ? 'Escalation' : 'Reminder', row.kind === 'ESCALATION' ? 'red' : 'amber') },
                { key: 'target_type', label: 'Chasing', render: (row) => (row.target_type === 'APPROVAL' ? 'Internal approver' : 'Customer') },
                { key: 'recipient', label: 'Sent to', render: (row) => h('span.fs-12', row.recipient) },
                { key: 'trigger_type', label: 'How', render: (row) => (row.trigger_type === 'MANUAL' ? `Manual · ${row.sent_by_name || ''}` : 'Automatic') },
                { key: 'sent_at', label: 'Sent', render: (row) => dateTime(row.sent_at) }
              ],
              rows: reminders
            })
          })
        : null,
      cr.share_links?.length
        ? card({
            title: 'Secure links',
            subtitle: 'Expiring, single-purpose links bound to one email address',
            flush: true,
            body: dataTable({
              columns: [
                { key: 'audience', label: 'Audience', render: (row) => badge(titleCase(row.audience), 'navy') },
                { key: 'email', label: 'Sent to' },
                { key: 'expires_at', label: 'Expires', render: (row) => dateTime(row.expires_at) },
                { key: 'click_count', label: 'Clicks', align: 'right' },
                { key: 'first_clicked_at', label: 'First opened', render: (row) => (row.first_clicked_at ? dateTime(row.first_clicked_at) : h('span.muted', 'Not opened')) },
                { key: 'revoked_at', label: 'State', render: (row) => badge(row.revoked_at ? 'Revoked' : 'Active', row.revoked_at ? 'slate' : 'green') }
              ],
              rows: cr.share_links
            })
          })
        : null
    );
  }

  async function documentsTab() {
    const versions = cr.documents || [];
    return card({
      title: 'Documents',
      subtitle: 'Every generated version is retained; approved versions are immutable.',
      actions: store.can('document.generate') && cr.is_editable
        ? h('button.btn.btn--secondary.btn--sm', { onClick: generateDocument }, icon('file', 14), 'Generate new version')
        : null,
      flush: true,
      body: versions.length
        ? dataTable({
            columns: [
              {
                key: 'version',
                label: 'Version',
                render: (row) => h('div', h('div.cell-strong', `v${row.version}`), h('div.cell-sub', row.doc_type === 'SIGNED_CR' ? 'Signed copy' : 'Change request'))
              },
              { key: 'format', label: 'Format', render: (row) => badge(row.format, row.format === 'PDF' ? 'red' : 'blue', { plain: true }) },
              { key: 'status', label: 'Status', render: (row) => badge(titleCase(row.status), APPROVAL_COLORS[row.status] || 'slate') },
              { key: 'generated_at', label: 'Generated', render: (row) => dateTime(row.generated_at) },
              { key: 'generated_by_name', label: 'Generated by', render: (row) => row.generated_by_name || 'System' },
              { key: 'file_size', label: 'Size', align: 'right', render: (row) => fileSize(row.file_size) },
              {
                key: 'sha256',
                label: 'Checksum',
                render: (row) => h('span.mono.fs-12', { title: row.sha256 }, (row.sha256 || '').slice(0, 10))
              },
              {
                key: 'actions',
                label: '',
                render: (row) =>
                  h(
                    'div.row.row--tight',
                    h(
                      'button.btn.btn--ghost.btn--sm',
                      { onClick: () => previewVersion(row) },
                      icon('eye', 14),
                      'Preview'
                    ),
                    h(
                      'button.btn.btn--secondary.btn--sm',
                      { onClick: () => api.download(`/api/documents/versions/${row.id}/download`) },
                      icon('download', 14),
                      row.format
                    )
                  )
              }
            ],
            rows: versions
          })
        : emptyState('No documents yet', 'Generate the Word and PDF change request documents.', store.can('document.generate')
            ? h('button.btn.btn--primary', { onClick: generateDocument }, icon('file', 15), 'Generate document')
            : null)
    });
  }

  async function emailsTab() {
    try {
      const data = await api.get(`/api/change-requests/${cr.id}/emails`);
      return card({
        title: 'Email history',
        subtitle: 'Delivery, open and click tracking for every message sent about this change request',
        flush: true,
        body: data.rows?.length
          ? dataTable({
              columns: [
                { key: 'template_code', label: 'Template', render: (row) => titleCase(row.template_code || 'Custom') },
                { key: 'to_email', label: 'To', render: (row) => h('div', h('div', row.to_email), row.cc_emails ? h('div.cell-sub', `cc ${row.cc_emails}`) : null) },
                { key: 'subject', label: 'Subject' },
                { key: 'status', label: 'Status', render: (row) => badge(titleCase(row.status), APPROVAL_COLORS[row.status] || 'slate') },
                { key: 'queued_at', label: 'Sent', render: (row) => dateTime(row.sent_at || row.queued_at) },
                { key: 'opened_at', label: 'Opened', render: (row) => (row.opened_at ? dateTime(row.opened_at) : h('span.muted', 'Not opened')) },
                { key: 'clicked_at', label: 'Link clicked', render: (row) => (row.clicked_at ? dateTime(row.clicked_at) : h('span.muted', '—')) },
                {
                  key: 'actions',
                  label: '',
                  render: (row) => h('button.btn.btn--ghost.btn--sm', { onClick: () => viewEmail(row.id) }, icon('eye', 14), 'View')
                }
              ],
              rows: data.rows
            })
          : emptyState('No emails yet', 'Messages appear here as the change request moves through the workflow.')
      });
    } catch (error) {
      apiError(error);
      return emptyState('Unable to load emails', error.message);
    }
  }

  async function auditTab() {
    try {
      const rows = await api.get(`/api/change-requests/${cr.id}/audit`);
      return card({
        title: 'Audit log',
        subtitle: 'Append-only: audit records cannot be edited or deleted, by anyone.',
        body: rows.length
          ? h(
              'div.feed',
              ...rows.map((row) =>
                h(
                  'div.feed__item',
                  h(`div.feed__icon.feed__icon--${auditTone(row.action)}`, icon(auditIcon(row.action), 14)),
                  h(
                    'div.feed__body',
                    h('div.feed__title', auditTitle(row)),
                    h('div.feed__meta', `${dateTime(row.created_at)} · ${row.actor_label || 'System'}${row.ip_address ? ` · ${row.ip_address}` : ''}`),
                    row.comments ? h('div.feed__diff', row.comments) : null,
                    row.field && (row.old_value || row.new_value)
                      ? h(
                          'div.feed__diff',
                          h('span.muted', `${row.field}: `),
                          row.old_value ? h('del', truncateValue(row.old_value)) : null,
                          ' ',
                          row.new_value ? h('ins', truncateValue(row.new_value)) : null
                        )
                      : null
                  )
                )
              )
            )
          : emptyState('No audit entries', 'Actions are recorded here automatically.')
      });
    } catch (error) {
      apiError(error);
      return emptyState('Unable to load the audit log', error.message);
    }
  }

  /* ------------------------------------------------------------ handlers -- */

  async function submit() {
    try {
      const readiness = await api.get(`/api/change-requests/${cr.id}/readiness`);
      if (!readiness.ok) {
        modal({
          title: 'Not ready to submit',
          body: h('div', h('p', 'Resolve these first:'), h('ul', ...readiness.problems.map((p) => h('li', p)))),
          actions: [{ label: 'Close', variant: 'primary' }]
        });
        return;
      }
      const confirmed = await confirmDialog({
        title: 'Submit for internal approval',
        message: `${cr.cr_number} will be locked and sent to ${cr.snapshot_internal_approver_email}.`,
        confirmLabel: 'Submit'
      });
      if (!confirmed) return;
      await api.post(`/api/change-requests/${cr.id}/submit`);
      notify.success('Submitted for approval. The approver has been emailed.');
      await reload();
    } catch (error) {
      apiError(error);
    }
  }

  async function decide(decision) {
    const isReject = decision === 'REJECT';
    const result = await confirmDialog({
      title: isReject ? 'Reject change request' : 'Approve change request',
      message: isReject
        ? `Rejecting ${cr.cr_number} returns it to the CR manager for revision.`
        : `Are you sure you want to approve this change request? The final document will be generated and locked.`,
      confirmLabel: isReject ? 'Reject CR' : 'Approve CR',
      variant: isReject ? 'danger' : 'success',
      requireComment: isReject,
      commentLabel: 'Please provide the reason for rejection',
      commentPlaceholder: 'Explain what needs to change…'
    });
    if (!result) return;
    try {
      await api.post(`/api/change-requests/${cr.id}/${isReject ? 'reject' : 'approve'}`, { comments: result.comments || null });
      notify.success(isReject ? 'Change request rejected. The CR manager has been notified.' : 'Change request approved.');
      await reload();
      await store.refreshUnread();
    } catch (error) {
      apiError(error);
    }
  }

  async function generateDocument() {
    try {
      const { html } = await api.get(`/api/change-requests/${cr.id}/documents/preview`);
      const formatSelect = select('format', DOCUMENT_FORMATS, 'PDF');

      modal({
        title: `Document preview — ${cr.cr_number}`,
        size: 'xl',
        subtitle: 'Word and PDF are generated from exactly this content',
        body: h(
          'div',
          h(
            'div.row.mb-2',
            h('div', { style: { minWidth: '260px' } }, field('Document format', formatSelect, { required: true })),
            h('div.muted.fs-13', { style: { flex: '1' } }, 'The generated file downloads automatically and is kept as a new version.')
          ),
          h('div.doc-preview', h('div', { html }))
        ),
        actions: [
          { label: 'Close', variant: 'secondary' },
          {
            label: 'Generate document',
            variant: 'primary',
            onClick: async () => {
              await generateAndDownload(cr.id, formatSelect.value);
              await reload();
            }
          }
        ]
      });
    } catch (error) {
      apiError(error);
    }
  }

  async function previewVersion(version) {
    try {
      const data = await api.get(`/api/documents/versions/${version.id}/preview`);
      modal({
        title: `${cr.cr_number} — version ${version.version}`,
        subtitle: `${version.format} · ${titleCase(version.status)} · generated ${dateTime(version.generated_at)}`,
        size: 'xl',
        body: h('div.doc-preview', h('div', { html: data.html })),
        actions: [
          { label: 'Close', variant: 'secondary' },
          {
            label: `Download ${version.format}`,
            variant: 'primary',
            onClick: () => api.download(`/api/documents/versions/${version.id}/download`)
          }
        ]
      });
    } catch (error) {
      apiError(error);
    }
  }

  async function shareWithCustomer() {
    try {
      const defaults = await api.get(`/api/change-requests/${cr.id}/share/defaults`);
      const hasFinal = (format) => (defaults.documents || []).some((doc) => doc.format === format);
      const form = h(
        'form',
        { onSubmit: (event) => event.preventDefault() },
        field('To', input('to', { type: 'email', value: defaults.to || '' }), { required: true, hint: 'The customer approver who will sign' }),
        field('CC', input('cc', { placeholder: 'comma separated, optional' })),
        field('Subject', input('subject', { value: defaults.subject })),
        field('Message', textarea('message', { rows: 8, value: defaults.message })),
        h('div.form-section', h('div.form-section__title', 'Attachments')),
        h(
          'div.row',
          hasFinal('PDF')
            ? switchControl('attach_pdf', true, 'Attach PDF')
            : h('span.muted.fs-13', 'No final PDF has been generated'),
          hasFinal('DOCX')
            ? switchControl('attach_docx', true, 'Attach Word document')
            : h('span.muted.fs-13', 'No final Word document has been generated')
        ),
        h(
          'div.mt-2',
          alert(
            'info',
            'A secure review link is included',
            'The customer must verify this email address with a one-time code before the change request is displayed.'
          )
        )
      );

      modal({
        title: 'Share with customer',
        subtitle: `${cr.cr_number} · ${cr.account?.account_name}`,
        size: 'lg',
        body: form,
        actions: [
          { label: 'Cancel', variant: 'secondary' },
          {
            label: 'Send',
            variant: 'primary',
            onClick: async () => {
              const data = readForm(form);
              await api.post(`/api/change-requests/${cr.id}/share`, {
                to: data.to,
                cc: (data.cc || '').split(',').map((value) => value.trim()).filter(Boolean),
                subject: data.subject,
                message: data.message,
                attach_pdf: data.attach_pdf,
                attach_docx: data.attach_docx
              });
              notify.success('Sent to the customer with the signed link.');
              await reload();
            }
          }
        ]
      });
    } catch (error) {
      apiError(error);
    }
  }

  async function sendForSignature() {
    const confirmed = await confirmDialog({
      title: 'Send via DocuSign',
      message: 'An envelope will be created with the Hyreo signatory and the customer signatory. Signature fields are mapped automatically.',
      confirmLabel: 'Create envelope'
    });
    if (!confirmed) return;
    try {
      const envelope = await api.post(`/api/change-requests/${cr.id}/docusign/send`, {});
      notify.success(`Envelope ${envelope.envelope_id} created.`);
      await reload();
    } catch (error) {
      apiError(error);
    }
  }

  async function revise() {
    const confirmed = await confirmDialog({
      title: 'Revise change request',
      message: 'The change request returns to an editable state and the revision number increases.',
      confirmLabel: 'Start revision'
    });
    if (!confirmed) return;
    try {
      await api.post(`/api/change-requests/${cr.id}/revise`);
      notify.success('Change request is editable again.');
      router.navigate(`/change-requests/${cr.id}/edit`);
    } catch (error) {
      apiError(error);
    }
  }

  async function cancel() {
    const result = await confirmDialog({
      title: 'Cancel change request',
      message: 'Cancelling is final. The change request stays on record with its audit history.',
      confirmLabel: 'Cancel CR',
      variant: 'danger',
      requireComment: true,
      commentLabel: 'Reason for cancellation'
    });
    if (!result) return;
    try {
      await api.post(`/api/change-requests/${cr.id}/cancel`, { reason: result.comments });
      notify.success('Change request cancelled.');
      await reload();
    } catch (error) {
      apiError(error);
    }
  }

  async function hold() {
    const result = await confirmDialog({
      title: 'Put on hold',
      message: 'The change request pauses until it is resumed.',
      confirmLabel: 'Put on hold',
      requireComment: true,
      commentLabel: 'Reason'
    });
    if (!result) return;
    try {
      await api.post(`/api/change-requests/${cr.id}/hold`, { reason: result.comments });
      notify.success('Change request is on hold.');
      await reload();
    } catch (error) {
      apiError(error);
    }
  }

  async function resume() {
    try {
      await api.post(`/api/change-requests/${cr.id}/resume`);
      notify.success('Change request resumed.');
      await reload();
    } catch (error) {
      apiError(error);
    }
  }

  async function remove() {
    const confirmed = await confirmDialog({
      title: 'Delete draft',
      message: `Delete ${cr.cr_number}? Only drafts can be deleted, and the action is recorded in the audit log.`,
      confirmLabel: 'Delete',
      variant: 'danger'
    });
    if (!confirmed) return;
    try {
      await api.del(`/api/change-requests/${cr.id}`);
      notify.success('Draft deleted.');
      router.navigate('/change-requests');
    } catch (error) {
      apiError(error);
    }
  }

  async function viewEmail(id) {
    try {
      const email = await api.get(`/api/emails/${id}`);
      modal({
        title: email.subject,
        subtitle: `To ${email.to_email} · ${dateTime(email.sent_at || email.queued_at)}`,
        size: 'lg',
        body: h('div', {
          style: { background: 'var(--ink-100)', padding: '12px', borderRadius: '8px', maxHeight: '60vh', overflow: 'auto' },
          html: email.body_html
        }),
        actions: [{ label: 'Close', variant: 'primary' }]
      });
    } catch (error) {
      apiError(error);
    }
  }

  draw();
}

/* ------------------------------------------------------------- helpers -- */

function renderTimeline(steps = []) {
  return h(
    'div.timeline',
    ...steps.map((step) =>
      h(
        `div.timeline__step.is-${step.state}`,
        h('div.timeline__dot', step.state === 'done' ? icon('check', 12) : step.state === 'failed' ? icon('x', 12) : ''),
        h('div.timeline__label', step.label),
        h('div.timeline__meta', step.at ? dateTime(step.at) : '—'),
        step.by ? h('div.timeline__meta', step.by) : null
      )
    )
  );
}

function auditTitle(row) {
  const map = {
    CR_CREATED: 'Change request created',
    CR_UPDATED: 'Change request updated',
    CR_SCOPE_UPDATED: 'Scope updated',
    CR_EFFORT_UPDATED: 'Effort estimate updated',
    CR_COST_UPDATED: 'Cost updated',
    CR_SUBMITTED: 'Submitted for approval',
    CR_APPROVED: 'Approved',
    CR_REJECTED: 'Rejected',
    CR_REVISED: 'Revision started',
    CR_CANCELLED: 'Cancelled',
    CR_HELD: 'Put on hold',
    CR_RESUMED: 'Resumed',
    STATUS_CHANGED: `Status changed${row.old_value ? ` from ${titleCase(row.old_value)} to ${titleCase(row.new_value)}` : ''}`,
    DOCUMENT_GENERATED: 'Document generated',
    DOCUMENT_DOWNLOADED: 'Document downloaded',
    EMAIL_SENT: 'Email sent',
    EMAIL_OPENED: 'Email opened',
    LINK_CLICKED: 'Secure link opened',
    SHARED_WITH_CUSTOMER: 'Shared with customer',
    CUSTOMER_VIEWED: 'Customer viewed the change request',
    CUSTOMER_APPROVED: 'Customer approved',
    CUSTOMER_REJECTED: 'Customer rejected',
    CUSTOMER_SIGNED: 'Customer signed',
    ENVELOPE_CREATED: 'e-Signature envelope created',
    ENVELOPE_UPDATED: 'Envelope status updated',
    ENVELOPE_COMPLETED: 'Envelope completed',
    OTP_ISSUED: 'Verification code issued',
    PORTAL_VERIFIED: 'Portal identity verified'
  };
  return map[row.action] || titleCase(row.action);
}

function auditIcon(action) {
  if (action.includes('APPROV')) return 'check';
  if (action.includes('REJECT')) return 'x';
  if (action.includes('DOCUMENT')) return 'file';
  if (action.includes('EMAIL') || action.includes('SHARED')) return 'mail';
  if (action.includes('SIGN') || action.includes('ENVELOPE')) return 'signature';
  if (action.includes('STATUS')) return 'refresh';
  if (action.includes('VIEW') || action.includes('LINK')) return 'eye';
  if (action.includes('OTP') || action.includes('PORTAL')) return 'lock';
  return 'history';
}

function auditTone(action) {
  if (action.includes('REJECT') || action.includes('CANCEL') || action.includes('DELETE')) return 'red';
  if (action.includes('APPROV') || action.includes('SIGN') || action.includes('COMPLETE')) return 'green';
  if (action.includes('EMAIL') || action.includes('VIEW') || action.includes('SHARED') || action.includes('LINK')) return 'blue';
  if (action.includes('SUBMIT') || action.includes('HOLD')) return 'amber';
  return '';
}

function truncateValue(value) {
  const text = String(value ?? '');
  return text.length > 90 ? `${text.slice(0, 89)}…` : text;
}

export default crDetailPage;
