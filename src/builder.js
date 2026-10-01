// Shipbuilder model: place, validate and export ship designs.
//
// A design is a flat list of parts (module id + position + angle) in the hull Frame's coordinates.
// Everything else in a .seria is derived from that list and the part templates (data/part_templates.json,
// extracted from Libraries/parts.seria and the shipped designs by tools/extract.mjs):
//   - slot links: two parts connect where their slots coincide. A module's mount slot (is_master=false)
//     needs a host slot whose type has all of its bits (1097 fuel/ammo -> 1x1/2x1 hull interior,
//     146 turrets -> 2x2 hull centre, ...); other slots pair up when their types share bits
//     (5: hull edges, armor, radars).
//   - turrets, radial engines and legs are separate Bodies held to their host by Joints; the rest sit
//     in the Frame. Antennas grow a chain of ANTENNA_PART bodies.
//   - the Creature (ship profile) under the command bridge: name, flagship flag, cached telemetry.
import DATA from '../data/part_templates.json' with { type: 'json' };
import { parseSeria, encodeSeria } from './seria.js';
import { Ship, Part } from './ship.js';
import { computeStats } from './stats.js';
import { mainModules } from './shipcard.js';
import { PX_PER_UNIT } from './render.js';
import { coerceHull, mirrorMesh, withFields } from './hull.js';

export const PART_TEMPLATES = DATA.parts;
export const BRIDGE = 'MDL_COMBRIDGE_01';
/** One hull block in metres (same as CELL in blueprint.js). */
export const GRID = 25 / PX_PER_UNIT;
/** Slots closer than this (m) coincide. */
const SLOT_EPS = 0.1;
/** Frame-local anchor of the hull end of every leg's hydraulic (distance) joint; the same in every design. */
const HULL_ANCHOR = [0, -9.75];
/** Antennas: two chains (physical, drawn wire) of ANTENNA_PART bodies stacked along the antenna's -y axis. */
const ANTENNA = { oid: 'MDL_ANTENNA_01', parts: 4, step: 3.5 };
/** Placement rules beyond the slot data, e.g. { MDL_ENGINE_03: { clearRadius: 5 } }. Empty for now. */
export const EXTRA_RULES = {};

const CODE = { Node: 7, Body: 15, Frame: 31, Creature: 47, Joint: 8589934595 };

// ---- geometry ---------------------------------------------------------------------------------
const rot = (x, y, a) => {
  const c = Math.cos(a), s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
};
/** Angle wrapped to (-PI, PI], snapping float noise at the quarter turns. */
export function normAngle(a) {
  a = Math.atan2(Math.sin(a), Math.cos(a));
  const q = Math.round(a / (Math.PI / 2));
  if (Math.abs(a - q * Math.PI / 2) < 1e-6) a = q * Math.PI / 2;
  return a <= -Math.PI + 1e-9 ? Math.PI : a;
}

let nextUid = 1;

/** One placed module. `raw` is its template Body (or the imported body, links stripped). */
export class BuildPart {
  constructor(oid, x = 0, y = 0, angle = 0, raw = PART_TEMPLATES[oid]) {
    if (!raw) throw new Error(`unknown module ${oid}`);
    this.uid = nextUid++;
    this.oid = oid;
    this.x = x;
    this.y = y;
    this.angle = normAngle(angle);
    this.raw = raw;
  }

  clone() {
    return new BuildPart(this.oid, this.x, this.y, this.angle, this.raw);
  }

  /** Attached by a mount slot (modules, turrets, engines, legs) rather than being structure. */
  get mounted() {
    return (this.raw.m_slots || []).some((s) => s.is_master === false);
  }

  /** 'motor' (turrets, radial engines), 'leg', or undefined (Frame child). */
  get joint() {
    return this.raw.joint ?? PART_TEMPLATES[this.oid]?.joint;
  }

  toWorld(lx, ly) {
    const [x, y] = rot(lx, ly, this.angle);
    return [this.x + x, this.y + y];
  }

  /** Footprint polygon in design coordinates. */
  polygon() {
    return (this.raw.m_mesh?.points || []).map(([x, y]) => this.toWorld(x, y));
  }

  bounds() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of this.polygon()) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (x0 === Infinity) return { x0: this.x, y0: this.y, x1: this.x, y1: this.y };
    return { x0, y0, x1, y1 };
  }

  /** Slots in design coordinates: { part, index, type, mount, x, y, lx, ly }. */
  slots() {
    return (this.raw.m_slots || []).map((s, index) => {
      const lx = s['m_position.x'] ?? 0, ly = s['m_position.y'] ?? 0;
      const [x, y] = this.toWorld(lx, ly);
      return { part: this, index, type: s.m_type, mount: s.is_master === false, x, y, lx, ly };
    });
  }
}

/** Snapped to the block grid: structure whose footprint is a whole number of blocks. */
function gridAligned(p) {
  if (p.mounted) return false;
  const b = p.bounds();
  const w = (b.x1 - b.x0) / GRID, h = (b.y1 - b.y0) / GRID;
  return w > 0.5 && h > 0.5 && Math.abs(w - Math.round(w)) < 0.25 && Math.abs(h - Math.round(h)) < 0.25;
}

