import { h, render, readForm } from '../lib/dom.js';
import {
  card, field, icon, input, select, textarea, switchControl, pageHeader, loading,
  notify, apiError, alert, tabs, badge, modal, confirmDialog, emptyState, formModal, definitionList
} from '../lib/ui.js';
import { dataTable } from '../components/table.js';
import { setPage } from '../components/shell.js';
import { dateTime, titleCase } from '../lib/format.js';
import api from '../lib/api.js';
import store from '../lib/store.js';
import router from '../lib/router.js';

const TABS = [
  { key: 'company', label: 'Company' },
  { key: 'defaults', label: 'Defaults' },
  { key: 'numbering', label: 'CR numbering' },
  { key: 'terms', label: 'Standard terms' },
  { key: 'email', label: 'Email' },
  { key: 'security', label: 'OTP & security' },
  { key: 'workflow', label: 'Reminders & time limits' },
  { key: 'integrations', label: 'Slack & Teams' },
  { key: 'docusign', label: 'DocuSign' },
  { key: 'templates', label: 'Email templates' },
  { key: 'approvals', label: 'Approval levels' },
  { key: 'users', label: 'Users' },
  { key: 'roles', label: 'Roles' }
];

const CATEGORY_FOR_TAB = {
  company: 'COMPANY',
  defaults: 'DEFAULTS',
  numbering: 'NUMBERING',
  terms: 'TERMS',
  email: 'EMAIL',
  security: 'SECURITY',
  workflow: 'WORKFLOW',
  integrations: 'INTEGRATIONS'
};

