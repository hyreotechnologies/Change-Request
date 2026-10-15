import { all, get, insert, run, transaction, update } from '../db/index.js';
import { nextAccountId, nextMsaId, uid, slugifyCode } from '../lib/ids.js';
import { nowIso, addDays } from '../lib/dates.js';
import { errors, translateDbError } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import audit, { ACTIONS } from './audit.js';
import msaDocuments from './msaDocuments.js';
import changeRequestService from './changeRequests.js';
import stateMachine from './stateMachine.js';
import { getSetting } from './settings.js';

const ACCOUNT_FIELDS = {
  account_name: { type: 'string', required: true, label: 'Account name', maxLength: 160 },
  account_code: { type: 'string', label: 'Account code', maxLength: 30, upper: true },
  legal_entity_name: { type: 'string', required: true, label: 'Legal entity name', maxLength: 200 },
  customer_type: { type: 'string', label: 'Customer type', maxLength: 60 },
  industry: { type: 'string', label: 'Industry', maxLength: 80 },
  country: { type: 'string', label: 'Country', maxLength: 80 },
  address: { type: 'text', label: 'Address', maxLength: 500 },
  city: { type: 'string', label: 'City', maxLength: 80 },
  state: { type: 'string', label: 'State', maxLength: 80 },
  postal_code: { type: 'string', label: 'Postal code', maxLength: 20 },
  status: { type: 'string', label: 'Status', enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
  account_manager: { type: 'string', label: 'Account manager', maxLength: 120 },
  cr_manager: { type: 'string', label: 'CR manager', maxLength: 120 },
  delivery_manager: { type: 'string', label: 'Delivery manager', maxLength: 120 },
  internal_approver_name: { type: 'string', label: 'Internal approver', maxLength: 120 },
  internal_approver_email: { type: 'email', label: 'Internal approver email' },
  notes: { type: 'text', label: 'Notes', maxLength: 4000 }
};

const MSA_FIELDS = {
  msa_reference_number: { type: 'string', required: true, label: 'MSA reference number', maxLength: 60 },
  msa_date: { type: 'date', required: true, label: 'MSA date' },
  contract_start_date: { type: 'date', required: true, label: 'Contract start date' },
  contract_end_date: { type: 'date', label: 'Contract end date' },
  contract_value: { type: 'number', label: 'Contract value', min: 0 },
  currency: { type: 'string', label: 'Currency', maxLength: 5, upper: true },
  billing_entity: { type: 'string', label: 'Billing entity', maxLength: 160 },
  payment_terms: { type: 'string', label: 'Payment terms', maxLength: 200 },
  po_required: { type: 'boolean', label: 'PO required' },
  status: { type: 'string', label: 'MSA status', enum: ['ACTIVE', 'EXPIRED', 'TERMINATED', 'DRAFT'], default: 'ACTIVE' },
  notes: { type: 'text', label: 'MSA notes', maxLength: 2000 }
};

const CONTACT_FIELDS = {
  name: { type: 'string', label: 'Contact name', maxLength: 120 },
  designation: { type: 'string', label: 'Designation', maxLength: 120 },
  email: { type: 'email', label: 'Contact email' },
  phone: { type: 'string', label: 'Phone', maxLength: 40 }
};

function uniqueAccountCode(base) {
  let candidate = slugifyCode(base);
  let suffix = 1;
  while (get('SELECT id FROM accounts WHERE upper(account_code) = upper(?)', [candidate])) {
    suffix += 1;
    candidate = `${slugifyCode(base).slice(0, 18)}${suffix}`;
  }
  return candidate;
}

export function create(payload, actor) {
  const account = validate(payload.account || payload, ACCOUNT_FIELDS);
  const msa = validate(payload.msa || {}, MSA_FIELDS);
  const primary = validate(payload.primary_contact || {}, CONTACT_FIELDS, { partial: true });
  const approver = validate(payload.approval_contact || {}, CONTACT_FIELDS, { partial: true });

  if (msa.contract_end_date && msa.contract_end_date < msa.contract_start_date) {
    throw errors.validation('Contract end date cannot be earlier than the start date', [
      { field: 'contract_end_date', message: 'Contract end date cannot be earlier than the start date' }
    ]);
  }

  const duplicate = get('SELECT a.account_name FROM msa_contracts m JOIN accounts a ON a.id = m.account_id WHERE upper(m.msa_reference_number) = upper(?)', [
    msa.msa_reference_number
  ]);
  if (duplicate) {
    throw errors.duplicate(`MSA reference ${msa.msa_reference_number} is already registered against ${duplicate.account_name}`, {
      field: 'msa_reference_number'
    });
  }

  try {
    return transaction(() => {
      const accountId = nextAccountId();
      const code = account.account_code ? slugifyCode(account.account_code) : uniqueAccountCode(account.account_name);
      const now = nowIso();

      insert('accounts', {
        id: accountId,
        account_code: code,
        account_name: account.account_name,
        legal_entity_name: account.legal_entity_name,
        customer_type: account.customer_type,
        industry: account.industry,
        country: account.country,
        address: account.address,
        city: account.city,
        state: account.state,
        postal_code: account.postal_code,
        status: account.status || 'ACTIVE',
        account_manager: account.account_manager,
        cr_manager: account.cr_manager,
        delivery_manager: account.delivery_manager,
        internal_approver_name: account.internal_approver_name,
        internal_approver_email: account.internal_approver_email,
        notes: account.notes,
        created_at: now,
        created_by: actor?.id || null
      });

      const msaId = nextMsaId();
      insert('msa_contracts', {
        id: msaId,
        account_id: accountId,
        msa_reference_number: msa.msa_reference_number,
        msa_date: msa.msa_date,
        contract_start_date: msa.contract_start_date,
        contract_end_date: msa.contract_end_date,
        contract_value: msa.contract_value,
        currency: msa.currency || getSetting('defaults.currency', 'INR'),
        billing_entity: msa.billing_entity,
        payment_terms: msa.payment_terms || getSetting('defaults.payment_terms'),
        po_required: msa.po_required ?? (getSetting('defaults.po_required', true) ? 1 : 0),
        status: msa.status || 'ACTIVE',
        is_primary: 1,
        notes: msa.notes,
        created_at: now,
        created_by: actor?.id || null
      });

      upsertContact(accountId, 'PRIMARY', primary);
      upsertContact(accountId, 'APPROVER', approver);

      // keep the uploaded contract with the MSA it produced
      if (payload.msa_document_id) {
        msaDocuments.attach(payload.msa_document_id, { msaId, accountId });
      }

      audit.record({
        entityType: 'ACCOUNT',
        entityId: accountId,
        action: ACTIONS.ACCOUNT_CREATED,
        actor,
        newValue: { account_code: code, account_name: account.account_name }
      });
      audit.record({
        entityType: 'MSA',
        entityId: msaId,
        action: ACTIONS.MSA_CREATED,
        actor,
        newValue: { msa_reference_number: msa.msa_reference_number, account_id: accountId }
      });

      return find(accountId);
    });
  } catch (error) {
    const translated = translateDbError(error);
    throw translated || error;
  }
}

function upsertContact(accountId, type, data) {
  if (!data || (!data.name && !data.email)) return null;
  const existing = get('SELECT * FROM customer_contacts WHERE account_id = ? AND contact_type = ?', [accountId, type]);
  if (existing) {
    update('customer_contacts', existing.id, {
      name: data.name ?? existing.name,
      designation: data.designation ?? existing.designation,
      email: data.email ?? existing.email,
      phone: data.phone ?? existing.phone,
      updated_at: nowIso()
    });
    return existing.id;
  }
  const id = uid('CNT');
  insert('customer_contacts', {
    id,
    account_id: accountId,
    contact_type: type,
    name: data.name,
    designation: data.designation,
    email: data.email,
    phone: data.phone,
    is_active: 1,
    created_at: nowIso()
  });
  return id;
}

export function edit(id, payload, actor) {
  const existing = get('SELECT * FROM accounts WHERE id = ?', [id]);
  if (!existing) throw errors.notFound('Account not found');

  const account = validate(payload.account || payload, ACCOUNT_FIELDS, { partial: true });
  const msaPayload = payload.msa ? validate(payload.msa, MSA_FIELDS, { partial: true }) : null;

  try {
    return transaction(() => {
      if (Object.keys(account).length) {
        if (account.account_code) account.account_code = slugifyCode(account.account_code);
        update('accounts', id, { ...account, updated_at: nowIso(), updated_by: actor?.id || null });
        audit.recordDiff({
          entityType: 'ACCOUNT',
          entityId: id,
          action: ACTIONS.ACCOUNT_UPDATED,
          actor,
          before: existing,
          after: { ...existing, ...account },
          fields: Object.keys(ACCOUNT_FIELDS)
        });
      }

      if (msaPayload) {
        const msaId = payload.msa.id || get('SELECT id FROM msa_contracts WHERE account_id = ? ORDER BY is_primary DESC, created_at LIMIT 1', [id])?.id;
        if (msaId) editMsa(msaId, msaPayload, actor);
      }

      if (payload.primary_contact) upsertContact(id, 'PRIMARY', validate(payload.primary_contact, CONTACT_FIELDS, { partial: true }));
      if (payload.approval_contact) upsertContact(id, 'APPROVER', validate(payload.approval_contact, CONTACT_FIELDS, { partial: true }));

      return find(id);
    });
  } catch (error) {
    const translated = translateDbError(error);
    throw translated || error;
  }
}

export function addMsa(accountId, payload, actor) {
  const account = get('SELECT * FROM accounts WHERE id = ?', [accountId]);
  if (!account) throw errors.notFound('Account not found');
  const msa = validate(payload, MSA_FIELDS);

  if (get('SELECT id FROM msa_contracts WHERE upper(msa_reference_number) = upper(?)', [msa.msa_reference_number])) {
    throw errors.duplicate('This MSA reference number is already registered', { field: 'msa_reference_number' });
  }

  const id = nextMsaId();
  insert('msa_contracts', {
    id,
    account_id: accountId,
    msa_reference_number: msa.msa_reference_number,
    msa_date: msa.msa_date,
    contract_start_date: msa.contract_start_date,
    contract_end_date: msa.contract_end_date,
    contract_value: msa.contract_value,
    currency: msa.currency || getSetting('defaults.currency', 'INR'),
    billing_entity: msa.billing_entity,
    payment_terms: msa.payment_terms,
    po_required: msa.po_required ?? 0,
    status: msa.status || 'ACTIVE',
    is_primary: 0,
    notes: msa.notes,
    created_at: nowIso(),
    created_by: actor?.id || null
  });
  audit.record({ entityType: 'MSA', entityId: id, action: ACTIONS.MSA_CREATED, actor, newValue: msa });
  return get('SELECT * FROM msa_contracts WHERE id = ?', [id]);
}

export function editMsa(msaId, payload, actor) {
  const existing = get('SELECT * FROM msa_contracts WHERE id = ?', [msaId]);
  if (!existing) throw errors.notFound('MSA not found');
  const data = validate(payload, MSA_FIELDS, { partial: true });

  if (data.msa_reference_number && data.msa_reference_number.toUpperCase() !== existing.msa_reference_number.toUpperCase()) {
    if (get('SELECT id FROM msa_contracts WHERE upper(msa_reference_number) = upper(?) AND id <> ?', [data.msa_reference_number, msaId])) {
      throw errors.duplicate('This MSA reference number is already registered', { field: 'msa_reference_number' });
    }
    const usedByCr = get('SELECT COUNT(*) AS count FROM change_requests WHERE msa_id = ?', [msaId])?.count || 0;
    if (usedByCr > 0) {
      throw errors.invalidState('The MSA reference cannot be changed because change requests have already been raised against it');
    }
  }

  update('msa_contracts', msaId, { ...data, updated_at: nowIso(), updated_by: actor?.id || null });
  audit.recordDiff({
    entityType: 'MSA',
    entityId: msaId,
    action: ACTIONS.MSA_UPDATED,
    actor,
    before: existing,
    after: { ...existing, ...data },
    fields: Object.keys(MSA_FIELDS)
  });
  return get('SELECT * FROM msa_contracts WHERE id = ?', [msaId]);
}

export function list({ q = null, status = null, limit = 50, offset = 0, sort = 'account_name' } = {}) {
  const where = [];
  const params = [];
  if (q) {
    where.push(`(a.account_name LIKE ? OR a.account_code LIKE ? OR a.legal_entity_name LIKE ?
      OR EXISTS (SELECT 1 FROM msa_contracts m2 WHERE m2.account_id = a.id AND m2.msa_reference_number LIKE ?))`);
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (status) {
    where.push('a.status = ?');
    params.push(status);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sortColumn = ['account_name', 'account_code', 'created_at', 'total_cr_value'].includes(sort) ? sort : 'account_name';

  const rows = all(
    `SELECT a.*,
            m.id AS msa_id, m.msa_reference_number, m.msa_date, m.contract_start_date, m.contract_end_date,
            m.status AS msa_status, m.currency,
            (SELECT COUNT(*) FROM msa_contracts mm WHERE mm.account_id = a.id) AS msa_count,
            (SELECT d.id FROM msa_documents d WHERE d.account_id = a.id ORDER BY d.uploaded_at DESC LIMIT 1) AS msa_document_id,
            (SELECT name FROM customer_contacts c WHERE c.account_id = a.id AND c.contact_type = 'PRIMARY' LIMIT 1) AS primary_contact_name,
            (SELECT email FROM customer_contacts c WHERE c.account_id = a.id AND c.contact_type = 'PRIMARY' LIMIT 1) AS primary_contact_email,
            (SELECT COUNT(*) FROM change_requests cr WHERE cr.account_id = a.id) AS total_crs,
            (SELECT IFNULL(SUM(cc.total_cost), 0) FROM change_requests cr
                JOIN change_request_costs cc ON cc.cr_id = cr.id
               WHERE cr.account_id = a.id AND cr.status NOT IN ('CANCELLED')) AS total_cr_value
       FROM accounts a
       LEFT JOIN msa_contracts m ON m.account_id = a.id AND m.is_primary = 1
       ${clause}
      ORDER BY ${sortColumn === 'total_cr_value' ? 'total_cr_value DESC' : `a.${sortColumn}`}
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const total = get(`SELECT COUNT(*) AS count FROM accounts a ${clause}`, params)?.count || 0;
  return { rows, total };
}

export function find(id) {
  const account = get('SELECT * FROM accounts WHERE id = ?', [id]);
  if (!account) throw errors.notFound('Account not found');
  const msas = all('SELECT * FROM msa_contracts WHERE account_id = ? ORDER BY is_primary DESC, msa_date DESC', [id]);
  const contacts = all('SELECT * FROM customer_contacts WHERE account_id = ? ORDER BY contact_type', [id]);
  const documents = msaDocuments.listForAccount(id);
  const enrich = (msa) => ({
    ...msa,
    document: documents.find((d) => d.msa_id === msa.id) || null,
    budget: msaBudget(msa),
    renewal: renewalState(msa)
  });
  return {
    ...account,
    msas: msas.map(enrich),
    msa_documents: documents,
    primary_msa: (() => {
      const primary = msas.find((m) => m.is_primary) || msas[0] || null;
      return primary ? enrich(primary) : null;
    })(),
    primary_contact: contacts.find((c) => c.contact_type === 'PRIMARY') || null,
    approval_contact: contacts.find((c) => c.contact_type === 'APPROVER') || null,
    contacts,
    summary: summary(id)
  };
}

export function findMsa(msaId) {
  const msa = get('SELECT * FROM msa_contracts WHERE id = ?', [msaId]);
  if (!msa) throw errors.notFound('MSA not found');
  return msa;
}

export function summary(accountId) {
  const base = get(
    `SELECT
        COUNT(*) AS total_crs,
        SUM(CASE WHEN status = 'DRAFT' THEN 1 ELSE 0 END) AS draft_crs,
        SUM(CASE WHEN status = 'PENDING_INTERNAL_APPROVAL' THEN 1 ELSE 0 END) AS pending_internal,
        SUM(CASE WHEN status IN ('INTERNALLY_APPROVED','READY_FOR_CUSTOMER') THEN 1 ELSE 0 END) AS approved_crs,
        SUM(CASE WHEN status IN ('INTERNAL_REJECTED','CUSTOMER_REJECTED','REVISION') THEN 1 ELSE 0 END) AS rejected_crs,
        SUM(CASE WHEN status = 'REVISION' THEN 1 ELSE 0 END) AS revision_crs,
        SUM(CASE WHEN status IN ('SENT_TO_CUSTOMER','CUSTOMER_VIEWED','CUSTOMER_APPROVAL_PENDING') THEN 1 ELSE 0 END) AS pending_customer,
        SUM(CASE WHEN status IN ('SIGNED','COMPLETED','CUSTOMER_APPROVED') THEN 1 ELSE 0 END) AS signed_crs,
        SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed_crs,
        SUM(CASE WHEN status NOT IN ('COMPLETED','CANCELLED','EXPIRED') THEN 1 ELSE 0 END) AS open_crs
      FROM change_requests WHERE account_id = ?`,
    [accountId]
  ) || {};

  const money = get(
    `SELECT IFNULL(SUM(cc.total_cost),0) AS total_cr_value,
            IFNULL(SUM(CASE WHEN cr.status IN ('SIGNED','COMPLETED','CUSTOMER_APPROVED') THEN cc.total_cost ELSE 0 END),0) AS signed_value
       FROM change_requests cr JOIN change_request_costs cc ON cc.cr_id = cr.id
      WHERE cr.account_id = ? AND cr.status <> 'CANCELLED'`,
    [accountId]
  ) || {};

  const effort = get(
    `SELECT
        IFNULL(SUM(e.hours),0) AS total_hours,
        IFNULL(SUM(CASE WHEN e.category = 'DEVELOPMENT' THEN e.hours ELSE 0 END),0) AS development_hours,
        IFNULL(SUM(CASE WHEN e.category = 'TESTING' THEN e.hours ELSE 0 END),0) AS testing_hours
       FROM change_request_efforts e JOIN change_requests cr ON cr.id = e.cr_id
      WHERE cr.account_id = ? AND cr.status <> 'CANCELLED'`,
    [accountId]
  ) || {};

  const currency =
    get('SELECT currency FROM msa_contracts WHERE account_id = ? ORDER BY is_primary DESC LIMIT 1', [accountId])?.currency ||
    getSetting('defaults.currency', 'INR');

  return {
    total_crs: base.total_crs || 0,
    draft_crs: base.draft_crs || 0,
    pending_internal: base.pending_internal || 0,
    approved_crs: base.approved_crs || 0,
    rejected_crs: base.rejected_crs || 0,
    revision_crs: base.revision_crs || 0,
    pending_customer: base.pending_customer || 0,
    signed_crs: base.signed_crs || 0,
    completed_crs: base.completed_crs || 0,
    open_crs: base.open_crs || 0,
    total_cr_value: money.total_cr_value || 0,
    signed_value: money.signed_value || 0,
    total_hours: effort.total_hours || 0,
    development_hours: effort.development_hours || 0,
    testing_hours: effort.testing_hours || 0,
    currency
  };
}

/* ---------------------------------------------------- contract health -- */

const COMMITTED = ['CUSTOMER_APPROVED', 'SIGNED', 'COMPLETED'];
const PIPELINE = [
  'PENDING_INTERNAL_APPROVAL', 'INTERNALLY_APPROVED', 'READY_FOR_CUSTOMER',
  'SENT_TO_CUSTOMER', 'CUSTOMER_VIEWED', 'CUSTOMER_APPROVAL_PENDING'
];

/**
 * How much of an MSA's contract value change requests have used.
 * committed = signed by the customer; pipeline = submitted but not yet signed.
 */
export function msaBudget(msa) {
  if (!msa) return null;
  const row = get(
    `SELECT
        IFNULL(SUM(CASE WHEN cr.status IN (${COMMITTED.map(() => '?').join(', ')}) THEN cc.total_cost ELSE 0 END),0) AS committed,
        IFNULL(SUM(CASE WHEN cr.status IN (${PIPELINE.map(() => '?').join(', ')}) THEN cc.total_cost ELSE 0 END),0) AS pipeline,
        IFNULL(SUM(CASE WHEN cr.status IN ('DRAFT','REVISION') THEN cc.total_cost ELSE 0 END),0) AS drafts
       FROM change_requests cr JOIN change_request_costs cc ON cc.cr_id = cr.id
      WHERE cr.msa_id = ?`,
    [...COMMITTED, ...PIPELINE, msa.id]
  ) || {};
  const contractValue = Number(msa.contract_value) || 0;
  const committed = Number(row.committed) || 0;
  const pipeline = Number(row.pipeline) || 0;
  return {
    contract_value: contractValue || null,
    currency: msa.currency,
    committed,
    pipeline,
    drafts: Number(row.drafts) || 0,
    remaining: contractValue ? contractValue - committed : null,
    used_percent: contractValue ? Math.round((committed / contractValue) * 1000) / 10 : null,
    projected_percent: contractValue ? Math.round(((committed + pipeline) / contractValue) * 1000) / 10 : null
  };
}

/** Where an MSA stands against its end date: ok, expiring (within the warning window) or expired. */
export function renewalState(msa) {
  if (!msa?.contract_end_date) return { state: 'open_ended', days_left: null };
  const daysLeft = Math.ceil((new Date(`${msa.contract_end_date}T23:59:59Z`).getTime() - Date.now()) / 86_400_000);
  const window = Number(getSetting('renewals.warning_days', 90)) || 0;
  let state = 'ok';
  if (daysLeft < 0) state = 'expired';
  else if (daysLeft <= window) state = 'expiring';
  return { state, days_left: daysLeft, end_date: msa.contract_end_date };
}

/** Active MSAs that end within the warning window (or already have), soonest first. */
export function expiringContracts() {
  const window = Number(getSetting('renewals.warning_days', 90)) || 0;
  const horizon = addDays(window).slice(0, 10);
  return all(
    `SELECT m.id, m.msa_reference_number, m.contract_end_date, m.contract_value, m.currency, m.status,
            a.id AS account_id, a.account_name,
            (SELECT COUNT(*) FROM change_requests cr WHERE cr.msa_id = m.id
               AND cr.status NOT IN ('COMPLETED','CANCELLED','EXPIRED')) AS open_crs
       FROM msa_contracts m JOIN accounts a ON a.id = m.account_id
      WHERE m.status = 'ACTIVE' AND a.status = 'ACTIVE'
        AND m.contract_end_date IS NOT NULL AND m.contract_end_date <= ?
      ORDER BY m.contract_end_date`,
    [horizon]
  ).map((row) => ({ ...row, ...renewalState(row) }));
}

export function changeRequests(accountId, { msaId = null } = {}) {
  const params = [accountId];
  let clause = 'WHERE cr.account_id = ?';
  if (msaId) {
    clause += ' AND cr.msa_id = ?';
    params.push(msaId);
  }
  return all(
    `SELECT cr.id, cr.cr_number, cr.cr_reference, cr.title, cr.cr_date, cr.status, cr.priority, cr.cr_type,
            cr.target_release_date, cr.created_at, cr.updated_at,
            m.msa_reference_number,
            IFNULL(cc.total_cost, 0) AS total_cost, IFNULL(cc.currency, 'INR') AS currency,
            IFNULL((SELECT SUM(hours) FROM change_request_efforts e WHERE e.cr_id = cr.id), 0) AS total_effort,
            (SELECT status FROM change_request_approvals a WHERE a.cr_id = cr.id ORDER BY level DESC LIMIT 1) AS internal_approval_status,
            (SELECT status FROM customer_approvals ca WHERE ca.cr_id = cr.id ORDER BY signer_order LIMIT 1) AS customer_approval_status,
            (SELECT status FROM docusign_envelopes de WHERE de.cr_id = cr.id ORDER BY created_at DESC LIMIT 1) AS signature_status
       FROM change_requests cr
       JOIN msa_contracts m ON m.id = cr.msa_id
       LEFT JOIN change_request_costs cc ON cc.cr_id = cr.id
       ${clause}
      ORDER BY cr.seq_no DESC`,
    params
  );
}

/**
 * What deleting this account would destroy, and what stands in the way.
 * Drives the confirmation dialog so the decision is never taken blind.
 */
export function deletionImpact(id) {
  const account = get('SELECT * FROM accounts WHERE id = ?', [id]);
  if (!account) throw errors.notFound('Account not found');

  const changeRequestRows = all(
    'SELECT id, cr_number, title, status FROM change_requests WHERE account_id = ? ORDER BY seq_no',
    [id]
  );
  const drafts = changeRequestRows.filter((cr) => cr.status === 'DRAFT');
  const blocking = changeRequestRows.filter((cr) => cr.status !== 'DRAFT');

  return {
    account_id: account.id,
    account_name: account.account_name,
    status: account.status,
    msa_count: get('SELECT COUNT(*) AS count FROM msa_contracts WHERE account_id = ?', [id])?.count || 0,
    contact_count: get('SELECT COUNT(*) AS count FROM customer_contacts WHERE account_id = ?', [id])?.count || 0,
    draft_change_requests: drafts,
    blocking_change_requests: blocking,
    can_delete: blocking.length === 0,
    requires_confirmation: drafts.length > 0,
    reason: blocking.length
      ? `${blocking.length} change request(s) have progressed beyond draft (${blocking
          .slice(0, 3)
          .map((cr) => `${cr.cr_number} — ${stateMachine.label(cr.status)}`)
          .join(', ')}${blocking.length > 3 ? ', …' : ''}). Submitted, approved and signed change requests are contractual records and are never deleted. Deactivate the account instead.`
      : null
  };
}

/**
 * Delete an account, cascading only its draft change requests.
 * Anything past draft blocks the delete outright; the audit trail survives in
 * every case, because audit_logs is append-only and holds no foreign key.
 */
export function remove(id, actor, { confirmName = null } = {}) {
  const account = get('SELECT * FROM accounts WHERE id = ?', [id]);
  if (!account) throw errors.notFound('Account not found');

  const impact = deletionImpact(id);
  if (!impact.can_delete) throw errors.invalidState(impact.reason);

  if (impact.requires_confirmation) {
    const supplied = String(confirmName || '').trim().toLowerCase();
    if (supplied !== account.account_name.trim().toLowerCase()) {
      throw errors.validation(
        `This account has ${impact.draft_change_requests.length} draft change request(s) that will be deleted with it. Type the account name exactly to confirm.`,
        [{ field: 'confirm_name', message: `Enter "${account.account_name}" to confirm` }]
      );
    }
  }

  try {
    transaction(() => {
      for (const cr of impact.draft_change_requests) {
        changeRequestService.remove(cr.id, actor);
      }
      msaDocuments.removeForAccount(id);
      run('DELETE FROM customer_contacts WHERE account_id = ?', [id]);
      run('DELETE FROM cr_approval_levels WHERE account_id = ?', [id]);
      run('DELETE FROM msa_contracts WHERE account_id = ?', [id]);
      run('DELETE FROM accounts WHERE id = ?', [id]);
    });
  } catch (error) {
    throw translateDbError(error) || error;
  }

  audit.record({
    entityType: 'ACCOUNT',
    entityId: id,
    action: 'ACCOUNT_DELETED',
    actor,
    oldValue: {
      account_code: account.account_code,
      account_name: account.account_name,
      legal_entity_name: account.legal_entity_name
    },
    newValue: {
      deleted_change_requests: impact.draft_change_requests.map((cr) => cr.cr_number),
      deleted_msas: impact.msa_count,
      deleted_contacts: impact.contact_count
    },
    comments: `Account deleted with ${impact.draft_change_requests.length} draft change request(s)`,
    ip: actor?.ip
  });

  return {
    deleted: true,
    account_name: account.account_name,
    deleted_change_requests: impact.draft_change_requests.length
  };
}

/** Deactivate / reactivate — the non-destructive alternative to deletion. */
export function setStatus(id, status, actor) {
  if (!['ACTIVE', 'INACTIVE'].includes(status)) throw errors.validation('Status must be ACTIVE or INACTIVE');
  return edit(id, { status }, actor);
}

/** Compact list used by the CR wizard account picker. */
export function lookup(q = '') {
  const like = `%${q}%`;
  return all(
    `SELECT a.id, a.account_code, a.account_name, a.legal_entity_name, a.status,
            a.account_manager, a.cr_manager, a.delivery_manager,
            a.internal_approver_name, a.internal_approver_email,
            m.id AS msa_id, m.msa_reference_number, m.msa_date, m.contract_start_date, m.contract_end_date,
            m.currency, m.payment_terms, m.po_required,
            (SELECT d.id FROM msa_documents d WHERE d.msa_id = m.id ORDER BY d.uploaded_at DESC LIMIT 1) AS msa_document_id,
            (SELECT name FROM customer_contacts c WHERE c.account_id = a.id AND c.contact_type = 'APPROVER' LIMIT 1) AS approver_name,
            (SELECT email FROM customer_contacts c WHERE c.account_id = a.id AND c.contact_type = 'APPROVER' LIMIT 1) AS approver_email,
            (SELECT name FROM customer_contacts c WHERE c.account_id = a.id AND c.contact_type = 'PRIMARY' LIMIT 1) AS primary_contact_name,
            (SELECT email FROM customer_contacts c WHERE c.account_id = a.id AND c.contact_type = 'PRIMARY' LIMIT 1) AS primary_contact_email
       FROM accounts a
       LEFT JOIN msa_contracts m ON m.account_id = a.id AND m.is_primary = 1
      WHERE a.status = 'ACTIVE' AND (? = '' OR a.account_name LIKE ? OR a.account_code LIKE ? OR m.msa_reference_number LIKE ?)
      ORDER BY a.account_name LIMIT 25`,
    [q, like, like, like]
  );
}

export default {
  create,
  edit,
  setStatus,
  deletionImpact,
  addMsa,
  editMsa,
  list,
  find,
  findMsa,
  summary,
  changeRequests,
  remove,
  lookup,
  msaBudget,
  renewalState,
  expiringContracts
};
