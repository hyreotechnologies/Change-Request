import { all, get, insert, run, transaction, update } from '../db/index.js';
import { nextChangeRequestId, uid } from '../lib/ids.js';
import { nowIso, todayIso, toDateOnly, addBusinessDays, businessDaysBetween } from '../lib/dates.js';
import { computeCosts, round2 } from '../lib/money.js';
import { errors, translateDbError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import audit, { ACTIONS } from './audit.js';
import documents from './documents.js';
import stateMachine, { STATUSES } from './stateMachine.js';
import numbering from './numbering.js';
import { getSetting } from './settings.js';
import sla from './sla.js';
import notifications from './notifications.js';

export const EFFORT_CATEGORIES = [
  { category: 'DEVELOPMENT', label: 'Development Efforts', sort_order: 1 },
  { category: 'TESTING', label: 'End-to-end Testing', sort_order: 2 },
  { category: 'BUSINESS_ANALYSIS', label: 'Business Analysis', sort_order: 3 },
  { category: 'PROJECT_MANAGEMENT', label: 'Project Management', sort_order: 4 },
  { category: 'DEPLOYMENT', label: 'Deployment', sort_order: 5 },
  { category: 'OTHER', label: 'Other', sort_order: 6 }
];

export const CR_TYPES = [
  'NEW_FEATURE', 'ENHANCEMENT', 'INTEGRATION', 'REPORT_ANALYTICS',
  'CONFIGURATION', 'BUG_FIX', 'SCOPE_CHANGE', 'OTHER'
];
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

const HEADER_FIELDS = {
  title: { type: 'string', required: true, label: 'CR title', maxLength: 200 },
  cr_date: { type: 'date', label: 'CR created date' },
  effective_date: { type: 'date', label: 'CR effective date' },
  requested_by: { type: 'string', label: 'Requested by', maxLength: 120 },
  customer_contact_name: { type: 'string', label: 'Customer contact', maxLength: 120 },
  customer_contact_email: { type: 'email', label: 'Customer contact email' },
  priority: { type: 'string', label: 'Priority', enum: PRIORITIES, default: 'MEDIUM' },
  cr_type: { type: 'string', label: 'CR type', enum: CR_TYPES, default: 'ENHANCEMENT' },
  description: { type: 'text', label: 'Description', maxLength: 8000 }
};

const TIMELINE_FIELDS = {
  dev_start_date: { type: 'date', label: 'Development start date' },
  dev_completion_date: { type: 'date', label: 'Development completion date' },
  test_start_date: { type: 'date', label: 'Testing start date' },
  test_completion_date: { type: 'date', label: 'Testing completion date' },
  target_release_date: { type: 'date', label: 'Target release date' },
  estimated_timeline: { type: 'string', label: 'Estimated timeline', maxLength: 200 },
  estimated_business_days: { type: 'number', label: 'Estimated business days', min: 0, max: 3650 },
  depends_on_po: { type: 'boolean', label: 'Dependency on PO' },
  po_required_date: { type: 'date', label: 'PO required date' },
  planned_production_release: { type: 'date', label: 'Planned production release' }
};

const COMMERCIAL_FIELDS = {
  payment_terms: { type: 'string', label: 'Payment terms', maxLength: 300 },
  po_required: { type: 'boolean', label: 'PO required' },
  po_number: { type: 'string', label: 'PO number', maxLength: 80 },
  invoice_terms: { type: 'text', label: 'Invoice terms', maxLength: 1000 },
  general_terms: { type: 'text', label: 'General terms', maxLength: 4000 }
};

/* -------------------------------------------------------------- creation -- */

export function create(payload, actor) {
  const accountId = payload.account_id;
  if (!accountId) throw errors.validation('Select an account before creating a change request', [{ field: 'account_id', message: 'Account is required' }]);

  const account = get('SELECT * FROM accounts WHERE id = ?', [accountId]);
  if (!account) throw errors.notFound('Account not found');
  if (account.status !== 'ACTIVE') throw errors.invalidState('This account is inactive; change requests cannot be raised against it');

  const msa = payload.msa_id
    ? get('SELECT * FROM msa_contracts WHERE id = ? AND account_id = ?', [payload.msa_id, accountId])
    : get('SELECT * FROM msa_contracts WHERE account_id = ? ORDER BY is_primary DESC, created_at LIMIT 1', [accountId]);
  if (!msa) throw errors.invalidState('This account has no MSA. Add an MSA before raising a change request.');
  if (msa.status === 'TERMINATED') throw errors.invalidState('The MSA is terminated; change requests cannot be raised against it');

  const header = validate(payload, HEADER_FIELDS);
  const approverContact = get(
    "SELECT * FROM customer_contacts WHERE account_id = ? AND contact_type = 'APPROVER' LIMIT 1",
    [accountId]
  );
  const primaryContact = get(
    "SELECT * FROM customer_contacts WHERE account_id = ? AND contact_type = 'PRIMARY' LIMIT 1",
    [accountId]
  );

  try {
    return transaction(() => {
      const seq = numbering.nextSequenceForAccount(accountId);
      const identifiers = numbering.buildIdentifiers({ account, msa, seq });
      const id = nextChangeRequestId();
      const now = nowIso();

      insert('change_requests', {
        id,
        cr_number: identifiers.cr_number,
        cr_reference: identifiers.cr_reference,
        seq_no: seq,
        account_id: accountId,
        msa_id: msa.id,
        title: header.title,
        cr_date: header.cr_date || todayIso(),
        effective_date: header.effective_date,
        requested_by: header.requested_by || actor?.name || null,
        customer_contact_name: header.customer_contact_name || primaryContact?.name || null,
        customer_contact_email: header.customer_contact_email || primaryContact?.email || null,
        priority: header.priority || 'MEDIUM',
        cr_type: header.cr_type || 'ENHANCEMENT',
        description: header.description,
        status: 'DRAFT',
        revision: 0,
        locked: 0,
        current_owner_user_id: actor?.id || null,

        snapshot_account_name: account.account_name,
        snapshot_account_code: account.account_code,
        snapshot_legal_entity: account.legal_entity_name,
        snapshot_msa_number: msa.msa_reference_number,
        snapshot_msa_date: msa.msa_date,
        snapshot_contract_start: msa.contract_start_date,
        snapshot_contract_end: msa.contract_end_date,
        snapshot_customer_approver: approverContact?.name || null,
        snapshot_customer_approver_email: approverContact?.email || null,
        snapshot_customer_approver_designation: approverContact?.designation || null,
        snapshot_account_manager: account.account_manager,
        snapshot_cr_manager: account.cr_manager || actor?.name || null,
        snapshot_internal_approver: account.internal_approver_name,
        snapshot_internal_approver_email: account.internal_approver_email,

        estimated_timeline: getSetting('defaults.estimated_timeline', ''),
        depends_on_po: msa.po_required ? 1 : 0,
        payment_terms: msa.payment_terms || getSetting('defaults.payment_terms', ''),
        po_required: msa.po_required ? 1 : 0,
        invoice_terms: getSetting('defaults.invoice_terms', ''),
        general_terms: (getSetting('terms.general_terms', []) || []).join('\n'),

        created_at: now,
        created_by: actor?.id || null,
        updated_at: now,
        updated_by: actor?.id || null
      });

      for (const category of EFFORT_CATEGORIES) {
        insert('change_request_efforts', {
          id: uid('EFF'),
          cr_id: id,
          category: category.category,
          label: category.label,
          hours: 0,
          sort_order: category.sort_order
        });
      }

      insert('change_request_costs', {
        id: uid('CST'),
        cr_id: id,
        billing_rate: Number(getSetting('defaults.billing_rate', 0)),
        currency: msa.currency || getSetting('defaults.currency', 'INR'),
        discount_type: 'NONE',
        tax_percent: Number(getSetting('defaults.tax_percent', 0)),
        updated_at: now
      });

      for (const [index, text] of (getSetting('terms.default_assumptions', []) || []).entries()) {
        insert('change_request_assumptions', { id: uid('ASM'), cr_id: id, text, sort_order: index });
      }

      if (Array.isArray(payload.items) && payload.items.length) saveItems(id, payload.items, actor, { skipAudit: true });

      audit.record({
        entityType: 'CHANGE_REQUEST',
        entityId: id,
        crId: id,
        action: ACTIONS.CR_CREATED,
        actor,
        newValue: { cr_number: identifiers.cr_number, cr_reference: identifiers.cr_reference, title: header.title },
        ip: actor?.ip
      });

      return find(id);
    });
  } catch (error) {
    throw translateDbError(error) || error;
  }
}

/* --------------------------------------------------------------- reading -- */

export function findRaw(id) {
  const cr = get('SELECT * FROM change_requests WHERE id = ? OR upper(cr_number) = upper(?)', [id, id]);
  if (!cr) throw errors.notFound('Change request not found');
  return cr;
}

export function find(id, { actor = null } = {}) {
  const cr = findRaw(id);
  assertVisible(cr, actor);

  const account = get('SELECT * FROM accounts WHERE id = ?', [cr.account_id]);
  const msa = get('SELECT * FROM msa_contracts WHERE id = ?', [cr.msa_id]);
  const items = all('SELECT * FROM change_request_items WHERE cr_id = ? ORDER BY sort_order, item_no', [cr.id]);
  const efforts = all('SELECT * FROM change_request_efforts WHERE cr_id = ? ORDER BY sort_order', [cr.id]);
  const costs = get('SELECT * FROM change_request_costs WHERE cr_id = ?', [cr.id]);
  const assumptions = all('SELECT * FROM change_request_assumptions WHERE cr_id = ? ORDER BY sort_order', [cr.id]);
  const dependencies = all('SELECT * FROM change_request_dependencies WHERE cr_id = ? ORDER BY sort_order', [cr.id]);
  const approvals = all('SELECT * FROM change_request_approvals WHERE cr_id = ? ORDER BY level, requested_at', [cr.id]);
  const customerApprovals = all('SELECT * FROM customer_approvals WHERE cr_id = ? ORDER BY signer_order', [cr.id]);
  const documents = all(
    `SELECT v.*, d.doc_type, d.title AS document_title
       FROM document_versions v JOIN documents d ON d.id = v.document_id
      WHERE v.cr_id = ? ORDER BY v.major DESC, v.minor DESC, v.generated_at DESC`,
    [cr.id]
  );
  const envelopes = all('SELECT * FROM docusign_envelopes WHERE cr_id = ? ORDER BY created_at DESC', [cr.id]);
  const owner = cr.current_owner_user_id ? get('SELECT id, name, email FROM users WHERE id = ?', [cr.current_owner_user_id]) : null;

  const totalEffort = round2(efforts.reduce((sum, e) => sum + Number(e.hours || 0), 0));
  const stageEnteredAt = get(`SELECT ${sla.stageEnteredSql('cr')} AS at FROM change_requests cr WHERE cr.id = ?`, [cr.id])?.at;

  return {
    ...cr,
    sla: sla.annotate({ status: cr.status, stage_entered_at: stageEnteredAt }).sla,
    status_label: stateMachine.label(cr.status),
    status_meta: STATUSES[cr.status] || null,
    is_editable: stateMachine.isEditable(cr.status) && !cr.locked,
    account,
    msa,
    items,
    efforts,
    costs: costs || null,
    total_effort: totalEffort,
    assumptions,
    dependencies,
    approvals,
    customer_approvals: customerApprovals,
    documents,
    envelopes,
    owner,
    permissions_context: {
      can_edit: stateMachine.isEditable(cr.status) && !cr.locked,
      can_submit: ['DRAFT', 'REVISION'].includes(cr.status),
      can_approve: cr.status === 'PENDING_INTERNAL_APPROVAL',
      can_share: ['INTERNALLY_APPROVED', 'READY_FOR_CUSTOMER', 'SENT_TO_CUSTOMER', 'CUSTOMER_VIEWED', 'CUSTOMER_APPROVAL_PENDING'].includes(cr.status),
      can_sign: ['READY_FOR_CUSTOMER', 'SENT_TO_CUSTOMER', 'CUSTOMER_VIEWED', 'CUSTOMER_APPROVAL_PENDING', 'CUSTOMER_APPROVED'].includes(cr.status),
      can_cancel: !stateMachine.isTerminal(cr.status)
    }
  };
}

/** APPROVER users only see change requests assigned to them. */
export function scopeClause(actor, alias = 'cr') {
  if (!actor || actor.role_code === 'ADMIN' || actor.role_code === 'CR_MANAGER' || actor.role_code === 'VIEWER') {
    return { sql: '', params: [] };
  }
  if (actor.role_code === 'APPROVER') {
    return {
      sql: `AND (EXISTS (SELECT 1 FROM change_request_approvals a WHERE a.cr_id = ${alias}.id AND lower(a.approver_email) = lower(?))
              OR lower(IFNULL(${alias}.snapshot_internal_approver_email,'')) = lower(?)
              OR ${alias}.created_by = ?)`,
      params: [actor.email, actor.email, actor.id]
    };
  }
  return { sql: '', params: [] };
}

function assertVisible(cr, actor) {
  if (!actor || actor.role_code !== 'APPROVER') return;
  const assigned = get(
    `SELECT 1 AS ok FROM change_request_approvals WHERE cr_id = ? AND lower(approver_email) = lower(?)`,
    [cr.id, actor.email]
  );
  const isApproverOfRecord = String(cr.snapshot_internal_approver_email || '').toLowerCase() === String(actor.email).toLowerCase();
  if (!assigned && !isApproverOfRecord && cr.created_by !== actor.id) {
    throw errors.forbidden('You do not have access to this change request');
  }
}

export function list(filters = {}, actor = null) {
  const {
    q = null, accountId = null, msaId = null, status = null, statusGroup = null, crType = null,
    priority = null, owner = null, from = null, to = null, minCost = null, maxCost = null,
    due = null, ids = null, limit = 50, offset = 0, sort = 'recent'
  } = filters;

  const where = ['1 = 1'];
  const params = [];

  if (q) {
    where.push(`(cr.cr_number LIKE ? OR cr.cr_reference LIKE ? OR cr.title LIKE ? OR a.account_name LIKE ? OR m.msa_reference_number LIKE ?)`);
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }
  if (accountId) {
    where.push('cr.account_id = ?');
    params.push(accountId);
  }
  if (msaId) {
    where.push('cr.msa_id = ?');
    params.push(msaId);
  }
  if (status) {
    const statuses = Array.isArray(status) ? status : String(status).split(',').filter(Boolean);
    where.push(`cr.status IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  }
  if (statusGroup && stateMachine.STATUS_GROUPS[statusGroup]) {
    const group = stateMachine.STATUS_GROUPS[statusGroup];
    where.push(`cr.status IN (${group.map(() => '?').join(', ')})`);
    params.push(...group);
  }
  if (crType) {
    where.push('cr.cr_type = ?');
    params.push(crType);
  }
  if (priority) {
    where.push('cr.priority = ?');
    params.push(priority);
  }
  if (owner) {
    // "me" resolves to the signed-in user so a saved view works for whoever opens it
    where.push('cr.current_owner_user_id = ?');
    params.push(owner === 'me' ? actor?.id || null : owner);
  }
  if (ids) {
    const list = (Array.isArray(ids) ? ids : String(ids).split(',')).filter(Boolean).slice(0, 500);
    if (list.length) {
      where.push(`cr.id IN (${list.map(() => '?').join(', ')})`);
      params.push(...list);
    }
  }
  if (due && ['overdue', 'due_soon', 'at_risk'].includes(due)) {
    const clause = sla.filterSql(due);
    where.push(`1 = 1 ${clause.sql}`);
    params.push(...clause.params);
  }
  if (from) {
    where.push('cr.cr_date >= ?');
    params.push(toDateOnly(from));
  }
  if (to) {
    where.push('cr.cr_date <= ?');
    params.push(toDateOnly(to));
  }
  if (minCost !== null && minCost !== undefined && minCost !== '') {
    where.push('IFNULL(cc.total_cost,0) >= ?');
    params.push(Number(minCost));
  }
  if (maxCost !== null && maxCost !== undefined && maxCost !== '') {
    where.push('IFNULL(cc.total_cost,0) <= ?');
    params.push(Number(maxCost));
  }

  const scope = scopeClause(actor);
  const whereSql = `WHERE ${where.join(' AND ')} ${scope.sql}`;
  const allParams = [...params, ...scope.params];

  const orderBy =
    {
      recent: 'cr.updated_at DESC, cr.created_at DESC',
      oldest: 'cr.created_at ASC',
      cost: 'IFNULL(cc.total_cost,0) DESC',
      cr_number: 'cr.cr_number ASC',
      status: 'cr.status ASC, cr.updated_at DESC',
      stage_age: 'stage_entered_at ASC'
    }[sort] || 'cr.updated_at DESC';

  const rows = all(
    `SELECT cr.id, cr.cr_number, cr.cr_reference, cr.title, cr.cr_date, cr.status, cr.priority, cr.cr_type,
            cr.target_release_date, cr.created_at, cr.updated_at, cr.submitted_at, cr.revision,
            a.id AS account_id, a.account_name, a.account_code,
            m.msa_reference_number,
            IFNULL(cc.total_cost,0) AS total_cost, IFNULL(cc.currency,'INR') AS currency,
            IFNULL((SELECT SUM(hours) FROM change_request_efforts e WHERE e.cr_id = cr.id),0) AS total_effort,
            u.name AS owner_name, cr.current_owner_user_id,
            ${sla.stageEnteredSql('cr')} AS stage_entered_at
       FROM change_requests cr
       JOIN accounts a ON a.id = cr.account_id
       JOIN msa_contracts m ON m.id = cr.msa_id
       LEFT JOIN change_request_costs cc ON cc.cr_id = cr.id
       LEFT JOIN users u ON u.id = cr.current_owner_user_id
       ${whereSql}
      ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    [...allParams, limit, offset]
  );

  const total =
    get(
      `SELECT COUNT(*) AS count FROM change_requests cr
         JOIN accounts a ON a.id = cr.account_id
         JOIN msa_contracts m ON m.id = cr.msa_id
         LEFT JOIN change_request_costs cc ON cc.cr_id = cr.id
        ${whereSql}`,
      allParams
    )?.count || 0;

  return {
    rows: rows.map((row) => sla.annotate({ ...row, status_label: stateMachine.label(row.status) })),
    total
  };
}

/* --------------------------------------------------------------- editing -- */

export function editHeader(id, payload, actor) {
  const cr = findRaw(id);
  stateMachine.assertEditable(cr);

  const header = validate(payload, HEADER_FIELDS, { partial: true });
  const timeline = validate(payload, TIMELINE_FIELDS, { partial: true });
  const commercial = validate(payload, COMMERCIAL_FIELDS, { partial: true });
  const data = { ...header, ...timeline, ...commercial };

  if (Object.keys(data).length === 0) return find(id, { actor });

  transaction(() => {
    update('change_requests', id, { ...data, updated_at: nowIso(), updated_by: actor?.id || null });
    audit.recordDiff({
      entityType: 'CHANGE_REQUEST',
      entityId: id,
      crId: id,
      action: ACTIONS.CR_UPDATED,
      actor,
      before: cr,
      after: { ...cr, ...data },
      fields: Object.keys(data),
      ip: actor?.ip
    });
  });
  return find(id, { actor });
}

export function saveItems(id, items, actor, { skipAudit = false } = {}) {
  const cr = findRaw(id);
  if (!skipAudit) stateMachine.assertEditable(cr);

  const cleaned = (Array.isArray(items) ? items : []).map((item, index) =>
    validate(
      { ...item, item_no: item.item_no ?? index + 1, sort_order: index },
      {
        feature_name: { type: 'string', required: true, label: `Item ${index + 1} feature name`, maxLength: 200 },
        requested_change: { type: 'text', label: 'Requested change', maxLength: 4000 },
        detailed_description: { type: 'text', label: 'Detailed description', maxLength: 8000 },
        business_justification: { type: 'text', label: 'Business justification', maxLength: 4000 },
        current_behaviour: { type: 'text', label: 'Current behaviour', maxLength: 4000 },
        expected_behaviour: { type: 'text', label: 'Expected behaviour', maxLength: 4000 },
        release_date: { type: 'date', label: 'Release date' },
        remarks: { type: 'text', label: 'Remarks', maxLength: 2000 },
        item_no: { type: 'integer', label: 'Item number', min: 1 },
        sort_order: { type: 'integer', label: 'Order', min: 0 }
      }
    )
  );

  transaction(() => {
    run('DELETE FROM change_request_items WHERE cr_id = ?', [id]);
    cleaned.forEach((item, index) => {
      insert('change_request_items', {
        id: uid('ITM'),
        cr_id: id,
        item_no: index + 1,
        feature_name: item.feature_name,
        requested_change: item.requested_change,
        detailed_description: item.detailed_description,
        business_justification: item.business_justification,
        current_behaviour: item.current_behaviour,
        expected_behaviour: item.expected_behaviour,
        release_date: item.release_date,
        remarks: item.remarks,
        sort_order: index
      });
    });
    run('UPDATE change_requests SET updated_at = ?, updated_by = ? WHERE id = ?', [nowIso(), actor?.id || null, id]);
    if (!skipAudit) {
      audit.record({
        entityType: 'CHANGE_REQUEST',
        entityId: id,
        crId: id,
        action: ACTIONS.CR_SCOPE_UPDATED,
        actor,
        newValue: { items: cleaned.length, features: cleaned.map((i) => i.feature_name) },
        ip: actor?.ip
      });
    }
  });
  return all('SELECT * FROM change_request_items WHERE cr_id = ? ORDER BY sort_order', [id]);
}

export function saveEfforts(id, efforts, actor) {
  const cr = findRaw(id);
  stateMachine.assertEditable(cr);

  const byCategory = {};
  for (const entry of Array.isArray(efforts) ? efforts : []) {
    if (!entry || !entry.category) continue;
    if (!EFFORT_CATEGORIES.some((c) => c.category === entry.category)) continue;
    byCategory[entry.category] = Math.max(0, Number(entry.hours) || 0);
  }

  const before = all('SELECT category, hours FROM change_request_efforts WHERE cr_id = ?', [id]);

  transaction(() => {
    for (const category of EFFORT_CATEGORIES) {
      const hours = round2(byCategory[category.category] ?? 0);
      const existing = get('SELECT id FROM change_request_efforts WHERE cr_id = ? AND category = ?', [id, category.category]);
      if (existing) {
        update('change_request_efforts', existing.id, { hours, label: category.label });
      } else {
        insert('change_request_efforts', {
          id: uid('EFF'),
          cr_id: id,
          category: category.category,
          label: category.label,
          hours,
          sort_order: category.sort_order
        });
      }
    }
    recomputeCosts(id);
    run('UPDATE change_requests SET updated_at = ?, updated_by = ? WHERE id = ?', [nowIso(), actor?.id || null, id]);
    audit.record({
      entityType: 'CHANGE_REQUEST',
      entityId: id,
      crId: id,
      action: ACTIONS.CR_EFFORT_UPDATED,
      actor,
      oldValue: Object.fromEntries(before.map((e) => [e.category, e.hours])),
      newValue: byCategory,
      ip: actor?.ip
    });
  });

  return all('SELECT * FROM change_request_efforts WHERE cr_id = ? ORDER BY sort_order', [id]);
}

export function saveCosts(id, payload, actor) {
  const cr = findRaw(id);
  stateMachine.assertEditable(cr);

  const data = validate(payload, {
    billing_rate: { type: 'number', label: 'Billing rate', min: 0 },
    currency: { type: 'string', label: 'Currency', maxLength: 5, upper: true },
    discount_type: { type: 'string', label: 'Discount type', enum: ['NONE', 'PERCENT', 'FIXED'] },
    discount_value: { type: 'number', label: 'Discount', min: 0 },
    tax_percent: { type: 'number', label: 'Tax %', min: 0, max: 100 }
  }, { partial: true });

  const existing = get('SELECT * FROM change_request_costs WHERE cr_id = ?', [id]);
  const merged = {
    billing_rate: data.billing_rate ?? existing?.billing_rate ?? 0,
    currency: data.currency ?? existing?.currency ?? 'INR',
    discount_type: data.discount_type ?? existing?.discount_type ?? 'NONE',
    discount_value: data.discount_value ?? existing?.discount_value ?? 0,
    tax_percent: data.tax_percent ?? existing?.tax_percent ?? 0
  };

  transaction(() => {
    recomputeCosts(id, merged);
    run('UPDATE change_requests SET updated_at = ?, updated_by = ? WHERE id = ?', [nowIso(), actor?.id || null, id]);
    audit.record({
      entityType: 'CHANGE_REQUEST',
      entityId: id,
      crId: id,
      action: ACTIONS.CR_COST_UPDATED,
      actor,
      oldValue: existing ? { billing_rate: existing.billing_rate, total_cost: existing.total_cost } : null,
      newValue: get('SELECT billing_rate, subtotal, discount_amount, tax_amount, total_cost FROM change_request_costs WHERE cr_id = ?', [id]),
      ip: actor?.ip
    });
  });

  return get('SELECT * FROM change_request_costs WHERE cr_id = ?', [id]);
}

/** Recompute every derived money field from the effort rows. Never trusts the client. */
export function recomputeCosts(crId, overrides = null) {
  const existing = get('SELECT * FROM change_request_costs WHERE cr_id = ?', [crId]);
  const efforts = all('SELECT category, hours FROM change_request_efforts WHERE cr_id = ?', [crId]);
  const effortByCategory = Object.fromEntries(efforts.map((e) => [e.category, Number(e.hours) || 0]));

  const input = {
    effortByCategory,
    billingRate: overrides?.billing_rate ?? existing?.billing_rate ?? 0,
    discountType: overrides?.discount_type ?? existing?.discount_type ?? 'NONE',
    discountValue: overrides?.discount_value ?? existing?.discount_value ?? 0,
    taxPercent: overrides?.tax_percent ?? existing?.tax_percent ?? 0
  };
  const computed = computeCosts(input);
  const currency = overrides?.currency ?? existing?.currency ?? 'INR';

  const row = {
    billing_rate: computed.billing_rate,
    currency,
    total_effort: computed.total_effort,
    development_cost: computed.development_cost,
    testing_cost: computed.testing_cost,
    other_cost: computed.other_cost,
    subtotal: computed.subtotal,
    discount_type: computed.discount_type,
    discount_value: computed.discount_value,
    discount_amount: computed.discount_amount,
    tax_percent: computed.tax_percent,
    tax_amount: computed.tax_amount,
    total_cost: computed.total_cost,
    updated_at: nowIso()
  };

  if (existing) update('change_request_costs', existing.id, row);
  else insert('change_request_costs', { id: uid('CST'), cr_id: crId, ...row });

  return { ...row, cr_id: crId };
}

export function saveAssumptions(id, entries, actor) {
  const cr = findRaw(id);
  stateMachine.assertEditable(cr);
  const cleaned = (Array.isArray(entries) ? entries : [])
    .map((e) => (typeof e === 'string' ? e : e?.text))
    .map((t) => String(t || '').trim())
    .filter(Boolean)
    .slice(0, 50);

  transaction(() => {
    run('DELETE FROM change_request_assumptions WHERE cr_id = ?', [id]);
    cleaned.forEach((text, index) => {
      insert('change_request_assumptions', { id: uid('ASM'), cr_id: id, text, sort_order: index });
    });
    run('UPDATE change_requests SET updated_at = ?, updated_by = ? WHERE id = ?', [nowIso(), actor?.id || null, id]);
    audit.record({
      entityType: 'CHANGE_REQUEST', entityId: id, crId: id, action: ACTIONS.CR_UPDATED,
      actor, field: 'assumptions', newValue: cleaned, ip: actor?.ip
    });
  });
  return all('SELECT * FROM change_request_assumptions WHERE cr_id = ? ORDER BY sort_order', [id]);
}

export function saveDependencies(id, entries, actor) {
  const cr = findRaw(id);
  stateMachine.assertEditable(cr);
  const types = ['CUSTOMER', 'INTERNAL', 'THIRD_PARTY', 'RISK', 'REMARK'];
  const cleaned = (Array.isArray(entries) ? entries : [])
    .map((e) => ({
      dependency_type: types.includes(e?.dependency_type) ? e.dependency_type : 'INTERNAL',
      text: String(e?.text || '').trim()
    }))
    .filter((e) => e.text)
    .slice(0, 80);

  transaction(() => {
    run('DELETE FROM change_request_dependencies WHERE cr_id = ?', [id]);
    cleaned.forEach((entry, index) => {
      insert('change_request_dependencies', {
        id: uid('DEP'),
        cr_id: id,
        dependency_type: entry.dependency_type,
        text: entry.text,
        sort_order: index
      });
    });
    run('UPDATE change_requests SET updated_at = ?, updated_by = ? WHERE id = ?', [nowIso(), actor?.id || null, id]);
    audit.record({
      entityType: 'CHANGE_REQUEST', entityId: id, crId: id, action: ACTIONS.CR_UPDATED,
      actor, field: 'dependencies', newValue: cleaned, ip: actor?.ip
    });
  });
  return all('SELECT * FROM change_request_dependencies WHERE cr_id = ? ORDER BY sort_order', [id]);
}

/* ---------------------------------------------------------- transitions -- */

/**
 * Apply a workflow event. The single place a CR status ever changes.
 */
export function applyTransition(crOrId, event, { actor, comments = null, patch = {}, targetStatus = null } = {}) {
  const cr = typeof crOrId === 'string' ? findRaw(crOrId) : crOrId;
  const to = targetStatus || stateMachine.nextStatus(cr.status, event);
  const resolved = to === null ? cr.previous_status || 'DRAFT' : to;

  const locked = !stateMachine.isEditable(resolved);
  update('change_requests', cr.id, {
    status: resolved,
    previous_status: cr.status,
    locked: locked ? 1 : 0,
    updated_at: nowIso(),
    updated_by: actor?.id || null,
    ...patch
  });

  audit.record({
    entityType: 'CHANGE_REQUEST',
    entityId: cr.id,
    crId: cr.id,
    action: ACTIONS.STATUS_CHANGED,
    actor,
    field: 'status',
    oldValue: cr.status,
    newValue: resolved,
    comments,
    ip: actor?.ip
  });

  return get('SELECT * FROM change_requests WHERE id = ?', [cr.id]);
}

export function assertReadyForSubmission(id) {
  const cr = findRaw(id);
  const problems = [];

  const items = all('SELECT id FROM change_request_items WHERE cr_id = ?', [id]);
  if (items.length === 0) problems.push('Add at least one change request scope item');

  const effort = get('SELECT IFNULL(SUM(hours),0) AS total FROM change_request_efforts WHERE cr_id = ?', [id]);
  if (!effort || Number(effort.total) <= 0) problems.push('Record the estimated effort');

  const costs = get('SELECT * FROM change_request_costs WHERE cr_id = ?', [id]);
  if (!costs || Number(costs.billing_rate) <= 0) problems.push('Set the billing rate');

  if (!cr.snapshot_internal_approver_email) {
    problems.push('The account has no internal approver email — add one on the account before submitting');
  }
  if (!cr.title) problems.push('Give the change request a title');

  return { ok: problems.length === 0, problems, cr };
}

export function remove(id, actor) {
  const cr = findRaw(id);
  if (cr.status !== 'DRAFT') throw errors.invalidState('Only draft change requests may be deleted');
  try {
    transaction(() => {
      documents.removeForChangeRequest(id);
      run('DELETE FROM change_request_items WHERE cr_id = ?', [id]);
      run('DELETE FROM change_request_efforts WHERE cr_id = ?', [id]);
      run('DELETE FROM change_request_costs WHERE cr_id = ?', [id]);
      run('DELETE FROM change_request_assumptions WHERE cr_id = ?', [id]);
      run('DELETE FROM change_request_dependencies WHERE cr_id = ?', [id]);
      run('DELETE FROM change_request_approvals WHERE cr_id = ?', [id]);
      run('DELETE FROM customer_approvals WHERE cr_id = ?', [id]);
      run('DELETE FROM docusign_envelopes WHERE cr_id = ?', [id]);
      // email history is kept and simply unlinked; the audit trail is immutable
      run('UPDATE email_logs SET cr_id = NULL WHERE cr_id = ?', [id]);
      run('DELETE FROM change_requests WHERE id = ?', [id]);
    });
  } catch (error) {
    throw translateDbError(error) || error;
  }
  audit.record({
    entityType: 'CHANGE_REQUEST',
    entityId: id,
    action: ACTIONS.CR_DELETED,
    actor,
    oldValue: { cr_number: cr.cr_number, title: cr.title },
    ip: actor?.ip
  });
  return { deleted: true };
}

export function cancel(id, reason, actor) {
  const cr = findRaw(id);
  if (!reason || String(reason).trim().length < 5) {
    throw errors.validation('Please give a reason for cancelling this change request', [
      { field: 'reason', message: 'A reason of at least 5 characters is required' }
    ]);
  }
  const updated = applyTransition(cr, 'cancel', {
    actor,
    comments: reason,
    patch: { cancelled_at: nowIso(), cancelled_by: actor?.id || null, cancel_reason: String(reason).trim() }
  });
  audit.record({
    entityType: 'CHANGE_REQUEST', entityId: id, crId: id, action: ACTIONS.CR_CANCELLED,
    actor, comments: reason, ip: actor?.ip
  });
  return updated;
}

export function hold(id, reason, actor) {
  const cr = findRaw(id);
  const updated = applyTransition(cr, 'hold', { actor, comments: reason, patch: { hold_reason: reason || null } });
  audit.record({ entityType: 'CHANGE_REQUEST', entityId: id, crId: id, action: ACTIONS.CR_HELD, actor, comments: reason });
  return updated;
}

export function resume(id, actor) {
  const cr = findRaw(id);
  if (cr.status !== 'ON_HOLD') throw errors.invalidState('This change request is not on hold');
  const updated = applyTransition(cr, 'resume', { actor, patch: { hold_reason: null } });
  audit.record({ entityType: 'CHANGE_REQUEST', entityId: id, crId: id, action: ACTIONS.CR_RESUMED, actor });
  return updated;
}

export function revise(id, actor) {
  const cr = findRaw(id);
  if (!['INTERNAL_REJECTED', 'CUSTOMER_REJECTED'].includes(cr.status)) {
    throw errors.invalidState('Only a rejected change request can be revised');
  }
  const updated = applyTransition(cr, 'revise', {
    actor,
    patch: { revision: (cr.revision || 0) + 1, current_owner_user_id: actor?.id || cr.created_by }
  });
  audit.record({
    entityType: 'CHANGE_REQUEST', entityId: id, crId: id, action: ACTIONS.CR_REVISED,
    actor, newValue: { revision: (cr.revision || 0) + 1 }
  });
  return updated;
}

/* -------------------------------------------------------------- timeline -- */

export function timeline(id) {
  const cr = findRaw(id);
  const events = [
    { key: 'CREATED', label: 'Created', at: cr.created_at, by: userLabel(cr.created_by) },
    { key: 'SUBMITTED', label: 'Submitted for approval', at: cr.submitted_at, by: userLabel(cr.submitted_by) },
    {
      key: 'INTERNAL_APPROVED',
      label: cr.internal_rejected_at && !cr.internally_approved_at ? 'Internally rejected' : 'Internally approved',
      at: cr.internally_approved_at || cr.internal_rejected_at,
      by: userLabel(cr.internally_approved_by || cr.internal_rejected_by),
      failed: Boolean(cr.internal_rejected_at && !cr.internally_approved_at)
    },
    {
      key: 'DOCUMENT',
      label: 'Document generated',
      at: get("SELECT MAX(generated_at) AS at FROM document_versions WHERE cr_id = ? AND status IN ('FINAL','SIGNED')", [id])?.at,
      by: null
    },
    { key: 'SENT', label: 'Sent to customer', at: cr.shared_at, by: userLabel(cr.shared_by) },
    { key: 'VIEWED', label: 'Customer viewed', at: cr.customer_viewed_at, by: cr.snapshot_customer_approver_email },
    {
      key: 'SIGNED',
      label: cr.status === 'CUSTOMER_REJECTED' ? 'Customer rejected' : 'Signed',
      at: cr.signed_at || (cr.status === 'CUSTOMER_REJECTED' ? cr.customer_decided_at : null),
      by: cr.snapshot_customer_approver,
      failed: cr.status === 'CUSTOMER_REJECTED'
    },
    { key: 'COMPLETED', label: 'Completed', at: cr.completed_at, by: null }
  ];

  return events.map((event, index) => ({
    ...event,
    state: event.at ? (event.failed ? 'failed' : 'done') : index === events.findIndex((e) => !e.at) ? 'current' : 'pending'
  }));
}

function userLabel(userId) {
  if (!userId) return null;
  return get('SELECT name FROM users WHERE id = ?', [userId])?.name || null;
}

/** Derive a timeline suggestion from effort and working-day assumptions. */
export function suggestTimeline(id) {
  const cr = findRaw(id);
  const totalEffort = get('SELECT IFNULL(SUM(hours),0) AS total FROM change_request_efforts WHERE cr_id = ?', [id])?.total || 0;
  const businessDays = Math.max(1, Math.ceil(Number(totalEffort) / 8));
  const start = cr.dev_start_date || cr.cr_date || todayIso();
  return {
    total_effort: totalEffort,
    estimated_business_days: businessDays,
    suggested_target_release_date: addBusinessDays(start, businessDays),
    business_days_to_target: cr.target_release_date ? businessDaysBetween(start, cr.target_release_date) : null
  };
}

/* ------------------------------------------------------------ duplicate -- */

/**
 * Start a new draft from an existing change request: same account, scope,
 * effort and commercial set-up, with dates, PO number and history left behind.
 */
export function duplicate(id, actor) {
  const source = find(id);
  const msaUsable = source.msa && source.msa.status !== 'TERMINATED';

  const created = create(
    {
      account_id: source.account_id,
      msa_id: msaUsable ? source.msa_id : undefined,
      title: `Copy of ${source.title}`.slice(0, 200),
      priority: source.priority,
      cr_type: source.cr_type,
      description: source.description,
      customer_contact_name: source.customer_contact_name,
      customer_contact_email: source.customer_contact_email
    },
    actor
  );

  transaction(() => {
    update('change_requests', created.id, {
      estimated_timeline: source.estimated_timeline,
      estimated_business_days: source.estimated_business_days,
      depends_on_po: source.depends_on_po,
      payment_terms: source.payment_terms,
      po_required: source.po_required,
      invoice_terms: source.invoice_terms,
      general_terms: source.general_terms
    });

    saveItems(
      created.id,
      (source.items || []).map((item) => ({
        feature_name: item.feature_name,
        requested_change: item.requested_change,
        detailed_description: item.detailed_description,
        business_justification: item.business_justification,
        current_behaviour: item.current_behaviour,
        expected_behaviour: item.expected_behaviour,
        remarks: item.remarks
      })),
      actor,
      { skipAudit: true }
    );

    for (const effort of source.efforts || []) {
      run('UPDATE change_request_efforts SET hours = ? WHERE cr_id = ? AND category = ?', [effort.hours || 0, created.id, effort.category]);
    }
    if (source.costs) {
      recomputeCosts(created.id, {
        billing_rate: source.costs.billing_rate,
        currency: source.costs.currency,
        discount_type: source.costs.discount_type,
        discount_value: source.costs.discount_value,
        tax_percent: source.costs.tax_percent
      });
    }

    run('DELETE FROM change_request_assumptions WHERE cr_id = ?', [created.id]);
    (source.assumptions || []).forEach((entry, index) => {
      insert('change_request_assumptions', { id: uid('ASM'), cr_id: created.id, text: entry.text, sort_order: index });
    });
    (source.dependencies || []).forEach((entry, index) => {
      insert('change_request_dependencies', {
        id: uid('DEP'),
        cr_id: created.id,
        dependency_type: entry.dependency_type,
        text: entry.text,
        sort_order: index
      });
    });

    audit.record({
      entityType: 'CHANGE_REQUEST',
      entityId: created.id,
      crId: created.id,
      action: ACTIONS.CR_DUPLICATED,
      actor,
      oldValue: { source_id: source.id, source_cr_number: source.cr_number },
      newValue: { cr_number: created.cr_number },
      comments: `Duplicated from ${source.cr_number}`,
      ip: actor?.ip
    });
  });

  return find(created.id, { actor });
}

/* ------------------------------------------------------------- reassign -- */

export function reassign(id, userId, actor) {
  const cr = findRaw(id);
  if (stateMachine.isTerminal(cr.status)) {
    throw errors.invalidState(`${cr.cr_number} is ${stateMachine.label(cr.status).toLowerCase()} and can no longer be reassigned`);
  }
  const user = get('SELECT id, name, email FROM users WHERE id = ? AND is_active = 1', [userId]);
  if (!user) throw errors.validation('Choose an active user to assign the change request to', [{ field: 'userId', message: 'Unknown or inactive user' }]);
  if (cr.current_owner_user_id === user.id) return { id: cr.id, cr_number: cr.cr_number, changed: false };

  const previous = cr.current_owner_user_id ? get('SELECT name FROM users WHERE id = ?', [cr.current_owner_user_id])?.name : null;
  transaction(() => {
    run('UPDATE change_requests SET current_owner_user_id = ?, updated_at = ?, updated_by = ? WHERE id = ?', [
      user.id,
      nowIso(),
      actor?.id || null,
      id
    ]);
    audit.record({
      entityType: 'CHANGE_REQUEST',
      entityId: id,
      crId: id,
      action: ACTIONS.CR_REASSIGNED,
      actor,
      field: 'current_owner',
      oldValue: previous,
      newValue: user.name,
      ip: actor?.ip
    });
  });
  if (user.id !== actor?.id) {
    notifications.notify({
      userIds: [user.id],
      type: 'CR_ASSIGNED',
      title: `${cr.cr_number} assigned to you`,
      body: `${actor?.name || 'Someone'} made you the owner of "${cr.title}".`,
      link: `/change-requests/${id}`,
      crId: id,
      severity: 'ACTION'
    });
  }
  return { id: cr.id, cr_number: cr.cr_number, changed: true };
}

/* ------------------------------------------------------ version snapshots -- */

const SNAPSHOT_FIELDS = {
  title: 'Title',
  priority: 'Priority',
  cr_type: 'Type',
  description: 'Description',
  effective_date: 'Effective date',
  dev_start_date: 'Development start',
  dev_completion_date: 'Development completion',
  test_start_date: 'Testing start',
  test_completion_date: 'Testing completion',
  target_release_date: 'Target release date',
  planned_production_release: 'Planned production release',
  estimated_timeline: 'Estimated timeline',
  estimated_business_days: 'Estimated business days',
  po_required: 'PO required',
  po_number: 'PO number',
  payment_terms: 'Payment terms',
  invoice_terms: 'Invoice terms',
  general_terms: 'General terms'
};

const ITEM_FIELDS = {
  requested_change: 'Requested change',
  detailed_description: 'Detailed description',
  business_justification: 'Business justification',
  current_behaviour: 'Current behaviour',
  expected_behaviour: 'Expected behaviour',
  release_date: 'Release date',
  remarks: 'Remarks'
};

const COST_FIELDS = {
  billing_rate: 'Billing rate',
  discount_type: 'Discount type',
  discount_value: 'Discount',
  tax_percent: 'Tax %',
  total_cost: 'Total CR cost'
};

function buildSnapshot(id) {
  const cr = find(id);
  return {
    revision: cr.revision || 0,
    header: Object.fromEntries(Object.keys(SNAPSHOT_FIELDS).map((key) => [key, cr[key] ?? null])),
    items: (cr.items || []).map((item) => ({
      feature_name: item.feature_name,
      ...Object.fromEntries(Object.keys(ITEM_FIELDS).map((key) => [key, item[key] ?? null]))
    })),
    efforts: Object.fromEntries((cr.efforts || []).map((e) => [e.label, Number(e.hours) || 0])),
    costs: cr.costs ? Object.fromEntries(Object.keys(COST_FIELDS).map((key) => [key, cr.costs[key] ?? null])) : {},
    currency: cr.costs?.currency || 'INR',
    assumptions: (cr.assumptions || []).map((a) => a.text),
    dependencies: (cr.dependencies || []).map((d) => `${d.dependency_type}: ${d.text}`)
  };
}

/** Record what was submitted, so the next submission can be compared with it. */
export function takeSnapshot(id, actor) {
  const data = buildSnapshot(id);
  insert('cr_snapshots', {
    id: uid('SNP'),
    cr_id: id,
    revision: data.revision,
    data_json: JSON.stringify(data),
    created_at: nowIso(),
    created_by: actor?.id || null
  });
}

const same = (a, b) => String(a ?? '').trim() === String(b ?? '').trim();

function diffSnapshots(before, after) {
  const changes = [];
  const push = (section, label, from, to) => changes.push({ section, label, before: from ?? null, after: to ?? null });

  for (const [key, label] of Object.entries(SNAPSHOT_FIELDS)) {
    if (!same(before.header?.[key], after.header?.[key])) push('Details', label, before.header?.[key], after.header?.[key]);
  }

  const beforeItems = new Map((before.items || []).map((item) => [String(item.feature_name).toLowerCase(), item]));
  const afterItems = new Map((after.items || []).map((item) => [String(item.feature_name).toLowerCase(), item]));
  for (const [key, item] of afterItems) {
    const previous = beforeItems.get(key);
    if (!previous) {
      push('Scope', `Added item: ${item.feature_name}`, null, item.requested_change || item.feature_name);
      continue;
    }
    for (const [field, label] of Object.entries(ITEM_FIELDS)) {
      if (!same(previous[field], item[field])) push('Scope', `${item.feature_name} · ${label}`, previous[field], item[field]);
    }
  }
  for (const [key, item] of beforeItems) {
    if (!afterItems.has(key)) push('Scope', `Removed item: ${item.feature_name}`, item.requested_change || item.feature_name, null);
  }

  const effortLabels = new Set([...Object.keys(before.efforts || {}), ...Object.keys(after.efforts || {})]);
  for (const label of effortLabels) {
    const from = Number(before.efforts?.[label] || 0);
    const to = Number(after.efforts?.[label] || 0);
    if (from !== to) push('Effort', `${label} (hours)`, from, to);
  }

  for (const [key, label] of Object.entries(COST_FIELDS)) {
    if (!same(before.costs?.[key], after.costs?.[key])) push('Cost', label, before.costs?.[key], after.costs?.[key]);
  }

  const listDiff = (section, from = [], to = []) => {
    for (const entry of to) if (!from.includes(entry)) push(section, 'Added', null, entry);
    for (const entry of from) if (!to.includes(entry)) push(section, 'Removed', entry, null);
  };
  listDiff('Assumptions', before.assumptions, after.assumptions);
  listDiff('Dependencies', before.dependencies, after.dependencies);

  return changes;
}

/**
 * While a change request is being revised: what has changed since it was last
 * submitted. Once resubmitted: what this submission changed from the previous one.
 */
export function compareVersions(id) {
  const cr = findRaw(id);
  const snapshots = all('SELECT * FROM cr_snapshots WHERE cr_id = ? ORDER BY created_at', [id]).map((row) => ({
    ...row,
    data: JSON.parse(row.data_json)
  }));

  const editing = stateMachine.isEditable(cr.status);
  let base;
  let target;
  if (editing) {
    base = snapshots[snapshots.length - 1];
    target = base ? { data: buildSnapshot(id), created_at: null, revision: cr.revision || 0 } : null;
  } else {
    base = snapshots[snapshots.length - 2];
    target = snapshots[snapshots.length - 1];
  }

  if (!base || !target) {
    return {
      available: false,
      mode: editing ? 'since_last_submission' : 'between_submissions',
      message: editing
        ? 'This change request has not been submitted before, so there is nothing to compare yet.'
        : 'This is the first submission; a comparison appears once it is revised and resubmitted.',
      changes: []
    };
  }

  return {
    available: true,
    mode: editing ? 'since_last_submission' : 'between_submissions',
    base: { revision: base.revision, submitted_at: base.created_at },
    target: { revision: target.revision, submitted_at: target.created_at },
    currency: target.data.currency,
    changes: diffSnapshots(base.data, target.data)
  };
}

export default {
  EFFORT_CATEGORIES,
  CR_TYPES,
  PRIORITIES,
  create,
  find,
  findRaw,
  list,
  editHeader,
  saveItems,
  saveEfforts,
  saveCosts,
  saveAssumptions,
  saveDependencies,
  recomputeCosts,
  applyTransition,
  assertReadyForSubmission,
  remove,
  cancel,
  hold,
  resume,
  revise,
  timeline,
  suggestTimeline,
  scopeClause,
  duplicate,
  reassign,
  takeSnapshot,
  compareVersions
};