export async function settingsPage({ params }) {
  let active = params?.tab && TABS.some((tab) => tab.key === params.tab) ? params.tab : 'company';
  const bodyHost = h('div.mt-2');

  function draw() {
    setPage(
      pageHeader({
        title: 'Settings',
        subtitle: 'Company profile, commercial defaults, workflow configuration, integrations and access control.'
      }),
      tabs(TABS, active, (key) => {
        active = key;
        history.replaceState({}, '', `/settings/${key}`);
        draw();
      }),
      bodyHost
    );

    render(bodyHost, loading());
    const renderers = {
      templates: templatesTab,
      approvals: approvalLevelsTab,
      users: usersTab,
      roles: rolesTab,
      docusign: docusignTab,
      workflow: workflowTab,
      integrations: integrationsTab
    };
    const renderer = renderers[active] || (() => settingsGroupTab(CATEGORY_FOR_TAB[active]));
    Promise.resolve(renderer()).then((node) => render(bodyHost, node));
  }

  draw();

  /* ------------------------------------------------- generic settings tab */

  async function settingsGroupTab(category) {
    const all = await api.get('/api/settings');
    const rows = all.filter((row) => row.category === category);
    const form = h('form', { onSubmit: (event) => event.preventDefault() });

    render(
      form,
      h(
        'div.grid.grid--2',
        ...rows.map((row) =>
          field(
            row.label || row.key,
            controlFor(row),
            { hint: row.description }
          )
        )
      ),
      h(
        'div.row.mt-2',
        h('div.muted', 'Changes are audited and take effect immediately.'),
        h('div.spacer'),
        h(
          'button.btn.btn--primary',
          {
            onClick: async (event) => {
              const button = event.currentTarget;
              button.disabled = true;
              try {
                const data = readForm(form);
                const values = {};
                for (const row of rows) {
                  let value = data[row.key];
                  if (row.value_type === 'JSON') value = String(value || '').split('\n').map((line) => line.trim()).filter(Boolean);
                  if (row.is_secret && (value === '********' || value === null)) continue;
                  // a blank secret keeps the stored one unless "Clear" was pressed
                  if (row.is_secret && !value && form.querySelector(`[name="${row.key}"]`)?.dataset.clear !== '1') continue;
                  values[row.key] = value;
                }
                await api.put('/api/settings', { values });
                await store.refreshSettings();
                notify.success('Settings saved.');
              } catch (error) {
                apiError(error);
              } finally {
                button.disabled = false;
              }
            }
          },
          icon('check', 15),
          'Save settings'
        )
      )
    );

    return card({ title: TABS.find((t) => t.key === active)?.label, body: form });
  }

  async function workflowTab() {
    return h(
      'div.stack',
      await settingsGroupTab('WORKFLOW'),
      card({
        title: 'Run reminders now',
        subtitle: 'The server checks every 15 minutes. Run a pass now to apply changed settings straight away.',
        body: h(
          'div.row',
          h('div.muted', 'Only sends what is due: nobody is reminded twice inside the repeat window or escalated twice.'),
          h('div.spacer'),
          h(
            'button.btn.btn--secondary',
            {
              onClick: async (event) => {
                const button = event.currentTarget;
                button.disabled = true;
                try {
                  const result = await api.post('/api/reminders/run');
                  if (result.skipped) notify.warning('Automatic reminders are switched off.');
                  else notify.success(`Sent ${result.reminders} reminder(s) and ${result.escalations} escalation(s).`);
                } catch (error) {
                  apiError(error);
                } finally {
                  button.disabled = false;
                }
              }
            },
            icon('send', 15),
            'Run reminders now'
          )
        )
      })
    );
  }

  async function integrationsTab() {
    return h(
      'div.stack',
      card({
        body: h(
          'div',
          h('p', 'Approval requests, internal decisions, customer signatures and rejections, and escalations are posted to the channels below.'),
          h(
            'ol.muted',
            { style: { margin: 0, paddingLeft: '18px' } },
            h('li', 'Slack: create an app with Incoming Webhooks enabled, add it to the channel and paste the webhook URL.'),
            h('li', 'Teams: add an Incoming Webhook connector (or a Workflows webhook) to the channel and paste its URL.')
          )
        )
      }),
      await settingsGroupTab('INTEGRATIONS'),
      card({
        title: 'Send a test message',
        subtitle: 'Save the webhook first, then check it arrives.',
        body: h(
          'div.row',
          h('div.spacer'),
          h(
            'button.btn.btn--secondary',
            {
              onClick: async (event) => {
                const button = event.currentTarget;
                button.disabled = true;
                try {
                  const results = await api.post('/api/integrations/chat/test');
                  for (const [channel, result] of Object.entries(results)) {
                    const name = channel === 'slack' ? 'Slack' : 'Teams';
                    if (result.ok) notify.success(`${name}: test message delivered.`);
                    else notify.error(`${name}: ${result.error}`);
                  }
                } catch (error) {
                  apiError(error);
                } finally {
                  button.disabled = false;
                }
              }
            },
            icon('send', 15),
            'Send test message'
          )
        )
      })
    );
  }

  function controlFor(row) {
    if (row.value_type === 'BOOLEAN') return switchControl(row.key, row.value, row.value ? 'Enabled' : 'Disabled');
    if (row.value_type === 'NUMBER') return input(row.key, { type: 'number', step: 'any', value: row.value ?? 0 });
    if (row.value_type === 'JSON') {
      return textarea(row.key, { rows: 4, value: Array.isArray(row.value) ? row.value.join('\n') : JSON.stringify(row.value ?? '') });
    }
    if (row.is_secret) {
      const control = input(row.key, { type: 'password', value: '', autocomplete: 'off', placeholder: row.is_configured ? 'Configured — leave blank to keep' : 'Not configured' });
      if (!row.is_configured) return control;
      return h(
        'div.row.row--tight',
        control,
        h(
          'button.btn.btn--ghost.btn--sm',
          {
            type: 'button',
            onClick: (event) => {
              control.value = '';
              control.dataset.clear = '1';
              control.placeholder = 'Will be removed when you save';
              event.currentTarget.disabled = true;
            }
          },
          'Clear'
        )
      );
    }
    if (row.key === 'email.transport') {
      return select(row.key, [
        { value: 'capture', label: 'Capture — store in the outbox (no external delivery)' },
        { value: 'smtp', label: 'SMTP — deliver through a mail server' }
      ], row.value);
    }
    if (String(row.value || '').length > 90) return textarea(row.key, { rows: 3, value: row.value ?? '' });
    return input(row.key, { value: row.value ?? '' });
  }

  /* ---------------------------------------------------------- templates -- */

  async function templatesTab() {
    const templates = await api.get('/api/settings/email-templates');
    return card({
      title: 'Email templates',
      subtitle: 'Edit the subject and body of any workflow email. Variables use {{mustache}} syntax.',
      flush: true,
      body: dataTable({
        columns: [
          { key: 'name', label: 'Template', render: (row) => h('div', h('div.cell-strong', row.name), h('div.cell-sub', row.description)) },
          { key: 'code', label: 'Code', render: (row) => h('span.mono.fs-12', row.code) },
          { key: 'subject', label: 'Subject' },
          { key: 'is_active', label: 'Active', render: (row) => badge(row.is_active ? 'Active' : 'Disabled', row.is_active ? 'green' : 'slate') },
          { key: 'updated_at', label: 'Updated', render: (row) => dateTime(row.updated_at) },
          {
            key: 'actions',
            label: '',
            render: (row) => h('button.btn.btn--secondary.btn--sm', { onClick: () => editTemplate(row) }, icon('edit', 14), 'Edit')
          }
        ],
        rows: templates
      })
    });
  }

  async function editTemplate(template) {
    const subjectInput = input('subject', { value: template.subject });
    const bodyInput = textarea('body_html', { rows: 16, value: template.body_html, style: { fontFamily: 'var(--mono)', fontSize: '12.5px' } });

    modal({
      title: template.name,
      subtitle: template.description,
      size: 'xl',
      body: h(
        'div',
        field('Subject', subjectInput),
        field('Body (HTML)', bodyInput),
        h(
          'div.mt-2',
          alert('info', 'Available variables', (template.variables || []).map((v) => `{{${v}}}`).join('  ·  ') || 'None')
        )
      ),
      actions: [
        {
          label: 'Reset to default',
          variant: 'ghost',
          onClick: async () => {
            const confirmed = await confirmDialog({
              title: 'Reset template',
              message: 'Restore the shipped subject and body for this template?',
              confirmLabel: 'Reset'
            });
            if (!confirmed) return false;
            await api.post(`/api/settings/email-templates/${template.code}/reset`);
            notify.success('Template reset.');
            draw();
            return true;
          }
        },
        { label: 'Cancel', variant: 'secondary' },
        {
          label: 'Save template',
          variant: 'primary',
          onClick: async () => {
            await api.put(`/api/settings/email-templates/${template.code}`, {
              subject: subjectInput.value,
              body_html: bodyInput.value
            });
            notify.success('Template saved.');
            draw();
          }
        }
      ]
    });
  }

  /* ---------------------------------------------------- approval levels -- */

  async function approvalLevelsTab() {
    const [levels, accounts] = await Promise.all([api.get('/api/settings/approval-levels'), api.get('/api/accounts/lookup')]);
    let working = levels.map((level) => ({ ...level }));
    const listHost = h('div');

    function drawLevels() {
      render(
        listHost,
        working.length
          ? h(
              'div',
              ...working.map((level, index) =>
                h(
                  'div.repeater__item',
                  h(
                    'div.repeater__head',
                    h('div.repeater__num', String(level.level || index + 1)),
                    h('div.repeater__title', level.name || `Level ${index + 1}`),
                    h(
                      'div.repeater__tools',
                      h('button.btn.btn--ghost.btn--sm.btn--icon', { onClick: () => { working.splice(index, 1); drawLevels(); } }, icon('trash', 14))
                    )
                  ),
                  h(
                    'div.repeater__body.grid.grid--form',
                    field('Level', h('input.input', { type: 'number', min: '1', value: level.level || index + 1, onInput: (e) => { level.level = Number(e.target.value); } })),
                    field('Name', h('input.input', { value: level.name || '', onInput: (e) => { level.name = e.target.value; } })),
                    field('Approver name', h('input.input', { value: level.approver_name || '', onInput: (e) => { level.approver_name = e.target.value; } })),
                    field('Approver email', h('input.input', { type: 'email', value: level.approver_email || '', onInput: (e) => { level.approver_email = e.target.value; } })),
                    field(
                      'Applies to',
                      select('', [{ value: '', label: 'All accounts (default ladder)' }, ...accounts.map((a) => ({ value: a.id, label: a.account_name }))], level.account_id || '', {
                        onChange: (e) => { level.account_id = e.target.value || null; }
                      })
                    )
                  )
                )
              )
            )
          : emptyState('No approval levels configured', 'Without a ladder, the account internal approver is used automatically.')
      );
    }

    drawLevels();

    return card({
      title: 'Approval levels',
      subtitle: 'Add levels to require more than one internal approval. Account-specific ladders override the default.',
      actions: h(
        'div.row.row--tight',
        h(
          'button.btn.btn--secondary.btn--sm',
          {
            onClick: () => {
              working.push({ level: working.length + 1, name: `Level ${working.length + 1}`, approver_name: '', approver_email: '', account_id: null });
              drawLevels();
            }
          },
          icon('plus', 14),
          'Add level'
        ),
        h(
          'button.btn.btn--primary.btn--sm',
          {
            onClick: async () => {
              try {
                await api.put('/api/settings/approval-levels', { levels: working });
                notify.success('Approval ladder saved.');
                draw();
              } catch (error) {
                apiError(error);
              }
            }
          },
          icon('check', 14),
          'Save ladder'
        )
      ),
      body: h('div', listHost, h('div.mt-2', alert('info', 'Multi-level approval is configuration, not code', 'A change request advances only when every level has approved, in order.')))
    });
  }

  /* --------------------------------------------------------------- users */

  async function usersTab() {
    const data = await api.get('/api/users');
    return card({
      title: 'Users',
      subtitle: 'Access is granted by email. Users sign in with a one-time code — there are no passwords.',
      actions: h('button.btn.btn--primary.btn--sm', { onClick: () => userForm() }, icon('plus', 14), 'Add user'),
      flush: true,
      body: dataTable({
        columns: [
          { key: 'name', label: 'Name', render: (row) => h('div', h('div.cell-strong', row.name), h('div.cell-sub', row.designation || '')) },
          { key: 'email', label: 'Email' },
          { key: 'role_name', label: 'Role', render: (row) => badge(row.role_name, row.role_code === 'ADMIN' ? 'navy' : 'slate') },
          { key: 'department', label: 'Department' },
          { key: 'is_active', label: 'Status', render: (row) => badge(row.is_active ? 'Active' : 'Inactive', row.is_active ? 'green' : 'slate') },
          { key: 'created_at', label: 'Created', render: (row) => dateTime(row.created_at) },
          { key: 'last_login_at', label: 'Last login', render: (row) => (row.last_login_at ? dateTime(row.last_login_at) : h('span.muted', 'Never')) },
          {
            key: 'actions',
            label: '',
            render: (row) =>
              h(
                'div.row.row--tight',
                h('button.btn.btn--ghost.btn--sm', { onClick: () => userForm(row) }, icon('edit', 14)),
                h(
                  'button.btn.btn--ghost.btn--sm',
                  {
                    onClick: async () => {
                      try {
                        await api.post(`/api/users/${row.id}/status`, { is_active: !row.is_active });
                        notify.success(`${row.name} ${row.is_active ? 'deactivated' : 'activated'}.`);
                        draw();
                      } catch (error) {
                        apiError(error);
                      }
                    }
                  },
                  row.is_active ? 'Deactivate' : 'Activate'
                )
              )
          }
        ],
        rows: data.rows
      })
    });
  }

  async function userForm(user = null) {
    const roles = store.enums?.roles || [];
    await formModal({
      title: user ? `Edit ${user.name}` : 'Add user',
      subtitle: user ? user.email : 'The user signs in with a one-time code sent to this address.',
      fields: h(
        'div',
        field('Full name', input('name', { value: user?.name || '' }), { required: true }),
        field('Email address', input('email', { type: 'email', value: user?.email || '' }), { required: true }),
        h(
          'div.grid.grid--form',
          field('Role', select('role_code', roles.map((role) => ({ value: role.code, label: role.label })), user?.role_code || 'VIEWER'), { required: true }),
          field('Department', input('department', { value: user?.department || '' }))
        ),
        h(
          'div.grid.grid--form',
          field('Designation', input('designation', { value: user?.designation || '' })),
          field('Phone', input('phone', { value: user?.phone || '' }))
        ),
        h('div.field', switchControl('is_active', user ? user.is_active : true, 'Active'))
      ),
      submitLabel: user ? 'Save changes' : 'Create user',
      onSubmit: async (data) => {
        if (user) await api.patch(`/api/users/${user.id}`, data);
        else await api.post('/api/users', data);
        notify.success(user ? 'User updated.' : 'User created.');
        draw();
      }
    });
  }

  /* --------------------------------------------------------------- roles */

  async function rolesTab() {
    const [roles, permissions] = await Promise.all([api.get('/api/roles'), api.get('/api/roles/permissions')]);
    const modules = [...new Set(permissions.map((permission) => permission.module))];

    return h(
      'div.stack',
      card({
        title: 'Roles and permissions',
        subtitle: 'The matrix is data — grant or revoke without a deployment. Administrators always keep every permission.',
        flush: true,
        body: h(
          'div.table-wrap',
          h(
            'table.data',
            h('thead', h('tr', h('th', 'Permission'), ...roles.map((role) => h('th.text-center', role.name)))),
            h(
              'tbody',
              ...modules.flatMap((module) => [
                h('tr', h('td', { colspan: roles.length + 1, style: { background: 'var(--ink-50)', fontWeight: '600' } }, module)),
                ...permissions
                  .filter((permission) => permission.module === module)
                  .map((permission) =>
                    h(
                      'tr',
                      h('td', h('div', h('div.cell-strong', permission.code), h('div.cell-sub', permission.description))),
                      ...roles.map((role) =>
                        h(
                          'td.text-center',
                          h('input', {
                            type: 'checkbox',
                            checked: role.permissions.includes(permission.code),
                            disabled: role.code === 'ADMIN',
                            style: { width: '16px', height: '16px', accentColor: 'var(--navy-800)' },
                            onChange: (event) => {
                              const set = new Set(role.permissions);
                              if (event.target.checked) set.add(permission.code);
                              else set.delete(permission.code);
                              role.permissions = [...set];
                            }
                          })
                        )
                      )
                    )
                  )
              ])
            )
          )
        ),
        footer: h(
          'div.row',
          h('div.muted', 'Changes apply to every user holding the role at their next request.'),
          h('div.spacer'),
          h(
            'button.btn.btn--primary',
            {
              onClick: async () => {
                try {
                  for (const role of roles.filter((r) => r.code !== 'ADMIN')) {
                    await api.put(`/api/roles/${role.code}/permissions`, { permissions: role.permissions });
                  }
                  notify.success('Permissions saved.');
                  draw();
                } catch (error) {
                  apiError(error);
                }
              }
            },
            icon('check', 15),
            'Save permissions'
          )
        )
      })
    );
  }

  /* ------------------------------------------------------------ docusign */

  async function docusignTab() {
    const status = await api.get('/api/settings/docusign');
    const form = h('form', { onSubmit: (event) => event.preventDefault() });

    render(
      form,
      h(
        'div.grid.grid--2',
        h(
          'div',
          field('Provider', select('docusign.provider', [
            { value: 'SIMULATED', label: 'Simulated — sign through the secure customer portal' },
            { value: 'DOCUSIGN', label: 'DocuSign — real envelopes via the DocuSign API' }
          ], status.provider)),
          field('Environment', select('docusign.environment', [
            { value: 'SANDBOX', label: 'Sandbox (demo)' },
            { value: 'PRODUCTION', label: 'Production' }
          ], status.environment)),
          field('API base URI', input('docusign.base_uri', { value: status.base_uri || '' })),
          field('Account id', input('docusign.account_id', { value: status.account_id || '' })),
          field('Integration key (client id)', input('docusign.integration_key', { value: status.integration_key || '' })),
          field('Impersonated user id', input('docusign.user_id', { value: status.user_id || '' }))
        ),
        h(
          'div',
          field('Secret key', input('docusign.secret_key', { type: 'password', placeholder: status.secret_key_configured ? '********' : 'Not configured' }), {
            hint: 'Stored AES-256-GCM encrypted; never returned to the browser'
          }),
          field('RSA private key', textarea('docusign.private_key', { rows: 6, placeholder: status.private_key_configured ? '******** (configured)' : '-----BEGIN RSA PRIVATE KEY-----' })),
          field('Connect webhook secret', input('docusign.webhook_secret', { type: 'password', placeholder: status.webhook_secret_configured ? '********' : 'Not configured' })),
          field('Webhook URL', input('webhook_url', { value: status.webhook_url, readOnly: true }), { hint: 'Configure this URL in DocuSign Connect' }),
          h('div.field', switchControl('docusign.enabled', status.enabled, 'e-Signature enabled'))
        )
      ),
      h(
        'div.row.mt-2',
        h('div.spacer'),
        h(
          'button.btn.btn--secondary',
          {
            onClick: async (event) => {
              const button = event.currentTarget;
              button.disabled = true;
              try {
                const result = await api.post('/api/settings/docusign/test');
                notify.success(result.message);
              } catch (error) {
                apiError(error);
              } finally {
                button.disabled = false;
              }
            }
          },
          icon('refresh', 15),
          'Test connection'
        ),
        h(
          'button.btn.btn--primary',
          {
            onClick: async (event) => {
              const button = event.currentTarget;
              button.disabled = true;
              try {
                const data = readForm(form);
                delete data.webhook_url;
                await api.put('/api/settings/docusign', data);
                notify.success('Integration settings saved.');
                draw();
              } catch (error) {
                apiError(error);
              } finally {
                button.disabled = false;
              }
            }
          },
          icon('check', 15),
          'Save integration'
        )
      )
    );

    return h(
      'div.stack',
      alert(status.ready ? 'success' : 'warning', status.ready ? 'Integration ready' : 'Integration incomplete', status.message),
      card({ title: 'DocuSign configuration', body: form }),
      card({
        title: 'How signing works',
        body: definitionList([
          ['Simulated provider', 'An envelope is tracked in the application and completed when the customer signs through the OTP-verified portal. The signed PDF and its signature certificate are stored against the change request.'],
          ['DocuSign provider', 'A real envelope is created with the Hyreo and customer signers, signature fields anchored to the document, and status updates received through DocuSign Connect.'],
          ['Tracked states', 'Created → Sent → Delivered → Viewed → Signed → Completed, with Declined and Voided handled explicitly.'],
          ['On completion', 'The signed document is stored, the change request moves to Completed, and the CR manager is notified.']
        ])
      })
    );
  }
}

export default settingsPage;
