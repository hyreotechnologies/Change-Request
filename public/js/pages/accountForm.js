import { h, render, readForm, setFieldErrors } from '../lib/dom.js';
import {
  card, field, icon, input, select, textarea, switchControl, pageHeader, loading,
  notify, apiError, alert, badge
} from '../lib/ui.js';
import { setPage } from '../components/shell.js';
import { inputDate, fileSize, date } from '../lib/format.js';
import api from '../lib/api.js';
import store from '../lib/store.js';
import router from '../lib/router.js';

const ACCEPTED = '.pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain';

/**
 * Create / edit an account.
 *
 * Creating starts from the signed MSA: upload it, let the system read what it
 * can, then review every field before anything is saved. Extraction is a
 * convenience, never the source of truth — the contract is.
 */
export async function accountFormPage({ params }) {
  const editing = Boolean(params?.id);
  let account = null;
  let users = [];

  setPage(loading(editing ? 'Loading account' : 'Preparing form'));

  try {
    [account, users] = await Promise.all([
      editing ? api.get(`/api/accounts/${params.id}`) : Promise.resolve(null),
      api.get('/api/users/pick-list').catch(() => [])
    ]);
  } catch (error) {
    apiError(error);
    router.navigate('/accounts');
    return;
  }

  if (editing) {
    renderForm({ prefill: null, upload: null });
  } else {
    renderUploadStage();
  }

  /* ------------------------------------------------------- upload stage -- */

  function renderUploadStage() {
    const fileInput = h('input', { type: 'file', accept: ACCEPTED, style: { display: 'none' } });
    const statusHost = h('div');

    const dropzone = h(
      'div.dropzone',
      { tabindex: '0', role: 'button', 'aria-label': 'Upload the signed MSA' },
      h('div.dropzone__icon', icon('file', 30)),
      h('div.dropzone__title', 'Upload the signed MSA'),
      h('div.dropzone__hint', 'PDF, Word (.docx) or plain text, up to 15 MB'),
      h('button.btn.btn--primary.mt-2', { type: 'button' }, icon('plus', 15), 'Choose file')
    );

    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        fileInput.click();
      }
    });
    for (const type of ['dragenter', 'dragover']) {
      dropzone.addEventListener(type, (event) => {
        event.preventDefault();
        dropzone.classList.add('is-active');
      });
    }
    for (const type of ['dragleave', 'drop']) {
      dropzone.addEventListener(type, (event) => {
        event.preventDefault();
        dropzone.classList.remove('is-active');
      });
    }
    dropzone.addEventListener('drop', (event) => {
      const file = event.dataTransfer?.files?.[0];
      if (file) handleFile(file);
    });
    fileInput.addEventListener('change', () => {
      if (fileInput.files?.[0]) handleFile(fileInput.files[0]);
    });

    setPage(
      pageHeader({
        breadcrumb: [h('a', { href: '/accounts' }, 'Accounts'), icon('chevronRight', 12), 'New account'],
        title: 'Create account',
        subtitle: 'Start with the signed MSA — its details populate the account, and the document stays on file.'
      }),
      h(
        'div.grid.grid--2',
        card({
          title: 'Step 1 — Upload the MSA',
          body: h('div', dropzone, fileInput, statusHost)
        }),
        card({
          title: 'What happens next',
          body: h(
            'div',
            h(
              'ol',
              { style: { margin: '0 0 14px', paddingLeft: '18px', lineHeight: '1.9' } },
              h('li', 'The MSA is stored against the account and can be opened at any time.'),
              h('li', 'Reference number, dates, parties, value and payment terms are read from it where possible.'),
              h('li', 'You review and correct every field before the account is created.')
            ),
            alert(
              'info',
              'Extraction assists, it does not decide',
              'Anything that cannot be read is simply left blank. Scanned PDFs hold images rather than text, so those need manual entry.'
            ),
            h(
              'div.mt-3',
              h(
                'button.btn.btn--secondary',
                { type: 'button', onClick: () => renderForm({ prefill: null, upload: null }) },
                'Enter details manually instead'
              )
            )
          )
        })
      )
    );

    async function handleFile(file) {
      if (file.size > 15 * 1024 * 1024) {
        notify.error('That file is larger than 15 MB.');
        return;
      }
      render(
        statusHost,
        h(
          'div.row.mt-2',
          h('span.spinner.spinner--dark'),
          h('span', `Reading ${file.name} (${fileSize(file.size)})…`)
        )
      );

      try {
        const base64 = await toBase64(file);
        const result = await api.post('/api/accounts/msa-documents', {
          fileName: file.name,
          contentType: file.type,
          base64
        });
        notify.success(
          result.found
            ? `Read ${result.found} field(s) from ${file.name}.`
            : `${file.name} stored. No details could be read — please enter them manually.`
        );
        renderForm({ prefill: result.fields, upload: result });
      } catch (error) {
        apiError(error);
        render(
          statusHost,
          h('div.mt-2', alert('danger', 'The MSA could not be processed', error.message || 'Please try a different file.'))
        );
      }
    }
  }

  /* --------------------------------------------------------- the form --- */

  function renderForm({ prefill, upload }) {
    const enums = store.enums || {};
    const msa = account?.primary_msa || null;
    const extracted = prefill || {};
    const form = h('form', { onSubmit: (event) => event.preventDefault() });
    const userNames = users.map((user) => user.name);
    const userEmails = users.map((user) => ({ value: user.email, label: `${user.name} — ${user.email}` }));

    // a field is "from the MSA" only when extraction actually produced it
    const fromMsa = (key) => (extracted[key] !== undefined && extracted[key] !== null && extracted[key] !== '' ? key : null);
    const hint = (key, fallback = null) =>
      fromMsa(key) ? `Read from the MSA${upload?.evidence?.[key] ? ` — "${truncateEvidence(upload.evidence[key])}"` : ''}` : fallback;
    const value = (key, existing = '') => extracted[key] ?? existing ?? '';

    render(
      form,
      upload ? extractionSummary(upload) : null,

      h(
        'div.grid.grid--2',
        card({
          title: 'Account details',
          body: h(
            'div',
            field('Account name', input('account_name', { value: value('account_name', account?.account_name) }), {
              required: true,
              hint: hint('account_name')
            }),
            h(
              'div.grid.grid--form',
              field(
                'Account code',
                input('account_code', {
                  value: value('account_code', account?.account_code),
                  placeholder: 'Auto-generated',
                  style: { textTransform: 'uppercase' }
                }),
                { hint: hint('account_code', 'Used in the CR number, e.g. PEERISLANDS-CR-001') }
              ),
              field('Customer type', select('customer_type', ['', ...(enums.customer_types || [])], account?.customer_type || ''))
            ),
            field(
              'Legal entity name',
              input('legal_entity_name', { value: value('legal_entity_name', account?.legal_entity_name) }),
              { required: true, hint: hint('legal_entity_name', 'Printed as the Licensee on the change request document') }
            ),
            h(
              'div.grid.grid--form',
              field('Industry', select('industry', ['', ...(enums.industries || [])], account?.industry || '')),
              field('Country', input('country', { value: value('country', account?.country) }), { hint: hint('country') })
            ),
            field('Address', textarea('address', { rows: 2, value: account?.address || '' })),
            h(
              'div.grid.grid--form',
              field('City', input('city', { value: account?.city || '' })),
              field('State', input('state', { value: account?.state || '' })),
              field('Postal code', input('postal_code', { value: account?.postal_code || '' }))
            ),
            h('div.form-section', h('div.form-section__title', 'Go-live & renewal')),
            h(
              'div.grid.grid--form',
              field('Go-live date', input('go_live_date', { type: 'date', value: inputDate(account?.go_live_date) }), {
                hint: 'When the customer went, or goes, live'
              }),
              field('Next renewal date', input('next_renewal_date', { type: 'date', value: inputDate(account?.next_renewal_date) }), {
                hint: 'Leave blank to use the MSA contract end date'
              })
            ),
            field(
              'Account status',
              select('status', [
                { value: 'ACTIVE', label: 'Active' },
                { value: 'INACTIVE', label: 'Inactive' }
              ], account?.status || 'ACTIVE')
            )
          )
        }),

        card({
          title: 'MSA details',
          subtitle: 'Master Subscription Agreement this account contracts under',
          actions: upload
            ? h(
                'button.btn.btn--secondary.btn--sm',
                { type: 'button', onClick: () => window.open(`/api/accounts/msa-documents/${upload.id}/download?inline=1`, '_blank') },
                icon('eye', 14),
                'View MSA'
              )
            : msa?.document
              ? h(
                  'button.btn.btn--secondary.btn--sm',
                  { type: 'button', onClick: () => window.open(`/api/accounts/msa-documents/${msa.document.id}/download?inline=1`, '_blank') },
                  icon('eye', 14),
                  'View MSA'
                )
              : null,
          body: h(
            'div',
            field(
              'MSA reference number',
              input('msa_reference_number', {
                value: value('msa_reference_number', msa?.msa_reference_number),
                placeholder: 'PEERISLANDS-0001'
              }),
              { required: true, hint: hint('msa_reference_number', 'Must be unique across every account') }
            ),
            h(
              'div.grid.grid--form',
              field('MSA date', input('msa_date', { type: 'date', value: value('msa_date', inputDate(msa?.msa_date)) }), {
                required: true,
                hint: hint('msa_date')
              }),
              field(
                'Contract start date',
                input('contract_start_date', { type: 'date', value: value('contract_start_date', inputDate(msa?.contract_start_date)) }),
                { required: true, hint: hint('contract_start_date') }
              ),
              field(
                'Contract end date',
                input('contract_end_date', { type: 'date', value: value('contract_end_date', inputDate(msa?.contract_end_date)) }),
                { hint: hint('contract_end_date') }
              )
            ),
            h(
              'div.grid.grid--form',
              field(
                'Contract value',
                input('contract_value', { type: 'number', step: '0.01', min: '0', value: value('contract_value', msa?.contract_value ?? '') }),
                { hint: hint('contract_value') }
              ),
              field(
                'Currency',
                select(
                  'currency',
                  (enums.currencies || [{ code: 'INR' }]).map((c) => ({ value: c.code, label: `${c.code} — ${c.label || c.code}` })),
                  value('currency', msa?.currency || store.currency)
                ),
                { hint: hint('currency') }
              )
            ),
            field(
              'Billing entity',
              input('billing_entity', { value: value('billing_entity', msa?.billing_entity || store.settings?.company?.legal_name) }),
              { hint: hint('billing_entity') }
            ),
            h(
              'div.grid.grid--form',
              field(
                'Payment terms',
                input('payment_terms', { value: value('payment_terms', msa?.payment_terms || store.settings?.defaults?.payment_terms) }),
                { hint: hint('payment_terms') }
              ),
              field(
                'MSA status',
                select('msa_status', (enums.msa_statuses || ['ACTIVE']).map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() })), msa?.status || 'ACTIVE')
              )
            ),
            h(
              'div.field',
              switchControl(
                'po_required',
                extracted.po_required ?? (msa ? msa.po_required : store.settings?.defaults?.po_required),
                'Purchase order required before delivery'
              ),
              fromMsa('po_required') ? h('span.field__hint', hint('po_required')) : null
            )
          )
        })
      ),

      h(
        'div.grid.grid--2.mt-2',
        card({
          title: 'Customer contacts',
          body: h(
            'div',
            h('div.form-section__title', 'Primary contact'),
            h(
              'div.grid.grid--form',
              field('Name', input('primary_name', { value: account?.primary_contact?.name || '' })),
              field('Designation', input('primary_designation', { value: account?.primary_contact?.designation || '' }))
            ),
            h(
              'div.grid.grid--form',
              field('Email', emailField('primary_email', account?.primary_contact?.email || '', upload)),
              field('Phone', input('primary_phone', { value: account?.primary_contact?.phone || '' }))
            ),
            h('div.form-section', h('div.form-section__title', 'Approval contact')),
            alert('info', 'This contact signs the change request', 'Change request documents are emailed to this address for review and electronic signature.'),
            h(
              'div.grid.grid--form.mt-2',
              field('Customer approver name', input('approver_name', { value: account?.approval_contact?.name || '' })),
              field('Designation', input('approver_designation', { value: account?.approval_contact?.designation || '' }))
            ),
            field('Customer approver email', emailField('approver_email', account?.approval_contact?.email || '', upload))
          )
        }),

        card({
          title: 'Internal ownership',
          subtitle: 'Who runs this account inside Hyreo',
          body: h(
            'div',
            h(
              'div.grid.grid--form',
              field('Account manager', input('account_manager', { value: account?.account_manager || '', list: 'user-names' })),
              field('CR manager', input('cr_manager', { value: account?.cr_manager || '', list: 'user-names' }))
            ),
            field('Delivery manager', input('delivery_manager', { value: account?.delivery_manager || '', list: 'user-names' })),
            h('datalist#user-names', ...userNames.map((name) => h('option', { value: name }))),
            h('div.form-section', h('div.form-section__title', 'Internal approver')),
            h(
              'div.grid.grid--form',
              field('Internal approver name', input('internal_approver_name', { value: account?.internal_approver_name || '', list: 'user-names' })),
              field(
                'Internal approver email',
                select(
                  'internal_approver_email',
                  [{ value: '', label: 'Select an approver…' }, ...userEmails],
                  account?.internal_approver_email || ''
                ),
                { required: true, hint: 'Change requests for this account are routed here for approval' }
              )
            ),
            field('Additional notes', textarea('notes', { rows: 4, value: account?.notes || '' }))
          )
        })
      ),

      h(
        'div.card.mt-2',
        h(
          'div.card__body.row',
          h('div.muted', editing ? 'Changes are audited field by field.' : 'A unique account id is generated on save.'),
          h('div.spacer'),
          !editing && upload
            ? h('button.btn.btn--ghost', { type: 'button', onClick: () => renderUploadStage() }, icon('chevronLeft', 15), 'Upload a different MSA')
            : null,
          h('button.btn.btn--secondary', { type: 'button', onClick: () => history.back() }, 'Cancel'),
          h(
            'button.btn.btn--primary',
            {
              type: 'submit',
              onClick: async (event) => {
                const button = event.currentTarget;
                button.disabled = true;
                try {
                  const saved = await submit(upload);
                  notify.success(editing ? 'Account updated.' : `Account ${saved.account_code} created.`);
                  router.navigate(`/accounts/${saved.id}`);
                } catch (error) {
                  if (error?.details) setFieldErrors(form, mapErrors(error.details));
                  apiError(error);
                  button.disabled = false;
                }
              }
            },
            icon('check', 15),
            editing ? 'Save changes' : 'Create account'
          )
        )
      )
    );

    setPage(
      pageHeader({
        breadcrumb: [
          h('a', { href: '/accounts' }, 'Accounts'),
          icon('chevronRight', 12),
          editing ? account.account_name : 'New account'
        ],
        title: editing ? `Edit ${account.account_name}` : 'Create account',
        subtitle: editing
          ? 'Update customer, contract and ownership details.'
          : upload
            ? 'Review what was read from the MSA, correct anything that is wrong, then create the account.'
            : 'Register the customer, its MSA and the contacts who approve change requests.'
      }),
      form
    );

    async function submit(uploadInfo) {
      const data = readForm(form);
      const payload = {
        msa_document_id: uploadInfo?.id || undefined,
        account: {
          account_name: data.account_name,
          account_code: data.account_code || undefined,
          legal_entity_name: data.legal_entity_name,
          customer_type: data.customer_type,
          industry: data.industry,
          country: data.country,
          address: data.address,
          city: data.city,
          state: data.state,
          postal_code: data.postal_code,
          status: data.status,
          account_manager: data.account_manager,
          cr_manager: data.cr_manager,
          delivery_manager: data.delivery_manager,
          internal_approver_name: data.internal_approver_name,
          internal_approver_email: data.internal_approver_email,
          go_live_date: data.go_live_date,
          next_renewal_date: data.next_renewal_date,
          notes: data.notes
        },
        msa: {
          id: msa?.id,
          msa_reference_number: data.msa_reference_number,
          msa_date: data.msa_date,
          contract_start_date: data.contract_start_date,
          contract_end_date: data.contract_end_date,
          contract_value: data.contract_value,
          currency: data.currency,
          billing_entity: data.billing_entity,
          payment_terms: data.payment_terms,
          po_required: data.po_required,
          status: data.msa_status
        },
        primary_contact: {
          name: data.primary_name,
          designation: data.primary_designation,
          email: data.primary_email,
          phone: data.primary_phone
        },
        approval_contact: {
          name: data.approver_name,
          designation: data.approver_designation,
          email: data.approver_email
        }
      };

      return editing ? api.patch(`/api/accounts/${params.id}`, payload) : api.post('/api/accounts', payload);
    }
  }
}

