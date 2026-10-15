import { all, get } from '../db/index.js';
import { monthKey, monthLabel, startOfMonthIso, daysBetween } from '../lib/dates.js';
import stateMachine from './stateMachine.js';
import changeRequests from './changeRequests.js';
import { getSetting } from './settings.js';
import sla from './sla.js';
import accounts from './accounts.js';

function scope(actor) {
  return changeRequests.scopeClause(actor);
}

export function kpis(actor) {
  const s = scope(actor);
  const base = `FROM change_requests cr WHERE 1 = 1 ${s.sql}`;
  const count = (condition, params = []) =>
    get(`SELECT COUNT(*) AS count ${base} ${condition}`, [...s.params, ...params])?.count || 0;

  const statusIn = (statuses) => `AND cr.status IN (${statuses.map(() => '?').join(', ')})`;

  const totalValue =
    get(
      `SELECT IFNULL(SUM(cc.total_cost),0) AS total
         FROM change_requests cr JOIN change_request_costs cc ON cc.cr_id = cr.id
        WHERE cr.status <> 'CANCELLED' ${s.sql}`,
      s.params
    )?.total || 0;

  const signedValue =
    get(
      `SELECT IFNULL(SUM(cc.total_cost),0) AS total
         FROM change_requests cr JOIN change_request_costs cc ON cc.cr_id = cr.id
        WHERE cr.status IN ('CUSTOMER_APPROVED','SIGNED','COMPLETED') ${s.sql}`,
      s.params
    )?.total || 0;

  return {
    total_accounts: get('SELECT COUNT(*) AS count FROM accounts')?.count || 0,
    active_msas: get("SELECT COUNT(*) AS count FROM msa_contracts WHERE status = 'ACTIVE'")?.count || 0,
    total_crs: count(''),
    draft_crs: count(statusIn(stateMachine.STATUS_GROUPS.DRAFT), stateMachine.STATUS_GROUPS.DRAFT),
    pending_internal: count(statusIn(stateMachine.STATUS_GROUPS.PENDING_INTERNAL), stateMachine.STATUS_GROUPS.PENDING_INTERNAL),
    approved_crs: count(statusIn(stateMachine.STATUS_GROUPS.APPROVED), stateMachine.STATUS_GROUPS.APPROVED),
    rejected_crs: count(statusIn(stateMachine.STATUS_GROUPS.REJECTED), stateMachine.STATUS_GROUPS.REJECTED),
    revision_crs: count("AND cr.status = 'REVISION'"),
    pending_customer: count(statusIn(stateMachine.STATUS_GROUPS.PENDING_CUSTOMER), stateMachine.STATUS_GROUPS.PENDING_CUSTOMER),
    signed_crs: count(statusIn(stateMachine.STATUS_GROUPS.SIGNED), stateMachine.STATUS_GROUPS.SIGNED),
    completed_crs: count("AND cr.status = 'COMPLETED'"),
    cancelled_crs: count("AND cr.status = 'CANCELLED'"),
    on_hold_crs: count("AND cr.status = 'ON_HOLD'"),
    total_cr_value: totalValue,
    signed_cr_value: signedValue,
    crs_this_month: count('AND cr.created_at >= ?', [startOfMonthIso()]),
    currency: getSetting('defaults.currency', 'INR')
  };
}

