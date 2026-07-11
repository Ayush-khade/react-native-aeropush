/**
 * Minimal ZIP writer — zero dependencies, Node built-ins only.
 *
 * Produces a standard ZIP container with DEFLATE (method 8) entries via
 * node:zlib. Deliberately mirrors what the SDK's native unzippers consume:
 * local file headers → central directory → EOCD, forward-slash paths,
 * no zip64 (bundles are a few MB, nowhere near the 4GB limit).
 *
 * This lives in the CLI (Node-side) so the SDK keeps its zero-native-deps
 * guarantee; Phase 4 extracts this into @aeropush/cli.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── CRC-32 (IEEE 802.3, the ZIP standard polynomial) ───────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ── DOS date/time (ZIP header format) ──────────────────────────────────────

function dosDateTime(date) {
  const time =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2);
  const day =
    ((date.getFullYear() - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate();
  return { time, day };
}

// ── Directory walk ──────────────────────────────────────────────────────────

function walkFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full, base));
    } else if (entry.isFile()) {
      // ZIP spec mandates forward slashes regardless of host OS.
      out.push({
        abs: full,
        rel: path.relative(base, full).split(path.sep).join('/'),
      });
    }
  }
  return out;
}

/**
 * Zip the CONTENTS of `srcDir` (not the directory itself) into `outFile`,
 * so the platform bundle sits at the zip root as the SDK expects.
 * Returns { files, bytes } for reporting.
 */
function zipDirectory(srcDir, outFile) {
  const files = walkFiles(srcDir);
  if (files.length === 0) {
    throw new Error(`nothing to zip in ${srcDir}`);
  }

  const { time, day } = dosDateTime(new Date());
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const data = fs.readFileSync(file.abs);
    const crc = crc32(data);
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    // DEFLATE unless stored is actually smaller (tiny/incompressible files).
    const useDeflate = compressed.length < data.length;
    const payload = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;
    const name = Buffer.from(file.rel, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset

    localParts.push(local, name, payload);
    centralParts.push(central, name);
    offset += 30 + name.length + payload.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central dir start disk
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  const zip = Buffer.concat([...localParts, centralDir, eocd]);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, zip);
  return { files: files.length, bytes: zip.length };
}

module.exports = { zipDirectory, crc32 };