/** Summary of what the upload produced, with the document one click away. */
function extractionSummary(upload) {
  const keys = Object.keys(upload.fields || {});
  const tone = upload.found >= 6 ? 'success' : upload.found > 0 ? 'info' : 'warning';

  return h(
    'div.mb-2',
    card({
      title: upload.file_name,
      subtitle: `${upload.document_kind === 'DOCX' ? 'Word document' : upload.document_kind} · ${fileSize(upload.file_size)} · stored with the account`,
      actions: h(
        'div.row.row--tight',
        badge(
          upload.found ? `${upload.found} field(s) read` : 'Nothing could be read',
          upload.found >= 6 ? 'green' : upload.found ? 'amber' : 'red'
        ),
        h(
          'button.btn.btn--secondary.btn--sm',
          { type: 'button', onClick: () => window.open(`/api/accounts/msa-documents/${upload.id}/download?inline=1`, '_blank') },
          icon('eye', 14),
          'View MSA'
        )
      ),
      body: h(
        'div',
        upload.warnings?.length
          ? h('div.mb-2', ...upload.warnings.map((warning) => alert('warning', 'Could not read the document text', warning)))
          : null,
        keys.length
          ? h(
              'div',
              alert(tone, 'Check every value before saving', 'These were read from the contract automatically. Correct anything that is wrong — nothing is saved until you create the account.'),
              h(
                'div.row.row--tight.mt-2',
                ...keys.map((key) =>
                  h(
                    'span.chip',
                    { title: upload.evidence?.[key] ? `Found in: “${upload.evidence[key]}”` : undefined },
                    icon('check', 12),
                    `${labelFor(key)}: ${formatValue(key, upload.fields[key])}`
                  )
                )
              )
            )
          : alert('warning', 'No details could be read', 'Enter the account and MSA details manually. The document is still stored against the account.')
      )
    })
  );
}

