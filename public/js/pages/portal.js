import { h, render } from '../lib/dom.js';
import { HYREO_LOGO_URL } from '../lib/brand.js';
import { card, field, icon, input, textarea, notify, apiError, alert, definitionList, badge, loading, confirmDialog, modal } from '../lib/ui.js';
import { date, dateTime, money, hours, titleCase } from '../lib/format.js';
import api from '../lib/api.js';

/**
 * External portal for internal approvers and customer signatories.
 * Security: the link is bound to one change request and one email address, and
 * nothing is shown until a one-time code sent to that address is verified.
 */
export async function portalPage(root, { params }) {
  const token = params.token;
  render(root, h('div.portal', portalBar(), h('div.portal__body', loading('Opening change request'))));

  let context;
  try {
    context = await api.get(`/api/portal/${token}`, { allowUnauthorised: true });
  } catch (error) {
    render(
      root,
      h(
        'div.portal',
        portalBar(),
        h(
          'div.portal__body',
          h('div.portal__gate', card({
            title: 'This link cannot be opened',
            body: h('div', alert('danger', error.message || 'The link is not valid', 'Please ask your Hyreo contact to send a new link.'))
          }))
        )
      )
    );
    return;
  }

  const bodyHost = h('div.portal__body');
  render(root, h('div.portal', portalBar(context), bodyHost));

  // an existing portal session short-circuits the OTP gate
  try {
    const view = await api.get(`/api/portal/${token}/cr`, { allowUnauthorised: true });
    renderChangeRequest(view);
  } catch {
    renderGate();
  }

  function portalBar(ctx = null) {
    return h(
      'header.portal__bar',
      h('div.brand', h('img.brand__logo', { src: HYREO_LOGO_URL, alt: ctx?.company_name || 'Hyreo' }), h('div.sidebar__subtitle', 'Account Management')),
      ctx
        ? h(
            'div',
            { style: { marginLeft: 'auto', textAlign: 'right' } },
            h('div', { style: { fontWeight: '600' } }, ctx.cr_number),
            h('div', { style: { fontSize: '12px', opacity: '0.75' } }, ctx.account_name)
          )
        : null
    );
  }

  /* ------------------------------------------------------------ OTP gate */

  function renderGate() {
    const emailInput = h('input.input', { type: 'email', placeholder: 'your.name@company.com', autofocus: true });
    const sendButton = h('button.btn.btn--primary.btn--lg.btn--block', 'Send verification code');

    render(
      bodyHost,
      h(
        'div.portal__gate',
        card({
          title:
            context.audience === 'CUSTOMER'
              ? 'Review & sign change request'
              : 'Review change request',
          subtitle: `${context.cr_number} · ${context.account_name}`,
          body: h(
            'div',
            h('p.muted', `For your security, confirm the email address this change request was sent to. We will send a one-time code to ${context.masked_email}.`),
            field('Email address', emailInput, { required: true }),
            sendButton,
            h(
              'div.mt-2',
              alert('info', 'Why this step?', 'The change request is only shown to the named recipient. The link alone does not grant access.')
            )
          )
        })
      )
    );

    sendButton.addEventListener('click', async () => {
      const email = emailInput.value.trim();
      if (!email) {
        emailInput.classList.add('is-invalid');
        return;
      }
      sendButton.disabled = true;
      render(sendButton, h('span.spinner'), 'Sending…');
      try {
        await api.post(`/api/portal/${token}/otp/request`, { email }, { allowUnauthorised: true });
        notify.success('Verification code sent.');
        renderOtp(email);
      } catch (error) {
        apiError(error);
        sendButton.disabled = false;
        render(sendButton, 'Send verification code');
      }
    });
  }

  function renderOtp(email) {
    const boxes = Array.from({ length: 6 }, () => h('input', { type: 'text', inputmode: 'numeric', maxlength: '1' }));
    const verifyButton = h('button.btn.btn--primary.btn--lg.btn--block', 'Verify & open change request');

    boxes.forEach((box, index) => {
      box.addEventListener('input', () => {
        box.value = box.value.replace(/\D/g, '').slice(0, 1);
        if (box.value && index < 5) boxes[index + 1].focus();
      });
      box.addEventListener('keydown', (event) => {
        if (event.key === 'Backspace' && !box.value && index > 0) boxes[index - 1].focus();
      });
      box.addEventListener('paste', (event) => {
        const text = (event.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
        if (!text) return;
        event.preventDefault();
        text.split('').forEach((digit, offset) => {
          if (boxes[offset]) boxes[offset].value = digit;
        });
      });
    });

    render(
      bodyHost,
      h(
        'div.portal__gate',
        card({
          title: 'Enter your verification code',
          subtitle: `Sent to ${email}`,
          body: h(
            'div',
            h('div.otp-inputs', ...boxes),
            h('div.mt-2', verifyButton),
            h(
              'button.btn.btn--ghost.btn--block.mt-1',
              {
                onClick: async () => {
                  try {
                    await api.post(`/api/portal/${token}/otp/request`, { email }, { allowUnauthorised: true });
                    notify.success('A new code has been sent.');
                  } catch (error) {
                    apiError(error);
                  }
                }
              },
              'Resend code'
            )
          )
        })
      )
    );

    boxes[0].focus();

    verifyButton.addEventListener('click', async () => {
      const code = boxes.map((box) => box.value).join('');
      if (code.length !== 6) {
        notify.warning('Enter all six digits.');
        return;
      }
      verifyButton.disabled = true;
      render(verifyButton, h('span.spinner'), 'Verifying…');
      try {
        await api.post(`/api/portal/${token}/otp/verify`, { email, code }, { allowUnauthorised: true });
        const view = await api.get(`/api/portal/${token}/cr`);
        renderChangeRequest(view);
      } catch (error) {
        apiError(error);
        boxes.forEach((box) => {
          box.value = '';
        });
        boxes[0].focus();
        verifyButton.disabled = false;
        render(verifyButton, 'Verify & open change request');
      }
    });

  }

  /* ------------------------------------------------------- change request */

  function renderChangeRequest(view) {
    const cr = view.cr;
    const currency = cr.costs?.currency || 'INR';
    const decision = view.decision;
    const isCustomer = view.audience === 'CUSTOMER';

    render(
      bodyHost,
      h(
        'div.stack',
        h(
          'div.card',
          h(
            'div.card__body',
            h(
              'div.row',
              h('div', h('h1', cr.cr_number), h('div.page__subtitle', cr.title)),
              h('div.spacer'),
              badge(cr.status_label, decision.status === 'APPROVED' ? 'green' : decision.status === 'REJECTED' ? 'red' : 'blue')
            )
          )
        ),

        decisionBanner(decision, cr),

        card({
          title: 'Change request summary',
          body: definitionList([
            ['Change request number', h('span.mono', cr.cr_number)],
            ['Contract reference', h('span.mono', cr.cr_reference)],
            ['Customer', cr.legal_entity || cr.account_name],
            ['MSA reference', h('span.mono', cr.msa_number)],
            ['MSA date', date(cr.msa_date)],
            ['CR date', date(cr.cr_date)],
            ['Type', titleCase(cr.cr_type)],
            ['Priority', titleCase(cr.priority)],
            ['Target release date', date(cr.target_release_date)],
            ['Total effort', hours(cr.total_effort)],
            ['Total CR cost', h('span.strong', money(cr.costs?.total_cost, currency))]
          ])
        }),

        card({
          title: 'Scope',
          flush: true,
          body: h(
            'div.table-wrap',
            h(
              'table.data',
              h('thead', h('tr', h('th', 'Item'), h('th', 'Feature'), h('th', 'Requested change'), h('th', 'Release date'))),
              h(
                'tbody',
                ...(cr.items || []).map((item) =>
                  h(
                    'tr',
                    h('td', String(item.item_no)),
                    h('td.cell-strong', item.feature_name),
                    h('td', h('div', item.requested_change || ''), item.detailed_description ? h('div.cell-sub', item.detailed_description) : null),
                    h('td.nowrap', date(item.release_date))
                  )
                )
              )
            )
          )
        }),

        h(
          'div.grid.grid--2',
          card({
            title: 'Effort estimate',
            body: h(
              'div.totals',
              ...(cr.efforts || []).filter((e) => Number(e.hours) > 0).map((effort) =>
                h('div.totals__row', h('span.totals__label', effort.label), h('span.totals__value', hours(effort.hours)))
              ),
              h('div.totals__row.totals__row--grand', h('span', 'Total effort'), h('span', hours(cr.total_effort)))
            )
          }),
          card({
            title: 'Cost',
            body: h(
              'div.totals',
              h('div.totals__row', h('span.totals__label', 'Billing rate'), h('span.totals__value', `${money(cr.costs?.billing_rate, currency)} / hour`)),
              h('div.totals__row', h('span.totals__label', 'Subtotal'), h('span.totals__value', money(cr.costs?.subtotal, currency))),
              h('div.totals__row', h('span.totals__label', 'Discount'), h('span.totals__value', `- ${money(cr.costs?.discount_amount, currency)}`)),
              h('div.totals__row', h('span.totals__label', 'Tax'), h('span.totals__value', money(cr.costs?.tax_amount, currency))),
              h('div.totals__row.totals__row--grand', h('span', 'Total CR cost'), h('span', money(cr.costs?.total_cost, currency)))
            )
          })
        ),

        h(
          'div.grid.grid--2',
          card({
            title: 'Timeline',
            body: definitionList([
              ['Estimated timeline', cr.estimated_timeline],
              ['Estimated business days', cr.estimated_business_days ? `${cr.estimated_business_days} days` : null],
              ['Target release date', date(cr.target_release_date)],
              ['Payment terms', cr.payment_terms],
              ['PO required', cr.po_required ? 'Yes' : 'No']
            ])
          }),
          card({
            title: 'Assumptions & dependencies',
            body: h(
              'div',
              (cr.assumptions || []).length
                ? h('ul', { style: { margin: '0 0 10px', paddingLeft: '18px' } }, ...cr.assumptions.map((a) => h('li', a.text)))
                : h('div.muted', 'Nil'),
              (cr.dependencies || []).length
                ? h('ul', { style: { margin: 0, paddingLeft: '18px' } }, ...cr.dependencies.map((d) => h('li', `${titleCase(d.dependency_type)}: ${d.text}`)))
                : null
            )
          })
        ),

        cr.general_terms
          ? card({
              title: 'General terms',
              body: h('ul', { style: { margin: 0, paddingLeft: '18px' } }, ...String(cr.general_terms).split('\n').filter(Boolean).map((term) => h('li', term)))
            })
          : null,

        card({
          title: 'Change request document',
          subtitle: 'The document below is what will be signed',
          actions: h(
            'div.row.row--tight',
            ...(view.documents || []).map((doc) =>
              h(
                'button.btn.btn--secondary.btn--sm',
                { onClick: () => api.download(`/api/portal/${token}/documents/${doc.id}`) },
                icon('download', 14),
                `${doc.format} v${doc.version}`
              )
            )
          ),
          body: h('div.doc-preview', h('div', { html: view.document_html }))
        }),

        decision.can_decide ? actionBar(isCustomer) : null
      )
    );

    function actionBar(customer) {
      return h(
        'div.card',
        h(
          'div.portal__actions',
          h('div.muted', { style: { marginRight: 'auto' } }, customer ? 'Your decision is recorded with a timestamp, your IP address and the verified email address.' : 'Your decision is recorded against the approval ladder.'),
          h('button.btn.btn--danger', { onClick: reject }, icon('x', 15), customer ? 'Reject' : 'Reject CR'),
          customer
            ? h('button.btn.btn--success', { onClick: signDialog }, icon('signature', 15), 'Approve & Sign')
            : h('button.btn.btn--success', { onClick: approve }, icon('check', 15), 'Approve CR')
        )
      );
    }

    async function approve() {
      const confirmed = await confirmDialog({
        title: 'Approve change request',
        message: 'Are you sure you want to approve this Change Request?',
        confirmLabel: 'Yes, approve',
        variant: 'success'
      });
      if (!confirmed) return;
      try {
        await api.post(`/api/portal/${token}/approve`, {});
        showReceipt('Change request approved', 'Thank you. The Hyreo team has been notified and the final document has been generated.');
      } catch (error) {
        apiError(error);
      }
    }

    async function reject() {
      const result = await confirmDialog({
        title: 'Reject change request',
        message: 'Please provide the reason for rejection. It is sent to the Hyreo change request manager.',
        confirmLabel: 'Reject change request',
        variant: 'danger',
        requireComment: true,
        commentLabel: 'Reason for rejection',
        commentPlaceholder: 'What needs to change?'
      });
      if (!result) return;
      try {
        await api.post(`/api/portal/${token}/reject`, { comments: result.comments });
        showReceipt('Change request rejected', 'Your comments have been sent to the Hyreo change request manager.');
      } catch (error) {
        apiError(error);
      }
    }

    function signDialog() {
      const nameInput = input('signature_name', { value: cr.customer_approver || '', placeholder: 'Type your full legal name' });
      const designationInput = input('designation', { value: cr.customer_approver_designation || '' });
      const commentsInput = textarea('comments', { rows: 2, placeholder: 'Optional note' });
      const preview = h('div.signature-preview', cr.customer_approver || '');
      const consent = h('input', { type: 'checkbox' });

      nameInput.addEventListener('input', () => render(preview, nameInput.value));

      modal({
        title: 'Approve & sign change request',
        subtitle: `${cr.cr_number} · ${money(cr.costs?.total_cost, currency)}`,
        size: 'lg',
        body: h(
          'div',
          alert('info', 'Electronic signature', 'Typing your name below and confirming constitutes your electronic signature on this change request.'),
          h(
            'div.mt-2',
            field('Full legal name', nameInput, { required: true }),
            field('Designation', designationInput),
            h('div.signature-pad', h('div.field__label', 'Signature preview'), preview),
            h('div.mt-2', field('Comments', commentsInput)),
            h(
              'label.checkbox.mt-2',
              consent,
              h(
                'span',
                'I confirm that I am authorised to sign on behalf of ',
                h('strong', cr.legal_entity || cr.account_name),
                ', and that I agree to the scope, effort, timeline and cost set out in this change request.'
              )
            )
          )
        ),
        actions: [
          { label: 'Cancel', variant: 'secondary' },
          {
            label: 'Approve & sign',
            variant: 'success',
            onClick: async () => {
              if (!nameInput.value.trim() || nameInput.value.trim().length < 2) {
                nameInput.classList.add('is-invalid');
                notify.warning('Please type your full name.');
                return false;
              }
              if (!consent.checked) {
                notify.warning('Please confirm the declaration before signing.');
                return false;
              }
              try {
                await api.post(`/api/portal/${token}/sign`, {
                  signature_name: nameInput.value.trim(),
                  designation: designationInput.value.trim(),
                  comments: commentsInput.value.trim(),
                  consent: true
                });
                showReceipt(
                  'Change request signed',
                  'Thank you. A signed copy has been stored and the Hyreo team has been notified. You can download the signed document below.'
                );
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
  }

  function decisionBanner(decision, cr) {
    if (decision.status === 'APPROVED') {
      return alert('success', 'You approved this change request', decision.decided_at ? `Recorded on ${dateTime(decision.decided_at)}` : '');
    }
    if (decision.status === 'REJECTED') {
      return alert('danger', 'You rejected this change request', decision.comments || '');
    }
    if (!decision.can_decide) {
      return alert('info', 'This change request is read-only', `Current status: ${cr.status_label}`);
    }
    return null;
  }

  async function showReceipt(title, message) {
    let view = null;
    try {
      view = await api.get(`/api/portal/${token}/cr`);
    } catch {
      /* the decision is recorded even if the refresh fails */
    }
    render(
      bodyHost,
      h(
        'div.portal__gate',
        card({
          title,
          body: h(
            'div',
            h('div.empty__icon', { style: { fontSize: '34px' } }, icon('check', 34)),
            h('p', message),
            view?.documents?.length
              ? h(
                  'div.row.row--tight.mt-2',
                  ...view.documents
                    .filter((doc) => doc.status === 'SIGNED' || doc.status === 'FINAL')
                    .map((doc) =>
                      h(
                        'button.btn.btn--secondary',
                        { onClick: () => api.download(`/api/portal/${token}/documents/${doc.id}`) },
                        icon('download', 15),
                        `Download ${doc.status === 'SIGNED' ? 'signed ' : ''}${doc.format}`
                      )
                    )
                )
              : null,
            h('div.mt-3.muted.fs-13', 'You may close this window.')
          )
        })
      )
    );
  }
}

export default portalPage;
