import crypto from 'node:crypto';
import { all, get, run } from '../db/index.js';
import { nowIso } from '../lib/dates.js';
import { encryptSecret, decryptSecret } from '../lib/crypto.js';
import { errors } from '../lib/errors.js';
import { getSetting, setSetting } from './settings.js';
import audit from './audit.js';
import config from '../config.js';

/**
 * One-click integrations.
 *
 * Each live connector signs in with the provider's own OAuth consent screen.
 * The OAuth apps are registered once by the vendor (client id/secret in the
 * environment), so a customer never pastes a URL, key or token — they click
 * Connect, approve, and come back connected. Tokens are stored encrypted.
 */

const AUTH = {
  microsoft: {
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    console: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    consoleName: 'Microsoft Entra admin center → App registrations'
  },
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    console: 'https://console.cloud.google.com/apis/credentials',
    consoleName: 'Google Cloud console → APIs & Services → Credentials'
  },
  slack: {
    authorizeUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    console: 'https://api.slack.com/apps',
    consoleName: 'Slack API → Your apps'
  }
};

export const CATALOG = [
  {
    key: 'outlook',
    name: 'Outlook',
    vendor: 'Microsoft 365',
    category: 'email',
    auth: 'microsoft',
    scopes: ['openid', 'profile', 'email', 'offline_access', 'User.Read', 'Mail.Send'],
    description: 'Send sign-in codes, approval requests and change request documents from your Microsoft 365 mailbox.'
  },
  {
    key: 'gmail',
    name: 'Gmail',
    vendor: 'Google Workspace',
    category: 'email',
    auth: 'google',
    scopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.send'],
    description: 'Send sign-in codes, approval requests and change request documents from your Google Workspace mailbox.'
  },
  {
    key: 'teams',
    name: 'Microsoft Teams',
    vendor: 'Microsoft 365',
    category: 'chat',
    auth: 'microsoft',
    scopes: ['openid', 'profile', 'email', 'offline_access', 'User.Read', 'Team.ReadBasic.All', 'Channel.ReadBasic.All', 'ChannelMessage.Send'],
    description: 'Post approval requests, decisions, signatures and escalations to a Teams channel.'
  },
  {
    key: 'slack',
    name: 'Slack',
    vendor: 'Slack',
    category: 'chat',
    auth: 'slack',
    scopes: ['incoming-webhook'],
    description: 'Post approval requests, decisions, signatures and escalations to the Slack channel you pick.'
  },
  {
    key: 'docusign',
    name: 'DocuSign',
    vendor: 'DocuSign',
    category: 'signature',
    managed: true,
    description: 'Send change request documents for legally binding electronic signature.'
  },
  { key: 'google_drive', name: 'Google Drive', vendor: 'Google Workspace', category: 'storage', soon: true, description: 'Save signed change requests and MSAs to a shared Drive folder.' },
  { key: 'onedrive', name: 'OneDrive & SharePoint', vendor: 'Microsoft 365', category: 'storage', soon: true, description: 'Save signed change requests and MSAs to a SharePoint document library.' },
  { key: 'salesforce', name: 'Salesforce', vendor: 'Salesforce', category: 'crm', soon: true, description: 'Keep accounts, contacts and contract values in sync with Salesforce.' },
  { key: 'hubspot', name: 'HubSpot', vendor: 'HubSpot', category: 'crm', soon: true, description: 'Sync accounts and log signed change requests against HubSpot companies.' },
  { key: 'zoho_crm', name: 'Zoho CRM', vendor: 'Zoho', category: 'crm', soon: true, description: 'Sync accounts and contacts with Zoho CRM.' },
  { key: 'jira', name: 'Jira', vendor: 'Atlassian', category: 'delivery', soon: true, description: 'Create a Jira epic when a change request is signed and track delivery against it.' }
];

const STATE_TTL_MINUTES = 10;

function entry(key) {
  const item = CATALOG.find((c) => c.key === key);
  if (!item) throw errors.notFound('Unknown integration');
  return item;
}

