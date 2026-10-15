import zlib from 'node:zlib';

/**
 * Minimal PDF 1.7 writer for the shared document model.
 * Supports: paged text with wrapping, bordered/shaded tables with automatic
 * row splitting across pages, bullets, rules and page footers.
 * Fonts: the standard Type1 faces (Helvetica family) with WinAnsi encoding, so
 * no font files need shipping.
 */

const W_REG = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584
];

const W_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584
];

const FONTS = {
  regular: { key: 'F1', base: 'Helvetica', widths: W_REG },
  bold: { key: 'F2', base: 'Helvetica-Bold', widths: W_BOLD },
  italic: { key: 'F3', base: 'Helvetica-Oblique', widths: W_REG },
  boldItalic: { key: 'F4', base: 'Helvetica-BoldOblique', widths: W_BOLD }
};

/** Map text into the WinAnsi range so the standard fonts can render it. */
function sanitise(input) {
  return String(input ?? '')
    .replace(/₹/g, 'INR ')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/•/g, '\u0095')
    .replace(/ /g, ' ')
    .replace(/✓/g, 'v')
    .replace(/[^\x09\x0A\x0D\x20-\x7E -ÿ\u0095]/g, '?');
}

function escapeText(text) {
  return sanitise(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function charWidth(code, widths) {
  if (code >= 32 && code <= 126) return widths[code - 32];
  if (code === 0x95) return 350; // bullet
  if (code >= 0xa0 && code <= 0xff) return 556;
  return 556;
}

export function measureText(text, { bold = false, size = 10 } = {}) {
  const widths = bold ? W_BOLD : W_REG;
  const clean = sanitise(text);
  let total = 0;
  for (let i = 0; i < clean.length; i += 1) total += charWidth(clean.charCodeAt(i), widths);
  return (total * size) / 1000;
}

export function wrapText(text, maxWidth, options = {}) {
  const lines = [];
  for (const rawLine of String(text ?? '').split('\n')) {
    const words = rawLine.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (measureText(candidate, options) <= maxWidth || current === '') {
        // hard-break words longer than a whole line
        if (measureText(candidate, options) > maxWidth && current === '') {
          let chunk = '';
          for (const ch of word) {
            if (measureText(chunk + ch, options) > maxWidth && chunk) {
              lines.push(chunk);
              chunk = ch;
            } else {
              chunk += ch;
            }
          }
          current = chunk;
          continue;
        }
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  return lines.length ? lines : [''];
}

class PdfBuilder {
  constructor({ pageWidth = 595.28, pageHeight = 841.89, margin = 54, footer = null } = {}) {
    this.pageWidth = pageWidth;
    this.pageHeight = pageHeight;
    this.margin = margin;
    this.contentWidth = pageWidth - margin * 2;
    this.footer = footer;
    this.pages = [];
    this.current = null;
    this.y = 0;
    this.addPage();
  }

  addPage() {
    this.current = [];
    this.pages.push(this.current);
    this.y = this.pageHeight - this.margin;
  }

  op(line) {
    this.current.push(line);
  }

  ensure(height) {
    if (this.y - height < this.margin + 28) {
      this.addPage();
      return true;
    }
    return false;
  }

  setFill(hex) {
    const { r, g, b } = hexToRgb(hex);
    this.op(`${r} ${g} ${b} rg`);
  }

  setStroke(hex) {
    const { r, g, b } = hexToRgb(hex);
    this.op(`${r} ${g} ${b} RG`);
  }

  drawText(text, x, y, { size = 10, bold = false, italic = false, color = '000000' } = {}) {
    const font = bold && italic ? FONTS.boldItalic : bold ? FONTS.bold : italic ? FONTS.italic : FONTS.regular;
    this.setFill(color);
    this.op(`BT /${font.key} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${escapeText(text)}) Tj ET`);
  }

  rect(x, y, w, h, style = 'S', color = '000000') {
    if (style === 'f') this.setFill(color);
    else this.setStroke(color);
    this.op(`${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re ${style}`);
  }

  line(x1, y1, x2, y2, color = '000000', width = 0.6) {
    this.setStroke(color);
    this.op(`${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
  }

  paragraph(text, options = {}) {
    const {
      size = 10, bold = false, italic = false, align = 'left', color = '000000',
      spaceBefore = 0, spaceAfter = 6, indent = 0, lineHeight = 1.32
    } = options;
    this.y -= spaceBefore;
    const width = this.contentWidth - indent;
    const lines = wrapText(text, width, { bold, size });
    const leading = size * lineHeight;
    for (const line of lines) {
      this.ensure(leading);
      let x = this.margin + indent;
      if (align === 'center') x = this.margin + (this.contentWidth - measureText(line, { bold, size })) / 2;
      else if (align === 'right') x = this.pageWidth - this.margin - measureText(line, { bold, size });
      this.y -= leading;
      this.drawText(line, x, this.y, { size, bold, italic, color });
    }
    this.y -= spaceAfter;
  }

  underlineLast(text, options = {}) {
    const { size = 10, bold = false } = options;
    const width = measureText(text, { bold, size });
    const x = this.margin + (this.contentWidth - width) / 2;
    this.line(x, this.y + 1, x + width, this.y + 1);
  }

  table(block) {
    const cellPadding = 5;
    const size = block.size || 9.5;
    const columnCount = Math.max(
      ...block.rows.map((row) => row.cells.reduce((sum, c) => sum + (c.colspan || 1), 0))
    );
    const widths = (block.widths && block.widths.length
      ? block.widths
      : Array.from({ length: columnCount }, () => 100 / columnCount)
    ).map((pct) => (this.contentWidth * pct) / 100);

    for (const row of block.rows) {
      // measure
      let cursor = 0;
      const prepared = row.cells.map((cell) => {
        const span = cell.colspan || 1;
        let w = 0;
        for (let i = 0; i < span; i += 1) w += widths[Math.min(cursor + i, widths.length - 1)] || 0;
        const x = this.margin + widths.slice(0, cursor).reduce((a, b) => a + b, 0);
        cursor += span;
        const lines = wrapText(cell.text ?? '', w - cellPadding * 2, { bold: cell.bold, size });
        return { cell, x, w, lines };
      });
      const rowHeight = Math.max(
        18,
        ...prepared.map((p) => p.lines.length * size * 1.3 + cellPadding * 2)
      );

      if (this.y - rowHeight < this.margin + 28) this.addPage();
      const top = this.y;
      const bottom = top - rowHeight;

      for (const p of prepared) {
        if (p.cell.shade) this.rect(p.x, bottom, p.w, rowHeight, 'f', p.cell.shade);
        if (!block.borderless) this.rect(p.x, bottom, p.w, rowHeight, 'S', '000000');
        let textY = top - cellPadding - size;
        for (const line of p.lines) {
          let tx = p.x + cellPadding;
          if (p.cell.align === 'center') tx = p.x + (p.w - measureText(line, { bold: p.cell.bold, size })) / 2;
          else if (p.cell.align === 'right') tx = p.x + p.w - cellPadding - measureText(line, { bold: p.cell.bold, size });
          this.drawText(line, tx, textY, { size, bold: p.cell.bold, italic: p.cell.italic });
          textY -= size * 1.3;
        }
      }
      this.y = bottom;
    }
    this.y -= 10;
  }

  build(meta = {}) {
    const objects = [];
    const pageCount = this.pages.length;

    if (this.footer) {
      this.pages.forEach((page, index) => {
        const label = this.footer.replace('{page}', index + 1).replace('{pages}', pageCount);
        const size = 8;
        const width = measureText(label, { size });
        page.push('0.45 0.45 0.45 rg');
        page.push(
          `BT /${FONTS.regular.key} ${size} Tf 1 0 0 1 ${(this.pageWidth - width) / 2} ${this.margin - 18} Tm (${escapeText(
            label
          )}) Tj ET`
        );
      });
    }

    const add = (body) => {
      objects.push(body);
      return objects.length; // object number
    };

    const fontObjects = Object.values(FONTS).map((font) =>
      add(`<< /Type /Font /Subtype /Type1 /BaseFont /${font.base} /Encoding /WinAnsiEncoding >>`)
    );
    const fontResources = Object.values(FONTS)
      .map((font, i) => `/${font.key} ${fontObjects[i]} 0 R`)
      .join(' ');

    const contentObjectNumbers = this.pages.map((page) => {
      const raw = Buffer.from(page.join('\n'), 'latin1');
      const compressed = zlib.deflateSync(raw);
      return add({ stream: compressed, dict: `<< /Length ${compressed.length} /Filter /FlateDecode >>` });
    });

    const pagesObjNumber = objects.length + this.pages.length + 1;
    const pageObjectNumbers = this.pages.map((_, index) =>
      add(
        `<< /Type /Page /Parent ${pagesObjNumber} 0 R /MediaBox [0 0 ${this.pageWidth.toFixed(2)} ${this.pageHeight.toFixed(
          2
        )}] /Resources << /Font << ${fontResources} >> >> /Contents ${contentObjectNumbers[index]} 0 R >>`
      )
    );

    const pagesObj = add(
      `<< /Type /Pages /Count ${pageCount} /Kids [${pageObjectNumbers.map((n) => `${n} 0 R`).join(' ')}] >>`
    );
    const infoObj = add(
      `<< /Title (${escapeText(meta.title || 'Change Request')}) /Author (${escapeText(
        meta.author || 'Hyreo'
      )}) /Producer (Hyreo Account Management) /Creator (Hyreo Account Management) /CreationDate (D:${pdfDate()}) >>`
    );
    const catalogObj = add(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);

    // serialise
    const chunks = [Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
    let offset = chunks[0].length;
    const offsets = [0];

    objects.forEach((body, index) => {
      const number = index + 1;
      let buffer;
      if (typeof body === 'string') {
        buffer = Buffer.from(`${number} 0 obj\n${body}\nendobj\n`, 'latin1');
      } else {
        buffer = Buffer.concat([
          Buffer.from(`${number} 0 obj\n${body.dict}\nstream\n`, 'latin1'),
          body.stream,
          Buffer.from('\nendstream\nendobj\n', 'latin1')
        ]);
      }
      offsets[number] = offset;
      offset += buffer.length;
      chunks.push(buffer);
    });

    const xrefOffset = offset;
    let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= objects.length; i += 1) {
      xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    }
    xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogObj} 0 R /Info ${infoObj} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    chunks.push(Buffer.from(xref, 'latin1'));

    return Buffer.concat(chunks);
  }
}

function pdfDate(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(
    date.getUTCMinutes()
  )}${p(date.getUTCSeconds())}Z`;
}

function hexToRgb(hex) {
  const clean = String(hex || '000000').replace('#', '');
  const num = parseInt(clean.length === 3 ? clean.replace(/(.)/g, '$1$1') : clean, 16);
  return {
    r: (((num >> 16) & 255) / 255).toFixed(3),
    g: (((num >> 8) & 255) / 255).toFixed(3),
    b: ((num & 255) / 255).toFixed(3)
  };
}

/**
 * @param {{ blocks: Array, meta?: object }} model
 * @returns {Buffer} PDF bytes
 */
export function renderPdf(model) {
  const meta = model.meta || {};
  const doc = new PdfBuilder({
    footer: meta.footer || 'Page {page} of {pages}',
    pageWidth: meta.landscape ? 841.89 : 595.28,
    pageHeight: meta.landscape ? 595.28 : 841.89
  });

  for (const block of model.blocks || []) {
    switch (block.type) {
      case 'title':
        doc.paragraph(block.text, { size: 13, bold: true, align: 'center', spaceAfter: 4 });
        doc.underlineLast(block.text, { size: 13, bold: true });
        doc.y -= 8;
        break;
      case 'heading':
        doc.paragraph(block.text, {
          size: block.level === 1 ? 11.5 : 10.5,
          bold: true,
          spaceBefore: 10,
          spaceAfter: 5,
          color: block.level === 1 ? '1F3864' : '000000'
        });
        break;
      case 'paragraph':
        doc.paragraph(block.text, {
          size: block.size ? block.size / 2 : 10,
          bold: block.bold,
          italic: block.italic,
          align: block.align === 'both' ? 'left' : block.align
        });
        break;
      case 'bullets':
        for (const item of block.items || []) {
          doc.paragraph(`•  ${item}`, { indent: 14, spaceAfter: 3 });
        }
        break;
      case 'table':
        doc.table(block);
        break;
      case 'spacer':
        doc.y -= (block.size || 120) / 20;
        break;
      case 'pagebreak':
        doc.addPage();
        break;
      default:
        break;
    }
  }

  return doc.build(meta);
}

export default { renderPdf, measureText, wrapText };
