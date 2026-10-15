import { all, get, run, transaction } from '../db/index.js';
import { errors } from '../lib/errors.js';

export const ROLES = [
  { code: 'ADMIN', name: 'Administrator', description: 'Full access including users, settings and integrations', sort_order: 1 },
  { code: 'CR_MANAGER', name: 'Change Request Manager', description: 'Owns accounts and the change request lifecycle', sort_order: 2 },
  { code: 'APPROVER', name: 'Approver', description: 'Reviews and decides on assigned change requests', sort_order: 3 },
  { code: 'VIEWER', name: 'Viewer', description: 'Read-only access to accounts, change requests and reports', sort_order: 4 }
];

export const PERMISSIONS = [
  { code: 'dashboard.view', module: 'Dashboard', description: 'View the executive dashboard' },
  { code: 'account.view', module: 'Accounts', description: 'View accounts and MSAs' },
  { code: 'account.create', module: 'Accounts', description: 'Create accounts' },
  { code: 'account.edit', module: 'Accounts', description: 'Edit accounts' },
  { code: 'account.delete', module: 'Accounts', description: 'Delete accounts without change requests' },
  { code: 'msa.create', module: 'MSA', description: 'Add an MSA to an account' },
  { code: 'msa.edit', module: 'MSA', description: 'Edit MSA details' },
  { code: 'cr.view', module: 'Change Requests', description: 'View change requests' },
  { code: 'cr.create', module: 'Change Requests', description: 'Create change requests' },
  { code: 'cr.edit', module: 'Change Requests', description: 'Edit draft change requests' },
  { code: 'cr.delete', module: 'Change Requests', description: 'Delete draft change requests' },
  { code: 'cr.submit', module: 'Change Requests', description: 'Submit for internal approval' },
  { code: 'cr.revise', module: 'Change Requests', description: 'Return a rejected CR to draft' },
  { code: 'cr.cancel', module: 'Change Requests', description: 'Cancel a change request' },
  { code: 'cr.hold', module: 'Change Requests', description: 'Put a change request on hold' },
  { code: 'cr.approve', module: 'Approvals', description: 'Approve or reject assigned change requests' },
  { code: 'document.generate', module: 'Documents', description: 'Generate CR documents' },
  { code: 'document.view', module: 'Documents', description: 'View documents and versions' },
  { code: 'document.download', module: 'Documents', description: 'Download documents' },
  { code: 'customer.share', module: 'Customer', description: 'Share a change request with the customer' },
  { code: 'docusign.send', module: 'Integration', description: 'Send a change request for e-signature' },
  { code: 'docusign.void', module: 'Integration', description: 'Void an e-signature envelope' },
  { code: 'report.view', module: 'Reports', description: 'View reports' },
  { code: 'report.export', module: 'Reports', description: 'Export reports' },
  { code: 'notification.view', module: 'Notifications', description: 'Access the notification centre' },
  { code: 'audit.view', module: 'Audit', description: 'View audit history' },
  { code: 'email.view', module: 'Communication', description: 'View the email outbox' },
  { code: 'user.manage', module: 'Administration', description: 'Manage users' },
  { code: 'role.manage', module: 'Administration', description: 'Manage role permissions' },
  { code: 'settings.manage', module: 'Administration', description: 'Manage application settings' },
  { code: 'integration.manage', module: 'Administration', description: 'Manage integrations' }
].map((permission, index) => ({ ...permission, sort_order: index }));

export const ROLE_MATRIX = {
  ADMIN: PERMISSIONS.map((p) => p.code),
  CR_MANAGER: [
    'dashboard.view', 'account.view', 'account.create', 'account.edit', 'msa.create', 'msa.edit',
    'cr.view', 'cr.create', 'cr.edit', 'cr.submit', 'cr.revise', 'cr.cancel', 'cr.hold',
    'document.generate', 'document.view', 'document.download', 'customer.share', 'docusign.send',
    'report.view', 'report.export', 'notification.view', 'audit.view', 'email.view'
  ],
  APPROVER: [
    'dashboard.view', 'account.view', 'cr.view', 'cr.approve', 'document.view', 'document.download',
    'report.view', 'report.export', 'notification.view', 'audit.view'
  ],
  VIEWER: [
    'dashboard.view', 'account.view', 'cr.view', 'document.view', 'document.download',
    'report.view', 'report.export', 'notification.view', 'audit.view'
  ]
};