function credentials(item) {
  return config.oauth[item.auth] || {};
}

function isConfigured(item) {
  const { clientId, clientSecret } = credentials(item);
  return Boolean(clientId && clientSecret);
}

export function redirectUri(key) {
  return `${config.appUrl}/api/integrations/${key}/callback`;
}

function row(key) {
  return get('SELECT * FROM integrations WHERE provider = ?', [key]);
}

function settingsOf(record) {
  try {
    return record?.settings_json ? JSON.parse(record.settings_json) : {};
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------- listing -- */

export async function list() {
  // loaded lazily: docusign depends on email, which depends on this module
  const { default: docusign } = await import('./docusign.js');
  const signature = docusign.integrationStatus();
  return CATALOG.map((item) => {
    if (item.managed) {
      return {
        ...pickPublic(item),
        status: signature.enabled ? (signature.provider === 'DOCUSIGN' ? 'connected' : 'built_in') : 'disconnected',
        account_label: signature.provider === 'DOCUSIGN' ? `${signature.environment} account` : 'Built-in e-signature',
        manage_path: '/settings/docusign'
      };
    }
    if (item.soon) return { ...pickPublic(item), status: 'coming_soon' };

    const record = row(item.key);
    const extra = settingsOf(record);
    return {
      ...pickPublic(item),
      status: record ? 'connected' : 'disconnected',
      configured: isConfigured(item),
      account_label: record?.account_label || null,
      account_email: record?.account_email || null,
      connected_at: record?.connected_at || null,
      last_used_at: record?.last_used_at || null,
      last_error: record?.last_error || null,
      channel: extra.channel_name ? { team: extra.team_name, name: extra.channel_name } : null,
      active_sender: item.category === 'email' ? getSetting('email.transport', 'capture') === item.key : undefined,
      setup: isConfigured(item)
        ? null
        : {
            provider: item.auth,
            console: AUTH[item.auth].console,
            console_name: AUTH[item.auth].consoleName,
            redirect_uri: redirectUri(item.key),
            env: [`${item.auth.toUpperCase()}_CLIENT_ID`, `${item.auth.toUpperCase()}_CLIENT_SECRET`],
            scopes: item.scopes
          }
    };
  });
}

function pickPublic(item) {
  return { key: item.key, name: item.name, vendor: item.vendor, category: item.category, description: item.description };
}

/* ------------------------------------------------------------- connect -- */

/** Begin the OAuth flow: returns the provider URL the browser should open. */
export function startConnect(key, user) {
  const item = entry(key);
  if (item.soon || item.managed) throw errors.invalidState(`${item.name} cannot be connected from here`);
  if (!isConfigured(item)) {
    throw errors.invalidState(`${item.name} is not set up on this server yet. Register the app with ${item.vendor} once, then Connect works in one click.`);
  }

  const state = crypto.randomBytes(24).toString('base64url');
  const now = new Date();
  run('DELETE FROM integration_oauth_states WHERE expires_at < ?', [now.toISOString()]);
  run('INSERT INTO integration_oauth_states (state, provider, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', [
    state,
    key,
    user.id,
    now.toISOString(),
    new Date(now.getTime() + STATE_TTL_MINUTES * 60_000).toISOString()
  ]);

  const { clientId } = credentials(item);
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri(key), state });
  if (item.auth === 'slack') {
    params.set('scope', item.scopes.join(','));
  } else {
    params.set('response_type', 'code');
    params.set('scope', item.scopes.join(' '));
  }
  if (item.auth === 'microsoft') params.set('prompt', 'select_account');
  if (item.auth === 'google') {
    params.set('access_type', 'offline');
    params.set('prompt', 'consent');
    params.set('include_granted_scopes', 'true');
  }
  return { url: `${AUTH[item.auth].authorizeUrl}?${params}` };
}

async function postForm(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false || data.error) {
    throw new Error(data.error_description || data.error || `token endpoint answered ${response.status}`);
  }
  return data;
}

