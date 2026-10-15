import { getSetting } from './settings.js';
import config from '../config.js';

/**
 * Posts workflow events to Slack and Microsoft Teams incoming webhooks.
 * Delivery is fire-and-forget: a chat outage must never fail a workflow step,
 * and the email + in-app channels remain the system of record.
 */

function targets() {
  return {
    slack: String(getSetting('integrations.slack_webhook_url', '') || '').trim(),
    teams: String(getSetting('integrations.teams_webhook_url', '') || '').trim()
  };
}

export function isConfigured() {
  const { slack, teams } = targets();
  return Boolean(slack || teams);
}

function absolute(link) {
  if (!link) return null;
  return /^https?:\/\//.test(link) ? link : `${config.appUrl}${link.startsWith('/') ? '' : '/'}${link}`;
}

function slackPayload({ title, text, url }) {
  const lines = [`*${title}*`, text, url ? `<${url}|Open in Hyreo CRMS>` : null].filter(Boolean);
  return { text: lines.join('\n') };
}

function teamsPayload({ title, text, url }) {
  return {
    '@type': 'MessageCard',
    '@context': 'https://schema.org/extensions',
    summary: title,
    themeColor: '1f3864',
    title,
    text: text || '',
    potentialAction: url
      ? [{ '@type': 'OpenUri', name: 'Open in Hyreo CRMS', targets: [{ os: 'default', uri: url }] }]
      : []
  };
}

async function postJson(webhook, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`webhook answered ${response.status}`);
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/** Deliver one message to every configured channel; resolves with per-channel results. */
export async function deliver({ title, text = '', link = null }) {
  const { slack, teams } = targets();
  const message = { title, text, url: absolute(link) };
  const results = {};
  if (slack) {
    results.slack = await postJson(slack, slackPayload(message)).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error: String(error?.message || error) })
    );
  }
  if (teams) {
    results.teams = await postJson(teams, teamsPayload(message)).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error: String(error?.message || error) })
    );
  }
  return results;
}

/** Background post used by the workflow; failures are logged, never thrown. */
export function post(message) {
  if (!isConfigured()) return;
  setImmediate(() => {
    deliver(message)
      .then((results) => {
        for (const [channel, result] of Object.entries(results)) {
          if (!result.ok) console.warn(`[hcrms] ${channel} notification failed: ${result.error}`);
        }
      })
      .catch(() => {});
  });
}

export default { post, deliver, isConfigured };
