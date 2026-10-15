import fs from 'node:fs';
import express, { Router } from 'express';
import { handler, requireSession, requirePermission } from '../middleware/index.js';
import accounts from '../services/accounts.js';
import msaDocuments from '../services/msaDocuments.js';
import changeRequests from '../services/changeRequests.js';
import numbering from '../services/numbering.js';
import audit from '../services/audit.js';

const router = Router();
router.use(requireSession);

router.get(
  '/',
  requirePermission('account.view'),
  handler((req, res) => {
    const { q, status, page = 1, pageSize = 25, sort } = req.query;
    const limit = Math.min(Number(pageSize) || 25, 200);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;
    res.json({ data: accounts.list({ q, status, limit, offset, sort }) });
  })
);

/**
 * Upload the signed MSA and read its details. The document is sent as base64 in
 * JSON so no multipart dependency is needed; the limit is raised for this route
 * alone rather than globally.
 */
router.post(
  '/msa-documents',
  requirePermission('account.create'),
  express.json({ limit: '25mb' }),
  handler((req, res) => {
    res.status(201).json({ data: msaDocuments.upload(req.body || {}, req.user) });
  })
);

router.get(
  '/msa-documents/:id/download',
  requirePermission('account.view'),
  handler((req, res) => {
    const file = msaDocuments.resolveFile(req.params.id);
    res.setHeader('Content-Type', file.mime);
    res.setHeader(
      'Content-Disposition',
      `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename="${file.fileName}"`
    );
    fs.createReadStream(file.absolutePath).pipe(res);
  })
);

router.get(
  '/lookup',
  requirePermission('account.view'),
  handler((req, res) => {
    res.json({ data: accounts.lookup(req.query.q || '') });
  })
);

router.post(
  '/',
  requirePermission('account.create'),
  handler((req, res) => {
    res.status(201).json({ data: accounts.create(req.body, req.user) });
  })
);

router.get(
  '/:id',
  requirePermission('account.view'),
  handler((req, res) => {
    res.json({ data: accounts.find(req.params.id) });
  })
);

router.patch(
  '/:id',
  requirePermission('account.edit'),
  handler((req, res) => {
    res.json({ data: accounts.edit(req.params.id, req.body, req.user) });
  })
);

router.get(
  '/:id/deletion-impact',
  requirePermission('account.delete'),
  handler((req, res) => {
    res.json({ data: accounts.deletionImpact(req.params.id) });
  })
);

router.delete(
  '/:id',
  requirePermission('account.delete'),
  handler((req, res) => {
    const confirmName = req.query.confirm ?? req.body?.confirm_name ?? null;
    res.json({ data: accounts.remove(req.params.id, req.user, { confirmName }) });
  })
);

router.post(
  '/:id/status',
  requirePermission('account.edit'),
  handler((req, res) => {
    res.json({ data: accounts.setStatus(req.params.id, req.body?.status, req.user) });
  })
);

router.get(
  '/:id/change-requests',
  requirePermission('cr.view'),
  handler((req, res) => {
    res.json({ data: accounts.changeRequests(req.params.id, { msaId: req.query.msaId || null }) });
  })
);

router.get(
  '/:id/summary',
  requirePermission('account.view'),
  handler((req, res) => {
    res.json({ data: accounts.summary(req.params.id) });
  })
);

router.get(
  '/:id/next-cr-number',
  requirePermission('cr.view'),
  handler((req, res) => {
    res.json({ data: numbering.preview(req.params.id) });
  })
);

router.get(
  '/:id/audit',
  requirePermission('audit.view'),
  handler((req, res) => {
    res.json({ data: audit.listForEntity('ACCOUNT', req.params.id) });
  })
);

router.post(
  '/:id/msas',
  requirePermission('msa.create'),
  handler((req, res) => {
    res.status(201).json({ data: accounts.addMsa(req.params.id, req.body, req.user) });
  })
);

export const msaRouter = Router();
msaRouter.use(requireSession);

msaRouter.get(
  '/:id',
  requirePermission('account.view'),
  handler((req, res) => {
    res.json({ data: accounts.findMsa(req.params.id) });
  })
);

msaRouter.patch(
  '/:id',
  requirePermission('msa.edit'),
  handler((req, res) => {
    res.json({ data: accounts.editMsa(req.params.id, req.body, req.user) });
  })
);

msaRouter.get(
  '/:id/document',
  requirePermission('account.view'),
  handler((req, res) => {
    const document = msaDocuments.findForMsa(req.params.id);
    if (!document) {
      res.json({ data: null });
      return;
    }
    res.json({
      data: {
        id: document.id,
        file_name: document.file_name,
        file_size: document.file_size,
        content_type: document.content_type,
        document_kind: document.document_kind,
        uploaded_at: document.uploaded_at
      }
    });
  })
);

msaRouter.get(
  '/:id/change-requests',
  requirePermission('cr.view'),
  handler((req, res) => {
    const msa = accounts.findMsa(req.params.id);
    res.json({
      data: {
        msa,
        account: accounts.find(msa.account_id),
        change_requests: changeRequests.list({ msaId: msa.id, limit: 200 }, req.user).rows
      }
    });
  })
);

export default router;
