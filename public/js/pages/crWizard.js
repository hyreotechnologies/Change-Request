import { h, render, readForm, debounce, setFieldErrors } from '../lib/dom.js';
import {
  card, field, icon, input, select, textarea, switchControl, pageHeader, loading,
  notify, apiError, alert, modal, confirmDialog, definitionList, emptyState
} from '../lib/ui.js';
import { setPage } from '../components/shell.js';
import { statusBadge } from '../components/table.js';
import { DOCUMENT_FORMATS, generateAndDownload } from '../components/documentActions.js';
import { date, inputDate, money, number, hours, titleCase } from '../lib/format.js';
import api from '../lib/api.js';
import store from '../lib/store.js';
import router from '../lib/router.js';

const STEPS = [
  { key: 'account', label: 'Account & MSA' },
  { key: 'header', label: 'CR details' },
  { key: 'scope', label: 'Scope' },
  { key: 'effort', label: 'Effort' },
  { key: 'cost', label: 'Cost' },
  { key: 'terms', label: 'Timeline & terms' },
  { key: 'review', label: 'Review & submit' }
];

/** Create / edit a change request through the seven-step wizard. */
export async function crWizardPage({ params, query }) {
  const editing = Boolean(params?.id);
  const state = {
    step: editing ? 1 : 0,
    crId: params?.id || null,
    cr: null,
    accounts: [],
    selectedAccount: null,
    items: [],
    dirty: false
  };

  // Step-local bindings are declared up front because draw() can render any step
  // immediately — edit mode opens on "CR details" — and a `let` declared further
  // down would still be in its temporal dead zone when that renderer runs.
  let headerForm = null;
  let effortForm = null;
  let costForm = null;
  let termsForm = null;
  let assumptions = [];
  let dependencies = [];

  setPage(loading(editing ? 'Loading change request' : 'Preparing change request'));

  try {
    state.accounts = await api.get('/api/accounts/lookup');
    if (editing) {
      state.cr = await api.get(`/api/change-requests/${params.id}`);
      if (!state.cr.is_editable) {
        notify.warning('This change request can no longer be edited.');
        router.navigate(`/change-requests/${params.id}`);
        return;
      }
      state.selectedAccount = state.cr.account;
      state.items = state.cr.items.map((item) => ({ ...item }));
    } else if (query?.account) {
      state.selectedAccount = state.accounts.find((a) => a.id === query.account) || null;
    }
  } catch (error) {
    apiError(error);
    router.navigate('/change-requests');
    return;
  }

  const bodyHost = h('div');
  const stepperHost = h('div.card.mb-3', h('div.card__body', h('div.stepper')));

  function draw() {
    render(
      stepperHost,
      h(
        'div.card__body',
        h(
          'div.stepper',
          ...STEPS.map((step, index) =>
            h(
              `button.stepper__step${index === state.step ? '.is-active' : ''}${index < state.step ? '.is-complete' : ''}`,
              {
                disabled: !state.crId && index > 0,
                onClick: async () => {
                  if (index === state.step) return;
                  if (index > state.step && !(await saveCurrentStep())) return;
                  if (index < state.step) await saveCurrentStep({ silent: true });
                  state.step = index;
                  draw();
                }
              },
              h('span.stepper__num', index < state.step ? icon('check', 12) : String(index + 1)),
              step.label
            )
          )
        )
      )
    );

    const renderers = [renderAccountStep, renderHeaderStep, renderScopeStep, renderEffortStep, renderCostStep, renderTermsStep, renderReviewStep];
    try {
      render(bodyHost, renderers[state.step]());
    } catch (error) {
      // never leave the user staring at an empty wizard
      console.error('Wizard step failed to render', error);
      render(
        bodyHost,
        card({
          title: 'This step could not be displayed',
          body: h(
            'div',
            alert('danger', 'Something went wrong rendering this step', error.message),
            h(
              'div.row.mt-2',
              h('button.btn.btn--secondary', { onClick: () => draw() }, icon('refresh', 15), 'Try again'),
              state.crId
                ? h(
                    'button.btn.btn--primary',
                    { onClick: () => router.navigate(`/change-requests/${state.crId}`) },
                    'Open the change request'
                  )
                : null
            )
          )
        })
      );
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  setPage(
    pageHeader({
      breadcrumb: [
        h('a', { href: '/change-requests' }, 'Change Requests'),
        icon('chevronRight', 12),
        editing ? state.cr.cr_number : 'New change request'
      ],
      title: editing ? `Edit ${state.cr.cr_number}` : 'Create change request',
      subtitle: editing
        ? state.cr.title
        : 'Select the account first — MSA, customer and approver details populate automatically.',
      actions: state.crId
        ? h('button.btn.btn--secondary', { onClick: () => router.navigate(`/change-requests/${state.crId}`) }, 'Open CR')
        : null
    }),
    stepperHost,
    bodyHost
  );

  draw();

  /* ------------------------------------------------------------- step 1 -- */

  function renderAccountStep() {
    const listHost = h('div');
    const searchInput = h('input.input', { type: 'search', placeholder: 'Search by account name, code or MSA number…' });
    searchInput.addEventListener(
      'input',
      debounce(async () => {
        state.accounts = await api.get(`/api/accounts/lookup?q=${encodeURIComponent(searchInput.value.trim())}`);
        renderAccountList();
      }, 240)
    );

    function renderAccountList() {
      render(
        listHost,
        state.accounts.length
          ? h(
              'div.stack',
              ...state.accounts.map((account) =>
                h(
                  'div.card',
                  {
                    style: {
                      cursor: 'pointer',
                      borderColor: state.selectedAccount?.id === account.id ? 'var(--accent)' : undefined,
                      boxShadow: state.selectedAccount?.id === account.id ? '0 0 0 3px var(--accent-soft)' : undefined
                    },
                    onClick: () => {
                      state.selectedAccount = account;
                      draw();
                    }
                  },
                  h(
                    'div.card__body.row',
                    h('span.avatar', (account.account_name || '?').slice(0, 1)),
                    h(
                      'div',
                      h('div.cell-strong', account.account_name),
                      h('div.cell-sub', `${account.account_code} · ${account.legal_entity_name || ''}`)
                    ),
                    h('div.spacer'),
                    account.msa_reference_number
                      ? h(
                          'div.text-right',
                          h('div.mono.fs-13', account.msa_reference_number),
                          h('div.cell-sub', `MSA dated ${date(account.msa_date)}`)
                        )
                      : h('span.badge.badge--amber', 'No MSA'),
                    state.selectedAccount?.id === account.id ? icon('check', 18) : null
                  )
                )
              )
            )
          : emptyState('No accounts found', 'Create the account and its MSA first.', h(
              'button.btn.btn--primary',
              { onClick: () => router.navigate('/accounts/new') },
              icon('plus', 15),
              'Create account'
            ))
      );
    }

    renderAccountList();

    return h(
      'div.stack',
      card({
        title: 'Step 1 — Select account',
        subtitle: 'A change request always belongs to an account and its MSA.',
        actions: searchInput,
        body: listHost
      }),
      state.selectedAccount ? autoPopulatedCard() : null,
      h(
        'div.card',
        h(
          'div.card__body.row',
          h(
            'div',
            h('div.muted', state.selectedAccount ? 'These details are copied onto the change request and locked to it.' : 'Select an account to continue.'),
            msaExpiryNote(state.selectedAccount)
          ),
          h('div.spacer'),
          h(
            'button.btn.btn--primary',
            {
              disabled: !state.selectedAccount,
              onClick: async () => {
                if (!state.selectedAccount) return;
                if (!state.selectedAccount.msa_id) {
                  notify.error('This account has no MSA. Add an MSA before creating a change request.');
                  return;
                }
                state.step = 1;
                draw();
              }
            },
            'Continue',
            icon('chevronRight', 15)
          )
        )
      )
    );
  }

  /** Flag an MSA that has ended or is about to, before a CR is raised against it. */
  function msaExpiryNote(account) {
    if (!account?.contract_end_date) return null;
    const daysLeft = Math.ceil((new Date(`${account.contract_end_date}T23:59:59Z`).getTime() - Date.now()) / 86_400_000);
    const window = Number(store.settings?.renewals?.warning_days ?? 90);
    if (daysLeft < 0) {
      return h('div.cell-sub', { style: { color: 'var(--red-700)', fontWeight: '600' } }, `The MSA ended on ${date(account.contract_end_date)}. Confirm the renewal before raising this change request.`);
    }
    if (daysLeft <= window) {
      return h('div.cell-sub', { style: { color: 'var(--amber-700)', fontWeight: '600' } }, `The MSA ends on ${date(account.contract_end_date)} (${daysLeft} day${daysLeft === 1 ? '' : 's'} left).`);
    }
    return null;
  }

  function autoPopulatedCard() {
    const account = state.selectedAccount;
    const detail = state.cr;
    return card({
      title: 'Auto-populated from the account',
      subtitle: 'Read-only — edit the account record to change any of these values.',
      body: definitionList([
        ['Account name', account.account_name],
        ['Legal entity', account.legal_entity_name || detail?.snapshot_legal_entity],
        ['MSA number', h('span.mono', account.msa_reference_number || detail?.snapshot_msa_number || '')],
        ['MSA date', date(account.msa_date || detail?.snapshot_msa_date)],
        ['Contract start', date(account.contract_start_date || detail?.snapshot_contract_start)],
        ['Contract end', date(account.contract_end_date || detail?.snapshot_contract_end)],
        ['Customer approver', detail?.snapshot_customer_approver || account.approver_name],
        ['Customer approver email', detail?.snapshot_customer_approver_email || account.approver_email],
        ['Account manager', detail?.snapshot_account_manager || account.account_manager],
        ['Internal CR manager', detail?.snapshot_cr_manager || account.cr_manager],
        ['Internal approver', detail?.snapshot_internal_approver || account.internal_approver_name],
        ['Internal approver email', detail?.snapshot_internal_approver_email || account.internal_approver_email]
      ])
    });
  }

  /* ------------------------------------------------------------- step 2 -- */

  function renderHeaderStep() {
    const cr = state.cr;
    const enums = store.enums || {};
    headerForm = h('form', { onSubmit: (e) => e.preventDefault() });

    const numberHost = h('div.row', h('span.skeleton', { style: { width: '160px', height: '20px' } }));
    if (cr) {
      render(numberHost, h('span.badge.badge--navy.badge--plain.mono', cr.cr_number), h('span.cell-sub', cr.cr_reference));
    } else {
      api
        .get(`/api/accounts/${state.selectedAccount.id}/next-cr-number`)
        .then((preview) =>
          render(
            numberHost,
            h('span.badge.badge--navy.badge--plain.mono', preview.cr_number),
            h('span.cell-sub', `Contract reference ${preview.cr_reference}`)
          )
        )
        .catch(() => render(numberHost, h('span.muted', 'Allocated on save')));
    }

    render(
      headerForm,
      h(
        'div.grid.grid--2',
        card({
          title: 'Step 2 — Change request details',
          body: h(
            'div',
            field('CR number', numberHost, { hint: 'Generated automatically and unique per account' }),
            field('CR title', input('title', { value: cr?.title || '', placeholder: 'Interview invite email enhancements' }), { required: true }),
            h(
              'div.grid.grid--form',
              field('CR created date', input('cr_date', { type: 'date', value: inputDate(cr?.cr_date) || new Date().toISOString().slice(0, 10) })),
              field('CR effective date', input('effective_date', { type: 'date', value: inputDate(cr?.effective_date) }))
            ),
            h(
              'div.grid.grid--form',
              field(
                'CR type',
                select('cr_type', (enums.cr_types || []).map((t) => ({ value: t.code, label: t.label })), cr?.cr_type || 'ENHANCEMENT')
              ),
              field(
                'Priority',
                select('priority', (enums.priorities || []).map((p) => ({ value: p.code, label: p.label })), cr?.priority || 'MEDIUM')
              )
            ),
            field('Requested by', input('requested_by', { value: cr?.requested_by || '', placeholder: 'Customer stakeholder who raised it' })),
            h(
              'div.grid.grid--form',
              field('Customer contact', input('customer_contact_name', { value: cr?.customer_contact_name || '' })),
              field('Customer contact email', input('customer_contact_email', { type: 'email', value: cr?.customer_contact_email || '' }))
            ),
            field('Background / description', textarea('description', { rows: 4, value: cr?.description || '' }))
          )
        }),
        autoPopulatedCard()
      ),
      navButtons()
    );

    return headerForm;
  }

  /* ------------------------------------------------------------- step 3 -- */

  function renderScopeStep() {
    const listHost = h('div');

    function drawItems() {
      render(
        listHost,
        state.items.length
          ? h('div', ...state.items.map((item, index) => itemCard(item, index)))
          : emptyState('No scope items yet', 'Add at least one change item — these become the scope table in the CR document.')
      );
    }

    function itemCard(item, index) {
      const update = (key) => (event) => {
        item[key] = event.target.value;
        state.dirty = true;
      };
      return h(
        'div.repeater__item',
        h(
          'div.repeater__head',
          h('div.repeater__num', String(index + 1)),
          h('div.repeater__title', item.feature_name || 'New change item'),
          h(
            'div.repeater__tools',
            h(
              'button.btn.btn--ghost.btn--sm.btn--icon',
              {
                title: 'Move up',
                disabled: index === 0,
                onClick: () => {
                  [state.items[index - 1], state.items[index]] = [state.items[index], state.items[index - 1]];
                  drawItems();
                }
              },
              '↑'
            ),
            h(
              'button.btn.btn--ghost.btn--sm.btn--icon',
              {
                title: 'Move down',
                disabled: index === state.items.length - 1,
                onClick: () => {
                  [state.items[index + 1], state.items[index]] = [state.items[index], state.items[index + 1]];
                  drawItems();
                }
              },
              '↓'
            ),
            h(
              'button.btn.btn--ghost.btn--sm.btn--icon',
              {
                title: 'Delete item',
                onClick: async () => {
                  const confirmed = await confirmDialog({
                    title: 'Delete change item',
                    message: `Remove "${item.feature_name || 'this item'}" from the scope?`,
                    confirmLabel: 'Delete',
                    variant: 'danger'
                  });
                  if (!confirmed) return;
                  state.items.splice(index, 1);
                  drawItems();
                }
              },
              icon('trash', 14)
            )
          )
        ),
        h(
          'div.repeater__body',
          field('Feature name', h('input.input', { value: item.feature_name || '', placeholder: 'Candidate Resume Addition', onInput: (e) => { item.feature_name = e.target.value; } }), { required: true }),
          field(
            'Requested change',
            h('textarea.textarea', { rows: 2, value: item.requested_change || '', placeholder: 'Attaching the candidate resume in the interview invite email shared with the panellists.', onInput: update('requested_change') })
          ),
          field('Detailed description', h('textarea.textarea', { rows: 3, value: item.detailed_description || '', onInput: update('detailed_description') })),
          h(
            'div.grid.grid--2',
            field('Current behaviour', h('textarea.textarea', { rows: 2, value: item.current_behaviour || '', onInput: update('current_behaviour') })),
            field('Expected behaviour', h('textarea.textarea', { rows: 2, value: item.expected_behaviour || '', onInput: update('expected_behaviour') }))
          ),
          field('Business justification', h('textarea.textarea', { rows: 2, value: item.business_justification || '', onInput: update('business_justification') })),
          h(
            'div.grid.grid--form',
            field('Release date', h('input.input', { type: 'date', value: inputDate(item.release_date), onInput: update('release_date') })),
            field('Remarks', h('input.input', { value: item.remarks || '', onInput: update('remarks') }))
          )
        )
      );
    }

    drawItems();

    return h(
      'div',
      card({
        title: 'Step 3 — Change request scope',
        subtitle: 'Each item becomes a numbered row in the change request document.',
        actions: h(
          'button.btn.btn--secondary.btn--sm',
          {
            onClick: () => {
              state.items.push({ feature_name: '', requested_change: '', release_date: '' });
              drawItems();
            }
          },
          icon('plus', 14),
          'Add another change item'
        ),
        body: h(
          'div',
          listHost,
          h(
            'button.btn.btn--secondary.mt-2',
            {
              onClick: () => {
                state.items.push({ feature_name: '', requested_change: '', release_date: '' });
                drawItems();
              }
            },
            icon('plus', 15),
            'Add change item'
          )
        )
      }),
      navButtons()
    );
  }

  /* ------------------------------------------------------------- step 4 -- */

  function renderEffortStep() {
    const categories = store.enums?.effort_categories || [];
    const existing = Object.fromEntries((state.cr?.efforts || []).map((e) => [e.category, e.hours]));
    const totalHost = h('div.totals__value', '0 h');
    effortForm = h('form', { onSubmit: (e) => e.preventDefault() });

    const recalc = () => {
      const data = readForm(effortForm);
      const total = categories.reduce((sum, category) => sum + (Number(data[category.category]) || 0), 0);
      render(totalHost, `${number(total, total % 1 ? 1 : 0)} h`);
      const rate = Number(state.cr?.costs?.billing_rate || store.settings?.defaults?.billing_rate || 0);
      render(estimateHost, money(total * rate, state.cr?.costs?.currency || store.currency));
    };
    const estimateHost = h('div.totals__value');

    render(
      effortForm,
      h(
        'div.grid.grid--2',
        card({
          title: 'Step 4 — Change cost evaluation & effort estimation',
          subtitle: 'All values in person hours.',
          body: h(
            'div',
            ...categories.map((category) =>
              field(
                category.label,
                h(
                  'div.input-group',
                  h('span.input-group__addon', 'Hours'),
                  h('input.input', {
                    type: 'number',
                    name: category.category,
                    min: '0',
                    step: '0.5',
                    value: existing[category.category] ?? 0,
                    onInput: recalc
                  })
                )
              )
            )
          )
        }),
        card({
          title: 'Calculated totals',
          body: h(
            'div.totals',
            h('div.totals__row', h('span.totals__label', 'Total effort'), totalHost),
            h('div.totals__row', h('span.totals__label', 'Indicative cost at current rate'), estimateHost),
            h(
              'div.mt-2',
              alert(
                'info',
                'Total effort is derived',
                'Total effort = development + testing + business analysis + project management + deployment + other. Cost is recalculated on the server whenever effort changes.'
              )
            )
          )
        })
      ),
      navButtons()
    );

    recalc();
    return effortForm;
  }

  /* ------------------------------------------------------------- step 5 -- */

  function renderCostStep() {
    const costs = state.cr?.costs || {};
    const totalEffort = Number(state.cr?.total_effort || 0);
    const currencies = (store.enums?.currencies || [{ code: 'INR' }]).map((c) => ({ value: c.code, label: c.code }));
    costForm = h('form', { onSubmit: (e) => e.preventDefault() });

    const preview = h('div.totals');

    const recalc = () => {
      const data = readForm(costForm);
      const rate = Number(data.billing_rate) || 0;
      const currency = data.currency || store.currency;
      const subtotal = totalEffort * rate;
      const discount =
        data.discount_type === 'PERCENT'
          ? (subtotal * Math.min(Number(data.discount_value) || 0, 100)) / 100
          : data.discount_type === 'FIXED'
            ? Math.min(Number(data.discount_value) || 0, subtotal)
            : 0;
      const net = subtotal - discount;
      const tax = (net * (Number(data.tax_percent) || 0)) / 100;

      render(
        preview,
        h('div.totals__row', h('span.totals__label', 'Total effort'), h('span.totals__value', hours(totalEffort))),
        h('div.totals__row', h('span.totals__label', 'Billing rate'), h('span.totals__value', money(rate, currency))),
        h('div.totals__row.totals__row--divider', h('span.totals__label', 'Subtotal'), h('span.totals__value', money(subtotal, currency))),
        h('div.totals__row', h('span.totals__label', 'Discount'), h('span.totals__value', `- ${money(discount, currency)}`)),
        h('div.totals__row', h('span.totals__label', `Tax (${Number(data.tax_percent) || 0}%)`), h('span.totals__value', money(tax, currency))),
        h('div.totals__row.totals__row--grand', h('span', 'Total CR cost'), h('span', money(net + tax, currency)))
      );
    };

    render(
      costForm,
      h(
        'div.grid.grid--2',
        card({
          title: 'Step 5 — Cost calculation',
          body: h(
            'div',
            h(
              'div.grid.grid--form',
              field('Billing rate (per hour)', h('input.input', {
                type: 'number', name: 'billing_rate', min: '0', step: '0.01',
                value: costs.billing_rate ?? store.settings?.defaults?.billing_rate ?? 0,
                onInput: recalc
              }), { required: true }),
              field('Currency', select('currency', currencies, costs.currency || store.currency, { onChange: recalc }))
            ),
            h('div.form-section', h('div.form-section__title', 'Discount')),
            h(
              'div.grid.grid--form',
              field(
                'Discount type',
                select('discount_type', [
                  { value: 'NONE', label: 'No discount' },
                  { value: 'PERCENT', label: 'Percentage' },
                  { value: 'FIXED', label: 'Fixed amount' }
                ], costs.discount_type || 'NONE', { onChange: recalc })
              ),
              field('Discount value', h('input.input', { type: 'number', name: 'discount_value', min: '0', step: '0.01', value: costs.discount_value ?? 0, onInput: recalc }))
            ),
            h('div.form-section', h('div.form-section__title', 'Tax')),
            field('Tax percentage', h('input.input', { type: 'number', name: 'tax_percent', min: '0', max: '100', step: '0.01', value: costs.tax_percent ?? store.settings?.defaults?.tax_percent ?? 0, onInput: recalc }))
          )
        }),
        card({ title: 'Cost summary', subtitle: 'Recalculated on the server when saved', body: preview })
      ),
      navButtons()
    );

    recalc();
    return costForm;
  }

  /* ------------------------------------------------------------- step 6 -- */

  function renderTermsStep() {
    const cr = state.cr || {};
    assumptions = (cr.assumptions || []).map((a) => a.text);
    dependencies = (cr.dependencies || []).map((d) => ({ ...d }));
    termsForm = h('form', { onSubmit: (e) => e.preventDefault() });

    const assumptionHost = h('div');
    const dependencyHost = h('div');

    function drawAssumptions() {
      render(
        assumptionHost,
        ...assumptions.map((text, index) =>
          h(
            'div.row.row--tight.mb-1',
            h('input.input', { value: text, placeholder: 'Assumption', onInput: (e) => { assumptions[index] = e.target.value; } }),
            h('button.btn.btn--ghost.btn--sm.btn--icon', { onClick: () => { assumptions.splice(index, 1); drawAssumptions(); } }, icon('trash', 14))
          )
        ),
        h('button.btn.btn--secondary.btn--sm', { onClick: () => { assumptions.push(''); drawAssumptions(); } }, icon('plus', 14), 'Add assumption')
      );
    }

    function drawDependencies() {
      const types = store.enums?.dependency_types || [];
      render(
        dependencyHost,
        ...dependencies.map((entry, index) =>
          h(
            'div.row.row--tight.mb-1',
            select('', types.map((t) => ({ value: t.code, label: t.label })), entry.dependency_type || 'INTERNAL', {
              style: { maxWidth: '190px' },
              onChange: (e) => { entry.dependency_type = e.target.value; }
            }),
            h('input.input', { value: entry.text || '', placeholder: 'Dependency or risk', onInput: (e) => { entry.text = e.target.value; } }),
            h('button.btn.btn--ghost.btn--sm.btn--icon', { onClick: () => { dependencies.splice(index, 1); drawDependencies(); } }, icon('trash', 14))
          )
        ),
        h('button.btn.btn--secondary.btn--sm', { onClick: () => { dependencies.push({ dependency_type: 'INTERNAL', text: '' }); drawDependencies(); } }, icon('plus', 14), 'Add dependency')
      );
    }

    drawAssumptions();
    drawDependencies();

    render(
      termsForm,
      h(
        'div.grid.grid--2',
        card({
          title: 'Step 6 — Timeline',
          body: h(
            'div',
            h(
              'div.grid.grid--form',
              field('Development start', input('dev_start_date', { type: 'date', value: inputDate(cr.dev_start_date) })),
              field('Development completion', input('dev_completion_date', { type: 'date', value: inputDate(cr.dev_completion_date) }))
            ),
            h(
              'div.grid.grid--form',
              field('Testing start', input('test_start_date', { type: 'date', value: inputDate(cr.test_start_date) })),
              field('Testing completion', input('test_completion_date', { type: 'date', value: inputDate(cr.test_completion_date) }))
            ),
            h(
              'div.grid.grid--form',
              field('Target release date', input('target_release_date', { type: 'date', value: inputDate(cr.target_release_date) })),
              field('Planned production release', input('planned_production_release', { type: 'date', value: inputDate(cr.planned_production_release) }))
            ),
            h(
              'div.grid.grid--form',
              field('Estimated business days', input('estimated_business_days', { type: 'number', min: '0', step: '0.5', value: cr.estimated_business_days ?? '' })),
              field('PO required date', input('po_required_date', { type: 'date', value: inputDate(cr.po_required_date) }))
            ),
            field('Estimated timeline wording', input('estimated_timeline', { value: cr.estimated_timeline || store.settings?.defaults?.estimated_timeline || '' }), {
              hint: 'Printed in the Timelines section of the document'
            }),
            h('div.field', switchControl('depends_on_po', cr.depends_on_po, 'Delivery depends on purchase order release'))
          )
        }),
        card({
          title: 'Commercial terms',
          body: h(
            'div',
            field('Payment terms', input('payment_terms', { value: cr.payment_terms || store.settings?.defaults?.payment_terms || '' })),
            h(
              'div.grid.grid--form',
              field('PO number', input('po_number', { value: cr.po_number || '' })),
              h('div.field', h('label.field__label', 'PO required'), switchControl('po_required', cr.po_required, 'Purchase order required'))
            ),
            field('Invoice terms', textarea('invoice_terms', { rows: 2, value: cr.invoice_terms || store.settings?.defaults?.invoice_terms || '' })),
            field('General terms', textarea('general_terms', { rows: 4, value: cr.general_terms || (store.settings?.terms?.general_terms || []).join('\n') }), {
              hint: 'One term per line — Admin can change the defaults in Settings'
            })
          )
        })
      ),
      h(
        'div.grid.grid--2.mt-2',
        card({ title: 'Assumptions', subtitle: 'Printed under Assumptions and Dependencies', body: assumptionHost }),
        card({ title: 'Dependencies & risks', subtitle: 'Customer, internal, third-party or risk entries', body: dependencyHost })
      ),
      navButtons()
    );

    return termsForm;
  }

  /* ------------------------------------------------------------- step 7 -- */

  function renderReviewStep() {
    const cr = state.cr;
    const currency = cr.costs?.currency || store.currency;

    return h(
      'div.stack',
      card({
        title: 'Step 7 — Review',
        subtitle: 'Check the summary, then save as draft or submit for internal approval.',
        actions: statusBadge(cr.status),
        body: definitionList([
          ['CR number', h('span.mono', cr.cr_number)],
          ['CR reference', h('span.mono', cr.cr_reference)],
          ['Account', cr.account?.account_name],
          ['MSA', cr.snapshot_msa_number],
          ['CR title', cr.title],
          ['CR type', titleCase(cr.cr_type)],
          ['Priority', titleCase(cr.priority)],
          ['CR date', date(cr.cr_date)],
          ['Target release', date(cr.target_release_date)],
          ['Scope items', String(cr.items?.length || 0)],
          ['Total effort', hours(cr.total_effort)],
          ['Total CR cost', money(cr.costs?.total_cost, currency)],
          ['Internal approver', cr.snapshot_internal_approver_email],
          ['Customer approver', cr.snapshot_customer_approver_email]
        ])
      }),

      cr.items?.length
        ? card({
            title: 'Scope',
            flush: true,
            body: h(
              'div.table-wrap',
              h(
                'table.data',
                h('thead', h('tr', h('th', 'Item'), h('th', 'Feature'), h('th', 'Requested change'), h('th', 'Release date'))),
                h(
                  'tbody',
                  ...cr.items.map((item) =>
                    h(
                      'tr',
                      h('td', String(item.item_no)),
                      h('td.cell-strong', item.feature_name),
                      h('td', item.requested_change || '—'),
                      h('td.nowrap', date(item.release_date))
                    )
                  )
                )
              )
            )
          })
        : alert('warning', 'No scope items', 'A change request cannot be submitted without at least one scope item.'),

      h(
        'div.grid.grid--2',
        card({
          title: 'Effort',
          body: h(
            'div.totals',
            ...(cr.efforts || []).map((effort) =>
              h('div.totals__row', h('span.totals__label', effort.label), h('span.totals__value', hours(effort.hours)))
            ),
            h('div.totals__row.totals__row--grand', h('span', 'Total effort'), h('span', hours(cr.total_effort)))
          )
        }),
        card({
          title: 'Cost',
          body: h(
            'div.totals',
            h('div.totals__row', h('span.totals__label', 'Billing rate'), h('span.totals__value', money(cr.costs?.billing_rate, currency))),
            h('div.totals__row', h('span.totals__label', 'Subtotal'), h('span.totals__value', money(cr.costs?.subtotal, currency))),
            h('div.totals__row', h('span.totals__label', 'Discount'), h('span.totals__value', `- ${money(cr.costs?.discount_amount, currency)}`)),
            h('div.totals__row', h('span.totals__label', 'Tax'), h('span.totals__value', money(cr.costs?.tax_amount, currency))),
            h('div.totals__row.totals__row--grand', h('span', 'Total CR cost'), h('span', money(cr.costs?.total_cost, currency)))
          )
        })
      ),

      h(
        'div.card',
        h(
          'div.card__body.row',
          h('button.btn.btn--secondary', { onClick: () => { state.step = 5; draw(); } }, icon('chevronLeft', 15), 'Back'),
          h('div.spacer'),
          h('button.btn.btn--secondary', { onClick: previewDocument }, icon('eye', 15), 'Generate preview'),
          h(
            'button.btn.btn--secondary',
            {
              onClick: () => {
                notify.success('Saved as draft.');
                router.navigate(`/change-requests/${state.crId}`);
              }
            },
            'Save draft'
          ),
          h('button.btn.btn--primary', { onClick: submitForApproval }, icon('send', 15), 'Submit for approval')
        )
      )
    );
  }

  async function previewDocument() {
    try {
      const { html } = await api.get(`/api/change-requests/${state.crId}/documents/preview`);
      const formatSelect = select('format', DOCUMENT_FORMATS, 'PDF');

      modal({
        title: `Document preview — ${state.cr.cr_number}`,
        subtitle: 'Exactly what the Word and PDF documents contain',
        size: 'xl',
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
          {
            label: 'Generate document',
            variant: 'secondary',
            onClick: async () => {
              await generateAndDownload(state.crId, formatSelect.value);
              await reload();
            }
          },
          { label: 'Close', variant: 'primary' }
        ]
      });
    } catch (error) {
      apiError(error);
    }
  }

  async function submitForApproval() {
    try {
      const readiness = await api.get(`/api/change-requests/${state.crId}/readiness`);
      if (!readiness.ok) {
        modal({
          title: 'Not ready to submit',
          body: h(
            'div',
            h('p', 'Please resolve the following before submitting:'),
            h('ul', ...readiness.problems.map((problem) => h('li', problem)))
          ),
          actions: [{ label: 'Close', variant: 'primary' }]
        });
        return;
      }

      const confirmed = await confirmDialog({
        title: 'Submit for internal approval',
        message: `${state.cr.cr_number} will be locked for editing and sent to ${state.cr.snapshot_internal_approver_email} for approval.`,
        confirmLabel: 'Submit for approval',
        variant: 'primary'
      });
      if (!confirmed) return;

      await api.post(`/api/change-requests/${state.crId}/submit`);
      notify.success('Submitted. The internal approver has been notified by email.');
      router.navigate(`/change-requests/${state.crId}`);
    } catch (error) {
      apiError(error);
    }
  }

  /* ------------------------------------------------------------- saving -- */

  function navButtons() {
    return h(
      'div.card.mt-2',
      h(
        'div.card__body.row',
        h(
          'button.btn.btn--secondary',
          {
            onClick: async () => {
              await saveCurrentStep({ silent: true });
              state.step = Math.max(0, state.step - 1);
              draw();
            }
          },
          icon('chevronLeft', 15),
          'Back'
        ),
        h('div.spacer'),
        state.crId
          ? h(
              'button.btn.btn--ghost',
              {
                onClick: async () => {
                  if (await saveCurrentStep()) notify.success('Draft saved.');
                }
              },
              'Save draft'
            )
          : null,
        h(
          'button.btn.btn--primary',
          {
            onClick: async (event) => {
              const button = event.currentTarget;
              button.disabled = true;
              const okay = await saveCurrentStep();
              button.disabled = false;
              if (!okay) return;
              state.step = Math.min(STEPS.length - 1, state.step + 1);
              draw();
            }
          },
          'Save & continue',
          icon('chevronRight', 15)
        )
      )
    );
  }

  async function reload() {
    state.cr = await api.get(`/api/change-requests/${state.crId}`);
    state.items = state.cr.items.map((item) => ({ ...item }));
    return state.cr;
  }

  async function saveCurrentStep({ silent = false } = {}) {
    try {
      const stepKey = STEPS[state.step].key;

      if (stepKey === 'header') {
        const data = readForm(headerForm);
        if (!data.title) {
          setFieldErrors(headerForm, [{ field: 'title', message: 'CR title is required' }]);
          return false;
        }
        if (!state.crId) {
          const created = await api.post('/api/change-requests', { account_id: state.selectedAccount.id, ...data });
          state.crId = created.id;
          state.cr = created;
          history.replaceState({}, '', `/change-requests/${created.id}/edit`);
          if (!silent) notify.success(`${created.cr_number} created as a draft.`);
        } else {
          await api.patch(`/api/change-requests/${state.crId}`, data);
        }
        await reload();
        return true;
      }

      if (!state.crId) return true;

      if (stepKey === 'scope') {
        const cleaned = state.items.filter((item) => (item.feature_name || '').trim());
        if (cleaned.length !== state.items.length) state.items = cleaned;
        await api.put(`/api/change-requests/${state.crId}/items`, { items: state.items });
        await reload();
        return true;
      }

      if (stepKey === 'effort') {
        const data = readForm(effortForm);
        const efforts = (store.enums?.effort_categories || []).map((category) => ({
          category: category.category,
          hours: Number(data[category.category]) || 0
        }));
        await api.put(`/api/change-requests/${state.crId}/efforts`, { efforts });
        await reload();
        return true;
      }

      if (stepKey === 'cost') {
        const data = readForm(costForm);
        await api.put(`/api/change-requests/${state.crId}/costs`, {
          billing_rate: Number(data.billing_rate) || 0,
          currency: data.currency,
          discount_type: data.discount_type,
          discount_value: Number(data.discount_value) || 0,
          tax_percent: Number(data.tax_percent) || 0
        });
        await reload();
        return true;
      }

      if (stepKey === 'terms') {
        const data = readForm(termsForm);
        await api.patch(`/api/change-requests/${state.crId}`, data);
        await api.put(`/api/change-requests/${state.crId}/assumptions`, {
          assumptions: assumptions.filter((text) => text && text.trim())
        });
        await api.put(`/api/change-requests/${state.crId}/dependencies`, {
          dependencies: dependencies.filter((entry) => entry.text && entry.text.trim())
        });
        await reload();
        return true;
      }

      return true;
    } catch (error) {
      apiError(error);
      return false;
    }
  }
}

export default crWizardPage;
