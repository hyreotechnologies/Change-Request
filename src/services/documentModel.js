import { formatLongDate, formatShortDate, formatDmy, todayIso } from '../lib/dates.js';
import { formatMoney, round2 } from '../lib/money.js';
import { getSetting } from './settings.js';

/**
 * Builds the renderer-independent model of the Change Request document.
 * The structure mirrors the executed Hyreo change request form:
 *   title -> preamble -> reference table -> scope table ->
 *   cost evaluation & payment terms table -> witness clause -> signature block.
 * lib/docx.js, lib/pdf.js and the HTML preview all consume this same model.
 */

const SHADE = 'E7E6E6';
const SECTION_SHADE = 'D9E2F3';

function hours(value) {
  const n = round2(value || 0);
  return `${Number.isInteger(n) ? n : n.toFixed(2)} Hours`;
}

export function buildDocumentModel(cr, { version = '1.0', watermark = null } = {}) {
  const currency = cr.costs?.currency || 'INR';
  const companyLegal = getSetting('company.legal_name', 'Hyreo Services India Private Limited');
  const signatoryName = getSetting('company.signatory_name', '');
  const signatoryDesignation = getSetting('company.signatory_designation', '');
  const effortDisclaimer = getSetting('terms.effort_disclaimer', '');
  const generalTerms = cr.general_terms
    ? String(cr.general_terms).split('\n').map((t) => t.trim()).filter(Boolean)
    : getSetting('terms.general_terms', []) || [];

  const msaNumber = cr.snapshot_msa_number || cr.msa?.msa_reference_number || '';
  const msaDate = cr.snapshot_msa_date || cr.msa?.msa_date;
  const licenseeLegal = cr.snapshot_legal_entity || cr.account?.legal_entity_name || cr.account?.account_name || '';
  const crSequence = cr.seq_no || 1;
  const crLabel = `CR${String(crSequence).padStart(2, '0')}`;

  const blocks = [];

  blocks.push({ type: 'title', text: 'CHANGE REQUEST' });

  blocks.push({
    type: 'paragraph',
    align: 'both',
    text:
      `This Change Request No. ${crSequence} to the Master Subscription Agreement dated ${formatLongDate(msaDate)}, ` +
      `is entered into on ${formatShortDate(cr.cr_date)} (hereinafter referred to as 'Change Request ${crSequence}' or '${crLabel}')` +
      (licenseeLegal ? ` between ${companyLegal} (the "Licensor") and ${licenseeLegal} (the "Licensee").` : '.')
  });

  blocks.push({
    type: 'table',
    widths: [47, 53],
    rows: [
      {
        cells: [
          { text: 'Master Subscription Agreement Reference No.', bold: true, shade: SHADE },
          { text: msaNumber }
        ]
      },
      {
        cells: [
          { text: 'Change Request Reference No.', bold: true, shade: SHADE },
          { text: cr.cr_reference || cr.cr_number || '' }
        ]
      },
      {
        cells: [
          { text: 'Change Request Date', bold: true, shade: SHADE },
          { text: formatLongDate(cr.cr_date) }
        ]
      },
      {
        cells: [
          { text: 'Customer / Licensee', bold: true, shade: SHADE },
          { text: licenseeLegal }
        ]
      },
      {
        cells: [
          { text: 'Licensor', bold: true, shade: SHADE },
          { text: companyLegal }
        ]
      }
    ]
  });

  /* ------------------------------------------------ change request scope -- */
  blocks.push({ type: 'heading', level: 1, text: 'Change Request Scope' });

  const scopeRows = [
    {
      header: true,
      cells: [
        { text: 'Item #', bold: true, shade: SHADE, align: 'center' },
        { text: 'CR Feature Name', bold: true, shade: SHADE },
        { text: 'Description', bold: true, shade: SHADE },
        { text: 'CR Release date', bold: true, shade: SHADE, align: 'center' },
        { text: 'Remarks', bold: true, shade: SHADE }
      ]
    }
  ];

  for (const item of cr.items || []) {
    const description = [
      item.requested_change ? `Requested Change: ${item.requested_change}` : '',
      item.detailed_description || '',
      item.business_justification ? `Business Justification: ${item.business_justification}` : '',
      item.current_behaviour ? `Current Behaviour: ${item.current_behaviour}` : '',
      item.expected_behaviour ? `Expected Behaviour: ${item.expected_behaviour}` : ''
    ]
      .filter(Boolean)
      .join('\n');

    scopeRows.push({
      cells: [
        { text: String(item.item_no), align: 'center' },
        { text: item.feature_name || '' },
        { text: description },
        { text: formatDmy(item.release_date), align: 'center' },
        { text: item.remarks || '' }
      ]
    });
  }

  if ((cr.items || []).length === 0) {
    scopeRows.push({ cells: [{ text: 'No scope items recorded.', colspan: 5, italic: true }] });
  }

  blocks.push({ type: 'table', widths: [8, 20, 44, 14, 14], rows: scopeRows });

  /* ------------------------------------- cost evaluation & payment terms -- */
  blocks.push({ type: 'heading', level: 1, text: 'Change Cost Evaluation and Payment Terms' });

  const efforts = (cr.efforts || []).filter((e) => Number(e.hours) > 0);
  const totalEffort = round2((cr.efforts || []).reduce((sum, e) => sum + Number(e.hours || 0), 0));
  const costs = cr.costs || {};

  const costRows = [
    {
      cells: [{ text: 'Estimated Effort (Person Hours)', bold: true, shade: SECTION_SHADE, colspan: 2 }]
    }
  ];

  (efforts.length ? efforts : [{ label: 'Development Efforts', hours: 0 }]).forEach((effort, index) => {
    costRows.push({
      cells: [
        { text: `${index + 1}. ${effort.label}${effort.notes ? ` — ${effort.notes}` : ''}` },
        { text: hours(effort.hours), align: 'center' }
      ]
    });
  });

  costRows.push({
    cells: [
      { text: 'Total Effort', bold: true },
      { text: hours(totalEffort), bold: true, align: 'center' }
    ]
  });

  if (effortDisclaimer) {
    costRows.push({ cells: [{ text: effortDisclaimer, italic: true, colspan: 2 }] });
  }

  costRows.push({ cells: [{ text: 'Timelines', bold: true, shade: SECTION_SHADE, colspan: 2 }] });
  costRows.push({
    cells: [
      {
        text:
          [
            cr.estimated_business_days ? `${cr.estimated_business_days} Business Days` : '',
            cr.estimated_timeline || '',
            cr.target_release_date ? `Target release date: ${formatDmy(cr.target_release_date)}` : '',
            cr.planned_production_release ? `Planned production release: ${formatDmy(cr.planned_production_release)}` : ''
          ]
            .filter(Boolean)
            .join('\n') || 'To be confirmed',
        colspan: 2
      }
    ]
  });

  costRows.push({ cells: [{ text: 'Assumptions and Dependencies', bold: true, shade: SECTION_SHADE, colspan: 2 }] });
  const assumptionLines = [
    ...(cr.assumptions || []).map((a) => a.text),
    ...(cr.dependencies || []).map((d) => `${dependencyLabel(d.dependency_type)}: ${d.text}`)
  ].filter(Boolean);
  costRows.push({
    cells: [{ text: assumptionLines.length ? assumptionLines.join('\n') : 'Nil', colspan: 2 }]
  });

  costRows.push({ cells: [{ text: 'Cost Estimate', bold: true, shade: SECTION_SHADE, colspan: 2 }] });
  costRows.push({
    cells: [
      { text: `Billing Rate (${currency} ${formatNumber(costs.billing_rate)} / Hour)` },
      { text: formatMoney(costs.billing_rate, currency), align: 'right' }
    ]
  });
  costRows.push({
    cells: [
      { text: `Change Request (CR) Cost (${hours(totalEffort)} x ${formatMoney(costs.billing_rate, currency)})` },
      { text: formatMoney(costs.subtotal, currency), align: 'right' }
    ]
  });
  if (Number(costs.discount_amount) > 0) {
    costRows.push({
      cells: [
        { text: `Discount${costs.discount_type === 'PERCENT' ? ` (${formatNumber(costs.discount_value)}%)` : ''}` },
        { text: formatMoney(costs.discount_amount, currency), align: 'right' }
      ]
    });
  }
  if (Number(costs.tax_percent) > 0) {
    costRows.push({
      cells: [
        { text: `Tax (${formatNumber(costs.tax_percent)}%)` },
        { text: formatMoney(costs.tax_amount, currency), align: 'right' }
      ]
    });
  }
  costRows.push({
    cells: [
      { text: 'Total Change Request (CR) Cost', bold: true },
      { text: formatMoney(costs.total_cost, currency), bold: true, align: 'right' }
    ]
  });

  const paymentLines = [
    cr.payment_terms ? `Payment terms: ${cr.payment_terms}` : '',
    cr.po_required ? `Purchase order required${cr.po_number ? ` (PO ${cr.po_number})` : ''}.` : '',
    cr.invoice_terms || ''
  ].filter(Boolean);
  if (paymentLines.length) {
    costRows.push({ cells: [{ text: 'Payment Terms', bold: true, shade: SECTION_SHADE, colspan: 2 }] });
    costRows.push({ cells: [{ text: paymentLines.join('\n'), colspan: 2 }] });
  }

  costRows.push({ cells: [{ text: 'General Terms', bold: true, shade: SECTION_SHADE, colspan: 2 }] });
  costRows.push({
    cells: [{ text: generalTerms.map((term) => `•  ${term}`).join('\n') || 'Nil', colspan: 2 }]
  });

  blocks.push({ type: 'table', widths: [72, 28], rows: costRows });

  /* -------------------------------------------------------- signature -- */
  const signatureYear = String(cr.cr_date || todayIso()).slice(0, 4);
  blocks.push({
    type: 'paragraph',
    text:
      'IN WITNESS WHEREOF, the Parties hereto agree and affix their signature to this Change Request Form with effect from ' +
      `______ the ______ day of ________, ${signatureYear}`
  });

  blocks.push({
    type: 'table',
    widths: [50, 50],
    rows: [
      {
        cells: [
          { text: `LICENSOR\nFor ${companyLegal}`, bold: true, shade: SHADE },
          { text: `LICENSEE\nFor ${licenseeLegal}`, bold: true, shade: SHADE }
        ]
      },
      {
        cells: [
          { text: `Name: ${signatoryName || ''}` },
          { text: `Name: ${cr.customer_signature_name || cr.snapshot_customer_approver || ''}` }
        ]
      },
      {
        cells: [
          { text: `Designation: ${signatoryDesignation || ''}` },
          { text: `Designation: ${cr.snapshot_customer_approver_designation || ''}` }
        ]
      },
      {
        cells: [{ text: 'Signature:' }, { text: 'Signature:' }]
      },
      {
        cells: [
          { text: `Date: ${cr.internally_approved_at ? formatLongDate(cr.internally_approved_at.slice(0, 10)) : ''}` },
          { text: `Date: ${cr.signed_at ? formatLongDate(cr.signed_at.slice(0, 10)) : ''}` }
        ]
      }
    ]
  });

  return {
    meta: {
      title: `Change Request ${cr.cr_number}`,
      author: companyLegal,
      subject: cr.title,
      footer: `${cr.cr_number} — ${cr.cr_reference} | Page {page} of {pages}`,
      version
    },
    blocks
  };
}

