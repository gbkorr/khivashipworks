// Compact design code: just what the shipbuilder needs to rebuild a design (part types, positions, rotations,
// name, flagship), small enough to print on a stat card (see stamp.js). Per-part state such as loaded fuel or
// custom sensor sectors is not kept: decoded parts start from their templates.
//
// Format (version 1), before optional deflate:
//   version, flags (1 = flagship, 2 = deflated rest), then (deflated if flag 2):
//   name length + UTF-8 name, group count, then per module type:
//     oid index (into OIDS), grid count, grid parts, free count, free parts
//   Grid parts sit on half blocks at quarter turns: zigzag(dx) and zigzag(dy) << 2 | quarter turns, in half blocks,
//   delta from the previous part of the list (sorted by y, then x).
//   Free parts (mounted modules at slot offsets, odd angles): zigzag(dx), zigzag(dy) in 1/128 m, delta coded,
//   then the angle in 1/64 turns (one byte; 255 = a float32 follows).
import { BuildModel, BuildPart, GRID, normAngle } from './builder.js';
import { readStamp } from './stamp.js';

const VERSION = 1;
const HALF = GRID / 2, FINE = 1 / 128;
/** Module ids by index. Only ever append to this list: codes refer to parts by position. */
export const OIDS = [
  'CRAFT_LA29', 'CRAFT_T7', 'MDL_AMMO', 'MDL_AMMO_02', 'MDL_ANTENNA_01', 'MDL_ARMOR1X1_01', 'MDL_ARMOR1X1_02',
  'MDL_ARMOR1X1_03', 'MDL_ARMOR1X1_04', 'MDL_ARMOR2X1_01', 'MDL_BOMB_01', 'MDL_CANNON_04', 'MDL_CANNON_100_2',
  'MDL_CANNON_130', 'MDL_CANNON_180', 'MDL_CANNON_180_2', 'MDL_CANNON_305_2', 'MDL_CANNON_30_6', 'MDL_CANNON_57_2',
  'MDL_CANNON_HARPOON', 'MDL_COMBRIDGE_01', 'MDL_DECK_01', 'MDL_DESTILLER_01', 'MDL_ENGINE_01', 'MDL_ENGINE_02',
  'MDL_ENGINE_03', 'MDL_ENGINE_04', 'MDL_ENGINE_05', 'MDL_EVAC', 'MDL_FCR_01', 'MDL_FCR_02', 'MDL_FCR_03',
  'MDL_FERMA1X1_01', 'MDL_FERMA1X1_04', 'MDL_FERMA2X1_01', 'MDL_FERMA2X2_01', 'MDL_FERMA2X2_02', 'MDL_FERMA2X2_03',
  'MDL_FERMA2X2_04', 'MDL_FERMA4X4_01', 'MDL_FLARES', 'MDL_FSS_02', 'MDL_FUEL_01', 'MDL_FUEL_02', 'MDL_FUEL_03',
  'MDL_GENERATOR_01', 'MDL_GENERATOR_02', 'MDL_HARD1X1_01', 'MDL_HARD1X1_04', 'MDL_HARD2X1_01', 'MDL_HARD2X2_01',
  'MDL_HARD2X2_02', 'MDL_HARD2X2_03', 'MDL_HARD2X2_04', 'MDL_IRST_01', 'MDL_JAMMER_01', 'MDL_KAZ', 'MDL_LCARGO_01',
  'MDL_LEG_01', 'MDL_LEG_02', 'MDL_LEG_03', 'MDL_LEG_04', 'MDL_LRRADIO_01', 'MDL_MISSILE_01', 'MDL_MISSILE_02',
  'MDL_MISSILE_03', 'MDL_MISSILE_CLUSTER_SFW_01', 'MDL_MISSILE_DRUM_01', 'MDL_NUKE_01', 'MDL_NUKE_01_CONV',
  'MDL_NUKE_02', 'MDL_NUKE_02_CONV', 'MDL_NUKE_03', 'MDL_NUKE_03_CONV', 'MDL_NUKE_04', 'MDL_NUKE_04_CONV',
  'MDL_PROTECTOR_01', 'MDL_QUARTERS_01', 'MDL_QUARTERS_02', 'MDL_RADAR_01', 'MDL_RADAR_02', 'MDL_RAILING_01',
  'MDL_RAILING_02', 'MDL_RSZO_220', 'MDL_SPO_01', 'MDL_SPO_02', 'MDL_TORPEDO_300', 'MDL_WHEEL_01',
];

const zig = (v) => (v << 1) ^ (v >> 31);
const unzig = (v) => (v >>> 1) ^ -(v & 1);

class Writer {
  constructor() { this.bytes = []; }
  byte(b) { this.bytes.push(b & 255); }
  varint(v) {
    v >>>= 0;
    while (v > 127) { this.bytes.push((v & 127) | 128); v >>>= 7; }
    this.bytes.push(v);
  }
  f32(v) { const b = new Uint8Array(new Float32Array([v]).buffer); for (const x of b) this.byte(x); }
  out() { return Uint8Array.from(this.bytes); }
}
class Reader {
  constructor(bytes) { this.b = bytes; this.i = 0; }
  byte() {
    if (this.i >= this.b.length) throw new Error('design code is truncated');
    return this.b[this.i++];
  }
  varint() {
    let v = 0, s = 0, b;
    do { b = this.byte(); v |= (b & 127) << s; s += 7; } while (b & 128 && s < 35);
    return v >>> 0;
  }
  f32() { const b = new Uint8Array(4); for (let k = 0; k < 4; k++) b[k] = this.byte(); return new Float32Array(b.buffer)[0]; }
}

