import zlib from 'node:zlib';
import { readZip, isZip } from './unzip.js';

/**
 * Plain-text extraction from an uploaded contract.
 *
 * Supports Word (.docx), text-based PDF and plain text. A scanned PDF holds
 * images rather than text, and no amount of parsing recovers words from pixels —
 * those come back with `text: ''` and a warning, and the caller falls back to
 * manual entry rather than inventing data.
 */

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name) => XML_ENTITIES[name] || ' ');
}

function tidy(text) {
  return text
    .replace(/\r\n?/g, '\n')
    // glyph codes a font could not map decode to control characters; drop them
    // so they never reach the field extractor as if they were words
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]+/g, ' ')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------------------------------------------ Word -- */

export function extractDocx(buffer) {
  const entries = readZip(buffer);
  const parts = ['word/document.xml', 'word/header1.xml', 'word/footer1.xml'].filter((name) => entries.has(name));
  if (!parts.length) return { text: '', warnings: ['The Word document did not contain a readable document part.'] };

  let out = '';
  for (const part of parts) {
    const xml = entries.get(part).toString('utf8');
    out += `${xml
      .replace(/<w:tab[^>]*\/>/g, '\t')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<\/w:tc>/g, '\t')
      .replace(/<\/w:tr>/g, '\n')
      .replace(/<[^>]+>/g, '')}\n`;
  }
  return { text: tidy(decodeEntities(out)), warnings: [] };
}

/* ------------------------------------------------------------------- PDF -- */

function decodePdfString(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) break;
    if (next >= '0' && next <= '7') {
      let octal = '';
      let j = i + 1;
      while (j < raw.length && octal.length < 3 && raw[j] >= '0' && raw[j] <= '7') {
        octal += raw[j];
        j += 1;
      }
      out += String.fromCharCode(parseInt(octal, 8));
      i = j - 1;
      continue;
    }
    const escapes = { n: '\n', r: '\n', t: '\t', b: '', f: '', '(': '(', ')': ')', '\\': '\\' };
    out += escapes[next] ?? next;
    i += 1;
  }
  return out;
}

function decodeHexString(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  let out = '';
  for (let i = 0; i + 1 < clean.length; i += 2) {
    const code = parseInt(clean.slice(i, i + 2), 16);
    if (code >= 32 || code === 10 || code === 9) out += String.fromCharCode(code);
  }
  return out;
}

/* ------------------------------------------------- font character maps -- */

function hexToString(hex) {
  let out = '';
  for (let i = 0; i + 3 < hex.length + 1; i += 4) {
    const code = parseInt(hex.slice(i, i + 4), 16);
    if (Number.isFinite(code) && code !== 0) out += String.fromCharCode(code);
  }
  return out;
}

/**
 * Decode a /ToUnicode CMap: the table a PDF carries so that glyph codes can be
 * turned back into characters. Without it, text drawn with a subset font reads
 * as meaningless bytes.
 */
function parseToUnicode(cmap) {
  const map = new Map();

  // the code space range states how many bytes a character code occupies;
  // Identity-H fonts use two, but their mapped keys are small numbers, so
  // inferring the width from the keys gets it wrong every time
  const codespace = cmap.match(/begincodespacerange([\s\S]*?)endcodespacerange/);
  const firstCode = codespace && codespace[1].match(/<([0-9A-Fa-f]+)>/);
  const width = firstCode ? Math.max(1, Math.min(2, firstCode[1].length / 2)) : 1;

  for (const block of cmap.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) {
    const pattern = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let pair;
    while ((pair = pattern.exec(block)) !== null) {
      map.set(parseInt(pair[1], 16), hexToString(pair[2]));
    }
  }

  for (const block of cmap.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
    let body = block;

    // <lo> <hi> [ <dst> <dst> … ]
    const arrayForm = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g;
    let range;
    while ((range = arrayForm.exec(block)) !== null) {
      const lo = parseInt(range[1], 16);
      const items = range[3].match(/<([0-9A-Fa-f]+)>/g) || [];
      items.forEach((item, index) => map.set(lo + index, hexToString(item.replace(/[<>]/g, ''))));
      body = body.replace(range[0], ' ');
    }

    // <lo> <hi> <dst>, incrementing the destination across the range
    const simpleForm = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    while ((range = simpleForm.exec(body)) !== null) {
      const lo = parseInt(range[1], 16);
      const hi = parseInt(range[2], 16);
      const base = range[3];
      const units = [];
      for (let i = 0; i + 3 < base.length + 1; i += 4) units.push(parseInt(base.slice(i, i + 4), 16));
      if (!units.length) continue;
      for (let code = lo; code <= hi && code - lo < 65_536; code += 1) {
        const shifted = [...units];
        shifted[shifted.length - 1] += code - lo;
        map.set(code, String.fromCharCode(...shifted.filter((c) => c !== 0)));
      }
    }
  }

  return { map, width };
}

