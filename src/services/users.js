import { all, get, insert, run, update } from '../db/index.js';
import { nextUserId } from '../lib/ids.js';
import { nowIso } from '../lib/dates.js';
import { errors } from '../lib/errors.js';
import { validate, normaliseEmail } from '../lib/validate.js';
import audit, { ACTIONS } from './audit.js';
import { revokeAllSessionsForUser } from './auth.js';

const ROLE_CODES = ['ADMIN', 'CR_MANAGER', 'APPROVER', 'VIEWER'];

export function list({ q = null, role = null, status = null, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (q) {
    where.push('(name LIKE ? OR email LIKE ? OR IFNULL(department,"") LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (role) {
    where.push('role_code = ?');
    params.push(role);
  }
  if (status === 'ACTIVE') where.push('is_active = 1');
  if (status === 'INACTIVE') where.push('is_active = 0');

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = all(
    `SELECT u.*, r.name AS role_name FROM users u JOIN roles r ON r.code = u.role_code
     ${clause} ORDER BY u.is_active DESC, u.name LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const total = get(`SELECT COUNT(*) AS count FROM users u ${clause}`, params)?.count || 0;
  return { rows: rows.map(present), total };
}

export function find(id) {
  const row = get('SELECT u.*, r.name AS role_name FROM users u JOIN roles r ON r.code = u.role_code WHERE u.id = ?', [id]);
  if (!row) throw errors.notFound('User not found');
  return present(row);
}

export function findByEmail(emailAddress) {
  const row = get('SELECT * FROM users WHERE lower(email) = ?', [normaliseEmail(emailAddress)]);
  return row ? present(row) : null;
}

export function create(payload, actor) {
  const data = validate(payload, {
    name: { type: 'string', required: true, label: 'Name', maxLength: 120 },
    email: { type: 'email', required: true, label: 'Email address' },
    role_code: { type: 'string', required: true, label: 'Role', enum: ROLE_CODES },
    department: { type: 'string', label: 'Department', maxLength: 120 },
    designation: { type: 'string', label: 'Designation', maxLength: 120 },
    phone: { type: 'string', label: 'Phone', maxLength: 40 },
    is_active: { type: 'boolean', label: 'Active', default: 1 }
  });

  if (get('SELECT id FROM users WHERE lower(email) = ?', [data.email])) {
    throw errors.duplicate('A user with this email address already exists', { field: 'email' });
  }

  const row = {
    id: nextUserId(),
    name: data.name,
    email: data.email,
    role_code: data.role_code,
    department: data.department,
    designation: data.designation,
    phone: data.phone,
    is_active: data.is_active ?? 1,
    created_at: nowIso(),
    created_by: actor?.id || null
  };
  insert('users', row);
  audit.record({
    entityType: 'USER',
    entityId: row.id,
    action: ACTIONS.USER_CREATED,
    actor,
    newValue: { name: row.name, email: row.email, role: row.role_code }
  });
  return find(row.id);
}

export function edit(id, payload, actor) {
  const existing = get('SELECT * FROM users WHERE id = ?', [id]);
  if (!existing) throw errors.notFound('User not found');

  const data = validate(
    payload,
    {
      name: { type: 'string', label: 'Name', maxLength: 120 },
      email: { type: 'email', label: 'Email address' },
      role_code: { type: 'string', label: 'Role', enum: ROLE_CODES },
      department: { type: 'string', label: 'Department', maxLength: 120 },
      designation: { type: 'string', label: 'Designation', maxLength: 120 },
      phone: { type: 'string', label: 'Phone', maxLength: 40 },
      is_active: { type: 'boolean', label: 'Active' }
    },
    { partial: true }
  );

  if (data.email && data.email !== existing.email.toLowerCase()) {
    if (get('SELECT id FROM users WHERE lower(email) = ? AND id <> ?', [data.email, id])) {
      throw errors.duplicate('A user with this email address already exists', { field: 'email' });
    }
  }

  const losingAdmin =
    existing.role_code === 'ADMIN' &&
    ((data.role_code && data.role_code !== 'ADMIN') || data.is_active === 0);
  if (losingAdmin) {
    const remaining =
      get('SELECT COUNT(*) AS count FROM users WHERE role_code = ? AND is_active = 1 AND id <> ?', ['ADMIN', id])?.count || 0;
    if (remaining === 0) throw errors.invalidState('At least one active administrator must remain');
  }
  if (actor?.id === id && data.is_active === 0) {
    throw errors.invalidState('You cannot deactivate your own account');
  }

  update('users', id, { ...data, updated_at: nowIso(), updated_by: actor?.id || null });

  audit.recordDiff({
    entityType: 'USER',
    entityId: id,
    action: ACTIONS.USER_UPDATED,
    actor,
    before: existing,
    after: { ...existing, ...data },
    fields: ['name', 'email', 'role_code', 'department', 'designation', 'phone', 'is_active']
  });

  if (data.is_active === 0 || (data.role_code && data.role_code !== existing.role_code)) {
    revokeAllSessionsForUser(id);
  }
  return find(id);
}

export function setStatus(id, isActive, actor) {
  return edit(id, { is_active: isActive ? 1 : 0 }, actor);
}

/** Users who can be picked as internal owners in account forms. */
export function pickList() {
  return all(
    `SELECT id, name, email, role_code, department FROM users WHERE is_active = 1 ORDER BY name`
  );
}

function present(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role_code: row.role_code,
    role_name: row.role_name,
    department: row.department,
    designation: row.designation,
    phone: row.phone,
    is_active: Boolean(row.is_active),
    created_at: row.created_at,
    last_login_at: row.last_login_at
  };
}

export default { list, find, findByEmail, create, edit, setStatus, pickList };
