import { errors } from '../lib/errors.js';

export const STATUSES = {
  DRAFT: { label: 'Draft', color: 'slate', group: 'INTERNAL', editable: true, terminal: false, order: 1 },
  PENDING_INTERNAL_APPROVAL: { label: 'Pending Internal Approval', color: 'amber', group: 'INTERNAL', editable: false, terminal: false, order: 2 },
  INTERNAL_REJECTED: { label: 'Internally Rejected', color: 'red', group: 'INTERNAL', editable: false, terminal: false, order: 3 },
  INTERNALLY_APPROVED: { label: 'Internally Approved', color: 'green', group: 'INTERNAL', editable: false, terminal: false, order: 4 },
  READY_FOR_CUSTOMER: { label: 'Ready for Customer', color: 'blue', group: 'CUSTOMER', editable: false, terminal: false, order: 5 },
  SENT_TO_CUSTOMER: { label: 'Sent to Customer', color: 'blue', group: 'CUSTOMER', editable: false, terminal: false, order: 6 },
  CUSTOMER_VIEWED: { label: 'Customer Viewed', color: 'blue', group: 'CUSTOMER', editable: false, terminal: false, order: 7 },
  CUSTOMER_APPROVAL_PENDING: { label: 'Customer Approval Pending', color: 'amber', group: 'CUSTOMER', editable: false, terminal: false, order: 8 },
  CUSTOMER_REJECTED: { label: 'Customer Rejected', color: 'red', group: 'CUSTOMER', editable: false, terminal: false, order: 9 },
  REVISION: { label: 'Under Revision', color: 'orange', group: 'INTERNAL', editable: true, terminal: false, order: 10 },
  CUSTOMER_APPROVED: { label: 'Customer Approved', color: 'green', group: 'CUSTOMER', editable: false, terminal: false, order: 11 },
  SIGNED: { label: 'Signed', color: 'green', group: 'SIGNATURE', editable: false, terminal: false, order: 12 },
  COMPLETED: { label: 'Completed', color: 'green', group: 'CLOSED', editable: false, terminal: true, order: 13 },
  CANCELLED: { label: 'Cancelled', color: 'slate', group: 'CLOSED', editable: false, terminal: true, order: 14 },
  ON_HOLD: { label: 'On Hold', color: 'orange', group: 'INTERNAL', editable: false, terminal: false, order: 15 },
  EXPIRED: { label: 'Expired', color: 'slate', group: 'CLOSED', editable: false, terminal: true, order: 16 }
};

export const STATUS_CODES = Object.keys(STATUSES);

