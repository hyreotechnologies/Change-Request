import { all, get, insert, run } from '../db/index.js';
import { uid } from '../lib/ids.js';
import { nowIso } from '../lib/dates.js';
import { errors } from '../lib/errors.js';

/** A user's saved change-request filters. Private to that user. */

const MAX_VIEWS = 20;
const ALLOWED_KEYS = new Set(['q', 'status', 'statusGroup', 'account', 'crType', 'priority', 'from', 'to', 'sort', 'owner', 'due', 'view']);

/** Keep only the filter keys the list page understands, so a view cannot smuggle anything else. */
function cleanQuery(query) {
  const params = new URLSearchParams(String(query || '').replace(/^\?/, ''));
  const kept = new URLSearchParams();
  for (const [key, value] of params) {
    if (ALLOWED_KEYS.has(key) && value) kept.set(key, value.slice(0, 200));
  }
  return kept.toString();
}

export function list(userId) {
  return all('SELECT id, name, query, sort_order, created_at FROM saved_views WHERE user_id = ? ORDER BY sort_order, created_at', [userId]);
}

export function create(userId, { name, query }) {
  const label = String(name || '').trim().slice(0, 60);
  if (!label) throw errors.validation('Give the view a name', [{ field: 'name', message: 'A name is required' }]);
  const count = get('SELECT COUNT(*) AS count FROM saved_views WHERE user_id = ?', [userId])?.count || 0;
  if (count >= MAX_VIEWS) throw errors.invalidState(`You can keep up to ${MAX_VIEWS} saved views. Delete one first.`);
  const duplicate = get('SELECT id FROM saved_views WHERE user_id = ? AND lower(name) = lower(?)', [userId, label]);
  if (duplicate) throw errors.validation(`You already have a view called "${label}"`, [{ field: 'name', message: 'Choose a different name' }]);

  const row = { id: uid('VEW'), user_id: userId, name: label, query: cleanQuery(query), sort_order: count, created_at: nowIso() };
  insert('saved_views', row);
  return row;
}

export function remove(userId, id) {
  const result = run('DELETE FROM saved_views WHERE id = ? AND user_id = ?', [id, userId]);
  if (!result.changes) throw errors.notFound('Saved view not found');
  return { deleted: true };
}

export default { list, create, remove };