/** Separating-axis test for convex polygons; touching (< eps of overlap) doesn't count. */
function polygonsOverlap(a, b, eps = 0.05) {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (!len) continue;
      const nx = (y1 - y2) / len, ny = (x2 - x1) / len;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const [x, y] of a) { const d = x * nx + y * ny; if (d < a0) a0 = d; if (d > a1) a1 = d; }
      for (const [x, y] of b) { const d = x * nx + y * ny; if (d < b0) b0 = d; if (d > b1) b1 = d; }
      if (Math.min(a1, b1) - Math.max(a0, b0) <= eps) return false;
    }
  }
  return a.length > 0 && b.length > 0;
}

/** Can a (mount or free) slot `s` plug into slot `h`? Returns the bind type, or 0. */
function slotBind(s, h) {
  if (s.part === h.part) return 0;
  if (s.mount && h.mount) return 0;
  if (s.mount) return (h.type & s.type) === s.type ? s.type : 0;
  if (h.mount) return (s.type & h.type) === h.type ? h.type : 0;
  return s.type & h.type;
}

class SlotIndex {
  constructor(slots) {
    this.cells = new Map();
    for (const s of slots) {
      const k = this.key(s.x, s.y);
      (this.cells.get(k) || this.cells.set(k, []).get(k)).push(s);
    }
  }
  key(x, y) { return `${Math.round(x / 0.5)},${Math.round(y / 0.5)}`; }
  near(x, y, r) {
    const out = [], n = Math.ceil(r / 0.5);
    const cx = Math.round(x / 0.5), cy = Math.round(y / 0.5);
    for (let i = -n; i <= n; i++) {
      for (let j = -n; j <= n; j++) {
        for (const s of this.cells.get(`${cx + i},${cy + j}`) || []) {
          if (Math.hypot(s.x - x, s.y - y) <= r) out.push(s);
        }
      }
    }
    return out;
  }
}

const slotKey = (s) => `${s.part.uid}:${s.index}`;

/**
 * Connect coinciding slots. Mount slots first (each to one compatible host slot), then free pairs.
 * @returns { links: [{ a, b, bind }], host: Map(part -> host part), linkOf(slot) -> link | undefined }
 */
export function computeLinks(parts) {
  const all = parts.flatMap((p) => p.slots());
  const index = new SlotIndex(all);
  const links = [], of = new Map(), host = new Map();
  const link = (a, b, bind) => {
    const l = { a, b, bind };
    links.push(l); of.set(slotKey(a), l); of.set(slotKey(b), l);
    if (a.mount && !host.has(a.part)) host.set(a.part, b.part);
  };
  // Passes: mount slots on coinciding host slots; mount slots the game placed off their slot (ENGINE_05
  // is sometimes put by its origin, 45-degree flares/KAZ land ~1 m off) within their slot's offset;
  // then the remaining free pairs.
  for (const [mount, loose] of [[true, false], [true, true], [false, false]]) {
    for (const s of all) {
      if (s.mount !== mount || of.has(slotKey(s))) continue;
      const r = loose ? SLOT_EPS + 1.5 * Math.hypot(s.lx, s.ly) : SLOT_EPS;
      if (loose && r <= SLOT_EPS) continue;
      let best = null, bind = 0, bd = Infinity;
      for (const h of index.near(s.x, s.y, r)) {
        if (of.has(slotKey(h)) || h.part === s.part) continue;
        const b = slotBind(s, h);
        const d = Math.hypot(h.x - s.x, h.y - s.y);
        if (b && d < bd) { best = h; bind = b; bd = d; }
      }
      if (best) link(s, best, bind);
    }
  }
  return { links, host, linkOf: (s) => of.get(slotKey(s)) };
}

/** Parts attached (transitively) to any of `parts` by their mount slots: what moves with them. */
export function dependents(allParts, parts) {
  const { host } = computeLinks(allParts);
  const out = new Set(parts);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [p, h] of host) if (out.has(h) && !out.has(p)) { out.add(p); grew = true; }
  }
  return [...out];
}

// Parts that must not overlap each other: all structure (hull, armor, radars), and mounted modules on the
// same render layer (internal modules, turrets, engines are separate layers). Legs and wheels reach across
// other parts, so they aren't checked yet.
function overlapClass(p) {
  if (!p.mounted) return 'structure';
  if (p.joint === 'leg' || p.oid === 'MDL_WHEEL_01') return null;
  return `layer${p.raw.m_layer ?? 0}`;
}

/**
 * Parts in `group` that overlap another part of their class (see overlapClass).
 * A module and its host don't count.
 * @returns Map(part -> [other parts])
 */
