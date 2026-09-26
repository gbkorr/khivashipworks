// Hull coercion: how the game's editor rewrites parts once they are linked into a ship.
//
// Reimplemented from Highfleet.exe (see decompilation/README.md, "Hull coercion and layering"). Per edit
// the game runs, in this order:
//   1. link handlers per slot link (FUN_1400bc740), keyed by the body's m_logic_editor codes:
//        3000  2x2 hull: hatch / turret ring / nuke tube sprites for what is mounted on it
//        100   rounded 2x2 corners: art variant _R1.._R4 for the body's angle, sprites kept upright
//        4000  sensor towers: _SIDE_UP / _SIDE_DOWN by angle
//        2000  legs: sprites mirrored by which way the leg folds from its hinge
//   2. heights (m_floor, FUN_140256a90): hull blocks rise while every edge neighbour is at least as high
//   3. tile variants (FUN_14025f270 / FUN_140252dc0): m_tile sprites pick _00.._09/_0N1 from neighbour heights
//   4. 1x1 blocks (FUN_140269fe0): straight / corner / end-cap art turned towards the linked sides
//      engines (FUN_140269d00): thrust side (m_spasmcode) and mirroring by side of the hull's centre
// Everything here is a pure function of the parts and their slot links, checked against every stock design
// by test/hull_test.mjs.
import MODULES from '../data/modules.json' with { type: 'json' };

const CAT = { GUN: 0x20, ENGINE: 0x100, NUKE: 0x8000000 };
const EDGE = 4;             // slot type bit of the hull's edge slots
const SLOT_HATCH = 0x200;   // mount slot bits: closed block (generators, quarters)
const SLOT_OPEN = 0x400;    //                  open hatch, no rotor (tanks, missiles, internal engines)
const SPASM = { L1: 100, R1: 101, L: 102, R: 103 };
const PI = Math.PI;

const category = (oid) => MODULES[oid]?.category ?? 0;
const logicCodes = (raw) => [].concat(raw.m_logic_editor ?? []);
/** Angle wrapped to [0, 2pi). */
const wrap2pi = (a) => ((a % (2 * PI)) + 2 * PI) % (2 * PI);
const near = (a, b, eps = 1e-3) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < eps;

// ---- sprite objects ----------------------------------------------------------------------------------
// Keys in the order the game writes a Sprite, so edited sprites serialize like the game's.
const SPRITE_ORDER = ['m_classname', 'm_code', 'm_type', 'm_position.x', 'm_position.y', 'm_angle', 'm_scale.x',
  'm_scale.y', 'm_tile', 'm_adjust', 'm_animation_name', 'm_animation_filename', 'm_animation_speed', 'm_stage',
  'm_opacity', 'm_ambient', 'm_mask', 'm_animation_mode'];

/** Copy of `obj` with `fields` set (undefined deletes); new keys go where `order` puts them. */
export function withFields(obj, fields, order = SPRITE_ORDER) {
  const entries = Object.entries(obj);
  for (const [k, v] of Object.entries(fields)) {
    const i = entries.findIndex(([q]) => q === k);
    if (v === undefined) { if (i >= 0) entries.splice(i, 1); continue; }
    if (i >= 0) { entries[i][1] = v; continue; }
    const rank = order.indexOf(k);
    const at = entries.findIndex(([q]) => order.indexOf(q) > rank);
    entries.splice(at < 0 ? entries.length : at, 0, [k, v]);
  }
  return Object.fromEntries(entries);
}

const num = (v) => (Math.abs(v) < 1e-9 ? undefined : v);

/** A new sprite as the game's editor makes it (FUN_14001be50). */
function sprite(name, stage, extra = {}) {
  return withFields({ m_classname: 'Sprite', m_code: 536870915 }, {
    ...extra, m_animation_name: name, m_animation_speed: 0, m_stage: stage || undefined, m_animation_mode: 4,
  });
}
const rename = (s, name) => withFields(s, { m_animation_name: name });
const turn = (s, angle) => withFields(s, { m_angle: num(angle) });