async function getJson(url, token) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `${url} answered ${response.status}`);
  return data;
}

/** Finish the OAuth flow; called by the provider redirect. */
export async function completeConnect(key, { code, state, error, error_description: description }, user) {
  const item = entry(key);
  const pending = get('SELECT * FROM integration_oauth_states WHERE state = ?', [state || '']);
  run('DELETE FROM integration_oauth_states WHERE state = ?', [state || '']);
  if (!pending || pending.provider !== key || pending.user_id !== user.id || pending.expires_at < nowIso()) {
    throw errors.invalidState('The connection request expired or did not start here. Click Connect again.');
  }
  if (error) throw errors.invalidState(description || `${item.name} did not grant access (${error})`);
  if (!code) throw errors.invalidState(`${item.name} did not return an authorisation code`);

  const { clientId, clientSecret } = credentials(item);
  const token = await postForm(AUTH[item.auth].tokenUrl, {
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri(key),
    ...(item.auth === 'slack' ? {} : { grant_type: 'authorization_code' })
  });

  const record = {
    access_token: token.access_token || null,
    refresh_token: token.refresh_token || null,
    expires_at: token.expires_in ? new Date(Date.now() + Number(token.expires_in) * 1000).toISOString() : null,
    scopes: token.scope || item.scopes.join(' '),
    settings: {}
  };

  if (item.auth === 'microsoft') {
    const me = await getJson('https://graph.microsoft.com/v1.0/me', record.access_token);
    record.account_email = me.mail || me.userPrincipalName || null;
    record.account_label = me.displayName ? `${me.displayName} · ${record.account_email}` : record.account_email;
  } else if (item.auth === 'google') {
    const me = await getJson('https://openidconnect.googleapis.com/v1/userinfo', record.access_token);
    record.account_email = me.email || null;
    record.account_label = me.name ? `${me.name} · ${me.email}` : me.email;
  } else if (item.auth === 'slack') {
    const hook = token.incoming_webhook || {};
    if (!hook.url) throw errors.invalidState('Slack did not return a channel to post to');
    record.access_token = null;
    record.settings = { webhook_url: encryptSecret(hook.url), channel_name: hook.channel, team_name: token.team?.name || null };
    record.account_label = `${token.team?.name || 'Slack'} · ${hook.channel}`;
  }

  save(key, record, user);

  if (key === 'teams') await autoPickChannel(user).catch((e) => markError(key, e));
  if (item.category === 'email') setSetting('email.transport', key, user);

  audit.record({
    entityType: 'INTEGRATION',
    entityId: key,
    action: 'INTEGRATION_CONNECTED',
    actor: user,
    newValue: { provider: key, account: record.account_label }
  });
  return { key, name: item.name, account_label: record.account_label };
}

function save(key, record, user) {
  const now = nowIso();
  run(
    `INSERT INTO integrations (provider, account_label, account_email, access_token, refresh_token, expires_at, scopes,
                               settings_json, last_error, connected_by, connected_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET
       account_label = excluded.account_label, account_email = excluded.account_email,
       access_token = excluded.access_token, refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at, scopes = excluded.scopes, settings_json = excluded.settings_json,
       last_error = NULL, connected_by = excluded.connected_by, connected_at = excluded.connected_at,
       updated_at = excluded.updated_at`,
    [
      key,
      record.account_label || null,
      record.account_email || null,
      record.access_token ? encryptSecret(record.access_token) : null,
      record.refresh_token ? encryptSecret(record.refresh_token) : null,
      record.expires_at,
      record.scopes,
      JSON.stringify(record.settings || {}),
      user?.id || null,
      now,
      now
    ]
  );
}

function markError(key, error) {
  run('UPDATE integrations SET last_error = ?, updated_at = ? WHERE provider = ?', [String(error?.message || error), nowIso(), key]);
}

function markUsed(key) {
  run('UPDATE integrations SET last_used_at = ?, last_error = NULL WHERE provider = ?', [nowIso(), key]);
}