export function charts(actor) {
  const s = scope(actor);

  const byStatus = all(
    `SELECT cr.status, COUNT(*) AS count FROM change_requests cr WHERE 1 = 1 ${s.sql} GROUP BY cr.status`,
    s.params
  ).map((row) => ({
    key: row.status,
    label: stateMachine.label(row.status),
    value: row.count,
    color: stateMachine.STATUSES[row.status]?.color || 'slate'
  }));

  const byCustomer = all(
    `SELECT a.account_name AS label, COUNT(*) AS value
       FROM change_requests cr JOIN accounts a ON a.id = cr.account_id
      WHERE 1 = 1 ${s.sql}
      GROUP BY a.id ORDER BY value DESC LIMIT 8`,
    s.params
  );

  const valueByCustomer = all(
    `SELECT a.account_name AS label, IFNULL(SUM(cc.total_cost),0) AS value
       FROM change_requests cr
       JOIN accounts a ON a.id = cr.account_id
       LEFT JOIN change_request_costs cc ON cc.cr_id = cr.id
      WHERE cr.status <> 'CANCELLED' ${s.sql}
      GROUP BY a.id ORDER BY value DESC LIMIT 8`,
    s.params
  );

  const monthsRaw = all(
    `SELECT substr(cr.cr_date, 1, 7) AS month, COUNT(*) AS count, IFNULL(SUM(cc.total_cost),0) AS value
       FROM change_requests cr LEFT JOIN change_request_costs cc ON cc.cr_id = cr.id
      WHERE cr.cr_date IS NOT NULL ${s.sql}
      GROUP BY month ORDER BY month`,
    s.params
  );
  const monthMap = new Map(monthsRaw.map((row) => [row.month, row]));
  const byMonth = [];
  const cursor = new Date();
  cursor.setDate(1);
  cursor.setMonth(cursor.getMonth() - 11);
  for (let i = 0; i < 12; i += 1) {
    const key = monthKey(cursor.toISOString().slice(0, 10));
    const row = monthMap.get(key);
    byMonth.push({ key, label: monthLabel(key), value: row?.count || 0, amount: row?.value || 0 });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  const pendingRows = all(
    `SELECT ap.requested_at FROM change_request_approvals ap
       JOIN change_requests cr ON cr.id = ap.cr_id
      WHERE ap.status = 'PENDING' AND cr.status = 'PENDING_INTERNAL_APPROVAL' ${s.sql}`,
    s.params
  );
  const buckets = [
    { key: '0-2', label: '0-2 days', value: 0 },
    { key: '3-5', label: '3-5 days', value: 0 },
    { key: '6-10', label: '6-10 days', value: 0 },
    { key: '10+', label: 'Over 10 days', value: 0 }
  ];
  for (const row of pendingRows) {
    const age = daysBetween(row.requested_at);
    if (age <= 2) buckets[0].value += 1;
    else if (age <= 5) buckets[1].value += 1;
    else if (age <= 10) buckets[2].value += 1;
    else buckets[3].value += 1;
  }

  const effortRows = all(
    `SELECT a.account_name AS label,
            IFNULL(SUM(CASE WHEN e.category = 'DEVELOPMENT' THEN e.hours ELSE 0 END),0) AS development,
            IFNULL(SUM(CASE WHEN e.category = 'TESTING' THEN e.hours ELSE 0 END),0) AS testing
       FROM change_request_efforts e
       JOIN change_requests cr ON cr.id = e.cr_id
       JOIN accounts a ON a.id = cr.account_id
      WHERE cr.status <> 'CANCELLED' ${s.sql}
      GROUP BY a.id
      HAVING development > 0 OR testing > 0
      ORDER BY (development + testing) DESC LIMIT 8`,
    s.params
  );

  return {
    by_status: byStatus,
    by_customer: byCustomer,
    value_by_customer: valueByCustomer,
    by_month: byMonth,
    approval_ageing: buckets,
    effort_split: effortRows
  };
}

export function recent(actor, limit = 10) {
  return changeRequests.list({ limit, sort: 'recent' }, actor).rows;
}

export function myWork(actor) {
  const s = scope(actor);
  const pendingApprovals =
    get(
      `SELECT COUNT(*) AS count FROM change_request_approvals ap JOIN change_requests cr ON cr.id = ap.cr_id
        WHERE ap.status = 'PENDING' AND cr.status = 'PENDING_INTERNAL_APPROVAL' AND lower(ap.approver_email) = lower(?)`,
      [actor.email]
    )?.count || 0;

  const myDrafts =
    get(
      `SELECT COUNT(*) AS count FROM change_requests cr WHERE cr.status IN ('DRAFT','REVISION') AND cr.created_by = ? ${s.sql}`,
      [actor.id, ...s.params]
    )?.count || 0;

  const awaitingCustomer =
    get(
      `SELECT COUNT(*) AS count FROM change_requests cr
        WHERE cr.status IN ('SENT_TO_CUSTOMER','CUSTOMER_VIEWED','CUSTOMER_APPROVAL_PENDING')
          AND cr.created_by = ? ${s.sql}`,
      [actor.id, ...s.params]
    )?.count || 0;

  const unread = get('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0', [actor.id])?.count || 0;

  return { pending_approvals: pendingApprovals, my_drafts: myDrafts, awaiting_customer: awaitingCustomer, unread_notifications: unread };
}

/* ------------------------------------------------------ waiting on me -- */

const OWNER_ACTIONS = {
  DRAFT: 'Finish and submit for approval',
  REVISION: 'Revise and resubmit',
  INTERNAL_REJECTED: 'Revise and resubmit',
  CUSTOMER_REJECTED: 'Revise and resubmit',
  INTERNALLY_APPROVED: 'Share with the customer',
  READY_FOR_CUSTOMER: 'Share with the customer',
  CUSTOMER_APPROVED: 'Complete the signature',
  ON_HOLD: 'Resume or cancel'
};

/**
 * Everything blocked on this user, oldest first, plus what they are waiting
 * on others for. One list to work from instead of the portfolio view.
 */
export function myQueue(actor) {
  const items = [];

  // approvals at the level currently being decided
  const approvals = all(
    `SELECT ap.requested_at, cr.id, cr.cr_number, cr.title, cr.status, cr.priority, a.account_name,
            IFNULL(cc.total_cost,0) AS total_cost, IFNULL(cc.currency,'INR') AS currency
       FROM change_request_approvals ap
       JOIN change_requests cr ON cr.id = ap.cr_id
       JOIN accounts a ON a.id = cr.account_id
       LEFT JOIN change_request_costs cc ON cc.cr_id = cr.id
      WHERE ap.status = 'PENDING' AND cr.status = 'PENDING_INTERNAL_APPROVAL'
        AND lower(ap.approver_email) = lower(?)
        AND ap.level = (SELECT MIN(level) FROM change_request_approvals x WHERE x.cr_id = cr.id AND x.status = 'PENDING')`,
    [actor.email]
  );
  for (const row of approvals) {
    items.push(
      sla.annotate({
        ...row,
        kind: 'APPROVE',
        action: 'Approve or reject',
        since: row.requested_at,
        stage_entered_at: row.requested_at,
        waiting_days: daysBetween(row.requested_at),
        status_label: stateMachine.label(row.status)
      })
    );
  }

  const owned = changeRequests.list({ owner: actor.id, status: Object.keys(OWNER_ACTIONS), limit: 100, sort: 'stage_age' }, actor).rows;
  for (const row of owned) {
    items.push({
      ...row,
      kind: 'OWNER',
      action: OWNER_ACTIONS[row.status],
      since: row.stage_entered_at,
      waiting_days: daysBetween(row.stage_entered_at)
    });
  }

  items.sort((a, b) => new Date(a.since) - new Date(b.since));

  const waitingOnOthers = changeRequests
    .list({ owner: actor.id, status: ['PENDING_INTERNAL_APPROVAL', ...stateMachine.STATUS_GROUPS.PENDING_CUSTOMER], limit: 50, sort: 'stage_age' }, actor)
    .rows.filter((row) => !approvals.some((a) => a.id === row.id))
    .map((row) => ({ ...row, waiting_days: daysBetween(row.stage_entered_at) }));

  // an approver owns the CR while it waits on them, so "others" also includes
  // anything this user raised that now sits with someone else
  const raised = all(
    `SELECT cr.id FROM change_requests cr
      WHERE cr.created_by = ? AND IFNULL(cr.current_owner_user_id,'') <> ?
        AND cr.status IN (${['PENDING_INTERNAL_APPROVAL', ...stateMachine.STATUS_GROUPS.PENDING_CUSTOMER].map(() => '?').join(', ')})`,
    [actor.id, actor.id, 'PENDING_INTERNAL_APPROVAL', ...stateMachine.STATUS_GROUPS.PENDING_CUSTOMER]
  ).map((row) => row.id);
  if (raised.length) {
    for (const row of changeRequests.list({ ids: raised, limit: 50, sort: 'stage_age' }, actor).rows) {
      if (!waitingOnOthers.some((existing) => existing.id === row.id)) {
        waitingOnOthers.push({ ...row, waiting_days: daysBetween(row.stage_entered_at) });
      }
    }
  }

  return { items, waiting_on_others: waitingOnOthers };
}

/** Counts of open change requests close to or past their stage time limit. */
export function timeLimits(actor) {
  const s = scope(actor);
  const count = (state) => {
    const clause = sla.filterSql(state);
    return get(`SELECT COUNT(*) AS count FROM change_requests cr WHERE 1 = 1 ${clause.sql} ${s.sql}`, [...clause.params, ...s.params])?.count || 0;
  };
  return {
    overdue: count('overdue'),
    due_soon: count('due_soon'),
    stage_durations: sla.stageDurations(s)
  };
}

export function overview(actor) {
  return {
    kpis: kpis(actor),
    charts: charts(actor),
    recent: recent(actor),
    my_work: myWork(actor),
    my_queue: myQueue(actor),
    time_limits: timeLimits(actor),
    renewals: accounts.expiringContracts(),
    generated_at: new Date().toISOString()
  };
}

/* --------------------------------------------------------- global search -- */

export function search(term, actor) {
  const q = String(term || '').trim();
  if (q.length < 2) return { accounts: [], msas: [], change_requests: [], contacts: [] };
  const like = `%${q}%`;
  const s = scope(actor);

  const accounts = all(
    `SELECT id, account_code, account_name, legal_entity_name, status
       FROM accounts
      WHERE account_name LIKE ? OR account_code LIKE ? OR legal_entity_name LIKE ?
      ORDER BY account_name LIMIT 8`,
    [like, like, like]
  );

  const msas = all(
    `SELECT m.id, m.msa_reference_number, m.msa_date, m.status, m.contract_start_date,
            a.id AS account_id, a.account_name,
            (SELECT COUNT(*) FROM change_requests cr WHERE cr.msa_id = m.id) AS cr_count
       FROM msa_contracts m JOIN accounts a ON a.id = m.account_id
      WHERE m.msa_reference_number LIKE ? OR a.account_name LIKE ?
      ORDER BY m.msa_reference_number LIMIT 8`,
    [like, like]
  );

  const crs = all(
    `SELECT cr.id, cr.cr_number, cr.cr_reference, cr.title, cr.status, cr.cr_date,
            a.account_name, m.msa_reference_number, IFNULL(cc.total_cost,0) AS total_cost, IFNULL(cc.currency,'INR') AS currency
       FROM change_requests cr
       JOIN accounts a ON a.id = cr.account_id
       JOIN msa_contracts m ON m.id = cr.msa_id
       LEFT JOIN change_request_costs cc ON cc.cr_id = cr.id
      WHERE (cr.cr_number LIKE ? OR cr.cr_reference LIKE ? OR cr.title LIKE ? OR a.account_name LIKE ?
             OR m.msa_reference_number LIKE ?
             OR EXISTS (SELECT 1 FROM change_request_items i WHERE i.cr_id = cr.id AND i.feature_name LIKE ?))
        ${s.sql}
      ORDER BY cr.updated_at DESC LIMIT 12`,
    [like, like, like, like, like, like, ...s.params]
  ).map((row) => ({ ...row, status_label: stateMachine.label(row.status) }));

  const contacts = all(
    `SELECT c.id, c.name, c.email, c.designation, c.contact_type, a.id AS account_id, a.account_name
       FROM customer_contacts c JOIN accounts a ON a.id = c.account_id
      WHERE c.name LIKE ? OR c.email LIKE ?
      ORDER BY c.name LIMIT 6`,
    [like, like]
  );

  return { accounts, msas, change_requests: crs, contacts, term: q };
}

export default { overview, kpis, charts, recent, myWork, myQueue, timeLimits, search };
