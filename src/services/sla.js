import { all } from '../db/index.js';
import { addDays, nowIso } from '../lib/dates.js';
import { getSetting } from './settings.js';
import stateMachine from './stateMachine.js';

/**
 * Stage time limits. Every open status belongs to a stage with a configurable
 * number of days; a change request is "due soon" in its last day and "overdue"
 * once it has sat in the stage longer than that. The clock starts at the last
 * status change, so a resubmission or a re-share starts a fresh clock.
 */

export const STAGES = {
  DRAFT: { label: 'Draft / revision', setting: 'sla.draft_days', waitingOn: 'CR owner', statuses: ['DRAFT', 'REVISION', 'INTERNAL_REJECTED', 'CUSTOMER_REJECTED'] },
  INTERNAL: { label: 'Internal approval', setting: 'sla.internal_days', waitingOn: 'Internal approver', statuses: ['PENDING_INTERNAL_APPROVAL'] },
  SHARE: { label: 'Approved, not shared', setting: 'sla.share_days', waitingOn: 'CR owner', statuses: ['INTERNALLY_APPROVED', 'READY_FOR_CUSTOMER'] },
  CUSTOMER: { label: 'With the customer', setting: 'sla.customer_days', waitingOn: 'Customer', statuses: ['SENT_TO_CUSTOMER', 'CUSTOMER_VIEWED', 'CUSTOMER_APPROVAL_PENDING'] }
};

export function stageFor(status) {
  for (const [key, stage] of Object.entries(STAGES)) {
    if (stage.statuses.includes(status)) return { key, ...stage };
  }
  return null;
}

/** SQL for the moment the change request entered its current status. */
export function stageEnteredSql(alias = 'cr') {
  return `COALESCE((SELECT MAX(al.created_at) FROM audit_logs al
                     WHERE al.cr_id = ${alias}.id AND al.action = 'STATUS_CHANGED'), ${alias}.created_at)`;
}

/** SQL for the configured day limit of the current stage (0 = no limit). */
export function limitSql(alias = 'cr') {
  const cases = [];
  const params = [];
  for (const stage of Object.values(STAGES)) {
    cases.push(`WHEN ${alias}.status IN (${stage.statuses.map(() => '?').join(', ')}) THEN ?`);
    params.push(...stage.statuses, Number(getSetting(stage.setting, 0)) || 0);
  }
  return { sql: `(CASE ${cases.join(' ')} ELSE 0 END)`, params };
}

/**
 * WHERE fragment selecting change requests in a given time-limit state.
 * state: 'overdue' | 'due_soon' | 'at_risk' (either of the two)
 */
export function filterSql(state, alias = 'cr') {
  const limit = limitSql(alias);
  const age = `(julianday(?) - julianday(${stageEnteredSql(alias)}))`;
  const now = nowIso();
  if (state === 'overdue') {
    return { sql: `AND ${limit.sql} > 0 AND ${age} > ${limit.sql}`, params: [...limit.params, now, ...limit.params] };
  }
  if (state === 'due_soon') {
    return {
      sql: `AND ${limit.sql} > 0 AND ${age} <= ${limit.sql} AND ${age} > ${limit.sql} - 1`,
      params: [...limit.params, now, ...limit.params, now, ...limit.params]
    };
  }
  if (state === 'at_risk') {
    return { sql: `AND ${limit.sql} > 0 AND ${age} > ${limit.sql} - 1`, params: [...limit.params, now, ...limit.params] };
  }
  return { sql: '', params: [] };
}

/** Attach the time-limit view of a row that carries status + stage_entered_at. */
export function annotate(row) {
  const stage = stageFor(row.status);
  if (!stage || !row.stage_entered_at) return { ...row, sla: null };
  const limitDays = Number(getSetting(stage.setting, 0)) || 0;
  const elapsedMs = Date.now() - new Date(row.stage_entered_at).getTime();
  const daysInStage = Math.max(0, elapsedMs / 86_400_000);
  const dueAt = limitDays > 0 ? addDays(limitDays, new Date(row.stage_entered_at)) : null;

  let state = 'none';
  if (limitDays > 0) {
    if (daysInStage > limitDays) state = 'overdue';
    else if (daysInStage > limitDays - 1) state = 'due_soon';
    else state = 'on_track';
  }

  return {
    ...row,
    sla: {
      stage: stage.key,
      stage_label: stage.label,
      waiting_on: stage.waitingOn,
      entered_at: row.stage_entered_at,
      days_in_stage: Math.floor(daysInStage),
      limit_days: limitDays,
      due_at: dueAt,
      days_overdue: state === 'overdue' ? Math.floor(daysInStage - limitDays) : 0,
      state
    }
  };
}

/**
 * Average time spent in each status, measured from the audit trail's
 * status changes. Open stages count up to now, so a backlog shows up.
 */
export function stageDurations(scope = { sql: '', params: [] }) {
  const events = all(
    `SELECT al.cr_id, al.old_value, al.new_value, al.created_at
       FROM audit_logs al
       JOIN change_requests cr ON cr.id = al.cr_id
      WHERE al.action = 'STATUS_CHANGED' ${scope.sql}
      ORDER BY al.cr_id, al.created_at`,
    scope.params
  );

  const created = new Map(
    all(`SELECT cr.id, cr.created_at, cr.status FROM change_requests cr WHERE 1 = 1 ${scope.sql}`, scope.params).map((row) => [row.id, row])
  );

  const totals = new Map();
  const add = (status, ms) => {
    if (!status || ms < 0) return;
    const entry = totals.get(status) || { total: 0, count: 0 };
    entry.total += ms;
    entry.count += 1;
    totals.set(status, entry);
  };

  const byCr = new Map();
  for (const event of events) {
    if (!byCr.has(event.cr_id)) byCr.set(event.cr_id, []);
    byCr.get(event.cr_id).push(event);
  }

  for (const [crId, cr] of created) {
    const list = byCr.get(crId) || [];
    let enteredAt = new Date(cr.created_at).getTime();
    let status = list.length ? clean(list[0].old_value) : cr.status;
    for (const event of list) {
      const at = new Date(event.created_at).getTime();
      add(status, at - enteredAt);
      status = clean(event.new_value);
      enteredAt = at;
    }
    if (!stateMachine.isTerminal(status)) add(status, Date.now() - enteredAt);
  }

  return stateMachine.STATUS_CODES.filter((code) => totals.has(code) && !stateMachine.isTerminal(code)).map((code) => {
    const entry = totals.get(code);
    return {
      status: code,
      label: stateMachine.label(code),
      average_days: Math.round((entry.total / entry.count / 86_400_000) * 10) / 10,
      samples: entry.count
    };
  });
}

/** Audit values are stored as JSON text; a status arrives as '"DRAFT"' or 'DRAFT'. */
function clean(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'string' ? parsed : text;
  } catch {
    return text;
  }
}

export default { STAGES, stageFor, stageEnteredSql, limitSql, filterSql, annotate, stageDurations };
