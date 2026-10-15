import { createZip } from './zip.js';

/**
 * Renders the shared document model (see services/documentModel.js) into a
 * Word .docx package. No third-party template engine: the legal layout of the
 * change request document is produced directly as OOXML.
 *
 * Block types: title | heading | paragraph | bullets | table | spacer | pagebreak
 */

const PAGE_WIDTH_TWIPS = 11906;
const MARGIN_TWIPS = 1134;
const CONTENT_WIDTH = PAGE_WIDTH_TWIPS - MARGIN_TWIPS * 2; // 9638

export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // strip control characters that are illegal in XML 1.0
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function runProps({ bold, italic, underline, size = 20, color = '000000' } = {}) {
  return [
    '<w:rPr>',
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>',
    bold ? '<w:b/><w:bCs/>' : '',
    italic ? '<w:i/><w:iCs/>' : '',
    underline ? '<w:u w:val="single"/>' : '',
    `<w:color w:val="${color}"/>`,
    `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`,
    '</w:rPr>'
  ].join('');
}

function textRuns(text, opts) {
  const parts = String(text ?? '').split('\n');
  return parts
    .map((line, index) => {
      const br = index > 0 ? '<w:br/>' : '';
      return `<w:r>${runProps(opts)}${br}<w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r>`;
    })
    .join('');
}

function paragraph(text, opts = {}) {
  const {
    align, bold, italic, underline, size = 20, color, spaceBefore = 0, spaceAfter = 80, indent = 0, numbered
  } = opts;
  const pPr = [
    '<w:pPr>',
    numbered ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : '',
    indent ? `<w:ind w:left="${indent}"/>` : '',
    `<w:spacing w:before="${spaceBefore}" w:after="${spaceAfter}" w:line="252" w:lineRule="auto"/>`,
    align ? `<w:jc w:val="${align}"/>` : '',
    runProps({ bold, italic, underline, size, color }).replace('<w:rPr>', '<w:rPr>').replace('</w:rPr>', '</w:rPr>'),
    '</w:pPr>'
  ].join('');
  return `<w:p>${pPr}${textRuns(text, { bold, italic, underline, size, color })}</w:p>`;
}

function emptyParagraph(size = 10) {
  return `<w:p><w:pPr><w:spacing w:after="${size}" w:line="252" w:lineRule="auto"/></w:pPr></w:p>`;
}