export function disconnect(key, user) {
  const item = entry(key);
  const record = row(key);
  if (!record) return { key, disconnected: false };
  run('DELETE FROM integrations WHERE provider = ?', [key]);
  if (item.category === 'email' && getSetting('email.transport', 'capture') === key) {
    setSetting('email.transport', 'capture', user);
  }
  audit.record({
    entityType: 'INTEGRATION',
    entityId: key,
    action: 'INTEGRATION_DISCONNECTED',
    actor: user,
    oldValue: { provider: key, account: record.account_label }
  });
  return { key, disconnected: true };
}

/** Make a connected Outlook or Gmail mailbox the one the application sends from. */
export function useForEmail(key, user) {
  const item = entry(key);
  if (item.category !== 'email') throw errors.validation(`${item.name} does not send email`);
  if (!row(key)) throw errors.invalidState(`Connect ${item.name} first`);
  setSetting('email.transport', key, user);
  audit.record({ entityType: 'INTEGRATION', entityId: key, action: 'INTEGRATION_UPDATED', actor: user, newValue: { email_sender: key } });
  return { key, active_sender: true };
}

/* -------------------------------------------------------------- tokens -- */

/** A valid access token for a connected provider, refreshing it when close to expiry. */
export async function accessToken(key) {
  const item = entry(key);
  const record = row(key);
  if (!record) throw errors.invalidState(`${item.name} is not connected`);
  const current = decryptSecret(record.access_token);
  const fresh = record.expires_at && Date.parse(record.expires_at) - Date.now() > 60_000;
  if (current && (fresh || !record.expires_at)) return current;

  const refresh = decryptSecret(record.refresh_token);
  if (!refresh) throw errors.invalidState(`${item.name} needs to be connected again`);
  const { clientId, clientSecret } = credentials(item);
  const token = await postForm(AUTH[item.auth].tokenUrl, {
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refresh,
    ...(item.auth === 'microsoft' ? { scope: item.scopes.join(' ') } : {})
  });
  run('UPDATE integrations SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = ? WHERE provider = ?', [
    encryptSecret(token.access_token),
    token.refresh_token ? encryptSecret(token.refresh_token) : record.refresh_token,
    token.expires_in ? new Date(Date.now() + Number(token.expires_in) * 1000).toISOString() : null,
    nowIso(),
    key
  ]);
  return token.access_token;
}

export function isConnected(key) {
  return Boolean(row(key));
}

export function connectedAccount(key) {
  const record = row(key);
  return record ? { email: record.account_email, label: record.account_label } : null;
}

/* --------------------------------------------------------------- teams -- */

export async function teamsChannels() {
  const token = await accessToken('teams');
  const teams = (await getJson('https://graph.microsoft.com/v1.0/me/joinedTeams', token)).value || [];
  const out = [];
  for (const team of teams.slice(0, 25)) {
    const channels = (await getJson(`https://graph.microsoft.com/v1.0/teams/${team.id}/channels`, token)).value || [];
    for (const channel of channels) {
      out.push({ team_id: team.id, team_name: team.displayName, channel_id: channel.id, channel_name: channel.displayName });
    }
  }
  return out;
}

async function autoPickChannel(user) {
  const channels = await teamsChannels();
  const pick = channels.find((c) => c.channel_name === 'General') || channels[0];
  if (pick) setTeamsChannel(pick, user, { silent: true });
}

export function setTeamsChannel({ team_id: teamId, team_name: teamName, channel_id: channelId, channel_name: channelName }, user, { silent = false } = {}) {
  const record = row('teams');
  if (!record) throw errors.invalidState('Microsoft Teams is not connected');
  if (!teamId || !channelId) throw errors.validation('Choose a channel');
  const next = { ...settingsOf(record), team_id: teamId, team_name: teamName, channel_id: channelId, channel_name: channelName };
  run('UPDATE integrations SET settings_json = ?, updated_at = ? WHERE provider = ?', [JSON.stringify(next), nowIso(), 'teams']);
  if (!silent) {
    audit.record({ entityType: 'INTEGRATION', entityId: 'teams', action: 'INTEGRATION_UPDATED', actor: user, newValue: { channel: `${teamName} / ${channelName}` } });
  }
  return { team: teamName, name: channelName };
}

