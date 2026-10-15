import { all, get, insert, run } from '../db/index.js';
import { uid } from '../lib/ids.js';
import { nowIso } from '../lib/dates.js';
import { errors } from '../lib/errors.js';
import { getSetting } from './settings.js';

function usersByEmail(emails = []) {
  const clean = emails.filter(Boolean).map((e) => String(e).toLowerCase());
  if (!clean.length) return [];
  const placeholders = clean.map(() => '?').join(', ');
  return all(`SELECT * FROM users WHERE lower(email) IN (${placeholders}) AND is_active = 1`, clean);
}

function usersByRole(roles = []) {
  if (!roles.length) return [];
  const placeholders = roles.map(() => '?').join(', ');
  return all(`SELECT * FROM users WHERE role_code IN (${placeholders}) AND is_active = 1`, roles);
}

/**
 * Create in-app notifications.
 * Recipients can be given as user ids, email addresses or role codes.
 */
export function notify({ userIds = [], emails = [], roles = [], type, title, body = null, link = null, crId = null, severity = 'INFO' }) {
  if (!getSetting('notifications.inapp_enabled', true)) return [];

  const recipients = new Map();
  for (const id of userIds.filter(Boolean)) {
    const user = get('SELECT * FROM users WHERE id = ? AND is_active = 1', [id]);
    if (user) recipients.set(user.id, user);
  }
  for (const user of usersByEmail(emails)) recipients.set(user.id, user);
  for (const user of usersByRole(roles)) recipients.set(user.id, user);

  const created = [];
  for (const user of recipients.values()) {
    const row = {
      id: uid('NTF'),
      user_id: user.id,
      cr_id: crId,
      type,
      title,
      body,
      link,
      severity,
      is_read: 0,
      created_at: nowIso()
    };
    insert('notifications', row);
    created.push(row);
  }
  return created;
}

export function list(userId, { unreadOnly = false, limit = 50, offset = 0 } = {}) {
  const where = unreadOnly ? 'AND is_read = 0' : '';
  const rows = all(
    `SELECT n.*, cr.cr_number, cr.title AS cr_title
       FROM notifications n
       LEFT JOIN change_requests cr ON cr.id = n.cr_id
      WHERE n.user_id = ? ${where}
      ORDER BY n.created_at DESC
      LIMIT ? OFFSET ?`,
    [userId, limit, offset]
  );
  const unread = get('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0', [userId])?.count || 0;
  const total = get('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ?', [userId])?.count || 0;
  return { rows, unread, total };
}

export function unreadCount(userId) {
  return get('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0', [userId])?.count || 0;
}

export function markRead(id, userId) {
  run('UPDATE notifications SET is_read = 1, read_at = ? WHERE id = ? AND user_id = ?', [nowIso(), id, userId]);
  return get('SELECT * FROM notifications WHERE id = ?', [id]);
}

/** Dismiss one notification. Read state is irrelevant — the user decides. */
export function remove(id, userId) {
  const result = run('DELETE FROM notifications WHERE id = ? AND user_id = ?', [id, userId]);
  if (!result.changes) throw errors.notFound('Notification not found');
  return { deleted: true };
}

/**
 * Close notifications whose underlying action is done — an approval that has
 * been decided should not keep asking. Dismissed rather than marked read: a
 * to-do that no longer applies is noise, not history (the audit log keeps it).
 */
export function resolve({ crId, types = [], emails = [], userIds = [] }) {
  if (!crId || !types.length) return { cleared: 0 };

  const recipients = new Set(userIds.filter(Boolean));
  for (const address of emails.filter(Boolean)) {
    const user = get('SELECT id FROM users WHERE lower(email) = lower(?)', [address]);
    if (user) recipients.add(user.id);
  }

  const typePlaceholders = types.map(() => '?').join(', ');
  if (!recipients.size) {
    const result = run(`DELETE FROM notifications WHERE cr_id = ? AND type IN (${typePlaceholders})`, [crId, ...types]);
    return { cleared: result.changes };
  }

  const userPlaceholders = [...recipients].map(() => '?').join(', ');
  const result = run(
    `DELETE FROM notifications WHERE cr_id = ? AND type IN (${typePlaceholders}) AND user_id IN (${userPlaceholders})`,
    [crId, ...types, ...recipients]
  );
  return { cleared: result.changes };
}

/** Clear the whole list, or only the ones already read. */
export function clear(userId, { readOnly = false } = {}) {
  const result = readOnly
    ? run('DELETE FROM notifications WHERE user_id = ? AND is_read = 1', [userId])
    : run('DELETE FROM notifications WHERE user_id = ?', [userId]);
  return { cleared: result.changes };
}

export function markAllRead(userId) {
  const result = run('UPDATE notifications SET is_read = 1, read_at = ? WHERE user_id = ? AND is_read = 0', [
    nowIso(),
    userId
  ]);
  return { updated: result.changes };
}

export default { notify, list, unreadCount, markRead, markAllRead, remove, clear, resolve };