export function overlaps(allParts, group = allParts, links = null) {
  const inGroup = new Set(group);
  const linked = new Set();
  for (const [p, h] of (links ?? computeLinks(allParts)).host) {
    linked.add(`${p.uid}:${h.uid}`); linked.add(`${h.uid}:${p.uid}`);
  }
  const data = allParts.map((p) => ({ p, poly: p.polygon(), b: p.bounds(), cls: overlapClass(p) }));
  const out = new Map();
  for (let i = 0; i < data.length; i++) {
    for (let j = i + 1; j < data.length; j++) {
      const A = data[i], B = data[j];
      if (!inGroup.has(A.p) && !inGroup.has(B.p)) continue;
      if (!A.cls || A.cls !== B.cls || linked.has(`${A.p.uid}:${B.p.uid}`)) continue;
      if (A.b.x1 <= B.b.x0 || B.b.x1 <= A.b.x0 || A.b.y1 <= B.b.y0 || B.b.y1 <= A.b.y0) continue;
      if (!polygonsOverlap(A.poly, B.poly)) continue;
      (out.get(A.p) || out.set(A.p, []).get(A.p)).push(B.p);
      (out.get(B.p) || out.set(B.p, []).get(B.p)).push(A.p);
    }
  }
  for (const [oid, rule] of Object.entries(EXTRA_RULES)) {
    if (!rule.clearRadius) continue;
    for (const A of data) {
      if (A.p.oid !== oid) continue;
      for (const B of data) {
        if (B.p === A.p || B.p.oid !== oid || (!inGroup.has(A.p) && !inGroup.has(B.p))) continue;
        if (Math.hypot(A.p.x - B.p.x, A.p.y - B.p.y) < rule.clearRadius) {
          (out.get(A.p) || out.set(A.p, []).get(A.p)).push(B.p);
        }
      }
    }
  }
  return out;
}

function unmounted(p, links) {
  return p.slots().some((s) => s.mount && !links.linkOf(s));
}

/**
 * Where `group` stands. `ok`: it may be dropped there. `attached`: every module in it sits on a free
 * compatible slot. `reason` ('overlap' | 'slot'): why not ok.
 * Nothing may overlap (see overlaps). A module off its slot may be parked away from the ship (validate()
 * reports it), but not on top of the hull: there it has to be on a slot.
 * Parts cut off from the bridge are allowed too, so a ship can be built up piece by piece.
 */
export function placement(allParts, group) {
  const links = computeLinks(allParts);
  if (overlaps(allParts, group, links).size) return { ok: false, attached: false, reason: 'overlap' };
  const loose = group.filter((p) => unmounted(p, links));
  const inGroup = new Set(group);
  const structure = allParts.filter((p) => !p.mounted && !inGroup.has(p)).map((p) => ({ b: p.bounds(), poly: p.polygon() }));
  for (const p of loose) {
    const b = p.bounds(), poly = p.polygon();
    for (const s of structure) {
      if (b.x1 <= s.b.x0 || s.b.x1 <= b.x0 || b.y1 <= s.b.y0 || s.b.y1 <= b.y0) continue;
      if (polygonsOverlap(poly, s.poly)) return { ok: false, attached: false, reason: 'slot' };
    }
  }
  return { ok: true, attached: !loose.length };
}

/** Can `group` be dropped where it is (see placement)? */
export function canPlace(allParts, group) {
  return placement(allParts, group).ok;
}

/**
 * Snap a moving group. The group's parts sit at base + (dx, dy); returns the corrected offset.
 * With a grid-sized structure part in the group, the offset keeps it on the block grid; otherwise the
 * `primary` part (the one being held) snaps one of its slots onto a free compatible slot nearby. With
 * none nearby, edge-attached structure (antenna, radars) puts its slot on a cell edge, and modules snap
 * to the block grid by their footprint rounded to whole blocks.
 * @param bases  Map(part -> [x, y]) positions at the start of the move
 */
export function snapOffset(allParts, group, primary, dx, dy, bases) {
  const at = (p) => { const [x, y] = bases.get(p); return [x + dx, y + dy]; };
  const gridPart = (gridAligned(primary) && primary) || group.find(gridAligned);
  if (gridPart) {
    const [x, y] = at(gridPart);
    const b = gridPart.bounds();
    const cx = (b.x0 + b.x1) / 2 - gridPart.x, cy = (b.y0 + b.y1) / 2 - gridPart.y;
    const snap = (v, size) => {
      const off = Math.round(size / GRID) % 2 ? GRID / 2 : 0;
      return Math.round((v - off) / GRID) * GRID + off;
    };
    return [dx + snap(x + cx, b.x1 - b.x0) - (x + cx), dy + snap(y + cy, b.y1 - b.y0) - (y + cy)];
  }
  const inGroup = new Set(group);
  const others = allParts.filter((p) => !inGroup.has(p));
  const taken = computeLinks(others);
  const index = new SlotIndex(others.flatMap((p) => p.slots()).filter((s) => !taken.linkOf(s)));
  const [px, py] = at(primary);
  const moved = Object.assign(primary.clone(), { x: px, y: py });
  let best = null, bd = Infinity;
  for (const s of moved.slots().sort((a, b) => b.mount - a.mount)) {
    for (const h of index.near(s.x, s.y, GRID * 0.75)) {
      if (!slotBind({ ...s, part: primary }, h)) continue;
      const d = Math.hypot(h.x - s.x, h.y - s.y) - (s.mount ? 0.5 : 0);   // prefer mounting
      if (d < bd) { bd = d; best = [h.x - s.x, h.y - s.y]; }
    }
  }
  if (best) return [dx + best[0], dy + best[1]];
  // A leg off the hull puts its top (mount) slot where a hull block's leg slot would be: on a grid point.
  if (primary.joint === 'leg') {
    const m = moved.slots().find((s) => s.mount);
    const line = (v) => Math.round(v / GRID) * GRID;
    return [dx + line(m.x) - m.x, dy + line(m.y) - m.y];
  }
  // No slot nearby. Structure that attaches by an edge slot (antenna, radars, bombs) puts that slot where
  // a block's edge slot would be: the middle of the cell edge it faces, as when attached.
  const edge = !primary.mounted && moved.slots()[0];
  if (edge) {
    const eb = moved.bounds();
    const vertical = Math.abs(edge.y - (eb.y0 + eb.y1) / 2) >= Math.abs(edge.x - (eb.x0 + eb.x1) / 2);
    const mid = (v) => (Math.round(v / GRID - 0.5) + 0.5) * GRID, line = (v) => Math.round(v / GRID) * GRID;
    const [tx, ty] = vertical ? [mid(edge.x), line(edge.y)] : [line(edge.x), mid(edge.y)];
    return [dx + tx - edge.x, dy + ty - edge.y];
  }
  // Anything else snaps by whole blocks, like hull (footprint rounded to blocks: odd sizes centre in a
  // block, even ones on a grid line).
  const b = moved.bounds();
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const snap = (v, size) => {
    const off = Math.max(1, Math.round(size / GRID)) % 2 ? GRID / 2 : 0;
    return Math.round((v - off) / GRID) * GRID + off;
  };
  return [dx + snap(cx, b.x1 - b.x0) - cx, dy + snap(cy, b.y1 - b.y0) - cy];
}