// ---- the ship graph ------------------------------------------------------------------------------------
/**
 * One node per part: its edge slots (local offsets, rotated with the part) with their linked neighbours,
 * and the modules mounted on its other slots.
 */
function graph(parts, links) {
  const nodes = new Map();
  for (const p of parts) {
    // The game tests slot sides against the part's unrotated local extents (see the README).
    let hw = 0, hh = 0;
    for (const [x, y] of p.raw.m_mesh?.points || []) { hw = Math.max(hw, Math.abs(x)); hh = Math.max(hh, Math.abs(y)); }
    nodes.set(p, {
      p, hw, hh, F: p.raw.m_floor_type ?? 0, group: p.raw.m_tile_group ?? 0, codes: logicCodes(p.raw),
      edges: [], mounts: [], h: 0, memo: new Map(),
    });
  }
  for (const n of nodes.values()) {
    for (const s of n.p.slots()) {
      const l = links.linkOf(s);
      const other = l && (l.a.part === n.p && l.a.index === s.index ? l.b : l.a);
      if (s.type & EDGE) n.edges.push({ x: s.x - n.p.x, y: s.y - n.p.y, n: other ? nodes.get(other.part) : null });
      else if (other) n.mounts.push({ part: other.part, slot: other, own: s });
    }
  }
  return nodes;
}

/** Which side of `n` an edge slot is on: 'L' | 'R' | 'U' | 'D' | null. */
function side(n, e) {
  if (e.x > n.hw) return 'R';
  if (e.x < -n.hw) return 'L';
  if (e.y > n.hh) return 'D';
  if (e.y < -n.hh) return 'U';
  return null;
}

// ---- 1. link handlers ------------------------------------------------------------------------------------
/** The closed 2x2 hull a generator or quarters makes: back, front and a tiled block (its art per neighbours). */
const filledSprites = (hard) => [sprite('ferma2x2_01_back', 0, { m_type: 1 }),
  sprite(hard ? 'hard2x2_01_front' : 'ferma2x2_01_front', 2), sprite('block2x2_01', 3, { m_tile: true })];

/**
 * A MDL_FERMA2X2_01 / MDL_HARD2X2_01 template with that filled art, as a part of its own (the shipbuilder's
 * "filled hull"): with nothing mounted coercion keeps a part's sprites, so it stays filled.
 */
export function filledHull(raw) {
  return { ...raw, m_sprites: filledSprites(raw.m_oid === 'MDL_HARD2X2_01') };
}

/** Code 3000 on MDL_FERMA2X2_01 / MDL_HARD2X2_01: sprites for what is mounted on it. */
function mountSprites(n, out) {
  const hard = n.p.oid === 'MDL_HARD2X2_01';
  if (!hard && n.p.oid !== 'MDL_FERMA2X2_01') return;
  const mounts = n.mounts.filter((m) => !(m.slot.type & EDGE));
  if (!mounts.length) return;   // nothing mounted: keep the part's own sprites
  const back = sprite('ferma2x2_01_back', 0, { m_type: 1 });
  const front = hard ? 'hard2x2_01_front' : 'ferma2x2_01_front';
  const nuke = mounts.find((m) => category(m.part.oid) & CAT.NUKE);
  if (nuke) {
    // A silo tube turned with the missile; the game picks the tube art at random (FUN_1401b1fb0).
    const variant = `tube2x2_0${nuke.part.uid % 4}`;
    out.sprites = [back, sprite(front, 2), sprite(variant, 3, { m_angle: num(nuke.part.angle) })];
    out.floorType |= 2;
    return;
  }
  const bits = mounts.reduce((b, m) => b | m.slot.type, 0);
  if (bits & SLOT_HATCH) {
    out.sprites = filledSprites(hard);
    return;
  }
  const open = [back, sprite('bridge2x2_01', 1), sprite('ferma2x2_01_mask', 2, { m_type: 2 }),
    sprite(hard ? 'hard2x2_01_front' : 'hull2x2_01', 3, { m_tile: true })];
  out.sprites = bits & SLOT_OPEN ? open
    : [...open, sprite('rotor_01', 0, { m_angle: PI }), sprite('rotor_03', 3)];
}