// Within 1 cm: the game's editor leaves a few mm of drift on some blocks.
const onStep = (v, step, tol = 0.01) => Math.abs(v / step - Math.round(v / step)) * step < tol;

async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}
export const deflate = (bytes) => pipe(bytes, new CompressionStream('deflate-raw'));
export const inflate = (bytes) => pipe(bytes, new DecompressionStream('deflate-raw'));

/** Pack a BuildModel (or anything with name, flagship, parts: [{ oid, x, y, angle }]). */
export async function encodeDesign(model) {
  const groups = new Map();
  for (const p of model.parts) {
    const idx = OIDS.indexOf(p.oid);
    if (idx < 0) throw new Error(`unknown module ${p.oid}`);
    if (!groups.has(idx)) groups.set(idx, { grid: [], free: [] });
    const g = groups.get(idx);
    const q = normAngle(p.angle) / (Math.PI / 2);
    if (onStep(p.x, HALF) && onStep(p.y, HALF) && onStep(q, 1)) {
      g.grid.push({ x: Math.round(p.x / HALF), y: Math.round(p.y / HALF), q: ((Math.round(q) % 4) + 4) % 4 });
    } else {
      g.free.push({ x: Math.round(p.x / FINE), y: Math.round(p.y / FINE), angle: p.angle });
    }
  }
  const w = new Writer();
  const name = new TextEncoder().encode(model.name ?? '').slice(0, 32);
  w.varint(name.length);
  for (const b of name) w.byte(b);
  w.varint(groups.size);
  const byPos = (a, b) => a.y - b.y || a.x - b.x;
  for (const [idx, g] of [...groups].sort((a, b) => a[0] - b[0])) {
    w.varint(idx);
    g.grid.sort(byPos);
    w.varint(g.grid.length);
    let px = 0, py = 0;
    for (const p of g.grid) {
      w.varint(zig(p.x - px));
      w.varint((zig(p.y - py) << 2) | p.q);
      px = p.x; py = p.y;
    }
    g.free.sort(byPos);
    w.varint(g.free.length);
    px = 0; py = 0;
    for (const p of g.free) {
      w.varint(zig(p.x - px));
      w.varint(zig(p.y - py));
      px = p.x; py = p.y;
      const t = (normAngle(p.angle) / (2 * Math.PI)) * 64;
      if (onStep(t, 1)) w.byte(((Math.round(t) % 64) + 64) % 64);
      else { w.byte(255); w.f32(p.angle); }
    }
  }
  const body = w.out();
  const packed = await deflate(body);
  const deflated = packed.length < body.length;
  const rest = deflated ? packed : body;
  const out = new Uint8Array(2 + rest.length);
  out[0] = VERSION;
  out[1] = (model.flagship ? 1 : 0) | (deflated ? 2 : 0);
  out.set(rest, 2);
  return out;
}

/** Rebuild a BuildModel from encodeDesign() bytes. */
export async function decodeDesign(bytes) {
  if (bytes[0] !== VERSION) throw new Error(`unsupported design code version ${bytes[0]}`);
  const flags = bytes[1];
  const body = flags & 2 ? await inflate(bytes.subarray(2)) : bytes.subarray(2);
  const r = new Reader(body);
  const name = new TextDecoder().decode(Uint8Array.from({ length: r.varint() }, () => r.byte()));
  const parts = [];
  for (let n = r.varint(); n > 0; n--) {
    const oid = OIDS[r.varint()];
    if (!oid) throw new Error('design code names an unknown module');
    let px = 0, py = 0;
    for (let k = r.varint(); k > 0; k--) {
      px += unzig(r.varint());
      const v = r.varint();
      py += unzig(v >>> 2);
      parts.push(new BuildPart(oid, px * HALF, py * HALF, (v & 3) * (Math.PI / 2)));
    }
    px = 0; py = 0;
    for (let k = r.varint(); k > 0; k--) {
      px += unzig(r.varint());
      py += unzig(r.varint());
      const a = r.byte();
      const angle = a === 255 ? r.f32() : (a / 64) * 2 * Math.PI;
      parts.push(new BuildPart(oid, px * FINE, py * FINE, angle));
    }
  }
  return new BuildModel({ name: name || 'Shared ship', flagship: !!(flags & 1), parts });
}

// ---- cards as design files ---------------------------------------------------------------------------------

/**
 * The design printed on a stat card image (its stamp), from the image's pixels ({ data, width, height }); null if
 * it can't be read.
 */
export async function designFromCard(imageData) {
  const code = readStamp(imageData);
  if (!code) return null;
  try { return await decodeDesign(code); } catch { return null; }
}