// How finely each part may be turned on its own: 4-, 8- or 24-way. Parts not listed keep their template
// angle (a turned group carries them round but resets their own rotation).
const ROTATION_WAYS = Object.fromEntries([
  ...['1X1_04', '2X1_01', '2X2_04', '2X2_02', '2X2_03'].flatMap((s) => [`MDL_FERMA${s}`, `MDL_HARD${s}`]),
  'MDL_ARMOR2X1_01', 'MDL_ARMOR1X1_01', 'MDL_ARMOR1X1_02', 'MDL_ARMOR1X1_03', 'MDL_ARMOR1X1_04',
  'MDL_ENGINE_05', 'MDL_ENGINE_02',
  'MDL_NUKE_01_CONV', 'MDL_NUKE_02_CONV', 'MDL_NUKE_03_CONV', 'MDL_NUKE_04_CONV',
  'MDL_NUKE_01', 'MDL_NUKE_02', 'MDL_NUKE_03', 'MDL_NUKE_04',
  'MDL_MISSILE_03', 'MDL_EVAC', 'MDL_FSS_02', 'MDL_BOMB_01', 'MDL_MISSILE_01', 'MDL_MISSILE_02',
  'MDL_FUEL_01', 'MDL_GENERATOR_02', 'MDL_QUARTERS_02', 'MDL_AMMO', 'MDL_GENERATOR_01',
  'MDL_ANTENNA_01', 'MDL_RADAR_01', 'MDL_RADAR_02', 'MDL_FCR_01', 'MDL_FCR_02', 'MDL_SPO_01', 'MDL_SPO_02',
  'MDL_IRST_01', 'MDL_JAMMER_01',
  'MDL_MISSILE_CLUSTER_SFW_01',
].map((oid) => [oid, 4]).concat(
  ['MDL_KAZ', 'MDL_FLARES', 'MDL_TORPEDO_300'].map((oid) => [oid, 8]),
  ['MDL_LEG_01', 'MDL_LEG_02', 'MDL_LEG_03', 'MDL_LEG_04'].map((oid) => [oid, 24]),
));

/** The angle one turn of this part steps by, or 0 if it doesn't turn on its own. */
export function rotationStep(oid) {
  const n = ROTATION_WAYS[oid];
  return n ? 2 * Math.PI / n : 0;
}

/** The angle a part has before it's turned (the aircraft's templates are turned a quarter). */
export const restAngle = (oid) => normAngle(PART_TEMPLATES[oid]?.m_angle ?? 0);

/** Turn one part by `dir` of its own steps (clockwise for dir > 0); false if it doesn't turn. */
export function turnPart(p, dir) {
  if (p.joint === 'leg') return turnLegs([p], [p], dir);
  const step = rotationStep(p.oid);
  if (!step) return false;
  p.angle = normAngle(Math.round((p.angle + dir * step) / step) * step) || 0;   // no -0
  return true;
}

/**
 * Turn a group of legs by `dir` leg steps (clockwise for dir > 0): each chain pivots on its top leg's mount
 * slot, carrying the legs hung off it. False unless every part is a leg.
 */
export function turnLegs(allParts, group, dir) {
  if (!group.length || !group.every((p) => p.joint === 'leg')) return false;
  const inGroup = new Set(group);
  const { host } = computeLinks(allParts);
  for (const top of group.filter((p) => !inGroup.has(host.get(p)))) {
    const step = rotationStep(top.oid);
    const da = Math.round((top.angle + dir * step) / step) * step - top.angle;
    const mount = top.slots().find((s) => s.mount);
    const chain = dependents(allParts, [top]).filter((p) => inGroup.has(p));
    for (const p of chain) {
      const [rx, ry] = rot(p.x - mount.x, p.y - mount.y, da);
      p.x = mount.x + rx; p.y = mount.y + ry;
      const a = p.angle + da, k = Math.round(a / step);
      p.angle = normAngle(Math.abs(a - k * step) < 1e-9 ? k * step : a) || 0;   // no float noise, no -0
    }
  }
  return true;
}

/** Turn parts 90 degrees clockwise (on screen, y down) about (cx, cy). */
export function rotateParts(parts, cx, cy) {
  for (const p of parts) {
    const rx = p.x - cx, ry = p.y - cy;
    p.x = cx - ry;
    p.y = cy + rx;
    p.angle = normAngle(p.angle + Math.PI / 2);
  }
}