function dependencyLabel(type) {
  return (
    {
      CUSTOMER: 'Customer dependency',
      INTERNAL: 'Internal dependency',
      THIRD_PARTY: 'Third-party dependency',
      RISK: 'Risk',
      REMARK: 'Remark'
    }[type] || 'Dependency'
  );
}

function formatNumber(value) {
  const n = Number(value || 0);
  return Number.isInteger(n) ? n.toLocaleString('en-IN') : n.toFixed(2);
}

/** HTML preview of the very same model (used by the Preview button and the portals). */
export function renderModelHtml(model) {
  const esc = (v) =>
    String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br/>');

  const parts = model.blocks.map((block) => {
    switch (block.type) {
      case 'title':
        return `<h1 class="doc-title">${esc(block.text)}</h1>`;
      case 'heading':
        return `<h2 class="doc-h${block.level || 2}">${esc(block.text)}</h2>`;
      case 'paragraph':
        return `<p class="doc-p${block.italic ? ' doc-italic' : ''}" style="${block.align === 'center' ? 'text-align:center;' : ''}${
          block.size ? `font-size:${block.size / 2}pt;` : ''
        }">${esc(block.text)}</p>`;
      case 'bullets':
        return `<ul class="doc-ul">${(block.items || []).map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
      case 'table': {
        const colgroup = block.widths ? `<colgroup>${block.widths.map((w) => `<col style="width:${w}%"/>`).join('')}</colgroup>` : '';
        const rows = block.rows
          .map(
            (row) =>
              `<tr>${row.cells
                .map(
                  (cell) =>
                    `<td${cell.colspan > 1 ? ` colspan="${cell.colspan}"` : ''} style="${
                      cell.shade ? `background:#${cell.shade};` : ''
                    }${cell.bold ? 'font-weight:600;' : ''}${cell.align ? `text-align:${cell.align};` : ''}${
                      cell.italic ? 'font-style:italic;' : ''
                    }">${esc(cell.text)}</td>`
                )
                .join('')}</tr>`
          )
          .join('');
        return `<table class="doc-table">${colgroup}<tbody>${rows}</tbody></table>`;
      }
      case 'spacer':
        return '<div class="doc-spacer"></div>';
      case 'pagebreak':
        return '<hr class="doc-pagebreak"/>';
      default:
        return '';
    }
  });

  return `<div class="doc-page">${parts.join('\n')}</div>`;
}

export default { buildDocumentModel, renderModelHtml };