function emailField(name, existing, upload) {
  const control = input(name, { type: 'email', value: existing, list: upload?.emails?.length ? 'msa-emails' : undefined });
  if (!upload?.emails?.length) return control;
  return h('div', control, h('datalist#msa-emails', ...upload.emails.map((address) => h('option', { value: address }))));
}

const LABELS = {
  account_name: 'Account',
  account_code: 'Code',
  legal_entity_name: 'Legal entity',
  msa_reference_number: 'MSA reference',
  msa_date: 'MSA date',
  contract_start_date: 'Start',
  contract_end_date: 'End',
  contract_value: 'Value',
  currency: 'Currency',
  billing_entity: 'Billing entity',
  payment_terms: 'Payment terms',
  po_required: 'PO required',
  country: 'Country'
};

function labelFor(key) {
  return LABELS[key] || key.replace(/_/g, ' ');
}

function formatValue(key, value) {
  if (value === true) return 'Yes';
  if (/date$/.test(key)) return date(value);
  const text = String(value);
  return text.length > 34 ? `${text.slice(0, 33)}…` : text;
}

function truncateEvidence(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > 90 ? `${clean.slice(0, 89)}…` : clean;
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('The file could not be read'));
    reader.readAsDataURL(file);
  });
}

/** Map server field names back onto the flattened form control names. */
function mapErrors(details) {
  const map = { status: 'status', 'msa.status': 'msa_status' };
  return details.map((detail) => ({ ...detail, field: map[detail.field] || detail.field }));
}

export default accountFormPage;