// ---- hull coercion ------------------------------------------------------------------------------
/** Parts that sit in the Frame (everything but modules hung off the hull by a joint). */
const inFrame = (p, links) => !(p.joint && links.host.has(p));

/**
 * The hull's centre (the Frame's m_center): the middle of the Frame parts' bounds. The game's is its centre
 * of mass, which matches in x and comes close in y.
 */
export function hullCenter(parts, links = computeLinks(parts)) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of parts) {
    if (!inFrame(p, links)) continue;
    const b = p.bounds();
    x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
  }
  return x0 < Infinity ? [(x0 + x1) / 2, (y0 + y1) / 2] : [0, 0];
}

// Body keys in the game's order, for the ones coercion may add.
const BODY_ORDER = ['m_classname', 'm_code', 'm_id', 'm_name', 'm_state', 'm_master_id', 'm_owner_id', 'm_position.x',
  'm_position.y', 'm_angle', 'm_center.x', 'm_center.y', 'm_scale.x', 'm_scale.y', 'm_stage', 'm_mesh_color',
  'm_floor_type', 'm_floor', 'm_tile_group', 'm_tile_script', 'm_meta', 'm_density', 'm_mass', 'm_mesh'];

/** A part's template body with the editor's changes (see hull.js) applied. */
function coercedRaw(raw, c) {
  if (!c) return raw;
  const sx = raw['m_scale.x'] ?? 1;
  return withFields({ ...raw, m_sprites: c.sprites }, {
    m_floor: c.floor || undefined,
    m_floor_type: c.floorType || (raw.m_floor_type !== undefined ? c.floorType : undefined),
    'm_scale.x': c.scaleX === 1 ? undefined : c.scaleX,
    m_mesh: c.scaleX !== sx ? mirrorMesh(raw.m_mesh) : raw.m_mesh,
    m_spasmcode: c.spasm,
  }, BODY_ORDER);
}

// ---- ids / object builders -----------------------------------------------------------------------
function newId() {
  const a = new BigInt64Array(1);
  do globalThis.crypto.getRandomValues(a); while (a[0] === 0n);
  return a[0].toString();
}
const num = (v) => Math.abs(v) < 1e-9 ? 0 : v;

/** Copy a template with the given identity/placement fields first, in the game's key order. */
function makeBody(raw, head, x, y, angle) {
  const b = { m_classname: 'Body', m_code: CODE.Body, m_id: head.m_id };
  if (raw.m_name !== undefined) b.m_name = raw.m_name;
  b.m_state = raw.m_state ?? 2;
  b.m_master_id = head.m_master_id;
  b.m_owner_id = head.m_owner_id;
  if (num(x)) b['m_position.x'] = x;
  if (num(y)) b['m_position.y'] = y;
  if (num(angle)) b.m_angle = angle;
  for (const [k, v] of Object.entries(raw)) {
    if (k in b || k === 'm_position.x' || k === 'm_position.y' || k === 'm_angle' || k === 'joint' ||
        k === 'hydraulic' || k === 'm_children' || k === 'm_owner_id') continue;
    b[k] = v;
  }
  return b;
}

/**
 * Strip identity, placement and links from an imported body, keeping it as the part's template.
 * `topLevel`: the body hung off the hull by a joint (not a Frame child).
 */
function importRaw(body, topLevel = false) {
  const t = {};
  for (const [k, v] of Object.entries(body)) {
    if (/^m_(id|master_id|owner_id|position\.[xy]|angle|velocity\.[xy]|ang_velocity|children)$/.test(k)) continue;
    if (k === 'm_slots') {
      t[k] = v.map((s) => {
        const { 'm_master.id': _m, 'm_block.id': _b, m_bind: _bind, ...rest } = s;
        return rest;
      });
    } else t[k] = v;
  }
  const tpl = PART_TEMPLATES[body.m_oid];
  const joint = tpl?.joint ?? (topLevel ? (body.is_leg ? 'leg' : 'motor') : undefined);
  if (joint) t.joint = joint;
  if (tpl?.hydraulic) t.hydraulic = tpl.hydraulic;
  return t;
}