function cellXml(cell, widthTwips) {
  const {
    text = '', bold = false, italic = false, shade = null, align = null, colspan = 1, valign = 'center', size = 20
  } = cell;
  const tcPr = [
    '<w:tcPr>',
    `<w:tcW w:w="${widthTwips}" w:type="dxa"/>`,
    colspan > 1 ? `<w:gridSpan w:val="${colspan}"/>` : '',
    shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>` : '',
    `<w:vAlign w:val="${valign}"/>`,
    '<w:tcMar><w:top w:w="80" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tcMar>',
    '</w:tcPr>'
  ].join('');
  const lines = String(text ?? '').split('\n');
  const paragraphs = lines
    .map((line) =>
      `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="252" w:lineRule="auto"/>${
        align ? `<w:jc w:val="${align}"/>` : ''
      }</w:pPr>${line === '' ? '' : textRuns(line, { bold, italic, size })}</w:p>`
    )
    .join('');
  return `<w:tc>${tcPr}${paragraphs}</w:tc>`;
}

function tableXml(block) {
  const widths = block.widths && block.widths.length ? block.widths : null;
  const columnCount = Math.max(
    ...block.rows.map((row) => row.cells.reduce((sum, c) => sum + (c.colspan || 1), 0))
  );
  const columnWidths = widths
    ? widths.map((pct) => Math.round((CONTENT_WIDTH * pct) / 100))
    : Array.from({ length: columnCount }, () => Math.round(CONTENT_WIDTH / columnCount));

  const grid = columnWidths.map((w) => `<w:gridCol w:w="${w}"/>`).join('');
  const rows = block.rows
    .map((row) => {
      let cursor = 0;
      const cells = row.cells
        .map((cell) => {
          const span = cell.colspan || 1;
          let width = 0;
          for (let i = 0; i < span; i += 1) width += columnWidths[Math.min(cursor + i, columnWidths.length - 1)] || 0;
          cursor += span;
          return cellXml(cell, width);
        })
        .join('');
      const trPr = row.header ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
      return `<w:tr>${trPr}${cells}</w:tr>`;
    })
    .join('');

  const borders = block.borderless
    ? '<w:tblBorders><w:top w:val="none"/><w:left w:val="none"/><w:bottom w:val="none"/><w:right w:val="none"/><w:insideH w:val="none"/><w:insideV w:val="none"/></w:tblBorders>'
    : '<w:tblBorders>' +
      ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
        .map((side) => `<w:${side} w:val="single" w:sz="8" w:space="0" w:color="000000"/>`)
        .join('') +
      '</w:tblBorders>';

  return (
    '<w:tbl><w:tblPr>' +
    `<w:tblW w:w="${CONTENT_WIDTH}" w:type="dxa"/>` +
    borders +
    '<w:tblLayout w:type="fixed"/>' +
    '<w:tblLook w:val="0600" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/>' +
    `</w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>` +
    emptyParagraph()
  );
}

function blockToXml(block) {
  switch (block.type) {
    case 'title':
      return paragraph(block.text, { bold: true, underline: true, align: 'center', size: 24, spaceAfter: 200 });
    case 'heading':
      return paragraph(block.text, {
        bold: true,
        size: block.level === 1 ? 22 : 20,
        spaceBefore: 160,
        spaceAfter: 100,
        color: block.level === 1 ? '1F3864' : '000000'
      });
    case 'paragraph':
      return paragraph(block.text, {
        bold: block.bold,
        italic: block.italic,
        align: block.align,
        size: block.size || 20
      });
    case 'bullets':
      return (block.items || [])
        .map((item) => paragraph(`•  ${item}`, { indent: 240, spaceAfter: 40 }))
        .join('');
    case 'table':
      return tableXml(block);
    case 'spacer':
      return emptyParagraph(block.size || 120);
    case 'pagebreak':
      return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    default:
      return '';
  }
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
</Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults>
<w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="en-IN"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="252" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;

const SETTINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>
</w:settings>`;

function coreXml({ title, author, created }) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${escapeXml(title)}</dc:title>
<dc:creator>${escapeXml(author)}</dc:creator>
<cp:lastModifiedBy>${escapeXml(author)}</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified>
</cp:coreProperties>`;
}

const APP_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>Hyreo Change Request Management System</Application><DocSecurity>0</DocSecurity><Company>Hyreo</Company>
</Properties>`;

/**
 * @param {{ blocks: Array, meta?: { title?: string, author?: string } }} model
 * @returns {Buffer} .docx package
 */
export function renderDocx(model) {
  const meta = model.meta || {};
  const body = (model.blocks || []).map(blockToXml).join('');
  const sectPr =
    `<w:sectPr><w:pgSz w:w="${PAGE_WIDTH_TWIPS}" w:h="16838"/>` +
    `<w:pgMar w:top="${MARGIN_TWIPS}" w:right="${MARGIN_TWIPS}" w:bottom="${MARGIN_TWIPS}" w:left="${MARGIN_TWIPS}" w:header="708" w:footer="708" w:gutter="0"/>` +
    '<w:cols w:space="708"/><w:docGrid w:linePitch="360"/></w:sectPr>';

  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<w:body>${body}${sectPr}</w:body></w:document>`;

  return createZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/_rels/document.xml.rels', data: DOCUMENT_RELS },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'word/settings.xml', data: SETTINGS },
    {
      name: 'docProps/core.xml',
      data: coreXml({
        title: meta.title || 'Change Request',
        author: meta.author || 'Hyreo Services India Private Limited',
        created: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
      })
    },
    { name: 'docProps/app.xml', data: APP_XML }
  ]);
}

export default { renderDocx, escapeXml };
