import { h, render } from '../lib/dom.js';
import { icon, pageHeader, loading, badge, apiError, notify, modal, alert, confirmDialog, field } from '../lib/ui.js';
import { setPage } from '../components/shell.js';
import { brandIcon } from '../lib/brandIcons.js';
import { relative } from '../lib/format.js';
import api from '../lib/api.js';
import router from '../lib/router.js';

const SECTIONS = [
  { key: 'email', title: 'Email', subtitle: 'Send sign-in codes, approval requests and documents from your own mailbox.' },
  { key: 'chat', title: 'Chat & notifications', subtitle: 'Bring approvals, decisions and signatures into the channels your team works in.' },
  { key: 'signature', title: 'E-signature', subtitle: 'Collect legally binding signatures on change requests.' },
  { key: 'soon', title: 'Coming soon', subtitle: 'Connectors on the roadmap.' }
];

/**
 * Integrations: one card per connector. Connect opens the provider's own
 * sign-in and consent screen and comes straight back — nothing to paste.
 */
export async function integrationsPage({ query }) {
  if (query.connected) notify.success('Connected. You are all set.');
  if (query.error) notify.error(query.error);
  if (query.connected || query.error) history.replaceState(null, '', '/integrations');

  const host = h('div', loading('Loading integrations'));
  setPage(
    pageHeader({
      title: 'Integrations',
      subtitle: 'Connect the tools your team already uses. One click to sign in — no URLs, keys or tokens to copy.'
    }),
    host
  );

  await load();

  async function load() {
    let items;
    try {
      items = await api.get('/api/integrations');
    } catch (error) {
      apiError(error);
      return;
    }
    const grouped = (key) => items.filter((item) => (key === 'soon' ? item.status === 'coming_soon' : item.category === key && item.status !== 'coming_soon'));
    render(
      host,
      ...SECTIONS.map((section) => {
        const list = grouped(section.key);
        if (!list.length) return null;
        return h(
          'section.integration-section',
          h('div.integration-section__head', h('h2.integration-section__title', section.title), h('div.card__subtitle', section.subtitle)),
          h('div.integration-grid', ...list.map((item) => integrationCard(item, load)))
        );
      })
    );
  }
}

function integrationCard(item, reload) {
  const connected = item.status === 'connected' || item.status === 'built_in';

  return h(
    `div.integration-card${connected ? '.is-connected' : ''}${item.status === 'coming_soon' ? '.is-soon' : ''}`,
    h(
      'div.integration-card__head',
      brandIcon(item.key, 44),
      h('div.integration-card__title', h('div.cell-strong', item.name), item.vendor !== item.name ? h('div.cell-sub', item.vendor) : null),
      statusBadge(item)
    ),
    h('p.integration-card__text', item.description),
    connected && item.account_label
      ? h('div.integration-card__account', icon('check', 13), h('span', item.account_label))
      : null,
    item.channel ? h('div.integration-card__meta', `Posting to ${item.channel.team} › ${item.channel.name}`) : null,
    item.key === 'teams' && item.status === 'connected' && !item.channel
      ? h('div.integration-card__meta', 'Choose a channel to start posting.')
      : null,
    item.last_used_at ? h('div.integration-card__meta', `Last used ${relative(item.last_used_at)}`) : null,
    item.last_error ? h('div.mt-1', alert('warning', 'Last attempt failed', item.last_error)) : null,
    h('div.integration-card__actions', ...actions(item, reload))
  );
}

function statusBadge(item) {
  switch (item.status) {
    case 'connected':
      return item.active_sender === false ? badge('Connected', 'blue') : badge(item.category === 'email' ? 'Sending email' : 'Connected', 'green');
    case 'built_in':
      return badge('Built-in', 'navy');
    case 'coming_soon':
      return badge('Coming soon', 'slate', { plain: true });
    default:
      return null;
  }
}