// Telemetry the game caches in the Creature, from computeStats (see test/all_designs.mjs).
// Keys without the m_ prefix; the order is the game's.
const TELEMETRY = [
  ['tele_mass', (s) => s.mass], ['tele_price', (s) => s.price],
  ['tele_firepower_guns', (s) => s.firepower.guns], ['tele_firepower_missiles', (s) => s.firepower.missiles],
  ['tele_firepower_bombs', (s) => s.firepower.bombs], ['tele_firepower_crafts', (s) => s.firepower.crafts],
  ['tele_combatvalue', (s) => s.combatValue], ['tele_aavalue', (s) => s.aaValue],
  ['tele_dynamic', (s) => s.twrFull], ['tele_dynamic_landing', (s) => s.twrFull],
  ['tele_dynamic_map', (s) => s.twr], ['tele_dynamic_map_repaired', (s) => s.twr],
  ['tele_airspeed', (s) => s.airspeed], ['tele_signature', (s) => s.signature],
  ['tele_signature_rd', (s) => s.signatureRD], ['tele_signature_ir', (s) => s.signatureIR],
  ['tele_fuel_time', (s) => s.fuelTotal / s.fuelNeed],
  ['tele_power_total', (s) => s.powerTotal], ['tele_power_total_repaired', (s) => s.powerTotal],
  ['tele_power_need', (s) => s.powerNeed], ['tele_power_real', (s) => s.powerTotal],
  ['tele_fuel_total', (s) => s.fuelTotal], ['tele_fuel_capacity', (s) => s.fuelCapacity],
  ['tele_fuel_need', (s) => s.fuelNeed], ['tele_fuel_need_cr', (s) => s.fuelNeed],
  ['tele_ammobox_total', (s) => s.ammo], ['tele_ammobox_need', (s) => s.ammoNeed],
  ['tele_thrust_left', (s) => s.thrust.left], ['tele_thrust_right', (s) => s.thrust.right],
  ['tele_thrust_left_landing', (s) => s.thrust.left], ['tele_thrust_right_landing', (s) => s.thrust.right],
  ['tele_thrust_left_map', (s) => s.thrust.mapLeft], ['tele_thrust_left_map_repaired', (s) => s.thrust.mapLeft],
  ['tele_thrust_right_map', (s) => s.thrust.mapRight], ['tele_thrust_right_map_repaired', (s) => s.thrust.mapRight],
  ['tele_at_left', (s) => s.thrust.atLeft], ['tele_at_right', (s) => s.thrust.atRight],
  ['tele_hp', (s) => s.hp], ['tele_hp_max', (s) => s.hp],
  ['tele_fss_total', (s) => s.fss], ['tele_fss_capacity', (s) => s.fss],
  ['tele_crew_capacity', (s) => s.crewCapacity], ['tele_crew_need', (s) => s.crewNeed],
  ['tele_b.x', (s) => s.size.w], ['tele_b.y', (s) => s.size.h], ['tele_r', (s) => s.radius],
  ['init_hp', (s) => s.hp], ['init_fuel', (s) => s.fuelCapacity], ['init_price', (s) => s.price],
  ['init_power', (s) => s.powerTotal], ['init_dynamic', (s) => s.twrFull],
];

// ---- the design --------------------------------------------------------------------------------
export class BuildModel {
  constructor({ name = 'New ship', flagship = false, parts = [], creature = null } = {}) {
    this.name = name;
    this.flagship = flagship;
    this.parts = parts;
    /** Imported Creature fields to keep (card texts...), or null for the template's. */
    this.creature = creature;
  }

  /** An empty design: just the command bridge at the origin. */
  static blank(name) {
    return new BuildModel({ name, parts: [new BuildPart(BRIDGE)] });
  }

  /** Load a .seria (string / ArrayBuffer / Uint8Array). */
  static fromSeria(input) {
    return BuildModel.fromTree(parseSeria(input));
  }

  static fromTree(root) {
    const frame = (root.m_children || []).find((c) => c.m_classname === 'Frame');
    const fx = frame?.['m_position.x'] ?? 0, fy = frame?.['m_position.y'] ?? 0, fa = frame?.m_angle ?? 0;
    const parts = [];
    let creature = null;
    for (const b of frame?.m_children || []) {
      if (b.m_classname !== 'Body' || !b.m_oid) continue;
      parts.push(new BuildPart(b.m_oid, b['m_position.x'] ?? 0, b['m_position.y'] ?? 0, b.m_angle ?? 0, importRaw(b)));
      creature ??= (b.m_children || []).find((c) => c.m_classname === 'Creature') ?? null;
    }
    for (const b of root.m_children || []) {
      if (b.m_classname !== 'Body' || !b.m_oid) continue;   // ANTENNA_PART chains are regenerated
      // Top-level bodies are in world space; bring them into the Frame's.
      const [x, y] = rot((b['m_position.x'] ?? 0) - fx, (b['m_position.y'] ?? 0) - fy, -fa);
      parts.push(new BuildPart(b.m_oid, x, y, (b.m_angle ?? 0) - fa, importRaw(b, true)));
    }
    return new BuildModel({
      name: creature?.m_ship_name ?? root.m_name ?? 'Imported ship',
      flagship: creature?.m_flagship === true,
      parts,
      creature,
    });
  }

  links() {
    return computeLinks(this.parts);
  }

  /**
   * What the game's editor does to the parts once linked (hull.js): sprites, heights, engine sides.
   * @returns { center, of: Map(part -> coercion) }
   */
  coerce(links = this.links(), parts = this.parts) {
    const center = hullCenter(parts, links);
    return { center, of: coerceHull(parts, links, { center }) };
  }

  /** Parts with no chain of slot links to the (first) command bridge; all of them if there is none. */
  unconnected(links = this.links()) {
    const bridge = this.parts.find((p) => p.oid === BRIDGE);
    if (!bridge) return [...this.parts];
    const adj = new Map(this.parts.map((p) => [p, []]));
    for (const l of links.links) { adj.get(l.a.part).push(l.b.part); adj.get(l.b.part).push(l.a.part); }
    const seen = new Set([bridge]), queue = [bridge];
    while (queue.length) for (const q of adj.get(queue.shift())) if (!seen.has(q)) { seen.add(q); queue.push(q); }
    return this.parts.filter((p) => !seen.has(p));
  }

