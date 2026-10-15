import api from '../lib/api.js';
import { notify } from '../lib/ui.js';

/**
 * Document generation is a deliberate choice of format — generating a change
 * request should not silently produce files nobody asked for. The chosen file
 * is downloaded as soon as it exists and is retained as a new version.
 */
export const DOCUMENT_FORMATS = [
  { value: 'PDF', label: 'PDF (.pdf)' },
  { value: 'DOCX', label: 'Word (.docx)' },
  { value: 'BOTH', label: 'Both Word and PDF' }
];

export async function generateAndDownload(crId, format = 'PDF', { notes = null } = {}) {
  const result = await api.post(`/api/change-requests/${crId}/documents/generate`, { format, notes });
  const files = result.files || [];

  notify.success(
    files.length > 1
      ? `Version ${result.version} generated (${files.map((file) => file.format).join(' and ')}).`
      : `Version ${result.version} ${files[0]?.format || ''} generated.`
  );

  // stagger so browsers do not suppress the second download
  files.forEach((file, index) => {
    setTimeout(() => api.download(`/api/documents/versions/${file.id}/download`), index * 450);
  });

  return result;
}

export default { DOCUMENT_FORMATS, generateAndDownload };
