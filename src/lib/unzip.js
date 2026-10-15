import zlib from 'node:zlib';

/**
 * Minimal ZIP reader — the counterpart of lib/zip.js.
 * Used to open .docx packages (an MSA uploaded as a Word document) without
 * pulling in an archive dependency.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

function findEndOfCentralDirectory(buffer) {
  // the EOCD record sits in the last 64KB (22 bytes + up to 65535 of comment)
  const start = Math.max(0, buffer.length - 66_000);
  for (let i = buffer.length - 22; i >= start; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

/**
 * @param {Buffer} buffer
 * @returns {Map<string, Buffer>} entry name -> uncompressed contents
 */
export function readZip(buffer) {
  const entries = new Map();
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) return entries;

  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd === -1) return entries;

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) break;

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    if (localOffset + 30 <= buffer.length) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const data = buffer.subarray(dataStart, dataStart + compressedSize);
      try {
        entries.set(name, method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data));
      } catch {
        /* a single unreadable entry must not abandon the archive */
      }
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

export function isZip(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 4 && buffer.readUInt32LE(0) === 0x04034b50;
}

export default { readZip, isZip };
