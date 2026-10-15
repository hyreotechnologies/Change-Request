import fs from 'node:fs';
import path from 'node:path';
import { all, get, insert, run, transaction, update } from '../db/index.js';
import { uid } from '../lib/ids.js';
import { nowIso } from '../lib/dates.js';
import { sha256File } from '../lib/crypto.js';
import { errors, translateDbError } from '../lib/errors.js';
import { renderDocx } from '../lib/docx.js';
import { renderPdf } from '../lib/pdf.js';
import { buildDocumentModel, renderModelHtml } from './documentModel.js';
import changeRequests from './changeRequests.js';
import audit, { ACTIONS } from './audit.js';
import config from '../config.js';

const FORMATS = { DOCX: { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, PDF: { ext: 'pdf', mime: 'application/pdf' } };

function documentDir(crId) {
  const dir = path.join(config.documentsDir, crId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ensureDocument(crId, docType, title, actor) {
  const existing = get('SELECT * FROM documents WHERE cr_id = ? AND doc_type = ?', [crId, docType]);
  if (existing) return existing;
  const row = {
    id: uid('DOC'),
    cr_id: crId,
    doc_type: docType,
    title,
    created_at: nowIso(),
    created_by: actor?.id || null
  };
  insert('documents', row);
  return row;
}

/**
 * Version numbers belong to a generation, not to a file format. Producing the
 * Word copy of an already-approved PDF must join that FINAL version rather than
 * inventing a new one, or the two halves of one contract disagree.
 */
function nextVersion(documentId, final, format) {
  const latest = get(
    'SELECT major, minor, status FROM document_versions WHERE document_id = ? ORDER BY major DESC, minor DESC LIMIT 1',
    [documentId]
  );

  if (final) {
    const latestFinalGroup = get(
      `SELECT major, minor FROM document_versions
        WHERE document_id = ? AND status IN ('FINAL','SIGNED')
        ORDER BY major DESC, minor DESC LIMIT 1`,
      [documentId]
    );
    if (latestFinalGroup) {
      const sameFormat = get(
        'SELECT 1 AS ok FROM document_versions WHERE document_id = ? AND major = ? AND minor = ? AND format = ?',
        [documentId, latestFinalGroup.major, latestFinalGroup.minor, format]
      );
      if (!sameFormat) return { major: latestFinalGroup.major, minor: latestFinalGroup.minor };
    }
    return latest ? { major: latest.major + 1, minor: 0 } : { major: 2, minor: 0 };
  }

  return latest ? { major: latest.major, minor: latest.minor + 1 } : { major: 1, minor: 0 };
}

/**
 * A manual generation is FINAL only when it completes an approved version that
 * is missing this format; otherwise it is a working draft.
 */
function shouldBeFinalCompanion(documentId, format) {
  const finalGroup = get(
    `SELECT major, minor FROM document_versions
      WHERE document_id = ? AND status = 'FINAL'
      ORDER BY major DESC, minor DESC LIMIT 1`,
    [documentId]
  );
  if (!finalGroup) return false;
  const existing = get(
    'SELECT 1 AS ok FROM document_versions WHERE document_id = ? AND major = ? AND minor = ? AND format = ?',
    [documentId, finalGroup.major, finalGroup.minor, format]
  );
  return !existing;
}

/**
 * Generate a new document version. Existing versions are never overwritten:
 * a FINAL version supersedes previous FINAL versions but they remain on disk
 * and downloadable, which is what the audit requirement means by "retained".
 */
export function generate(crId, { format = 'BOTH', final = false, notes = null, actor = null } = {}) {
  const cr = changeRequests.find(crId);
  if (!cr.items?.length && final) {
    throw errors.invalidState('A final document cannot be generated for a change request with no scope items');
  }

  const formats = format === 'BOTH' ? ['DOCX', 'PDF'] : [String(format).toUpperCase()];
  for (const f of formats) {
    if (!FORMATS[f]) throw errors.validation(`Unsupported document format: ${f}`);
  }

  try {
    return transaction(() => {
      const document = ensureDocument(crId, 'CR_DOCUMENT', `Change Request ${cr.cr_number}`, actor);
      // completing an approved version in a second format stays FINAL
      const isFinal = final || formats.every((fmt) => shouldBeFinalCompanion(document.id, fmt));
      const { major, minor } = nextVersion(document.id, isFinal, formats[0]);
      const versionLabel = `${major}.${minor}`;
      const model = buildDocumentModel(cr, {
        version: versionLabel,
        watermark: isFinal ? null : 'DRAFT — not for signature'
      });

      const created = [];
      for (const fmt of formats) {
        const buffer = fmt === 'DOCX' ? renderDocx(model) : renderPdf(model);
        const fileName = `${cr.cr_number.replace(/[^A-Za-z0-9_-]/g, '_')}_v${versionLabel}.${FORMATS[fmt].ext}`;
        const filePath = path.join(documentDir(crId), fileName);
        fs.writeFileSync(filePath, buffer);

        const row = {
          id: uid('DVR'),
          document_id: document.id,
          cr_id: crId,
          version: versionLabel,
          major,
          minor,
          format: fmt,
          file_path: path.relative(config.storageDir, filePath),
          file_size: buffer.length,
          sha256: sha256File(buffer),
          status: isFinal ? 'FINAL' : 'DRAFT',
          is_locked: isFinal ? 1 : 0,
          generated_by: actor?.id || null,
          generated_at: nowIso(),
          notes
        };
        insert('document_versions', row);
        created.push(row);
      }

      if (isFinal) {
        // previous FINAL versions become SUPERSEDED but remain retrievable
        const supersede = all(
          `SELECT id, is_locked FROM document_versions
            WHERE document_id = ? AND status = 'FINAL' AND (major < ? OR (major = ? AND minor < ?))`,
          [document.id, major, major, minor]
        );
        for (const version of supersede) {
          run('UPDATE document_versions SET status = ? WHERE id = ?', ['SUPERSEDED', version.id]);
        }
        run("UPDATE document_versions SET status = 'SUPERSEDED' WHERE document_id = ? AND status = 'DRAFT'", [document.id]);
      }

      update('documents', document.id, { current_version_id: created[0].id });

      audit.record({
        entityType: 'DOCUMENT',
        entityId: document.id,
        crId,
        action: ACTIONS.DOCUMENT_GENERATED,
        actor,
        newValue: { version: versionLabel, formats, status: isFinal ? 'FINAL' : 'DRAFT' },
        comments: notes,
        ip: actor?.ip
      });

      return { version: versionLabel, status: isFinal ? 'FINAL' : 'DRAFT', files: created };
    });
  } catch (error) {
    throw translateDbError(error) || error;
  }
}

export function listForChangeRequest(crId) {
  return all(
    `SELECT v.*, d.doc_type, d.title AS document_title, u.name AS generated_by_name
       FROM document_versions v
       JOIN documents d ON d.id = v.document_id
       LEFT JOIN users u ON u.id = v.generated_by
      WHERE v.cr_id = ?
      ORDER BY v.generated_at DESC, v.major DESC, v.minor DESC`,
    [crId]
  );
}

export function listAll({ q = null, status = null, crId = null, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (q) {
    where.push('(cr.cr_number LIKE ? OR cr.title LIKE ? OR a.account_name LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (status) {
    where.push('v.status = ?');
    params.push(status);
  }
  if (crId) {
    where.push('v.cr_id = ?');
    params.push(crId);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = all(
    `SELECT v.*, d.doc_type, cr.cr_number, cr.title AS cr_title, cr.status AS cr_status,
            a.account_name, u.name AS generated_by_name
       FROM document_versions v
       JOIN documents d ON d.id = v.document_id
       JOIN change_requests cr ON cr.id = v.cr_id
       JOIN accounts a ON a.id = cr.account_id
       LEFT JOIN users u ON u.id = v.generated_by
       ${clause}
      ORDER BY v.generated_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const total =
    get(
      `SELECT COUNT(*) AS count FROM document_versions v
         JOIN change_requests cr ON cr.id = v.cr_id
         JOIN accounts a ON a.id = cr.account_id ${clause}`,
      params
    )?.count || 0;
  return { rows, total };
}

export function getVersion(versionId) {
  const version = get(
    `SELECT v.*, d.doc_type, cr.cr_number, cr.id AS change_request_id
       FROM document_versions v
       JOIN documents d ON d.id = v.document_id
       JOIN change_requests cr ON cr.id = v.cr_id
      WHERE v.id = ?`,
    [versionId]
  );
  if (!version) throw errors.notFound('Document version not found');
  return version;
}

export function resolveFile(versionId) {
  const version = getVersion(versionId);
  const absolute = path.join(config.storageDir, version.file_path);
  if (!fs.existsSync(absolute)) throw errors.notFound('The stored document file is missing');
  return {
    version,
    absolutePath: absolute,
    fileName: path.basename(absolute),
    mime: FORMATS[version.format]?.mime || 'application/octet-stream'
  };
}

export function latestFinal(crId, format = 'PDF') {
  return get(
    `SELECT * FROM document_versions
      WHERE cr_id = ? AND format = ? AND status IN ('FINAL','SIGNED')
      ORDER BY major DESC, minor DESC LIMIT 1`,
    [crId, format]
  );
}

export function latestAny(crId, format = 'PDF') {
  return get(
    `SELECT * FROM document_versions WHERE cr_id = ? AND format = ? ORDER BY major DESC, minor DESC, generated_at DESC LIMIT 1`,
    [crId, format]
  );
}

export function hasFinal(crId) {
  return Boolean(
    get("SELECT 1 AS ok FROM document_versions WHERE cr_id = ? AND status IN ('FINAL','SIGNED') LIMIT 1", [crId])
  );
}

/** Persist the counter-signed document produced by the portal or DocuSign. */
export function storeSignedDocument(crId, buffer, { actor = null, source = 'PORTAL', fileName = null } = {}) {
  const cr = changeRequests.findRaw(crId);
  return transaction(() => {
    const document = ensureDocument(crId, 'SIGNED_CR', `Signed Change Request ${cr.cr_number}`, actor);
    const { major, minor } = nextVersion(document.id, true, 'PDF');
    const versionLabel = `${major}.${minor}`;
    const name = fileName || `${cr.cr_number.replace(/[^A-Za-z0-9_-]/g, '_')}_signed_v${versionLabel}.pdf`;
    const filePath = path.join(documentDir(crId), name);
    fs.writeFileSync(filePath, buffer);

    const row = {
      id: uid('DVR'),
      document_id: document.id,
      cr_id: crId,
      version: versionLabel,
      major,
      minor,
      format: 'PDF',
      file_path: path.relative(config.storageDir, filePath),
      file_size: buffer.length,
      sha256: sha256File(buffer),
      status: 'SIGNED',
      is_locked: 1,
      generated_by: actor?.id || null,
      generated_at: nowIso(),
      notes: `Signed via ${source}`
    };
    insert('document_versions', row);
    update('documents', document.id, { current_version_id: row.id });

    audit.record({
      entityType: 'DOCUMENT',
      entityId: document.id,
      crId,
      action: ACTIONS.DOCUMENT_GENERATED,
      actor: actor || { type: 'SYSTEM', name: source },
      newValue: { version: versionLabel, status: 'SIGNED', source }
    });

    return row;
  });
}

/** Render the signed PDF for portal signatures (document + signature certificate). */
export function renderSignedPdf(crId, signature) {
  const cr = changeRequests.find(crId);
  const model = buildDocumentModel(
    { ...cr, customer_signature_name: signature.signature_name, signed_at: signature.signed_at },
    { version: signature.version || '2.0' }
  );

  model.blocks.push({ type: 'pagebreak' });
  model.blocks.push({ type: 'heading', level: 1, text: 'Electronic Signature Certificate' });
  model.blocks.push({
    type: 'table',
    widths: [35, 65],
    rows: [
      { cells: [{ text: 'Change Request', bold: true, shade: 'E7E6E6' }, { text: `${cr.cr_number} (${cr.cr_reference})` }] },
      { cells: [{ text: 'Customer', bold: true, shade: 'E7E6E6' }, { text: cr.snapshot_legal_entity || '' }] },
      { cells: [{ text: 'Signed by', bold: true, shade: 'E7E6E6' }, { text: signature.signer_name || '' }] },
      { cells: [{ text: 'Email address', bold: true, shade: 'E7E6E6' }, { text: signature.signer_email || '' }] },
      { cells: [{ text: 'Signature', bold: true, shade: 'E7E6E6' }, { text: signature.signature_name || '' }] },
      { cells: [{ text: 'Signed at (UTC)', bold: true, shade: 'E7E6E6' }, { text: signature.signed_at || '' }] },
      { cells: [{ text: 'IP address', bold: true, shade: 'E7E6E6' }, { text: signature.ip_address || '' }] },
      { cells: [{ text: 'Method', bold: true, shade: 'E7E6E6' }, { text: signature.method || 'Portal (email OTP verified)' }] },
      { cells: [{ text: 'Envelope', bold: true, shade: 'E7E6E6' }, { text: signature.envelope_id || 'N/A' }] }
    ]
  });
  model.blocks.push({
    type: 'paragraph',
    italic: true,
    text:
      'The signatory identity was verified by a one-time passcode sent to the email address above. ' +
      'This certificate and the associated audit trail are retained by the Hyreo Change Request Management System.'
  });

  return renderPdf(model);
}

export function previewHtml(crId, { version = null } = {}) {
  const cr = changeRequests.find(crId);
  const model = buildDocumentModel(cr, { version: version || 'preview' });
  return renderModelHtml(model);
}

/**
 * Remove every document of a change request that is being deleted.
 * Refuses outright if any version is locked (FINAL or SIGNED) — those are
 * contractual records and a deletion must never take them with it.
 */
export function removeForChangeRequest(crId) {
  const locked = get(
    'SELECT COUNT(*) AS count FROM document_versions WHERE cr_id = ? AND is_locked = 1',
    [crId]
  )?.count || 0;
  if (locked > 0) {
    throw errors.invalidState('This change request has approved or signed documents and cannot be deleted');
  }

  const versions = all('SELECT id, file_path FROM document_versions WHERE cr_id = ?', [crId]);
  run('UPDATE documents SET current_version_id = NULL WHERE cr_id = ?', [crId]);
  run('DELETE FROM document_versions WHERE cr_id = ?', [crId]);
  run('DELETE FROM documents WHERE cr_id = ?', [crId]);

  for (const version of versions) {
    const absolute = path.join(config.storageDir, version.file_path);
    try {
      if (fs.existsSync(absolute)) fs.rmSync(absolute);
    } catch {
      /* the database is the record of truth; a stray file must not fail the delete */
    }
  }
  try {
    const dir = path.join(config.documentsDir, crId);
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    /* ignore */
  }

  return { removed: versions.length };
}

export function recordDownload(versionId, actor) {
  const version = getVersion(versionId);
  audit.record({
    entityType: 'DOCUMENT',
    entityId: version.document_id,
    crId: version.cr_id,
    action: ACTIONS.DOCUMENT_DOWNLOADED,
    actor,
    newValue: { version: version.version, format: version.format },
    ip: actor?.ip
  });
  return version;
}

export default {
  generate,
  removeForChangeRequest,
  listForChangeRequest,
  listAll,
  getVersion,
  resolveFile,
  latestFinal,
  latestAny,
  hasFinal,
  storeSignedDocument,
  renderSignedPdf,
  previewHtml,
  recordDownload
};