/**
 * Modern PDFs pack most of their dictionaries into compressed object streams,
 * so the font definitions are invisible to a scan of the raw file. Unpacking
 * them is the difference between reading a real contract and reading nothing.
 */
function expandObjectStreams(buffer, latin, objects) {
  const extra = [];

  for (const [, object] of [...objects]) {
    if (!/\/Type\s*\/ObjStm/.test(object.body)) continue;
    const content = objectStreamText(buffer, latin, object);
    if (!content) continue;

    const count = Number((object.body.match(/\/N\s+(\d+)/) || [])[1] || 0);
    const first = Number((object.body.match(/\/First\s+(\d+)/) || [])[1] || 0);
    if (!count || !first) continue;

    const header = content.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < count; i += 1) {
      const number = header[i * 2];
      const offset = header[i * 2 + 1];
      if (!Number.isFinite(number) || !Number.isFinite(offset)) continue;
      const nextOffset = i + 1 < count ? header[(i + 1) * 2 + 1] : content.length - first;
      const body = content.slice(first + offset, first + (Number.isFinite(nextOffset) ? nextOffset : content.length));
      if (!objects.has(number)) objects.set(number, { bodyStart: -1, body, embedded: true });
      extra.push(body);
    }
  }

  return extra;
}

/** Index the indirect objects so font references can be followed. */
function parseObjects(latin) {
  const objects = new Map();
  const pattern = /(\d+)\s+0\s+obj\b/g;
  let match;
  while ((match = pattern.exec(latin)) !== null) {
    const bodyStart = match.index + match[0].length;
    const bodyEnd = latin.indexOf('endobj', bodyStart);
    if (bodyEnd === -1) break;
    objects.set(Number(match[1]), { bodyStart, body: latin.slice(bodyStart, bodyEnd) });
    pattern.lastIndex = bodyEnd + 'endobj'.length;
  }
  return objects;
}

function objectStreamText(buffer, latin, object) {
  const opener = object.body.match(/stream\r?\n?/);
  if (!opener) return null;
  const dataStart = object.bodyStart + opener.index + opener[0].length;
  const dataEnd = latin.indexOf('endstream', dataStart);
  if (dataEnd === -1) return null;

  const raw = buffer.subarray(dataStart, dataEnd);
  const header = object.body.slice(0, opener.index);
  if (!/FlateDecode/.test(header)) return raw.toString('latin1');
  try {
    return zlib.inflateSync(raw).toString('latin1');
  } catch {
    try {
      return zlib.inflateRawSync(raw).toString('latin1');
    } catch {
      return null;
    }
  }
}

