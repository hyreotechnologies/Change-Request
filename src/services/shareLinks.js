import { get, insert, run } from '../db/index.js';
import { uid, randomToken } from '../lib/ids.js';
import { nowIso, addDays, isPast } from '../lib/dates.js';
import { hashToken, maskEmail } from '../lib/crypto.js';
import { errors } from '../lib/errors.js';
import { getSetting } from './settings.js';
import audit, { ACTIONS } from './audit.js';
import config from '../config.js';

/**
 * Single-purpose, expiring links for external actors.
 * A link is bound to one change request AND one email address; possession of
 * the token alone grants nothing until the OTP challenge on that address passes.
 *
 * A link stays usable after the recipient has decided, so they can still open
 * the change request and download their signed copy until it expires. Acting
 * twice is prevented by the state machine, not by revoking the link. Issuing a
 * new link for the same recipient supersedes the previous one, and voiding an
 * envelope revokes outstanding customer links explicitly.
 */
export function createLink({ crId, audience, email, recipientName = null, approvalId = null, actor = null, days = null }) {
  if (!email) throw errors.validation('An email address is required to create a secure link');
  const validityDays = days || Number(getSetting('security.portal_link_days', 14));
  const token = randomToken(32);

  // supersede any live link for the same recipient and purpose
  run(
    `UPDATE share_links SET revoked_at = ?
      WHERE cr_id = ? AND audience = ? AND lower(email) = lower(?) AND revoked_at IS NULL`,
    [nowIso(), crId, audience, email]
  );

  const row = {
    id: uid('LNK'),
    cr_id: crId,
    audience,
    email: String(email).toLowerCase(),
    recipient_name: recipientName,
    token_hash: hashToken(token),
    approval_id: approvalId,
    expires_at: addDays(validityDays),
    click_count: 0,
    created_by: actor?.id || null,
    created_at: nowIso()
  };
  insert('share_links', row);

  return { ...row, token, url: `${config.appUrl}/s/${token}` };
}

export function resolveToken(token) {
  if (!token) throw errors.notFound('This link is not valid');
  const link = get('SELECT * FROM share_links WHERE token_hash = ?', [hashToken(token)]);
  if (!link) throw errors.notFound('This link is not valid or has been replaced by a newer one');
  if (link.revoked_at) throw errors.forbidden('This link has been revoked. Please ask for a new one.');
  if (isPast(link.expires_at)) throw errors.forbidden('This link has expired. Please ask for a new one.');
  return link;
}

export function registerClick(token, { ip = null, userAgent = null } = {}) {
  const link = resolveToken(token);
  run(
    `UPDATE share_links SET click_count = click_count + 1,
        first_clicked_at = COALESCE(first_clicked_at, ?), last_clicked_at = ? WHERE id = ?`,
    [nowIso(), nowIso(), link.id]
  );
  if (!link.first_clicked_at) {
    audit.record({
      entityType: 'SHARE_LINK',
      entityId: link.id,
      crId: link.cr_id,
      action: ACTIONS.LINK_CLICKED,
      actor: { type: link.audience === 'CUSTOMER' ? 'CUSTOMER' : 'APPROVER', name: link.email },
      ip,
      userAgent
    });
  }
  return link;
}

export function revokeForChangeRequest(crId, audience = null) {
  const params = [nowIso(), crId];
  let sql = 'UPDATE share_links SET revoked_at = ? WHERE cr_id = ? AND revoked_at IS NULL';
  if (audience) {
    sql += ' AND audience = ?';
    params.push(audience);
  }
  run(sql, params);
}

export function describe(link) {
  return {
    id: link.id,
    audience: link.audience,
    masked_email: maskEmail(link.email),
    expires_at: link.expires_at,
    cr_id: link.cr_id
  };
}

export default { createLink, resolveToken, registerClick, revokeForChangeRequest, describe };