  /**
   * Check every rule. @returns { ok, problems: Map(part -> [message]), messages: [string] }
   */
  validate() {
    const links = this.links();
    const problems = new Map();
    const add = (p, msg) => (problems.get(p) || problems.set(p, []).get(p)).push(msg);
    const messages = [];
    const bridges = this.parts.filter((p) => p.oid === BRIDGE);
    if (bridges.length !== 1) {
      messages.push(bridges.length ? `${bridges.length} command bridges (need exactly one)` : 'no command bridge');
      for (const b of bridges.slice(1)) add(b, 'extra command bridge');
    }
    for (const [p, others] of overlaps(this.parts, this.parts, links)) add(p, `overlaps ${others.length} part(s)`);
    for (const p of this.parts) if (unmounted(p, links)) add(p, 'not on a compatible slot');
    if (bridges.length) for (const p of this.unconnected(links)) add(p, 'not connected to the bridge');
    const counts = {};
    for (const msgs of problems.values()) for (const m of msgs) counts[m.replace(/\d+ part\(s\)/, 'other parts')] = (counts[m.replace(/\d+ part\(s\)/, 'other parts')] || 0) + 1;
    for (const [m, n] of Object.entries(counts)) messages.push(`${n} part${n > 1 ? 's' : ''} ${m}`);
    return { ok: messages.length === 0, problems, messages };
  }

  /** The parsed-seria tree of the design (see parseSeria). */
  toTree() {
    const links = this.links();
    const hull = this.coerce(links);
    const nodeId = newId(), frameId = newId(), creatureId = newId();
    const ids = new Map(this.parts.map((p) => [p, newId()]));
    const bodyOf = new Map();
    const top = [], frameChildren = [], antennaParts = [], joints = [];

    for (const p of this.parts) {
      const onJoint = p.joint && links.host.has(p);
      const body = makeBody(coercedRaw(p.raw, hull.of.get(p)), {
        m_id: ids.get(p), m_master_id: onJoint ? nodeId : frameId, m_owner_id: creatureId,
      }, p.x, p.y, p.angle);
      const slots = p.slots();
      body.m_slots = (p.raw.m_slots || []).map((s, i) => {
        const out = { m_classname: s.m_classname, m_code: s.m_code, 'm_master.id': ids.get(p) };
        const l = links.linkOf(slots[i]);
        if (l) {
          const other = l.a.part === p && l.a.index === i ? l.b : l.a;
          out['m_block.id'] = ids.get(other.part);
          out.m_bind = l.bind;
        }
        for (const [k, v] of Object.entries(s)) if (!(k in out) && k !== 'm_block.id' && k !== 'm_bind') out[k] = v;
        return out;
      });
      if (!body.m_slots.length) delete body.m_slots;
      bodyOf.set(p, body);
      (onJoint ? top : frameChildren).push(body);
    }

    const joint = (a, b, fields) => ({
      m_classname: 'Joint', m_code: CODE.Joint, m_state: 1, 'm_master.id': nodeId,
      'm_A.id': ids.get(a) ?? a, 'm_B.id': ids.get(b) ?? b, ...fields,
    });
    const shift = (name, x, y) => {
      const o = {};
      if (num(x)) o[`${name}_x`] = x;
      if (num(y)) o[`${name}_y`] = y;
      return o;
    };
    for (const p of this.parts) {
      const h = links.host.get(p);
      if (!p.joint || !h) continue;
      const mount = p.slots().find((s) => s.mount);
      const l = links.linkOf(mount);
      const hostSlot = l.a.part === p ? l.b : l.a;
      if (p.joint === 'motor') {
        joints.push(joint(h, p, {
          ...shift('shiftA', hostSlot.lx, hostSlot.ly), ...shift('shiftB', mount.lx, mount.ly),
          m_type: 1, m_motor_enable: true, m_motor_torque: 100,
        }));
      } else if (p.joint === 'leg') {
        // The hull is one physics body (the Frame), so a hull-mounted leg's reference angle is its own.
        const ref = normAngle(h.joint === 'leg' ? p.angle - h.angle : p.angle);
        joints.push(joint(h, p, {
          ...shift('shiftA', hostSlot.lx, hostSlot.ly), ...shift('shiftB', mount.lx, mount.ly),
          m_type: 1, m_angle_enable: true, m_angle_reference: ref,
          ...(ref >= 0 ? { m_angle_max: ref } : { m_angle_min: ref, m_cw: false }),
        }));
        // Hydraulic: from a point on the parent (fixed hull point, or up the parent leg) to the leg's lower end.
        let ax, ay;
        if (h.joint === 'leg') {
          [ax, ay] = h.raw.hydraulic?.a ?? PART_TEMPLATES[h.oid]?.hydraulic?.a ?? [0, 2.5 * (h.slots().find((s) => s.mount)?.ly ?? -2)];
        } else {
          [ax, ay] = rot(HULL_ANCHOR[0] - h.x, HULL_ANCHOR[1] - h.y, -h.angle);
        }
        const [bx, by] = p.raw.hydraulic?.b ?? PART_TEMPLATES[p.oid]?.hydraulic?.b ?? [0, -mount.ly];
        const [wax, way] = h.toWorld(ax, ay), [wbx, wby] = p.toWorld(bx, by);
        const len = Math.hypot(wax - wbx, way - wby);
        joints.push(joint(h, p, { ...shift('shiftA', ax, ay), ...shift('shiftB', bx, by), m_length: len, m_length_max: len }));
      }
    }

    // Antennas: two chains of massless welded bodies, the second one drawn as the wire.
    for (const p of this.parts) {
      if (p.oid !== ANTENNA.oid) continue;
      for (const render of [false, true]) {
        let prev = p;
        for (let k = 1; k <= ANTENNA.parts; k++) {
          const [x, y] = p.toWorld(0, -ANTENNA.step * k);
          const id = newId();
          antennaParts.push(makeBody(DATA.antennaPart, { m_id: id, m_master_id: nodeId, m_owner_id: creatureId }, x, y, p.angle));
          joints.push(joint(prev, id, render ? { m_type: 2, m_render_type: 1 } : { m_type: 2 }));
          prev = id;
        }
      }
    }

    // Frame: the hull; children first, then its cached mass / centre of mass (frame-local), as the game writes it.
    const frame = {
      m_classname: 'Frame', m_code: CODE.Frame, m_id: frameId, m_state: 2, m_master_id: nodeId,
      m_owner_id: creatureId, m_children: frameChildren,
    };
    const root = {
      m_classname: 'Node', m_code: CODE.Node, m_id: nodeId, m_name: this.name,
      m_children: [...top, ...antennaParts, frame],
    };
    if (joints.length) root.m_joints = joints;
    // m_center: the game's matches the middle of the hull's bounds in x and comes close in y.
    const ship = new Ship(root);
    let mass = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of ship.bodies) {
      if (!b.inFrame) continue;
      mass += b.mass;
      for (const [x, y] of b.worldMesh()) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    frame['m_center.x'] = hull.center[0];
    frame['m_center.y'] = y0 < Infinity ? (y0 + y1) / 2 : 0;
    frame.m_mass = mass;
    frame.m_mesh = { m_classname: 'Mesh', m_size: 0 };

    const bridge = this.parts.find((p) => p.oid === BRIDGE);
    if (bridge) bodyOf.get(bridge).m_children = [this.profile(ship, creatureId, ids.get(bridge))];
    return root;
  }