function actions(item, reload) {
  if (item.status === 'coming_soon') {
    return [h('button.btn.btn--secondary.btn--sm', { disabled: true }, 'Coming soon')];
  }
  if (item.manage_path) {
    return [h('button.btn.btn--secondary.btn--sm', { onClick: () => router.navigate(item.manage_path) }, icon('settings', 14), 'Manage')];
  }
  if (item.status !== 'connected') {
    return [h('button.btn.btn--primary.btn--sm', { onClick: (event) => connect(item, event.currentTarget) }, icon('plus', 14), 'Connect')];
  }

  const list = [];
  if (item.category === 'email' && item.active_sender === false) {
    list.push(
      h(
        'button.btn.btn--primary.btn--sm',
        { onClick: () => run(api.post(`/api/integrations/${item.key}/use-for-email`), `Emails will now be sent from ${item.name}.`, reload) },
        'Use for sending'
      )
    );
  }
  if (item.key === 'teams') {
    list.push(h('button.btn.btn--secondary.btn--sm', { onClick: () => chooseChannel(reload) }, item.channel ? 'Change channel' : 'Choose channel'));
  }
  list.push(
    h(
      'button.btn.btn--secondary.btn--sm',
      {
        onClick: async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            const result = await api.post(`/api/integrations/${item.key}/test`);
            notify.success(result.message);
          } catch (error) {
            apiError(error);
          } finally {
            button.disabled = false;
            reload();
          }
        }
      },
      icon('send', 14),
      'Send test'
    ),
    h('button.btn.btn--ghost.btn--sm', { onClick: () => disconnect(item, reload) }, 'Disconnect')
  );
  return list;
}

async function connect(item, button) {
  if (item.setup) {
    setupGuide(item);
    return;
  }
  button.disabled = true;
  try {
    const { url } = await api.post(`/api/integrations/${item.key}/connect`);
    window.location.assign(url);
  } catch (error) {
    apiError(error);
    button.disabled = false;
  }
}

async function disconnect(item, reload) {
  const confirmed = await confirmDialog({
    title: `Disconnect ${item.name}`,
    message:
      item.category === 'email'
        ? 'Emails will stop going out through this mailbox. They are kept in the outbox until another mailbox or SMTP is set up.'
        : 'Updates will stop being posted to this channel.',
    confirmLabel: 'Disconnect',
    variant: 'danger'
  });
  if (!confirmed) return;
  await run(api.post(`/api/integrations/${item.key}/disconnect`), `${item.name} disconnected.`, reload);
}

async function chooseChannel(reload) {
  let channels;
  try {
    channels = await api.get('/api/integrations/teams/channels');
  } catch (error) {
    apiError(error);
    return;
  }
  if (!channels.length) {
    notify.error('No Teams channels were found for the connected account.');
    return;
  }
  const select = h(
    'select.select',
    ...channels.map((c, index) => h('option', { value: String(index) }, `${c.team_name} › ${c.channel_name}`))
  );
  modal({
    title: 'Choose a Teams channel',
    subtitle: 'Approval requests, decisions and signatures are posted here.',
    body: field('Channel', select),
    actions: [
      { label: 'Cancel', variant: 'secondary' },
      {
        label: 'Save',
        variant: 'primary',
        onClick: async () => {
          try {
            await api.put('/api/integrations/teams/channel', channels[Number(select.value)]);
            notify.success('Teams channel saved.');
            reload();
          } catch (error) {
            apiError(error);
            return false;
          }
          return true;
        }
      }
    ]
  });
}

/** Shown only until the platform owner has registered the app with the provider. */
function setupGuide(item) {
  const { setup } = item;
  const insecure = setup.redirect_uri.startsWith('http://') && !/^http:\/\/localhost[:/]/.test(setup.redirect_uri);
  modal({
    title: `${item.name} is not set up yet`,
    subtitle: 'A one-time step for the platform owner. After it, Connect works in one click for everyone.',
    size: 'lg',
    body: h(
      'div',
      insecure
        ? alert(
            'warning',
            'A secure (https) address is needed',
            `${item.vendor} only returns users to https addresses (or localhost). Serve the application over https and set APP_URL to that address before registering.`
          )
        : null,
      h(
        'ol.setup-steps',
        h('li', 'Register an application in ', h('a', { href: setup.console, target: '_blank', rel: 'noopener' }, setup.console_name), '.'),
        h('li', 'Add this redirect URI:', copyable(setup.redirect_uri)),
        h('li', 'Allow these permissions:', h('div.setup-scopes', ...setup.scopes.map((scope) => h('code', scope)))),
        h('li', 'Put the client ID and secret in the server ', h('code', '.env'), ' file and restart:', copyable(`${setup.env[0]}=…\n${setup.env[1]}=…`))
      )
    ),
    actions: [{ label: 'Close', variant: 'secondary' }]
  });
}

function copyable(text) {
  return h(
    'div.setup-copy',
    h('code', text),
    h(
      'button.btn.btn--ghost.btn--sm',
      {
        type: 'button',
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(text);
            notify.success('Copied.');
          } catch {
            notify.error('Copy failed — select the text instead.');
          }
        }
      },
      icon('copy', 14)
    )
  );
}

async function run(promise, message, reload) {
  try {
    await promise;
    notify.success(message);
    reload();
  } catch (error) {
    apiError(error);
  }
}

export default integrationsPage;
