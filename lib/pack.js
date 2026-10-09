// A folder of designs as one file (.ships): each design's .shipcard (sharecode.js) with what the folder lists it by,
// which a .shipcard keeps inside its packed body. Little-endian:
//   'HFSP' | u8 version (1) | varint count | per design:
//     varint name length | UTF-8 name | varint parts | u8 flags (1: flagship) | f64 saved (ms since 1970; 0 for the
//     game's designs) | varint .shipcard length | .shipcard
// Imports nothing (a script outside the page can use it too).

const MAGIC = [0x48, 0x46, 0x53, 0x50];   // 'HFSP'
const VERSION = 1;

/** Pack designs ([{ name, parts, flagship, saved, shipcard }]) into a .ships file. */
export function encodePack(designs) {
  const out = [...MAGIC, VERSION];
  const varint = (v) => {
    for (; v >= 0x80; v = Math.floor(v / 0x80)) out.push((v & 0x7f) | 0x80);
    out.push(v);
  };
  const bytes = (b) => { for (const x of b) out.push(x); };
  varint(designs.length);
  for (const d of designs) {
    const name = new TextEncoder().encode(d.name);
    varint(name.length);
    bytes(name);
    varint(d.parts);
    out.push(d.flagship ? 1 : 0);
    const saved = new Uint8Array(8);
    new DataView(saved.buffer).setFloat64(0, d.saved, true);
    bytes(saved);
    varint(d.shipcard.length);
    bytes(d.shipcard);
  }
  return new Uint8Array(out);
}

/** The designs in a .ships file (see encodePack). */
export function decodePack(bytes) {
  let at = 0;
  const take = (n) => {
    if (at + n > bytes.length) throw new Error('truncated designs file');
    at += n;
    return bytes.subarray(at - n, at);
  };
  const varint = () => {
    let v = 0;
    for (let k = 1; ; k *= 0x80) {
      const b = take(1)[0];
      v += (b & 0x7f) * k;
      if (b < 0x80) return v;
    }
  };
  if (MAGIC.some((m, i) => bytes[i] !== m)) throw new Error('not a designs file');
  take(MAGIC.length);
  const version = take(1)[0];
  if (version !== VERSION) throw new Error(`unsupported designs file version ${version}`);
  const designs = [];
  for (let n = varint(); n > 0; n--) {
    const name = new TextDecoder().decode(take(varint()));
    const parts = varint(), flagship = take(1)[0] === 1;
    const saved = new DataView(take(8).slice().buffer).getFloat64(0, true);
    designs.push({ name, parts, flagship, saved, shipcard: take(varint()).slice() });
  }
  return designs;
}
