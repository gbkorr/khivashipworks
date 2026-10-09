// File formats written (and read) here by hand: .zip and the gallery's PDF.
import { deflate } from '../lib/sharecode.js';

/** A .zip of `files` ({ name, bytes }), each deflated. */
export async function zip(files) {
  const crcTable = zip.crc ??= Array.from({ length: 256 }, (_, n) => {
    for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  const crc32 = (b) => { let c = ~0; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; };
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = new TextEncoder().encode(f.name), data = await deflate(f.bytes), crc = crc32(f.bytes);
    // version 2.0, flags (bit 11: UTF-8 names), deflate, no date, crc, sizes, name length
    const fields = [[20, 2], [0x800, 2], [8, 2], [0, 2], [0x21, 2], [crc, 4], [data.length, 4], [f.bytes.length, 4], [name.length, 2]];
    const head = (sig, pre, post) => {
      const all = [[sig, 4], ...pre, ...fields, ...post];
      const b = new Uint8Array(all.reduce((n, [, k]) => n + k, 0)), v = new DataView(b.buffer);
      let at = 0;
      for (const [x, k] of all) { k === 4 ? v.setUint32(at, x, true) : v.setUint16(at, x, true); at += k; }
      return b;
    };
    const local = head(0x04034b50, [], [[0, 2]]);
    parts.push(local, name, data);
    central.push(head(0x02014b50, [[20, 2]], [[0, 2], [0, 2], [0, 2], [0, 2], [0, 4], [offset, 4]]), name);
    offset += local.length + name.length + data.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = new Uint8Array(22), v = new DataView(end.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, files.length, true); v.setUint16(10, files.length, true);
  v.setUint32(12, size, true); v.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

/** UTF-16BE hex string (a PDF text string), and back. */
const pdfText = (t) => `<FEFF${Array.from({ length: t.length }, (_, i) => t.charCodeAt(i).toString(16).padStart(4, '0')).join('')}>`;
export const fromPdfText = (hex) => String.fromCharCode(...(hex.match(/.{4}/g) ?? []).map((h) => parseInt(h, 16)));
/**
 * A PDF of `pages` ({ jpeg bytes, w, h in px }), each filling a pw x ph pt page; with a title and attached files
 * ({ name, bytes }, in order).
 */
export function pdf(pages, pw, ph, { title = '', files = [] } = {}) {
  const enc = new TextEncoder(), chunks = [], offsets = [];
  let size = 0;
  const put = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; chunks.push(b); size += b.length; };
  const obj = (n, ...body) => { offsets[n] = size; put(`${n} 0 obj\n`); for (const b of body) put(b); put('\nendobj\n'); };
  const W = pw.toFixed(2), H = ph.toFixed(2);
  // 1 catalog, 2 page tree, 3 info, then 3 per page (page, contents, image), then 2 per file (spec, file).
  const pageId = (i) => 4 + 3 * i, fileId = (i) => 4 + 3 * pages.length + 2 * i;
  put('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
  const names = files.map((f, i) => `(${String(i).padStart(6, '0')}) ${fileId(i)} 0 R`).join(' ');
  obj(1, `<< /Type /Catalog /Pages 2 0 R${files.length ? ` /Names << /EmbeddedFiles << /Names [${names}] >> >>` : ''} >>`);
  obj(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${pageId(i)} 0 R`).join(' ')}] >>`);
  obj(3, `<< /Title ${pdfText(title)} /Producer (Khiva Shipworks) >>`);
  pages.forEach((p, i) => {
    const n = pageId(i), draw = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
    obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`);
    obj(n + 1, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
    obj(n + 2, `<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`, p.jpeg, '\nendstream');
  });
  files.forEach((f, i) => {
    const n = fileId(i), ascii = f.name.replace(/[^\x20-\x7e]|[()\\]/g, '_');
    obj(n, `<< /Type /Filespec /F (${ascii}) /UF ${pdfText(f.name)} /EF << /F ${n + 1} 0 R >> >>`);
    obj(n + 1, `<< /Type /EmbeddedFile /Subtype /application#2Foctet-stream /Length ${f.bytes.length} >>\nstream\n`, f.bytes, '\nendstream');
  });
  const xref = size, count = offsets.length;
  put(`xref\n0 ${count}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`);
  put(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}
export const isPdf = (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;   // %PDF
