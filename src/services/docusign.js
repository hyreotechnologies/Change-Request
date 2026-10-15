import crypto from 'node:crypto';
import fs from 'node:fs';
import { all, get, insert, transaction, update } from '../db/index.js';
import { uid } from '../lib/ids.js';
import { nowIso, formatDateTime } from '../lib/dates.js';
import { hmacSignature } from '../lib/crypto.js';
import { errors } from '../lib/errors.js';
import { getSetting, isSecretConfigured } from './settings.js';
import changeRequests from './changeRequests.js';
import documents from './documents.js';
import shareLinks from './shareLinks.js';
import email from './email.js';
import notifications from './notifications.js';
import audit, { ACTIONS } from './audit.js';
import config from '../config.js';

/**
 * e-Signature integration layer.
 *
 * Two providers implement the same interface:
 *   SIMULATED — envelopes are tracked internally and completed by the customer
 *               portal signature flow. Lets the whole lifecycle run without
 *               DocuSign credentials.
 *   DOCUSIGN  — real REST API (JWT grant). Credentials are stored encrypted in
 *               settings and never leave the server.
 */

const STATUS_MAP = {
  created: 'CREATED',
  sent: 'SENT',
  delivered: 'DELIVERED',
  signed: 'SIGNED',
  completed: 'COMPLETED',
  declined: 'DECLINED',
  voided: 'VOIDED'
};

export function providerName() {
  return String(getSetting('docusign.provider', 'SIMULATED')).toUpperCase() === 'DOCUSIGN' ? 'DOCUSIGN' : 'SIMULATED';
}

export function isEnabled() {
  return Boolean(getSetting('docusign.enabled', true));
}

export function integrationStatus() {
  const provider = providerName();
  const ready =
    provider === 'SIMULATED' ||
    Boolean(
      getSetting('docusign.account_id') &&
        getSetting('docusign.integration_key') &&
        getSetting('docusign.user_id') &&
        isSecretConfigured('docusign.private_key')
    );
  return {
    enabled: isEnabled(),
    provider,
    environment: getSetting('docusign.environment', 'SANDBOX'),
    base_uri: getSetting('docusign.base_uri'),
    account_id: getSetting('docusign.account_id'),
    integration_key: getSetting('docusign.integration_key'),
    user_id: getSetting('docusign.user_id'),
    private_key_configured: isSecretConfigured('docusign.private_key'),
    secret_key_configured: isSecretConfigured('docusign.secret_key'),
    webhook_secret_configured: isSecretConfigured('docusign.webhook_secret'),
    webhook_url: `${config.appUrl}/api/webhooks/docusign`,
    ready,
    message: ready
      ? provider === 'SIMULATED'
        ? 'Simulated provider active — envelopes are tracked in the application and completed through the secure customer portal.'
        : 'DocuSign credentials are configured.'
      : 'DocuSign is selected but the account id, integration key, user id or RSA private key is missing.'
  };
}

/* --------------------------------------------------------- send envelope -- */