/** Permissions that only ever apply to records assigned to the actor. */
export const SCOPED_ROLES = new Set(['APPROVER']);

export function seedRbac() {
  transaction(() => {
    for (const role of ROLES) {
      run(
        `INSERT INTO roles (code, name, description, is_system, sort_order) VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(code) DO UPDATE SET name = excluded.name, description = excluded.description`,
        [role.code, role.name, role.description, role.sort_order]
      );
    }
    for (const permission of PERMISSIONS) {
      run(
        `INSERT INTO permissions (code, module, description, sort_order) VALUES (?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET module = excluded.module, description = excluded.description, sort_order = excluded.sort_order`,
        [permission.code, permission.module, permission.description, permission.sort_order]
      );
    }
    const existing = get('SELECT COUNT(*) AS count FROM role_permissions')?.count || 0;
    if (existing === 0) {
      for (const [roleCode, permissionCodes] of Object.entries(ROLE_MATRIX)) {
        for (const code of permissionCodes) {
          run('INSERT INTO role_permissions (role_code, permission_code) VALUES (?, ?) ON CONFLICT DO NOTHING', [
            roleCode,
            code
          ]);
        }
      }
    } else {
      // keep ADMIN complete when new permissions are introduced by an upgrade
      for (const code of ROLE_MATRIX.ADMIN) {
        run('INSERT INTO role_permissions (role_code, permission_code) VALUES (?, ?) ON CONFLICT DO NOTHING', ['ADMIN', code]);
      }
    }
  });
}

export function permissionsForRole(roleCode) {
  return all('SELECT permission_code FROM role_permissions WHERE role_code = ? ORDER BY permission_code', [roleCode]).map(
    (r) => r.permission_code
  );
}

export function listRoles() {
  return all('SELECT * FROM roles ORDER BY sort_order').map((role) => ({
    ...role,
    permissions: permissionsForRole(role.code),
    user_count: get('SELECT COUNT(*) AS count FROM users WHERE role_code = ?', [role.code])?.count || 0
  }));
}

export function listPermissions() {
  return all('SELECT * FROM permissions ORDER BY sort_order');
}

export function setRolePermissions(roleCode, permissionCodes = []) {
  const role = get('SELECT * FROM roles WHERE code = ?', [roleCode]);
  if (!role) throw errors.notFound('Role not found');
  if (roleCode === 'ADMIN') throw errors.forbidden('The Administrator role always retains every permission');

  const valid = new Set(listPermissions().map((p) => p.code));
  const invalid = permissionCodes.filter((code) => !valid.has(code));
  if (invalid.length) throw errors.validation(`Unknown permission(s): ${invalid.join(', ')}`);

  transaction(() => {
    run('DELETE FROM role_permissions WHERE role_code = ?', [roleCode]);
    for (const code of permissionCodes) {
      run('INSERT INTO role_permissions (role_code, permission_code) VALUES (?, ?)', [roleCode, code]);
    }
  });
  return permissionsForRole(roleCode);
}

export function can(actor, permission) {
  if (!actor) return false;
  if (actor.role_code === 'ADMIN') return true;
  return (actor.permissions || []).includes(permission);
}

export function assertCan(actor, permission) {
  if (!can(actor, permission)) {
    throw errors.forbidden(`You do not have permission to ${permission.replace('.', ' ')}`);
  }
}

export default {
  ROLES,
  PERMISSIONS,
  ROLE_MATRIX,
  seedRbac,
  permissionsForRole,
  listRoles,
  listPermissions,
  setRolePermissions,
  can,
  assertCan
};