  /** The Creature (ship profile) under the bridge, in the game's key order. */
  profile(ship, id, bridgeId) {
    const base = this.creature ?? DATA.creature;
    const c = {
      m_classname: 'Creature', m_code: CODE.Creature, m_id: id, m_name: base.m_name, m_state: base.m_state ?? 2,
      m_master_id: bridgeId, m_owner_id: id,
    };
    // Kept from the base, in order: body fields, then (after the name/flags block) card texts, then the rest.
    // Numeric telemetry is recomputed; the tele on/off flags are kept.
    const derived = (k, v) => /^m_(init_|card_modules$)/.test(k) || (k.startsWith('m_tele_') && typeof v === 'number');
    const fixed = /^m_(classname|code|id|name|state|master_id|owner_id|ship_name|playable|flagship)$/;
    const rest = Object.entries(base).filter(([k, v]) => !fixed.test(k) && !derived(k, v));
    const isHead = (k) => /^m_(stage|density|mesh|layer|health|health_lock|escadra_index)$/.test(k);
    const isCard = (k) => /^m_(alignment|card_|bio_)/.test(k);
    for (const [k, v] of rest) if (isHead(k)) c[k] = v;
    c.m_ship_name = this.name;
    c.m_playable = true;
    if (this.flagship) c.m_flagship = true;
    for (const [k, v] of rest) if (isCard(k)) c[k] = v;
    c.m_card_modules = mainModules(ship).map((m) => `${m.oid}=${m.count},`).join('');
    const stats = computeStats(ship);
    for (const [k, f] of TELEMETRY) {
      const v = f(stats);
      if (Number.isFinite(v) && v !== 0) c[`m_${k}`] = v;
    }
    for (const [k, v] of rest) if (!isHead(k) && !isCard(k)) c[k] = v;
    return c;
  }

  /** The design as .seria bytes (CRLF, windows-1251), ready to drop into the game's Ships folder. */
  toSeria() {
    return encodeSeria(this.toTree());
  }

  /** A Ship of the parts as placed (antenna wires, but no joints / profile), cheap enough to rebuild while dragging. */
  view(parts = this.parts) {
    const bodies = [], joints = [];
    const hull = this.coerce(computeLinks(parts), parts);
    for (const p of parts) {
      const part = new Part({ ...coercedRaw(p.raw, hull.of.get(p)), m_id: `p${p.uid}`, 'm_position.x': p.x, 'm_position.y': p.y, m_angle: p.angle });
      part.build = p;
      bodies.push(part);
      // Antenna masts are drawn as wires up a chain of bodies (as in the export's second chain).
      if (p.oid !== ANTENNA.oid) continue;
      let prev = `p${p.uid}`;
      for (let k = 1; k <= ANTENNA.parts; k++) {
        const [x, y] = p.toWorld(0, -ANTENNA.step * k);
        const id = `p${p.uid}a${k}`;
        bodies.push(new Part({ ...DATA.antennaPart, m_id: id, 'm_position.x': x, 'm_position.y': y, m_angle: p.angle }));
        joints.push({ 'm_A.id': prev, 'm_B.id': id, m_type: 2, m_render_type: 1 });
        prev = id;
      }
    }
    return { raw: { m_joints: joints }, bodies, parts: bodies.filter((b) => b.build), name: this.name };
  }
}