export function sendEnvelope(crId, payload = {}, actor = null) {
  if (!isEnabled()) throw errors.invalidState('e-Signature is disabled in settings');

  const cr = changeRequests.find(crId);
  if (!['READY_FOR_CUSTOMER', 'SENT_TO_CUSTOMER', 'CUSTOMER_VIEWED', 'CUSTOMER_APPROVAL_PENDING', 'CUSTOMER_APPROVED'].includes(cr.status)) {
    throw errors.invalidState('The change request must be internally approved before it can be sent for signature');
  }
  const pdf = documents.latestFinal(crId, 'PDF');
  if (!pdf) throw errors.invalidState('Generate the final change request document before sending it for signature');

  const customerEmail = payload.customer_email || cr.snapshot_customer_approver_email || cr.customer_contact_email;
  const customerName = payload.customer_name || cr.snapshot_customer_approver || 'Customer signatory';
  if (!customerEmail) throw errors.validation('A customer signatory email address is required');

  const hyreoEmail = payload.signer_email || getSetting('company.email');
  const hyreoName = payload.signer_name || getSetting('company.signatory_name');

  const recipients = [
    { role: 'LICENSOR', name: hyreoName, email: hyreoEmail, routing_order: 1 },
    { role: 'LICENSEE', name: customerName, email: customerEmail, routing_order: 2 }
  ];

  const provider = providerName();
  const file = documents.resolveFile(pdf.id);

  const envelope = transaction(() => {
    const row = {
      id: uid('ENV'),
      cr_id: crId,
      provider,
      envelope_id: provider === 'SIMULATED' ? `SIM-${uid('')}`.slice(0, 26) : 'pending',
      status: 'CREATED',
      environment: getSetting('docusign.environment', 'SANDBOX'),
      recipients_json: JSON.stringify(recipients),
      created_by: actor?.id || null,
      created_at: nowIso(),
      updated_at: nowIso()
    };
    insert('docusign_envelopes', row);
    audit.record({
      entityType: 'ENVELOPE',
      entityId: row.id,
      crId,
      action: ACTIONS.ENVELOPE_CREATED,
      actor,
      newValue: { provider, recipients: recipients.map((r) => r.email) },
      ip: actor?.ip
    });
    return row;
  });

  if (provider === 'DOCUSIGN') {
    return createRemoteEnvelope(envelope, { cr, file, recipients, actor });
  }

  // simulated: the customer signs through the secure portal
  const link = shareLinks.createLink({
    crId,
    audience: 'CUSTOMER',
    email: customerEmail,
    recipientName: customerName,
    actor
  });

  update('docusign_envelopes', envelope.id, { status: 'SENT', sent_at: nowIso(), updated_at: nowIso() });

  if (cr.status === 'READY_FOR_CUSTOMER') {
    changeRequests.applyTransition(changeRequests.findRaw(crId), 'share', {
      actor,
      patch: { shared_at: nowIso(), shared_by: actor?.id || null }
    });
  }

  email.send({
    templateCode: 'DOCUSIGN_SENT',
    to: get('SELECT email FROM users WHERE id = ?', [cr.created_by])?.email || getSetting('company.email'),
    crId,
    crReference: cr.cr_reference,
    variables: {
      manager_name: get('SELECT name FROM users WHERE id = ?', [cr.created_by])?.name || 'there',
      cr_number: cr.cr_number,
      envelope_id: envelope.envelope_id,
      recipients: recipients.map((r) => `${r.name} <${r.email}>`).join(', '),
      cr_url: `${config.appUrl}/change-requests/${crId}`
    }
  });

  email.send({
    templateCode: 'CUSTOMER_APPROVAL_REQUEST',
    to: customerEmail,
    crId,
    crReference: cr.cr_reference,
    attachments: [{ filename: file.fileName, path: file.absolutePath, contentType: file.mime }],
    variables: {
      customer_name: customerName,
      cr_number: cr.cr_number,
      cr_reference: cr.cr_reference,
      cr_title: cr.title,
      account_name: cr.account?.account_name,
      cr_cost: cr.costs?.total_cost,
      target_release_date: cr.target_release_date || 'To be confirmed',
      portal_url: link.url,
      company_name: getSetting('company.name', 'Hyreo')
    },
    actor
  });

  notifications.notify({
    userIds: [cr.created_by].filter(Boolean),
    type: 'ENVELOPE_SENT',
    title: `Envelope sent for ${cr.cr_number}`,
    body: `${customerName} <${customerEmail}>`,
    link: `/change-requests/${crId}`,
    crId
  });

  return get('SELECT * FROM docusign_envelopes WHERE id = ?', [envelope.id]);
}

/* -------------------------------------------------------- DocuSign REST -- */

function base64Url(input) {
  return Buffer.from(input).toString('base64url');
}