/** event -> { from: [...], to } */
export const TRANSITIONS = {
  submit: { from: ['DRAFT', 'REVISION'], to: 'PENDING_INTERNAL_APPROVAL' },
  approve_level: { from: ['PENDING_INTERNAL_APPROVAL'], to: 'PENDING_INTERNAL_APPROVAL' },
  approve: { from: ['PENDING_INTERNAL_APPROVAL'], to: 'INTERNALLY_APPROVED' },
  reject: { from: ['PENDING_INTERNAL_APPROVAL'], to: 'INTERNAL_REJECTED' },
  ready: { from: ['INTERNALLY_APPROVED'], to: 'READY_FOR_CUSTOMER' },
  share: { from: ['READY_FOR_CUSTOMER', 'SENT_TO_CUSTOMER', 'CUSTOMER_VIEWED', 'CUSTOMER_APPROVAL_PENDING'], to: 'SENT_TO_CUSTOMER' },
  customer_view: { from: ['SENT_TO_CUSTOMER'], to: 'CUSTOMER_VIEWED' },
  await_customer: { from: ['CUSTOMER_VIEWED'], to: 'CUSTOMER_APPROVAL_PENDING' },
  customer_approve: { from: ['SENT_TO_CUSTOMER', 'CUSTOMER_VIEWED', 'CUSTOMER_APPROVAL_PENDING'], to: 'CUSTOMER_APPROVED' },
  customer_reject: { from: ['SENT_TO_CUSTOMER', 'CUSTOMER_VIEWED', 'CUSTOMER_APPROVAL_PENDING'], to: 'CUSTOMER_REJECTED' },
  revise: { from: ['CUSTOMER_REJECTED', 'INTERNAL_REJECTED'], to: 'REVISION' },
  sign: { from: ['CUSTOMER_APPROVED'], to: 'SIGNED' },
  complete: { from: ['SIGNED'], to: 'COMPLETED' },
  hold: {
    from: [
      'DRAFT', 'PENDING_INTERNAL_APPROVAL', 'INTERNALLY_APPROVED', 'READY_FOR_CUSTOMER',
      'SENT_TO_CUSTOMER', 'CUSTOMER_VIEWED', 'CUSTOMER_APPROVAL_PENDING', 'REVISION'
    ],
    to: 'ON_HOLD'
  },
  resume: { from: ['ON_HOLD'], to: null },
  cancel: {
    from: [
      'DRAFT', 'PENDING_INTERNAL_APPROVAL', 'INTERNAL_REJECTED', 'INTERNALLY_APPROVED', 'READY_FOR_CUSTOMER',
      'SENT_TO_CUSTOMER', 'CUSTOMER_VIEWED', 'CUSTOMER_APPROVAL_PENDING', 'CUSTOMER_REJECTED', 'REVISION', 'ON_HOLD'
    ],
    to: 'CANCELLED'
  },
  expire: { from: ['SENT_TO_CUSTOMER', 'CUSTOMER_VIEWED', 'CUSTOMER_APPROVAL_PENDING'], to: 'EXPIRED' }
};

export const EDITABLE_STATUSES = STATUS_CODES.filter((code) => STATUSES[code].editable);
export const TERMINAL_STATUSES = STATUS_CODES.filter((code) => STATUSES[code].terminal);

export function label(status) {
  return STATUSES[status]?.label || status;
}

export function isEditable(status) {
  return Boolean(STATUSES[status]?.editable);
}

export function isTerminal(status) {
  return Boolean(STATUSES[status]?.terminal);
}

export function canTransition(from, event) {
  const transition = TRANSITIONS[event];
  if (!transition) return false;
  return transition.from.includes(from);
}

export function nextStatus(from, event) {
  const transition = TRANSITIONS[event];
  if (!transition) throw errors.invalidState(`Unknown workflow event: ${event}`);
  if (!transition.from.includes(from)) {
    throw errors.invalidState(
      `A change request in status "${label(from)}" cannot be ${event.replace(/_/g, ' ')}ed`
    );
  }
  return transition.to;
}

export function assertEditable(cr) {
  if (!isEditable(cr.status)) {
    throw errors.locked(
      `This change request is ${label(cr.status).toLowerCase()} and cannot be edited. Use the revision workflow to make changes.`
    );
  }
  if (cr.locked) throw errors.locked('This change request is locked for editing');
}

/** Statuses the dashboard and reports group together. */
export const STATUS_GROUPS = {
  DRAFT: ['DRAFT'],
  REVISION: ['REVISION'],
  PENDING_INTERNAL: ['PENDING_INTERNAL_APPROVAL'],
  APPROVED: ['INTERNALLY_APPROVED', 'READY_FOR_CUSTOMER'],
  // a rejected CR moves straight into REVISION, so the rejected lens has to
  // include it or rejections would vanish from the dashboard and reports
  REJECTED: ['INTERNAL_REJECTED', 'CUSTOMER_REJECTED', 'REVISION'],
  PENDING_CUSTOMER: ['SENT_TO_CUSTOMER', 'CUSTOMER_VIEWED', 'CUSTOMER_APPROVAL_PENDING'],
  SIGNED: ['CUSTOMER_APPROVED', 'SIGNED'],
  COMPLETED: ['COMPLETED'],
  CLOSED: ['COMPLETED', 'CANCELLED', 'EXPIRED']
};

export default {
  STATUSES,
  STATUS_CODES,
  TRANSITIONS,
  STATUS_GROUPS,
  label,
  isEditable,
  isTerminal,
  canTransition,
  nextStatus,
  assertEditable
};
