import { get } from '../db/index.js';
import { getSetting } from './settings.js';

/**
 * CR identifiers are produced from configurable format strings so the
 * convention can change without a deploy.
 *
 * Tokens: {ACCOUNT_CODE} {ACCOUNT_NAME} {MSA_NUMBER} {YYYY} {YY} {MM} {SEQ} {SEQ:n}
 */
export function applyFormat(format, context) {
  return String(format || '')
    .replace(/\{SEQ:(\d+)\}/g, (_, width) => String(context.seq).padStart(Number(width), '0'))
    .replace(/\{SEQ\}/g, String(context.seq))
    .replace(/\{ACCOUNT_CODE\}/g, context.accountCode || '')
    .replace(/\{ACCOUNT_NAME\}/g, context.accountName || '')
    .replace(/\{MSA_NUMBER\}/g, context.msaNumber || '')
    .replace(/\{YYYY\}/g, String(context.year))
    .replace(/\{YY\}/g, String(context.year).slice(-2))
    .replace(/\{MM\}/g, String(context.month).padStart(2, '0'))
    .trim();
}

/** Next per-account sequence number. Independent for every account. */
export function nextSequenceForAccount(accountId) {
  const row = get('SELECT MAX(seq_no) AS max_seq FROM change_requests WHERE account_id = ?', [accountId]);
  return (row?.max_seq || 0) + 1;
}

export function buildIdentifiers({ account, msa, seq, date = new Date() }) {
  const context = {
    seq,
    accountCode: account.account_code,
    accountName: account.account_name,
    msaNumber: msa?.msa_reference_number || '',
    year: date.getFullYear(),
    month: date.getMonth() + 1
  };

  const crNumber = applyFormat(getSetting('numbering.cr_number_format', '{ACCOUNT_CODE}-CR-{SEQ:3}'), context);
  const crReference = applyFormat(getSetting('numbering.cr_reference_format', '{MSA_NUMBER}-{SEQ:2}'), context);
  return { cr_number: crNumber, cr_reference: crReference, seq_no: seq };
}

/** Preview used by the CR wizard before anything is saved. */
export function preview(accountId) {
  const account = get('SELECT * FROM accounts WHERE id = ?', [accountId]);
  if (!account) return null;
  const msa = get('SELECT * FROM msa_contracts WHERE account_id = ? ORDER BY is_primary DESC, created_at LIMIT 1', [accountId]);
  return buildIdentifiers({ account, msa, seq: nextSequenceForAccount(accountId) });
}

export default { applyFormat, nextSequenceForAccount, buildIdentifiers, preview };