async function accessToken() {
  const integrationKey = getSetting('docusign.integration_key');
  const userId = getSetting('docusign.user_id');
  const privateKey = getSetting('docusign.private_key');
  const environment = String(getSetting('docusign.environment', 'SANDBOX')).toUpperCase();
  const authHost = environment === 'PRODUCTION' ? 'account.docusign.com' : 'account-d.docusign.com';

  if (!integrationKey || !userId || !privateKey) {
    throw errors.integration('DocuSign credentials are incomplete. Configure the integration key, user id and RSA private key.');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(
    JSON.stringify({
      iss: integrationKey,
      sub: userId,
      aud: authHost,
      iat: now,
      exp: now + 3600,
      scope: 'signature impersonation'
    })
  );
  let signature;
  try {
    signature = crypto.createSign('RSA-SHA256').update(`${header}.${claims}`).sign(privateKey, 'base64url');
  } catch (error) {
    throw errors.integration(`The configured DocuSign RSA private key could not be used: ${error.message}`);
  }

  const response = await fetch(`https://${authHost}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw errors.integration(`DocuSign authentication failed: ${body.error_description || body.error || response.status}`);
  }
  return body.access_token;
}

async function createRemoteEnvelope(envelope, { cr, file, recipients, actor }) {
  const token = await accessToken();
  const baseUri = String(getSetting('docusign.base_uri', 'https://demo.docusign.net/restapi')).replace(/\/+$/, '');
  const accountId = getSetting('docusign.account_id');

  const definition = {
    emailSubject: `Change Request ${cr.cr_number} — ${cr.account?.account_name}`,
    emailBlurb: `Please review and sign change request ${cr.cr_reference}.`,
    status: 'sent',
    documents: [
      {
        documentBase64: fs.readFileSync(file.absolutePath).toString('base64'),
        name: `Change Request ${cr.cr_number}`,
        fileExtension: 'pdf',
        documentId: '1'
      }
    ],
    recipients: {
      signers: recipients.map((recipient, index) => ({
        email: recipient.email,
        name: recipient.name,
        recipientId: String(index + 1),
        routingOrder: String(recipient.routing_order),
        roleName: recipient.role,
        tabs: {
          signHereTabs: [
            {
              anchorString: 'Signature:',
              anchorUnits: 'pixels',
              anchorXOffset: '60',
              anchorYOffset: index === 0 ? '-6' : '-6',
              anchorCaseSensitive: 'false',
              anchorMatchWholeWord: 'false',
              anchorIgnoreIfNotPresent: 'true'
            }
          ],
          dateSignedTabs: [
            {
              anchorString: 'Date:',
              anchorUnits: 'pixels',
              anchorXOffset: '40',
              anchorYOffset: '-4',
              anchorIgnoreIfNotPresent: 'true'
            }
          ]
        }
      }))
    },
    eventNotification: buildWebhookConfig()
  };

  const response = await fetch(`${baseUri}/v2.1/accounts/${accountId}/envelopes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(definition)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    update('docusign_envelopes', envelope.id, { status: 'CREATED', raw_json: JSON.stringify(body), updated_at: nowIso() });
    throw errors.integration(`DocuSign envelope creation failed: ${body.message || response.status}`, body);
  }

  update('docusign_envelopes', envelope.id, {
    envelope_id: body.envelopeId,
    status: STATUS_MAP[String(body.status || 'sent').toLowerCase()] || 'SENT',
    sent_at: nowIso(),
    raw_json: JSON.stringify(body),
    updated_at: nowIso()
  });

  if (cr.status === 'READY_FOR_CUSTOMER') {
    changeRequests.applyTransition(changeRequests.findRaw(cr.id), 'share', {
      actor,
      patch: { shared_at: nowIso(), shared_by: actor?.id || null }
    });
  }

  audit.record({
    entityType: 'ENVELOPE',
    entityId: envelope.id,
    crId: cr.id,
    action: ACTIONS.ENVELOPE_UPDATED,
    actor,
    newValue: { envelope_id: body.envelopeId, status: body.status }
  });

  return get('SELECT * FROM docusign_envelopes WHERE id = ?', [envelope.id]);
}

function buildWebhookConfig() {
  return {
    url: `${config.appUrl}/api/webhooks/docusign`,
    requireAcknowledgment: 'true',
    envelopeEvents: [
      { envelopeEventStatusCode: 'sent' },
      { envelopeEventStatusCode: 'delivered' },
      { envelopeEventStatusCode: 'completed' },
      { envelopeEventStatusCode: 'declined' },
      { envelopeEventStatusCode: 'voided' }
    ],
    includeDocuments: 'false'
  };
}

export async function refresh(crId) {
  const envelope = get('SELECT * FROM docusign_envelopes WHERE cr_id = ? ORDER BY created_at DESC LIMIT 1', [crId]);
  if (!envelope) throw errors.notFound('No envelope has been created for this change request');

  if (envelope.provider === 'SIMULATED') {
    return reconcile(crId);
  }

  const token = await accessToken();
  const baseUri = String(getSetting('docusign.base_uri')).replace(/\/+$/, '');
  const accountId = getSetting('docusign.account_id');
  const response = await fetch(`${baseUri}/v2.1/accounts/${accountId}/envelopes/${envelope.envelope_id}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw errors.integration(`DocuSign status check failed: ${body.message || response.status}`);

  applyEnvelopeStatus(envelope.id, body.status, body);
  if (String(body.status).toLowerCase() === 'completed') {
    await downloadCompletedDocument(envelope, token, baseUri, accountId);
  }
  return get('SELECT * FROM docusign_envelopes WHERE id = ?', [envelope.id]);
}

async function downloadCompletedDocument(envelope, token, baseUri, accountId) {
  const response = await fetch(
    `${baseUri}/v2.1/accounts/${accountId}/envelopes/${envelope.envelope_id}/documents/combined`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!response.ok) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  const version = documents.storeSignedDocument(envelope.cr_id, buffer, { source: 'DOCUSIGN' });
  update('docusign_envelopes', envelope.id, { signed_document_path: version.file_path, updated_at: nowIso() });
  completeChangeRequest(envelope.cr_id, envelope);
  return version;
}

/* --------------------------------------------------------- status logic -- */

export function applyEnvelopeStatus(envelopeRowId, rawStatus, raw = null) {
  const status = STATUS_MAP[String(rawStatus || '').toLowerCase()] || 'SENT';
  const patch = { status, updated_at: nowIso() };
  const now = nowIso();
  if (status === 'SENT') patch.sent_at = now;
  if (status === 'DELIVERED') patch.delivered_at = now;
  if (status === 'SIGNED') patch.signed_at = now;
  if (status === 'COMPLETED') patch.completed_at = now;
  if (status === 'DECLINED') patch.declined_at = now;
  if (status === 'VOIDED') patch.voided_at = now;
  if (raw) patch.raw_json = JSON.stringify(raw).slice(0, 200000);

  update('docusign_envelopes', envelopeRowId, patch);
  const envelope = get('SELECT * FROM docusign_envelopes WHERE id = ?', [envelopeRowId]);
  audit.record({
    entityType: 'ENVELOPE',
    entityId: envelopeRowId,
    crId: envelope.cr_id,
    action: status === 'COMPLETED' ? ACTIONS.ENVELOPE_COMPLETED : ACTIONS.ENVELOPE_UPDATED,
    actor: { type: 'SYSTEM', name: 'DocuSign' },
    newValue: { status }
  });
  return envelope;
}

/** Move the CR to signed/completed once an envelope completes. */
export function completeChangeRequest(crId, envelope) {
  const cr = changeRequests.findRaw(crId);
  if (['COMPLETED'].includes(cr.status)) return cr;

  transaction(() => {
    if (['SENT_TO_CUSTOMER', 'CUSTOMER_VIEWED', 'CUSTOMER_APPROVAL_PENDING'].includes(cr.status)) {
      changeRequests.applyTransition(cr, 'customer_approve', {
        actor: { type: 'SYSTEM', name: 'DocuSign' },
        patch: { customer_decided_at: nowIso() }
      });
    }
    const afterApprove = changeRequests.findRaw(crId);
    if (afterApprove.status === 'CUSTOMER_APPROVED') {
      changeRequests.applyTransition(afterApprove, 'sign', {
        actor: { type: 'SYSTEM', name: 'DocuSign' },
        patch: { signed_at: nowIso() }
      });
    }
    const afterSign = changeRequests.findRaw(crId);
    if (afterSign.status === 'SIGNED') {
      changeRequests.applyTransition(afterSign, 'complete', {
        actor: { type: 'SYSTEM', name: 'DocuSign' },
        patch: { completed_at: nowIso() }
      });
    }
  });

  const detail = changeRequests.find(crId);
  const managerId = detail.created_by;
  email.send({
    templateCode: 'DOCUSIGN_COMPLETED',
    to: get('SELECT email FROM users WHERE id = ?', [managerId])?.email || getSetting('company.email'),
    crId,
    crReference: detail.cr_reference,
    variables: {
      manager_name: get('SELECT name FROM users WHERE id = ?', [managerId])?.name || 'there',
      cr_number: detail.cr_number,
      account_name: detail.account?.account_name,
      envelope_id: envelope?.envelope_id || '',
      completed_at: formatDateTime(nowIso()),
      cr_url: `${config.appUrl}/change-requests/${crId}`
    }
  });
  notifications.notify({
    userIds: [managerId].filter(Boolean),
    roles: ['ADMIN'],
    type: 'ENVELOPE_COMPLETED',
    title: `${detail.cr_number} fully signed`,
    body: 'The signed change request has been stored.',
    link: `/change-requests/${crId}`,
    crId,
    severity: 'SUCCESS'
  });

  return changeRequests.findRaw(crId);
}

/**
 * Keep simulated envelopes aligned with the portal signature flow.
 * Called whenever a change request detail is loaded.
 */
export function reconcile(crId) {
  const envelope = get("SELECT * FROM docusign_envelopes WHERE cr_id = ? AND provider = 'SIMULATED' ORDER BY created_at DESC LIMIT 1", [crId]);
  if (!envelope) return null;
  const cr = changeRequests.findRaw(crId);

  if (['COMPLETED', 'SIGNED', 'CUSTOMER_APPROVED'].includes(cr.status) && envelope.status !== 'COMPLETED') {
    const signed = get("SELECT file_path FROM document_versions WHERE cr_id = ? AND status = 'SIGNED' ORDER BY generated_at DESC LIMIT 1", [crId]);
    update('docusign_envelopes', envelope.id, {
      status: 'COMPLETED',
      delivered_at: envelope.delivered_at || nowIso(),
      viewed_at: envelope.viewed_at || cr.customer_viewed_at,
      signed_at: cr.signed_at || nowIso(),
      completed_at: cr.completed_at || nowIso(),
      signed_document_path: signed?.file_path || envelope.signed_document_path,
      updated_at: nowIso()
    });
    audit.record({
      entityType: 'ENVELOPE',
      entityId: envelope.id,
      crId,
      action: ACTIONS.ENVELOPE_COMPLETED,
      actor: { type: 'SYSTEM', name: 'System' },
      newValue: { status: 'COMPLETED' }
    });
  } else if (cr.customer_viewed_at && ['SENT', 'DELIVERED'].includes(envelope.status)) {
    update('docusign_envelopes', envelope.id, { status: 'VIEWED', viewed_at: cr.customer_viewed_at, updated_at: nowIso() });
  } else if (cr.status === 'CUSTOMER_REJECTED' && envelope.status !== 'DECLINED') {
    update('docusign_envelopes', envelope.id, {
      status: 'DECLINED',
      declined_at: nowIso(),
      decline_reason: cr.customer_rejection_comments,
      updated_at: nowIso()
    });
  }
  return get('SELECT * FROM docusign_envelopes WHERE id = ?', [envelope.id]);
}

export function voidEnvelope(crId, reason, actor) {
  const envelope = get('SELECT * FROM docusign_envelopes WHERE cr_id = ? ORDER BY created_at DESC LIMIT 1', [crId]);
  if (!envelope) throw errors.notFound('No envelope has been created for this change request');
  if (['COMPLETED', 'VOIDED'].includes(envelope.status)) throw errors.invalidState('This envelope can no longer be voided');

  update('docusign_envelopes', envelope.id, {
    status: 'VOIDED',
    voided_at: nowIso(),
    decline_reason: reason || null,
    updated_at: nowIso()
  });
  shareLinks.revokeForChangeRequest(crId, 'CUSTOMER');
  audit.record({
    entityType: 'ENVELOPE',
    entityId: envelope.id,
    crId,
    action: ACTIONS.ENVELOPE_UPDATED,
    actor,
    newValue: { status: 'VOIDED' },
    comments: reason
  });
  return get('SELECT * FROM docusign_envelopes WHERE id = ?', [envelope.id]);
}

/* ------------------------------------------------------------- webhook -- */

export function handleWebhook(rawBody, signatureHeader) {
  const secret = getSetting('docusign.webhook_secret');
  if (secret) {
    const expected = hmacSignature(rawBody, secret);
    if (!signatureHeader || signatureHeader !== expected) {
      throw errors.forbidden('Invalid webhook signature');
    }
  }

  let payload;
  try {
    payload = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
  } catch {
    throw errors.validation('Webhook payload is not valid JSON');
  }

  const envelopeId = payload?.data?.envelopeId || payload?.envelopeId || payload?.envelopeSummary?.envelopeId;
  const status = payload?.data?.envelopeSummary?.status || payload?.status || payload?.event;
  if (!envelopeId) throw errors.validation('Webhook payload did not include an envelope id');

  const envelope = get('SELECT * FROM docusign_envelopes WHERE envelope_id = ?', [envelopeId]);
  if (!envelope) throw errors.notFound('Unknown envelope');

  const updated = applyEnvelopeStatus(envelope.id, String(status).replace('envelope-', ''), payload);
  if (updated.status === 'COMPLETED') completeChangeRequest(envelope.cr_id, updated);
  return { ok: true, envelope_id: envelopeId, status: updated.status };
}

export function listForChangeRequest(crId) {
  return all('SELECT * FROM docusign_envelopes WHERE cr_id = ? ORDER BY created_at DESC', [crId]);
}

export async function testConnection() {
  const provider = providerName();
  if (provider === 'SIMULATED') {
    return { ok: true, provider, message: 'Simulated provider is active — no external call is required.' };
  }
  const token = await accessToken();
  const baseUri = String(getSetting('docusign.base_uri')).replace(/\/+$/, '');
  const accountId = getSetting('docusign.account_id');
  const response = await fetch(`${baseUri}/v2.1/accounts/${accountId}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw errors.integration(`DocuSign returned ${response.status}: ${body.message || 'unknown error'}`);
  return { ok: true, provider, message: `Connected to DocuSign account ${body.accountName || accountId}` };
}

export default {
  providerName,
  isEnabled,
  integrationStatus,
  sendEnvelope,
  refresh,
  reconcile,
  voidEnvelope,
  handleWebhook,
  listForChangeRequest,
  testConnection,
  completeChangeRequest
};
