import { all, get, insert } from '../db/index.js';
import { uid } from '../lib/ids.js';
import { nowIso } from '../lib/dates.js';

/**
 * Append-only audit trail. The table itself refuses UPDATE and DELETE
 * (see schema.sql triggers), so this is the only way a record ever appears.
 */
export function record({
  entityType,
  entityId = null,
  crId = null,
  action,
  actor = null,
  field = null,
  oldValue = null,
  newValue = null,
  comments = null,
  ip = null,
  userAgent = null
}) {
  const row = {
    id: uid('AUD'),
    entity_type: entityType,
    entity_id: entityId,
    cr_id: crId,
    action,
    actor_type: actor?.type || (actor?.id ? 'USER' : 'SYSTEM'),
    actor_id: actor?.id || null,
    actor_label: actor?.name || actor?.email || 'System',
    field,
    old_value: serialise(oldValue),
    new_value: serialise(newValue),
    comments,
    ip_address: ip || actor?.ip || null,
    user_agent: userAgent || actor?.userAgent || null,
    created_at: nowIso()
  };
  insert('audit_logs', row);
  return row;
}

function serialise(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Record a field-by-field diff between two versions of a record. */
export function recordDiff({ entityType, entityId, crId, action, actor, before = {}, after = {}, fields = null, ip }) {
  const keys = fields || Array.from(new Set([...Object.keys(before), ...Object.keys(after)]));
  const changes = [];
  for (const key of keys) {
    const oldValue = before?.[key];
    const newValue = after?.[key];
    if (oldValue === newValue) continue;
    if ((oldValue ?? '') === (newValue ?? '')) continue;
    changes.push({ field: key, oldValue, newValue });
  }
  if (!changes.length) return [];
  for (const change of changes) {
    record({
      entityType,
      entityId,
      crId,
      action,
      actor,
      field: change.field,
      oldValue: change.oldValue,
      newValue: change.newValue,
      ip
    });
  }
  return changes;
}

export function listForChangeRequest(crId, { limit = 500 } = {}) {
  return all(
    `SELECT * FROM audit_logs WHERE cr_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    [crId, limit]
  );
}

export function listForEntity(entityType, entityId, { limit = 200 } = {}) {
  return all(
    `SELECT * FROM audit_logs WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    [entityType, entityId, limit]
  );
}

export function search({ entityType, action, actorId, crId, from, to, limit = 200, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (entityType) {
    where.push('entity_type = ?');
    params.push(entityType);
  }
  if (action) {
    where.push('action = ?');
    params.push(action);
  }
  if (actorId) {
    where.push('actor_id = ?');
    params.push(actorId);
  }
  if (crId) {
    where.push('cr_id = ?');
    params.push(crId);
  }
  if (from) {
    where.push('created_at >= ?');
    params.push(from);
  }
  if (to) {
    where.push('created_at <= ?');
    params.push(`${to}T23:59:59.999Z`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = all(
    `SELECT * FROM audit_logs ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const total = get(`SELECT COUNT(*) AS count FROM audit_logs ${clause}`, params)?.count || 0;
  return { rows, total };
}

export const ACTIONS = {
  CR_CREATED: 'CR_CREATED',
  CR_UPDATED: 'CR_UPDATED',
  CR_SCOPE_UPDATED: 'CR_SCOPE_UPDATED',
  CR_EFFORT_UPDATED: 'CR_EFFORT_UPDATED',
  CR_COST_UPDATED: 'CR_COST_UPDATED',
  CR_SUBMITTED: 'CR_SUBMITTED',
  CR_APPROVED: 'CR_APPROVED',
  CR_REJECTED: 'CR_REJECTED',
  CR_REVISED: 'CR_REVISED',
  CR_CANCELLED: 'CR_CANCELLED',
  CR_HELD: 'CR_HELD',
  CR_RESUMED: 'CR_RESUMED',
  CR_DELETED: 'CR_DELETED',
  CR_DUPLICATED: 'CR_DUPLICATED',
  CR_REASSIGNED: 'CR_REASSIGNED',
  REMINDER_SENT: 'REMINDER_SENT',
  ESCALATION_SENT: 'ESCALATION_SENT',
  STATUS_CHANGED: 'STATUS_CHANGED',
  DOCUMENT_GENERATED: 'DOCUMENT_GENERATED',
  DOCUMENT_DOWNLOADED: 'DOCUMENT_DOWNLOADED',
  EMAIL_SENT: 'EMAIL_SENT',
  EMAIL_OPENED: 'EMAIL_OPENED',
  LINK_CLICKED: 'LINK_CLICKED',
  SHARED_WITH_CUSTOMER: 'SHARED_WITH_CUSTOMER',
  CUSTOMER_VIEWED: 'CUSTOMER_VIEWED',
  CUSTOMER_APPROVED: 'CUSTOMER_APPROVED',
  CUSTOMER_REJECTED: 'CUSTOMER_REJECTED',
  CUSTOMER_SIGNED: 'CUSTOMER_SIGNED',
  ENVELOPE_CREATED: 'ENVELOPE_CREATED',
  ENVELOPE_UPDATED: 'ENVELOPE_UPDATED',
  ENVELOPE_COMPLETED: 'ENVELOPE_COMPLETED',
  ACCOUNT_CREATED: 'ACCOUNT_CREATED',
  ACCOUNT_UPDATED: 'ACCOUNT_UPDATED',
  MSA_CREATED: 'MSA_CREATED',
  MSA_UPDATED: 'MSA_UPDATED',
  USER_CREATED: 'USER_CREATED',
  USER_UPDATED: 'USER_UPDATED',
  LOGIN_SUCCEEDED: 'LOGIN_SUCCEEDED',
  LOGIN_FAILED: 'LOGIN_FAILED',
  LOGOUT: 'LOGOUT',
  OTP_ISSUED: 'OTP_ISSUED',
  SETTINGS_UPDATED: 'SETTINGS_UPDATED',
  PERMISSIONS_UPDATED: 'PERMISSIONS_UPDATED'
};

export default { record, recordDiff, listForChangeRequest, listForEntity, search, ACTIONS };