/**
 * Code 100: rounded 2x2 corners keep their lit art upright and swap to the variant for the angle. The turret
 * ring (bridge) sprite depends on which of the two lower slot positions the turned part still has
 * (FUN_140048e50): both _01, lower left only _02, lower right only _03, neither none (the game leaves it unnamed).
 */
function rotatedArt(n, out) {
  const k = ((Math.round(n.p.angle / (PI / 2)) % 4) + 4) % 4;
  const slotNear = (x, y) => n.p.slots().some((s) => Math.hypot(s.x - n.p.x - x, s.y - n.p.y - y) < 1);
  const left = slotNear(-n.hw / 2, n.hh), right = slotNear(n.hw / 2, n.hh);
  const bridge = left && right ? 'bridge2x2_01' : left ? 'bridge2x2_02' : right ? 'bridge2x2_03' : '';
  out.sprites = out.sprites.map((s, i) => {
    const name = s.m_animation_name ?? '';
    const renamed = /_R\d$/.test(name) ? name.replace(/_R\d$/, `_R${k + 1}`) : i === 1 ? bridge : name;
    return turn(rename(s, renamed), n.p.angle ? -n.p.angle : 0);
  });
}

/** Code 4000: sensor towers point up unless the part is turned past a quarter turn. */
function towerSide(n, out) {
  const a = Math.atan2(Math.sin(n.p.angle), Math.cos(n.p.angle));
  const up = a > -PI / 2 && a < PI / 2;
  out.sprites = out.sprites.map((s) => {
    const name = s.m_animation_name ?? '';
    const i = name.indexOf('_SIDE');
    return i < 0 ? s : rename(s, name.slice(0, i) + (up ? '_SIDE_UP' : '_SIDE_DOWN'));
  });
}

/** Code 2000: a leg's sprites face the way it folds from its hinge. */
function legSide(n, out, ctx) {
  const mount = n.mounts.find((m) => m.own.mount);
  if (!mount) return;
  const host = mount.part;
  const H = [mount.slot.x, mount.slot.y];
  // The host's centre, 1 m up for hull (Frame) parts; the leg's origin.
  const A = host.joint ? [host.x, host.y] : [host.x, host.y - 1];
  const B = [n.p.x, n.p.y];
  const unit = ([x, y]) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };
  const v1 = unit([A[0] - H[0], A[1] - H[1]]), v2 = unit([B[0] - H[0], B[1] - H[1]]);
  const theta = wrap2pi(Math.atan2(v2[0] * v1[1] - v2[1] * v1[0], v2[1] * v1[1] + v2[0] * v1[0]));
  const flip = Math.abs(theta - PI) < 1e-3 ? ctx.center[0] < n.p.x : theta < PI;
  out.sprites = out.sprites.map((s) => {
    const sx = Math.abs(s['m_scale.x'] ?? 1);
    return withFields(s, { 'm_scale.x': flip ? -sx : sx === 1 ? undefined : sx });
  });
}

// ---- 2. heights ------------------------------------------------------------------------------------------
function heights(nodes, links) {
  const all = [...nodes.values()];
  for (const n of all) n.h = n.p.raw.m_floor ?? 0;
  for (const n of all) {
    if (n.F & 0x10) n.h = 3;
    else if (n.F & 1) { n.h = 0; for (const m of n.mounts) nodes.get(m.part).h = 0; }
  }
  // A gun turning on a joint lifts its block over a higher neighbour.
  const gunOn = new Set();
  for (const [p, h] of links.host) if (p.joint === 'motor' && category(p.oid) & CAT.GUN) gunOn.add(nodes.get(h));
  for (let pass = 0, changed = true; changed && pass < 200; pass++) {
    changed = false;
    for (const n of all) {
      if (!(n.F & 1) || !n.edges.length) continue;
      let ge = 0, gt = 0, g8 = 0;
      for (const { n: o } of n.edges) {
        if (!o || !o.F) continue;
        const mine = n.h - (n.F & 4 && !(o.F & 4) ? 1 : 0);
        const theirs = o.h - (!(n.F & 4) && o.F & 4 ? 1 : 0);
        if (mine <= theirs) { ge++; if (mine < theirs) gt++; }
        if (n.F & 8 && !(o.F & 8) && mine < theirs) g8++;
      }
      const lift = gunOn.has(n) && gt > 0 && n.h < 1;
      const raise = n.F & 8 ? g8 > 0 : (n.F & 2 ? gt : ge) === n.edges.length;
      if (!raise && !lift) continue;
      n.h++;
      changed = true;
      for (const p of new Set(n.mounts.map((m) => m.part))) nodes.get(p).h++;
    }
  }
}