/** Resource name (/F1, /TT2 …) -> the character map of the font it names. */
function buildFontMaps(buffer, latin) {
  const objects = parseObjects(latin);
  const embedded = expandObjectStreams(buffer, latin, objects);
  const maps = new Map();

  const sources = [latin, ...embedded];
  for (const source of sources) {
    const resourcePattern = /\/Font\s*<<([\s\S]{0,4000}?)>>/g;
    let resource;
    while ((resource = resourcePattern.exec(source)) !== null) {
      const refPattern = /\/([A-Za-z0-9+._-]+)\s+(\d+)\s+0\s+R/g;
      let ref;
      while ((ref = refPattern.exec(resource[1])) !== null) {
        const name = ref[1];
        if (maps.has(name)) continue;

        const font = objects.get(Number(ref[2]));
        if (!font) continue;
        const toUnicode = font.body.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
        if (!toUnicode) continue;

        const cmapObject = objects.get(Number(toUnicode[1]));
        if (!cmapObject || cmapObject.embedded) continue; // a CMap is always its own stream
        const cmap = objectStreamText(buffer, latin, cmapObject);
        if (!cmap) continue;

        const parsed = parseToUnicode(cmap);
        if (parsed.map.size) maps.set(name, parsed);
      }
    }
  }
  return maps;
}

function decodeWithMap(codes, map, bytesPerCode) {
  let out = '';
  for (let i = 0; i < codes.length; i += bytesPerCode) {
    const code = bytesPerCode === 2 ? (codes[i] << 8) | (codes[i + 1] || 0) : codes[i];
    const mapped = map.get(code);
    out += mapped !== undefined ? mapped : bytesPerCode === 1 ? String.fromCharCode(code) : '';
  }
  return out;
}



/** Pull the text-showing operators out of one decoded content stream. */
function textFromContentStream(content, fontMaps = new Map()) {
  let out = '';
  const pattern =
    /\/([A-Za-z0-9+._-]+)\s+[\d.]+\s+Tf|\((?:\\.|[^\\()])*\)|<[0-9a-fA-F\s]+>|\bT[dD]\b|\bT\*\b|\bTJ\b|\bTj\b|\bET\b|\b'\b|\b"\b/g;
  let match;
  let pendingStrings = [];
  let currentMap = null;
  let width = 1;

  const flush = () => {
    if (pendingStrings.length) {
      out += pendingStrings.join('');
      pendingStrings = [];
    }
  };

  while ((match = pattern.exec(content)) !== null) {
    const token = match[0];

    if (match[1] !== undefined) {
      const font = fontMaps.get(match[1]) || null;
      currentMap = font ? font.map : null;
      width = font ? font.width : 1;
    } else if (token.startsWith('(')) {
      const decoded = decodePdfString(token.slice(1, -1));
      pendingStrings.push(
        currentMap ? decodeWithMap(Array.from(decoded, (ch) => ch.charCodeAt(0)), currentMap, width) : decoded
      );
    } else if (token.startsWith('<')) {
      const clean = token.replace(/[^0-9a-fA-F]/g, '');
      if (currentMap) {
        const bytes = [];
        for (let i = 0; i + 1 < clean.length; i += 2) bytes.push(parseInt(clean.slice(i, i + 2), 16));
        pendingStrings.push(decodeWithMap(bytes, currentMap, width));
      } else {
        pendingStrings.push(decodeHexString(token));
      }
    } else if (token === 'Tj' || token === 'TJ' || token === "'" || token === '"') {
      flush();
    } else {
      flush();
      out += '\n';
    }
  }
  flush();
  return out;
}

/**
 * A PDF holds many streams and most are not page text: font programs, CMaps,
 * images, metadata and cross-reference tables. Decoding those and scanning for
 * `Tj` produces convincing-looking rubbish, so a stream has to prove itself
 * before its bytes are treated as words.
 */
const NON_TEXT_STREAM = /\/(?:Image|FontFile\d?|Metadata|ObjStm|XRef|EmbeddedFile|ICCBased|Type1C|CIDFontType0C|TrueType)\b/;

function isProbablyContentStream(dictionary) {
  return !NON_TEXT_STREAM.test(dictionary);
}

/**
 * Does this read like prose? Glyph codes from a subset font without a usable
 * /ToUnicode table decode to control characters and accented noise; the ratio
 * check keeps that out rather than offering "IdentityAdobeUü:!Jö" as a term.
 */
