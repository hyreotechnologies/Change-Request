import { all, get } from '../db/index.js';
import { errors } from '../lib/errors.js';
import { formatDateTime, formatDmy, monthLabel, daysBetween, toDateOnly } from '../lib/dates.js';
import { formatAmount } from '../lib/money.js';
import { renderXlsx, renderCsv } from '../lib/xlsx.js';
import { renderPdf } from '../lib/pdf.js';
import stateMachine from './stateMachine.js';
import changeRequests from './changeRequests.js';
import { getSetting } from './settings.js';

/**
 * Report registry. Every report declares its columns once; the table view,
 * the Excel/CSV writer and the PDF writer all consume the same definition.
 */

function baseFilters(filters = {}, actor = null, alias = 'cr') {
  const where = [];
  const params = [];

  if (filters.accountId) {
    where.push(`${alias}.account_id = ?`);
    params.push(filters.accountId);
  }
  if (filters.msaId) {
    where.push(`${alias}.msa_id = ?`);
    params.push(filters.msaId);
  }
  if (filters.status) {
    const statuses = String(filters.status).split(',').filter(Boolean);
    where.push(`${alias}.status IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  }
  if (filters.from) {
    where.push(`${alias}.cr_date >= ?`);
    params.push(toDateOnly(filters.from));
  }
  if (filters.to) {
    where.push(`${alias}.cr_date <= ?`);
    params.push(toDateOnly(filters.to));
  }
  if (filters.crManager) {
    where.push(`${alias}.created_by = ?`);
    params.push(filters.crManager);
  }
  if (filters.minCost) {
    where.push('IFNULL(cc.total_cost,0) >= ?');
    params.push(Number(filters.minCost));
  }
  if (filters.maxCost) {
    where.push('IFNULL(cc.total_cost,0) <= ?');
    params.push(Number(filters.maxCost));
  }

  const scope = changeRequests.scopeClause(actor, alias);
  return {
    sql: `${where.length ? `AND ${where.join(' AND ')}` : ''} ${scope.sql}`,
    params: [...params, ...scope.params]
  };
}

const CR_JOIN = `
  FROM change_requests cr
  JOIN accounts a ON a.id = cr.account_id
  JOIN msa_contracts m ON m.id = cr.msa_id
  LEFT JOIN change_request_costs cc ON cc.cr_id = cr.id
  LEFT JOIN users u ON u.id = cr.created_by
`;

function statusLabel(row) {
  return stateMachine.label(row.status);
}

export const REPORTS = {
  'cr-register': {
    name: 'CR Register',
    description: 'Every change request with its commercial and approval position.',
    columns: [
      { key: 'cr_number', label: 'CR Number' },
      { key: 'cr_reference', label: 'CR Reference' },
      { key: 'account_name', label: 'Account' },
      { key: 'msa_reference_number', label: 'MSA' },
      { key: 'title', label: 'CR Title' },
      { key: 'cr_date', label: 'Created Date' },
      { key: 'target_release_date', label: 'Release Date' },
      { key: 'total_effort', label: 'Effort (hrs)', type: 'number' },
      { key: 'total_cost', label: 'Cost', type: 'number' },
      { key: 'status_label', label: 'Status' },
      { key: 'internal_approval', label: 'Internal Approval' },
      { key: 'customer_approval', label: 'Customer Approval' },
      { key: 'signature_status', label: 'Signature' },
      { key: 'created_by_name', label: 'CR Manager' }
    ],
    run(filters, actor) {
      const f = baseFilters(filters, actor);
      return all(
        `SELECT cr.id, cr.cr_number, cr.cr_reference, cr.title, cr.cr_date, cr.target_release_date, cr.status,
                a.account_name, m.msa_reference_number, u.name AS created_by_name,
                IFNULL(cc.total_cost,0) AS total_cost, IFNULL(cc.currency,'INR') AS currency,
                IFNULL((SELECT SUM(hours) FROM change_request_efforts e WHERE e.cr_id = cr.id),0) AS total_effort,
                (SELECT status FROM change_request_approvals ap WHERE ap.cr_id = cr.id ORDER BY level DESC LIMIT 1) AS internal_approval,
                (SELECT status FROM customer_approvals ca WHERE ca.cr_id = cr.id ORDER BY signer_order LIMIT 1) AS customer_approval,
                (SELECT status FROM docusign_envelopes de WHERE de.cr_id = cr.id ORDER BY created_at DESC LIMIT 1) AS signature_status
         ${CR_JOIN} WHERE 1 = 1 ${f.sql} ORDER BY a.account_name, cr.seq_no`,
        f.params
      ).map((row) => ({
        ...row,
        status_label: statusLabel(row),
        internal_approval: row.internal_approval || 'Not started',
        customer_approval: row.customer_approval || 'Not sent',
        signature_status: row.signature_status || 'Not sent'
      }));
    }
  },

  'account-cr-history': {
    name: 'Account CR History',
    description: 'Change request history grouped by account.',
    columns: [
      { key: 'account_name', label: 'Account' },
      { key: 'account_code', label: 'Code' },
      { key: 'msa_reference_number', label: 'MSA' },
      { key: 'cr_number', label: 'CR Number' },
      { key: 'title', label: 'CR Title' },
      { key: 'cr_date', label: 'CR Date' },
      { key: 'total_effort', label: 'Effort (hrs)', type: 'number' },
      { key: 'total_cost', label: 'CR Cost', type: 'number' },
      { key: 'status_label', label: 'Status' }
    ],
    run(filters, actor) {
      const f = baseFilters(filters, actor);
      return all(
        `SELECT a.account_name, a.account_code, m.msa_reference_number, cr.cr_number, cr.title, cr.cr_date, cr.status,
                IFNULL(cc.total_cost,0) AS total_cost,
                IFNULL((SELECT SUM(hours) FROM change_request_efforts e WHERE e.cr_id = cr.id),0) AS total_effort
         ${CR_JOIN} WHERE 1 = 1 ${f.sql} ORDER BY a.account_name, cr.seq_no`,
        f.params
      ).map((row) => ({ ...row, status_label: statusLabel(row) }));
    }
  },

  'msa-cr-summary': {
    name: 'MSA-wise CR Summary',
    description: 'One row per MSA with cumulative change request totals.',
    columns: [
      { key: 'msa_reference_number', label: 'MSA' },
      { key: 'account_name', label: 'Account' },
      { key: 'msa_date', label: 'MSA Date' },
      { key: 'contract_start_date', label: 'Contract Start' },
      { key: 'contract_end_date', label: 'Contract End' },
      { key: 'msa_status', label: 'MSA Status' },
      { key: 'cr_count', label: 'CRs', type: 'number' },
      { key: 'completed_count', label: 'Completed', type: 'number' },
      { key: 'total_effort', label: 'Effort (hrs)', type: 'number' },
      { key: 'total_value', label: 'CR Value', type: 'number' }
    ],
    run(filters, actor) {
      const f = baseFilters(filters, actor);
      return all(
        `SELECT m.msa_reference_number, m.msa_date, m.contract_start_date, m.contract_end_date, m.status AS msa_status,
                a.account_name,
                COUNT(cr.id) AS cr_count,
                SUM(CASE WHEN cr.status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed_count,
                IFNULL(SUM(cc.total_cost),0) AS total_value,
                IFNULL(SUM((SELECT SUM(hours) FROM change_request_efforts e WHERE e.cr_id = cr.id)),0) AS total_effort
           FROM msa_contracts m
           JOIN accounts a ON a.id = m.account_id
           LEFT JOIN change_requests cr ON cr.msa_id = m.id
           LEFT JOIN change_request_costs cc ON cc.cr_id = cr.id
          WHERE 1 = 1 ${f.sql}
          GROUP BY m.id ORDER BY a.account_name, m.msa_reference_number`,
        f.params
      );
    }
  },

  'monthly-cr': {
    name: 'Monthly CR Report',
    description: 'Change request volume and value by month.',
    columns: [
      { key: 'month_label', label: 'Month' },
      { key: 'cr_count', label: 'CRs Raised', type: 'number' },
      { key: 'completed_count', label: 'Completed', type: 'number' },
      { key: 'rejected_count', label: 'Rejected', type: 'number' },
      { key: 'total_effort', label: 'Effort (hrs)', type: 'number' },
      { key: 'total_value', label: 'CR Value', type: 'number' }
    ],
    run(filters, actor) {
      const f = baseFilters(filters, actor);
      return all(
        `SELECT substr(cr.cr_date,1,7) AS month,
                COUNT(*) AS cr_count,
                SUM(CASE WHEN cr.status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed_count,
                SUM(CASE WHEN cr.internal_rejection_comments IS NOT NULL OR cr.customer_rejection_comments IS NOT NULL THEN 1 ELSE 0 END) AS rejected_count,
                IFNULL(SUM(cc.total_cost),0) AS total_value,
                IFNULL(SUM((SELECT SUM(hours) FROM change_request_efforts e WHERE e.cr_id = cr.id)),0) AS total_effort
         ${CR_JOIN} WHERE cr.cr_date IS NOT NULL ${f.sql}
          GROUP BY month ORDER BY month DESC`,
        f.params
      ).map((row) => ({ ...row, month_label: monthLabel(row.month) }));
    }
  },

  'pending-approval': {
    name: 'Pending Approval Report',
    description: 'Change requests awaiting an internal decision, with ageing.',
    columns: [
      { key: 'cr_number', label: 'CR Number' },
      { key: 'account_name', label: 'Account' },
      { key: 'title', label: 'CR Title' },
      { key: 'level_name', label: 'Approval Level' },
      { key: 'approver_name', label: 'Approver' },
      { key: 'approver_email', label: 'Approver Email' },
      { key: 'requested_at_label', label: 'Submitted' },
      { key: 'ageing_days', label: 'Ageing (days)', type: 'number' },
      { key: 'total_cost', label: 'CR Cost', type: 'number' }
    ],
    run(filters, actor) {
      const f = baseFilters(filters, actor);
      return all(
        `SELECT cr.cr_number, cr.title, a.account_name, ap.level_name, ap.approver_name, ap.approver_email, ap.requested_at,
                IFNULL(cc.total_cost,0) AS total_cost
           FROM change_request_approvals ap
           JOIN change_requests cr ON cr.id = ap.cr_id
           JOIN accounts a ON a.id = cr.account_id
           JOIN msa_contracts m ON m.id = cr.msa_id
           LEFT JOIN change_request_costs cc ON cc.cr_id = cr.id
           LEFT JOIN users u ON u.id = cr.created_by
          WHERE ap.status = 'PENDING' AND cr.status = 'PENDING_INTERNAL_APPROVAL' ${f.sql}
          ORDER BY ap.requested_at`,
        f.params
      ).map((row) => ({
        ...row,
        requested_at_label: formatDateTime(row.requested_at),
        ageing_days: daysBetween(row.requested_at)
      }));
    }
  },

  'cr-cost': {
    name: 'CR Cost Report',
    description: 'Commercial breakdown of every change request.',
    columns: [
      { key: 'cr_number', label: 'CR Number' },
      { key: 'account_name', label: 'Account' },
      { key: 'currency', label: 'Currency' },
      { key: 'billing_rate', label: 'Rate', type: 'number' },
      { key: 'total_effort', label: 'Effort (hrs)', type: 'number' },
      { key: 'subtotal', label: 'Subtotal', type: 'number' },
      { key: 'discount_amount', label: 'Discount', type: 'number' },
      { key: 'tax_amount', label: 'Tax', type: 'number' },
      { key: 'total_cost', label: 'Total CR Cost', type: 'number' },
      { key: 'status_label', label: 'Status' }
    ],
    run(filters, actor) {
      const f = baseFilters(filters, actor);
      return all(
        `SELECT cr.cr_number, cr.status, a.account_name,
                IFNULL(cc.currency,'INR') AS currency, IFNULL(cc.billing_rate,0) AS billing_rate,
                IFNULL(cc.total_effort,0) AS total_effort, IFNULL(cc.subtotal,0) AS subtotal,
                IFNULL(cc.discount_amount,0) AS discount_amount, IFNULL(cc.tax_amount,0) AS tax_amount,
                IFNULL(cc.total_cost,0) AS total_cost
         ${CR_JOIN} WHERE 1 = 1 ${f.sql} ORDER BY total_cost DESC`,
        f.params
      ).map((row) => ({ ...row, status_label: statusLabel(row) }));
    }
  },

  effort: {
    name: 'Effort Report',
    description: 'Effort by category across change requests.',
    columns: [
      { key: 'cr_number', label: 'CR Number' },
      { key: 'account_name', label: 'Account' },
      { key: 'development', label: 'Development', type: 'number' },
      { key: 'testing', label: 'Testing', type: 'number' },
      { key: 'business_analysis', label: 'BA', type: 'number' },
      { key: 'project_management', label: 'PM', type: 'number' },
      { key: 'deployment', label: 'Deployment', type: 'number' },
      { key: 'other', label: 'Other', type: 'number' },
      { key: 'total_effort', label: 'Total', type: 'number' },
      { key: 'status_label', label: 'Status' }
    ],
    run(filters, actor) {
      const f = baseFilters(filters, actor);
      return all(
        `SELECT cr.cr_number, cr.status, a.account_name,
                IFNULL(SUM(CASE WHEN e.category='DEVELOPMENT' THEN e.hours END),0) AS development,
                IFNULL(SUM(CASE WHEN e.category='TESTING' THEN e.hours END),0) AS testing,
                IFNULL(SUM(CASE WHEN e.category='BUSINESS_ANALYSIS' THEN e.hours END),0) AS business_analysis,
                IFNULL(SUM(CASE WHEN e.category='PROJECT_MANAGEMENT' THEN e.hours END),0) AS project_management,
                IFNULL(SUM(CASE WHEN e.category='DEPLOYMENT' THEN e.hours END),0) AS deployment,
                IFNULL(SUM(CASE WHEN e.category='OTHER' THEN e.hours END),0) AS other,
                IFNULL(SUM(e.hours),0) AS total_effort
         ${CR_JOIN}
           LEFT JOIN change_request_efforts e ON e.cr_id = cr.id
          WHERE 1 = 1 ${f.sql}
          GROUP BY cr.id ORDER BY total_effort DESC`,
        f.params
      ).map((row) => ({ ...row, status_label: statusLabel(row) }));
    }
  },

  'customer-pending': {
    name: 'Customer Pending Report',
    description: 'Change requests waiting with the customer.',
    columns: [
      { key: 'cr_number', label: 'CR Number' },
      { key: 'account_name', label: 'Account' },
      { key: 'title', label: 'CR Title' },
      { key: 'contact_email', label: 'Sent To' },
      { key: 'shared_at_label', label: 'Sent On' },
      { key: 'customer_viewed_label', label: 'Viewed On' },
      { key: 'ageing_days', label: 'Ageing (days)', type: 'number' },
      { key: 'total_cost', label: 'CR Cost', type: 'number' },
      { key: 'status_label', label: 'Status' }
    ],
    run(filters, actor) {
      const f = baseFilters(filters, actor);
      return all(
        `SELECT cr.cr_number, cr.title, cr.status, cr.shared_at, cr.customer_viewed_at, a.account_name,
                IFNULL(cc.total_cost,0) AS total_cost,
                (SELECT contact_email FROM customer_approvals ca WHERE ca.cr_id = cr.id ORDER BY signer_order LIMIT 1) AS contact_email
         ${CR_JOIN}
          WHERE cr.status IN ('SENT_TO_CUSTOMER','CUSTOMER_VIEWED','CUSTOMER_APPROVAL_PENDING') ${f.sql}
          ORDER BY cr.shared_at`,
        f.params
      ).map((row) => ({
        ...row,
        status_label: statusLabel(row),
        shared_at_label: formatDateTime(row.shared_at),
        customer_viewed_label: row.customer_viewed_at ? formatDateTime(row.customer_viewed_at) : 'Not yet viewed',
        ageing_days: daysBetween(row.shared_at)
      }));
    }
  },

  'rejected-cr': {
    name: 'Rejected CR Report',
    description: 'Internal and customer rejections with reasons.',
    columns: [
      { key: 'cr_number', label: 'CR Number' },
      { key: 'account_name', label: 'Account' },
      { key: 'title', label: 'CR Title' },
      { key: 'rejection_type', label: 'Rejected By' },
      { key: 'rejected_at_label', label: 'Rejected On' },
      { key: 'comments', label: 'Reason' },
      { key: 'total_cost', label: 'CR Cost', type: 'number' },
      { key: 'status_label', label: 'Current Status' }
    ],
    run(filters, actor) {
      const f = baseFilters(filters, actor);
      return all(
        `SELECT cr.cr_number, cr.title, cr.status, a.account_name, IFNULL(cc.total_cost,0) AS total_cost,
                cr.internal_rejected_at, cr.internal_rejection_comments, cr.customer_decided_at, cr.customer_rejection_comments
         ${CR_JOIN}
          WHERE (cr.internal_rejection_comments IS NOT NULL OR cr.customer_rejection_comments IS NOT NULL) ${f.sql}
          ORDER BY COALESCE(cr.customer_decided_at, cr.internal_rejected_at) DESC`,
        f.params
      ).map((row) => {
        const customer = Boolean(row.customer_rejection_comments);
        return {
          ...row,
          status_label: statusLabel(row),
          rejection_type: customer ? 'Customer' : 'Internal approver',
          rejected_at_label: formatDateTime(customer ? row.customer_decided_at : row.internal_rejected_at),
          comments: customer ? row.customer_rejection_comments : row.internal_rejection_comments
        };
      });
    }
  },

  'completed-cr': {
    name: 'Completed CR Report',
    description: 'Signed and completed change requests.',
    columns: [
      { key: 'cr_number', label: 'CR Number' },
      { key: 'account_name', label: 'Account' },
      { key: 'msa_reference_number', label: 'MSA' },
      { key: 'title', label: 'CR Title' },
      { key: 'cr_date', label: 'CR Date' },
      { key: 'signed_at_label', label: 'Signed On' },
      { key: 'completed_at_label', label: 'Completed On' },
      { key: 'cycle_days', label: 'Cycle (days)', type: 'number' },
      { key: 'total_cost', label: 'CR Cost', type: 'number' }
    ],
    run(filters, actor) {
      const f = baseFilters(filters, actor);
      return all(
        `SELECT cr.cr_number, cr.title, cr.cr_date, cr.signed_at, cr.completed_at, cr.created_at,
                a.account_name, m.msa_reference_number, IFNULL(cc.total_cost,0) AS total_cost
         ${CR_JOIN} WHERE cr.status = 'COMPLETED' ${f.sql} ORDER BY cr.completed_at DESC`,
        f.params
      ).map((row) => ({
        ...row,
        signed_at_label: formatDateTime(row.signed_at),
        completed_at_label: formatDateTime(row.completed_at),
        cycle_days: row.completed_at ? daysBetween(row.created_at, row.completed_at) : null
      }));
    }
  }
};

export function listReports() {
  return Object.entries(REPORTS).map(([code, report]) => ({
    code,
    name: report.name,
    description: report.description,
    columns: report.columns
  }));
}

export function run(code, filters = {}, actor = null) {
  const report = REPORTS[code];
  if (!report) throw errors.notFound(`Unknown report: ${code}`);
  const rows = report.run(filters, actor);
  return {
    code,
    name: report.name,
    description: report.description,
    columns: report.columns,
    rows,
    total: rows.length,
    generated_at: new Date().toISOString(),
    filters
  };
}

export function exportReport(code, filters, actor, format = 'xlsx') {
  const result = run(code, filters, actor);
  const currency = getSetting('defaults.currency', 'INR');
  const fileBase = `${code}-${new Date().toISOString().slice(0, 10)}`;

  if (format === 'csv') {
    return {
      buffer: renderCsv(result),
      fileName: `${fileBase}.csv`,
      mime: 'text/csv; charset=utf-8'
    };
  }

  if (format === 'pdf') {
    const widths = distributeWidths(result.columns.length);
    const rows = [
      {
        header: true,
        cells: result.columns.map((column) => ({ text: column.label, bold: true, shade: 'E7E6E6' }))
      },
      ...result.rows.map((row) => ({
        cells: result.columns.map((column) => ({
          text:
            column.type === 'number'
              ? row[column.key] === null || row[column.key] === undefined
                ? ''
                : formatAmount(row[column.key], currency)
              : String(row[column.key] ?? ''),
          align: column.type === 'number' ? 'right' : 'left'
        }))
      }))
    ];

    const model = {
      meta: {
        title: result.name,
        author: getSetting('company.legal_name', 'Hyreo'),
        footer: `${result.name} | Generated ${formatDateTime(result.generated_at)} | Page {page} of {pages}`,
        landscape: result.columns.length > 6
      },
      blocks: [
        { type: 'title', text: result.name },
        { type: 'paragraph', align: 'center', text: `${result.description} — ${result.total} record(s)` },
        { type: 'table', widths, rows, size: 8 }
      ]
    };
    return { buffer: renderPdf(model), fileName: `${fileBase}.pdf`, mime: 'application/pdf' };
  }

  return {
    buffer: renderXlsx({ sheetName: result.name, columns: result.columns, rows: result.rows }),
    fileName: `${fileBase}.xlsx`,
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  };
}

function distributeWidths(count) {
  const width = 100 / count;
  return Array.from({ length: count }, () => width);
}

export default { REPORTS, listReports, run, exportReport };