// ---- 3. tile variants -------------------------------------------------------------------------------------
/** Height of the part `dx`, `dy` edge hops away within tile group `group` (max over paths; -1: none). */
function hopHeight(n, group, dx, dy) {
  if (!dx && !dy) return n.group === group ? n.h : -1;
  const key = `${group},${dx},${dy}`;
  if (n.memo.has(key)) return n.memo.get(key);
  let best = -1;
  for (const e of n.edges) {
    let dir = null;
    if (dx > 0 && e.x > n.hw) dir = 'R';
    else if (dx < 0 && e.x < -n.hw) dir = 'L';
    if (dy > 0 && e.y > n.hh) dir = 'D';
    else if (dy < 0 && e.y < -n.hh) dir = 'U';
    if (!dir) continue;
    let v = -1;
    if (e.n) {
      const nx = dx + (dir === 'L' ? 1 : dir === 'R' ? -1 : 0), ny = dy + (dir === 'U' ? 1 : dir === 'D' ? -1 : 0);
      v = hopHeight(e.n, group, nx, ny);
    }
    if (v > best) best = v;
  }
  n.memo.set(key, best);
  return best;
}

/** The tile art suffix for a part, from its neighbours' heights (FUN_140252dc0). */
export function tileSuffix(n) {
  const g = n.group, h = n.h;
  const at = (dx, dy) => hopHeight(n, g, dx, dy);
  const reach = (dx, dy, from) => [1, 2, 3].slice(from - 1).some((k) => h <= at(dx * k, dy * k));
  const L = reach(-1, 0, 1), R = reach(1, 0, 1), U = reach(0, -1, 1), D = reach(0, 1, 1);
  const Lf = reach(-1, 0, 2), Rf = reach(1, 0, 2), Uf = reach(0, -1, 2), Df = reach(0, 1, 2);
  const UL = at(-1, -1) === h, DL = at(-1, 1) === h, UR = at(1, -1) === h, DR = at(1, 1) === h;
  if (!L) {
    if (!U) {
      if (!R) {
        if (!D) return '00';
        if (Df) return '031';
        if (!DL) return DR ? '06' : '031';
        return DR ? '031' : '07';
      }
      if (D) return '06';
      if (Rf) return '061';
      if (!UR) return DR ? '03' : '061';
      return DR ? '061' : '05';
    }
    if (!R) {
      if (D) return '011';
      if (Uf) return '051';
      if (!UL) return UR ? '02' : '051';
      return UR ? '051' : '04';
    }
    return D ? '02' : '09';
  }
  if (U) return R ? (D ? '01' : '05') : (D ? '04' : '08');
  if (!R) {
    if (D) return '07';
    if (Lf) return '071';
    if (!UL) return DL ? '03' : '071';
    return DL ? '071' : '05';
  }
  return D ? '03' : '081';
}

function tiles(n, out) {
  if (!n.group || !out.sprites.some((s) => s.m_tile)) return;
  const suffix = tileSuffix(n);
  out.sprites = out.sprites.map((s) => {
    if (!s.m_tile) return s;
    const name = s.m_animation_name ?? '';
    const i = name.indexOf('_');
    return rename(s, `${i < 0 ? name : name.slice(0, i)}_${suffix}`);
  });
}

