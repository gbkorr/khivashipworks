// Extra data in a PNG file: an ancillary chunk inserted before IEND, which viewers ignore and a straight copy of
// the file keeps. Used to ship the exact .seria with a stat card (chunk 'hfSe': ancillary, private, safe to copy).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const isPng = (b) => b.length > 8 && SIGNATURE.every((v, i) => b[i] === v);
const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const typeAt = (b, i) => String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);

/** Walk the chunks: [{ type, start (of the length field), data (subarray) }]. */
function chunks(png) {
  const out = [];
  for (let i = 8; i + 12 <= png.length;) {
    const len = u32(png, i);
    if (i + 12 + len > png.length) break;
    out.push({ type: typeAt(png, i), start: i, data: png.subarray(i + 8, i + 8 + len) });
    i += 12 + len;
  }
  return out;
}

/** A copy of the PNG with a `type` chunk holding `data` (replacing one already there), before IEND. */
export function addChunk(png, type, data) {
  png = new Uint8Array(png);
  if (!isPng(png)) throw new Error('not a PNG');
  const all = chunks(png);
  const iend = all.find((c) => c.type === 'IEND');
  if (!iend) throw new Error('PNG has no IEND');
  const keep = all.filter((c) => c.type !== type && c.type !== 'IEND');
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let k = 0; k < 4; k++) chunk[4 + k] = type.charCodeAt(k);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  const parts = [png.subarray(0, 8), ...keep.map((c) => png.subarray(c.start, c.start + 12 + c.data.length)),
    chunk, png.subarray(iend.start, iend.start + 12)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** The data of the first `type` chunk with a valid CRC, or null (also for non-PNG input). */
export function readChunk(png, type) {
  png = new Uint8Array(png);
  if (!isPng(png)) return null;
  for (const c of chunks(png)) {
    if (c.type !== type) continue;
    const crc = u32(png, c.start + 8 + c.data.length);
    if (crc === crc32(png.subarray(c.start + 4, c.start + 8 + c.data.length))) return c.data.slice();
  }
  return null;
}