export function looksLikeText(text) {
  const value = String(text || '');
  if (value.trim().length < 24) return false;
  const letters = (value.match(/[A-Za-z]/g) || []).length;
  const readable = (value.match(/[A-Za-z0-9 \n\t.,;:()\/@%&'"#-]/g) || []).length;
  return letters / value.length >= 0.4 && readable / value.length >= 0.85;
}

export function extractPdf(buffer) {
  const warnings = [];
  const latin = buffer.toString('latin1');
  const pieces = [];
  let candidates = 0;

  // subset fonts draw glyph codes, not characters; their /ToUnicode tables are
  // the only way back to readable words
  let fontMaps = new Map();
  try {
    fontMaps = buildFontMaps(buffer, latin);
  } catch {
    /* a malformed font table must not stop the rest of the document */
  }

  const streamPattern = /stream\r?\n?/g;
  let match;
  while ((match = streamPattern.exec(latin)) !== null) {
    const start = match.index + match[0].length;
    const end = latin.indexOf('endstream', start);
    if (end === -1) break;
    // resume *after* the keyword: "endstream" itself contains "stream", and
    // restarting on it makes the scanner swallow the following stream whole
    streamPattern.lastIndex = end + 'endstream'.length;

    // the dictionary immediately before the stream says what it holds
    if (!isProbablyContentStream(latin.slice(Math.max(0, match.index - 400), match.index))) continue;

    const slice = buffer.subarray(start, end);
    let content = null;
    try {
      content = zlib.inflateSync(slice).toString('latin1');
    } catch {
      try {
        content = zlib.inflateRawSync(slice).toString('latin1');
      } catch {
        const raw = slice.toString('latin1');
        if (/\bBT\b/.test(raw) && /\bT[jJ]\b/.test(raw)) content = raw;
      }
    }
    if (!content) continue;

    // a page description opens a text object before it can show any text
    if (!/\bBT\b/.test(content) || !/\bT[jJ]\b/.test(content)) continue;

    candidates += 1;
    const piece = textFromContentStream(content, fontMaps);
    if (looksLikeText(piece)) pieces.push(piece);
  }

  const text = tidy(pieces.join('\n'));

  if (!candidates) {
    warnings.push(
      'No text layer was found in this PDF. Scanned documents hold images rather than text, so the details could not be read automatically.'
    );
  } else if (!text) {
    warnings.push(
      'This PDF stores its text as font glyph codes with no usable character table, so it could not be read. Upload the Word original if you have it, or enter the details manually.'
    );
  }

  return { text, warnings };
}

/* ---------------------------------------------------------------- facade -- */

export function detectKind(buffer, fileName = '', contentType = '') {
  const name = String(fileName).toLowerCase();
  const type = String(contentType).toLowerCase();
  if (name.endsWith('.docx') || type.includes('wordprocessingml')) return 'DOCX';
  if (name.endsWith('.pdf') || type.includes('pdf')) return 'PDF';
  if (name.endsWith('.txt') || name.endsWith('.md') || type.startsWith('text/')) return 'TEXT';
  if (isZip(buffer)) return 'DOCX';
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'PDF';
  if (name.endsWith('.doc')) return 'DOC_LEGACY';
  return 'UNKNOWN';
}

export function extractText(buffer, { fileName = '', contentType = '' } = {}) {
  const kind = detectKind(buffer, fileName, contentType);

  if (kind === 'DOCX') return { kind, ...extractDocx(buffer) };
  if (kind === 'PDF') return { kind, ...extractPdf(buffer) };
  if (kind === 'TEXT') return { kind, text: tidy(buffer.toString('utf8')), warnings: [] };
  if (kind === 'DOC_LEGACY') {
    return {
      kind,
      text: '',
      warnings: ['Legacy .doc files are not supported. Save the MSA as .docx or PDF and upload it again.']
    };
  }
  return { kind, text: '', warnings: ['This file type could not be read. Upload the MSA as PDF, Word (.docx) or plain text.'] };
}

export default { extractText, extractDocx, extractPdf, detectKind };