// ---- 4. 1x1 blocks and engines ---------------------------------------------------------------------------
/** 1x1 hull: straight, corner (_02_) or end cap (_03_) art, turned towards the linked sides. */
function oneByOne(n, out) {
  const linked = new Set();
  for (const e of n.edges) if (e.n) { const s = side(n, e); if (s) linked.add(s); }
  const pre = n.p.oid === 'MDL_HARD1X1_01' ? 'hard1x1_' : 'ferma1x1_';
  const has = (s) => linked.has(s);
  let kind = '01_', angle = 0;
  if (linked.size === 2 && (has('U') || has('D')) && (has('L') || has('R'))) {
    kind = '02_';
    angle = has('L') ? (has('D') ? PI / 2 : PI) : (has('U') ? -PI / 2 : 0);
  } else if (linked.size === 1) {
    kind = '03_';
    angle = has('L') ? PI / 2 : has('U') ? PI : has('R') ? -PI / 2 : 0;
  }
  const [b, f] = out.sprites;
  if (!b || !f) return;
  out.sprites = [turn(rename(b, `${pre}${kind}back`), angle), turn(rename(f, `${pre}${kind}front`), angle), ...out.sprites.slice(2)];
}

/** Engines thrust to the side of the hull's centre they sit on; hung engines are mirrored on the right. */
function engineSide(n, out, ctx) {
  const p = n.p;
  const base = [].concat(p.raw.m_spasmcode ?? []).filter((c) => c < SPASM.L1 || c > SPASM.R);
  const sx = p.raw['m_scale.x'] ?? 1;
  if (p.joint) {
    const right = p.x > ctx.center[0] ? true : p.x < ctx.center[0] ? false : sx < 0;
    out.scaleX = right ? -1 : 1;
    out.spasm = [...base, ...(right ? [SPASM.R1, SPASM.R] : [SPASM.L1, SPASM.L])];
    return;
  }
  const alongX = near(p.angle, 0) || near(p.angle, PI);
  const v = alongX ? p.x : p.y, c = alongX ? ctx.center[0] : ctx.center[1];
  out.spasm = v < c ? [...base, SPASM.L] : v > c ? [...base, SPASM.R] : base;
}

/** Mesh points mirrored in x (the order reversed so the winding is kept), as FUN_14004eab0 does. */
export function mirrorMesh(mesh) {
  if (!mesh?.points) return mesh;
  return { ...mesh, points: mesh.points.map(([x, y]) => [-x, y]).reverse() };
}

// ---- entry point -----------------------------------------------------------------------------------------
/**
 * The game editor's view of every part once linked.
 * @param parts   BuildParts (design / Frame coordinates)
 * @param links   computeLinks(parts)
 * @param center  [x, y] the hull's centre (the Frame's m_center) that engine sides are measured from
 * @returns Map(part -> { sprites, floor, floorType, scaleX, spasm })
 */
export function coerceHull(parts, links, { center = [0, 0] } = {}) {
  const nodes = graph(parts, links);
  const ctx = { center };
  const out = new Map();
  for (const n of nodes.values()) {
    out.set(n.p, {
      sprites: n.p.raw.m_sprites || [], floor: 0, floorType: n.F, scaleX: n.p.raw['m_scale.x'] ?? 1,
      spasm: n.p.raw.m_spasmcode,
    });
  }
  for (const n of nodes.values()) {
    const o = out.get(n.p);
    if (n.codes.includes(3000)) mountSprites(n, o);
    if (n.codes.includes(100)) rotatedArt(n, o);
    if (n.codes.includes(4000)) towerSide(n, o);
    if (n.codes.includes(2000)) legSide(n, o, ctx);
  }
  for (const n of nodes.values()) n.F = out.get(n.p).floorType;
  heights(nodes, links);
  for (const n of nodes.values()) {
    const o = out.get(n.p);
    o.floor = n.h;
    tiles(n, o);
    if (n.codes.includes(1)) oneByOne(n, o);
    if (category(n.p.oid) & CAT.ENGINE) engineSide(n, o, ctx);
  }
  return out;
}
