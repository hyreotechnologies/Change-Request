import fs from 'node:fs';
import { Router } from 'express';
import { handler, requireSession, requirePermission } from '../middleware/index.js';
import documents from '../services/documents.js';
import reports from '../services/reports.js';

const router = Router();
router.use(requireSession);

router.get(
  '/',
  requirePermission('document.view'),
  handler((req, res) => {
    const { q, status, crId, page = 1, pageSize = 50 } = req.query;
    const limit = Math.min(Number(pageSize) || 50, 200);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;
    res.json({ data: documents.listAll({ q, status, crId, limit, offset }) });
  })
);

router.get(
  '/versions/:id',
  requirePermission('document.view'),
  handler((req, res) => {
    res.json({ data: documents.getVersion(req.params.id) });
  })
);

router.get(
  '/versions/:id/preview',
  requirePermission('document.view'),
  handler((req, res) => {
    const version = documents.getVersion(req.params.id);
    res.json({ data: { html: documents.previewHtml(version.cr_id, { version: version.version }), version } });
  })
);

router.get(
  '/versions/:id/download',
  requirePermission('document.download'),
  handler((req, res) => {
    const file = documents.resolveFile(req.params.id);
    documents.recordDownload(req.params.id, req.user);
    res.setHeader('Content-Type', file.mime);
    res.setHeader(
      'Content-Disposition',
      `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename="${file.fileName}"`
    );
    fs.createReadStream(file.absolutePath).pipe(res);
  })
);

/* --------------------------------------------------------------- reports -- */

export const reportRouter = Router();
reportRouter.use(requireSession);

reportRouter.get(
  '/',
  requirePermission('report.view'),
  handler((req, res) => {
    res.json({ data: reports.listReports() });
  })
);

reportRouter.get(
  '/:code',
  requirePermission('report.view'),
  handler((req, res) => {
    res.json({ data: reports.run(req.params.code, req.query, req.user) });
  })
);

reportRouter.get(
  '/:code/export',
  requirePermission('report.export'),
  handler((req, res) => {
    const format = String(req.query.format || 'xlsx').toLowerCase();
    const { buffer, fileName, mime } = reports.exportReport(req.params.code, req.query, req.user, format);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.end(buffer);
  })
);

export default router;