/* ------------------------------------------------------------ delivery -- */

/** Slack webhook issued by the OAuth install, if Slack is connected. */
export function slackWebhook() {
  const record = row('slack');
  return record ? decryptSecret(settingsOf(record).webhook_url) || null : null;
}

export function teamsTarget() {
  const record = row('teams');
  const extra = settingsOf(record);
  return record && extra.team_id && extra.channel_id ? extra : null;
}

export async function postToTeams({ title, text, url }) {
  const target = teamsTarget();
  if (!target) throw new Error('no Teams channel selected');
  const token = await accessToken('teams');
  const escape = (value) => String(value || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const content = [`<b>${escape(title)}</b>`, text ? escape(text).replace(/\n/g, '<br>') : null, url ? `<a href="${escape(url)}">Open change request</a>` : null]
    .filter(Boolean)
    .join('<br>');
  const response = await fetch(`https://graph.microsoft.com/v1.0/teams/${target.team_id}/channels/${target.channel_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: { contentType: 'html', content } }),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    const error = new Error(`Teams answered ${response.status}`);
    markError('teams', error);
    throw error;
  }
  markUsed('teams');
  return true;
}

export function recordDelivery(key, error = null) {
  if (error) markError(key, error);
  else markUsed(key);
}

/** Send one email through a connected Outlook or Gmail mailbox. */
export async function sendMail(key, { to, cc, subject, html, text, attachments = [], fromName = getSetting('email.from_name') || null, replyTo }) {
  const token = await accessToken(key);
  const account = connectedAccount(key);
  try {
    if (key === 'outlook') {
      const recipients = (list_) => String(list_ || '').split(',').map((a) => a.trim()).filter(Boolean).map((address) => ({ emailAddress: { address } }));
      const response = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            subject,
            body: { contentType: 'HTML', content: html },
            toRecipients: recipients(to),
            ccRecipients: recipients(cc),
            replyTo: replyTo ? recipients(replyTo) : [],
            attachments: attachments.map((a) => ({
              '@odata.type': '#microsoft.graph.fileAttachment',
              name: a.filename,
              contentType: a.contentType || 'application/octet-stream',
              contentBytes: a.content.toString('base64'),
              ...(a.cid ? { isInline: true, contentId: a.cid } : {})
            }))
          },
          saveToSentItems: true
        }),
        signal: AbortSignal.timeout(30000)
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.error?.message || `Outlook answered ${response.status}`);
      }
    } else if (key === 'gmail') {
      const { default: MailComposer } = await import('nodemailer/lib/mail-composer');
      const raw = await new MailComposer({
        from: fromName ? `${fromName} <${account.email}>` : account.email,
        to,
        cc: cc || undefined,
        replyTo: replyTo || undefined,
        subject,
        html,
        text,
        attachments: attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType, cid: a.cid }))
      })
        .compile()
        .build();
      const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: raw.toString('base64url') }),
        signal: AbortSignal.timeout(30000)
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.error?.message || `Gmail answered ${response.status}`);
      }
    } else {
      throw new Error(`${key} cannot send email`);
    }
    markUsed(key);
    return { provider: key, from: account.email };
  } catch (error) {
    markError(key, error);
    throw error;
  }
}

export function connectedSummary() {
  return all('SELECT provider, account_label FROM integrations');
}

export default {
  CATALOG,
  list,
  startConnect,
  completeConnect,
  disconnect,
  useForEmail,
  accessToken,
  isConnected,
  connectedAccount,
  teamsChannels,
  setTeamsChannel,
  slackWebhook,
  teamsTarget,
  postToTeams,
  sendMail,
  recordDelivery,
  redirectUri,
  connectedSummary
};
