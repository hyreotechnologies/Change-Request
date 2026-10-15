import fs from 'node:fs';
import path from 'node:path';
import { all, get, insert, run, update } from '../db/index.js';
import { uid } from '../lib/ids.js';
import { nowIso } from '../lib/dates.js';
import { sha256File } from '../lib/crypto.js';
import { errors } from '../lib/errors.js';
import { extractText } from '../lib/textExtract.js';
import msaExtract from './msaExtract.js';
import audit from './audit.js';
import config from '../config.js';

/**
 * The signed MSA itself: uploaded first, read for its details, then kept with
 * the account so anyone can open the source contract later.
 */

const MAX_BYTES = 15 * 1024 * 1024;

const MIME = {
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  PDF: 'application/pdf',
  TEXT: 'text/plain; charset=utf-8'
};

function uploadDir(id) {
  const dir = path.join(config.storageDir, 'msa', id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeName(fileName) {
  return String(fileName || 'msa')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'msa';
}

/**
 * Store an uploaded contract and read what it can from it.
 * The file is kept whether or not extraction succeeded — the document is the
 * point; the extraction is a convenience.
 */
export function upload({ fileName, contentType, base64 }, actor) {
  if (!base64) throw errors.validation('No file was received');

  let buffer;
  try {
    buffer = Buffer.from(String(base64), 'base64');
  } catch {
    throw errors.validation('The uploaded file could not be decoded');
  }
  if (!buffer.length) throw errors.validation('The uploaded file is empty');
  if (buffer.length > MAX_BYTES) {
    throw errors.validation(`The MSA is larger than ${Math.round(MAX_BYTES / 1024 / 1024)} MB`);
  }

  const extraction = extractText(buffer, { fileName, contentType });
  const analysis = msaExtract.analyse(extraction.text);

  const id = uid('MSD');
  const name = safeName(fileName);
  const filePath = path.join(uploadDir(id), name);
  fs.writeFileSync(filePath, buffer);

  const row = {
    id,
    msa_id: null,
    account_id: null,
    file_name: fileName || name,
    file_path: path.relative(config.storageDir, filePath),
    file_size: buffer.length,
    content_type: contentType || MIME[extraction.kind] || 'application/octet-stream',
    document_kind: extraction.kind,
    extracted_text: extraction.text ? extraction.text.slice(0, 200_000) : null,
    extracted_json: JSON.stringify({ fields: analysis.fields, evidence: analysis.evidence, emails: analysis.emails }),
    uploaded_at: nowIso(),
    uploaded_by: actor?.id || null
  };
  insert('msa_documents', row);

  audit.record({
    entityType: 'MSA_DOCUMENT',
    entityId: id,
    action: 'MSA_UPLOADED',
    actor,
    newValue: { file_name: row.file_name, kind: extraction.kind, fields_found: analysis.found },
    ip: actor?.ip
  });

  return {
    id,
    file_name: row.file_name,
    file_size: row.file_size,
    document_kind: extraction.kind,
    text_length: extraction.text.length,
    warnings: extraction.warnings,
    confidence: analysis.confidence,
    found: analysis.found,
    fields: analysis.fields,
    evidence: analysis.evidence,
    emails: analysis.emails
  };
}

/** Bind an uploaded document to the MSA it was used to create. */
export function attach(documentId, { msaId, accountId }) {
  const row = get('SELECT * FROM msa_documents WHERE id = ?', [documentId]);
  if (!row) throw errors.notFound('Uploaded MSA document not found');
  update('msa_documents', documentId, { msa_id: msaId, account_id: accountId });
  return get('SELECT * FROM msa_documents WHERE id = ?', [documentId]);
}

export function findForMsa(msaId) {
  return get('SELECT * FROM msa_documents WHERE msa_id = ? ORDER BY uploaded_at DESC LIMIT 1', [msaId]) || null;
}

export function listForAccount(accountId) {
  return all(
    `SELECT d.id, d.msa_id, d.file_name, d.file_size, d.content_type, d.document_kind, d.uploaded_at,
            m.msa_reference_number, u.name AS uploaded_by_name
       FROM msa_documents d
       LEFT JOIN msa_contracts m ON m.id = d.msa_id
       LEFT JOIN users u ON u.id = d.uploaded_by
      WHERE d.account_id = ?
      ORDER BY d.uploaded_at DESC`,
    [accountId]
  );
}

export function find(documentId) {
  const row = get('SELECT * FROM msa_documents WHERE id = ?', [documentId]);
  if (!row) throw errors.notFound('MSA document not found');
  return row;
}

export function resolveFile(documentId) {
  const row = find(documentId);
  const absolute = path.join(config.storageDir, row.file_path);
  if (!fs.existsSync(absolute)) throw errors.notFound('The stored MSA file is missing');
  return {
    row,
    absolutePath: absolute,
    fileName: row.file_name || path.basename(absolute),
    mime: row.content_type || 'application/octet-stream'
  };
}

/** Remove documents belonging to a deleted account. */
export function removeForAccount(accountId) {
  const rows = all('SELECT id, file_path FROM msa_documents WHERE account_id = ?', [accountId]);
  run('DELETE FROM msa_documents WHERE account_id = ?', [accountId]);
  for (const row of rows) {
    try {
      const absolute = path.join(config.storageDir, row.file_path);
      if (fs.existsSync(absolute)) fs.rmSync(absolute);
      const dir = path.dirname(absolute);
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch {
      /* the database is the record of truth */
    }
  }
  return { removed: rows.length };
}

export { sha256File };

export default { upload, attach, find, findForMsa, listForAccount, resolveFile, removeForAccount };
