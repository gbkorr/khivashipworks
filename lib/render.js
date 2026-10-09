// Canvas renderer for ships (unlit sprite compositing; shading.js lights and shades it).
import { SPRITES } from './data.js';
import { PART_FRAMES } from './partstyles.js';

/** Pixels of atlas texture per world unit (metre). One hull block is 25 px = 25/7 m. */
export const PX_PER_UNIT = 7;
/** Width of the sprite atlas (Media/Tex/Ships1.png); multi-frame animations wrap at this edge. */
const ATLAS_WIDTH = 4096;

/** Draw layers of the game's renderer (FUN_14015de50): 0..69, four per floor. */
const LAYERS = 69, FLOOR_LAYERS = 4, FLOOR_FADE = 0.2;
const clampLayer = (z) => Math.max(0, Math.min(LAYERS, z));

/**
 * Build the flat, depth-sorted draw list of a ship.
 * Depth, as the game's renderer: clamp(stage of the body and its Frame + 4 x m_floor) + sprite m_stage,
 * clamped to 0..69; ties keep file order. Sprites with m_type bit 1 (the hull's back plates) are drawn
 * again on every floor below theirs, fading 0.2 per floor, so raised hull reads as a wall.
 * partScale shrinks (or grows) each body's sprites about the body's own origin: a number for every
 * part, or a map of module id -> scale (missing = 1), like PART_SCALE (partstyles.js); the map leaves a 2x2
 * hull with a nuke's silo tube (hull.js) at full size.
 * Modules in PART_FRAMES draw that animation frame instead of the design's.
 * lower maps module id -> true for parts drawn under everything else on their floor (like PART_BACK); given one,
 * the list goes floor by floor, the lowered parts' sprites first on each (in depth order among themselves); default
 * none: depth order throughout. 'all' instead of true: drawn under every other part, whatever its floor.
 * art maps module id -> a sprite name drawn alone in place of the part's sprites, at the first one's place (like
 * PART_ART).
 * Each entry: { part, sprite, def, x, y, angle, sx, sy, z, frame, alpha }  (x, y in world units)
 */
export function drawList(ship, { partScale = 1, lower = null, art = null } = {}) {
  const list = [];
  let order = 0;
  for (const part of ship.bodies) {
    const c = Math.cos(part.angle), s = Math.sin(part.angle);
    // A 2x2 hull showing a nuke's silo tube stays full size, the size of the nuke in it.
    const tube = part.sprites.some((sp) => sp.name?.startsWith('tube2x2_'));
    const k = typeof partScale === 'number' ? partScale : tube ? 1 : partScale?.[part.oid] ?? 1;
    const own = art?.[part.oid];
    const sprites = own && part.sprites.length ? [{ ...part.sprites[0], name: own }] : part.sprites;
    for (const sp of sprites) {
      const def = SPRITES[sp.name];
      if (!def) continue;
      // Sprite offsets are in atlas pixels in the body's (possibly mirrored) local frame.
      const lx = (sp.x * part.scaleX * k) / PX_PER_UNIT, ly = (sp.y * part.scaleY * k) / PX_PER_UNIT;
      const mirrored = part.scaleX * part.scaleY < 0;
      const entry = {
        part, sprite: sp, def,
        x: part.x + lx * c - ly * s,
        y: part.y + lx * s + ly * c,
        angle: part.angle + (mirrored ? -sp.angle : sp.angle),
        sx: sp.sx * part.scaleX * k, sy: sp.sy * part.scaleY * k,
        z: clampLayer(clampLayer(part.baseStage + part.stage + FLOOR_LAYERS * part.floor) + sp.stage),
        frame: PART_FRAMES[part.oid] ?? sp.frame,
        alpha: 1,
        floor: part.floor,
        back: lower?.[part.oid] === 'all' ? 2 : lower?.[part.oid] ? 1 : 0,
        order: order++,
      };
      list.push(entry);
      if (sp.type & 1) {
        for (let f = 1; f <= part.floor; f++) {
          list.push({ ...entry, z: clampLayer(entry.z - FLOOR_LAYERS * f), floor: part.floor - f, alpha: Math.max(0, 1 - FLOOR_FADE * f), order: order++ });
        }
      }
    }
  }
  // (back: 2 under every other part, 1 under the rest of its floor)
  const byDepth = (a, b) => a.z - b.z || a.order - b.order;
  const byFloor = (a, b) => (b.back === 2) - (a.back === 2) || a.floor - b.floor || b.back - a.back || byDepth(a, b);
  list.sort(lower ? byFloor : byDepth);
  return list;
}

/** Atlas position of an animation frame (frames run left to right with 1px gutters, wrapping). */
export function frameRect(def, frame = 0) {
  const n = def.frames || 1;
  const f = ((Math.floor(frame) % n) + n) % n;
  if (!f) return [def.x, def.y];
  const perRow = Math.max(1, Math.floor((ATLAS_WIDTH - def.x) / (def.w + 1)));
  return [def.x + (f % perRow) * (def.w + 1), def.y + Math.floor(f / perRow) * (def.h + 1)];
}

/**
 * Place a draw list entry's sprite: after this, its texels are drawn at (-hx, -hy) in sprite pixels. `scale`: output
 * px per metre, the world origin at (x, y).
 * snap: at the atlas' own scale, an unscaled sprite turned by quarter turns is moved (by up to half a pixel) so its
 * texels land on whole pixels. Parts an odd number of cells across are centred mid-cell, 12.5 px off the 25 px grid:
 * their sprites otherwise fall half a pixel off, and the canvas' filtering spreads each texel over two pixels.
 */
export function placeSprite(ctx, d, x, y, scale, snap = false) {
  const k = scale / PX_PER_UNIT;
  let tx = x + d.x * scale, ty = y + d.y * scale;
  const q = d.angle / (Math.PI / 2), unit = (v) => Math.abs(Math.abs(v) - 1) < 1e-6;
  if (snap && Math.abs(k - 1) < 1e-9 && Math.abs(q - Math.round(q)) < 1e-6 && unit(d.sx) && unit(d.sy)) {
    const c = Math.round(Math.cos(d.angle)), s = Math.round(Math.sin(d.angle));
    const lx = -d.def.hx * d.sx, ly = -d.def.hy * d.sy;
    const cx = tx + lx * c - ly * s, cy = ty + lx * s + ly * c;   // the sprite's corner
    tx += Math.round(cx) - cx;
    ty += Math.round(cy) - cy;
  }
  ctx.translate(tx, ty);
  ctx.rotate(d.angle);
  ctx.scale(d.sx * k, d.sy * k);
}

/**
 * Icons drawn over parts (renderShip's badges), in atlas px centred on (0, 0), drawn like Parts_contrast's parts: a
 * shape filled mid blue inside a white outline with a lighter band in from it, and a dark edge around the outside.
 */
/**
 * The badges' colours, as Parts_contrast's parts (halo: the dark edge outside; fill; band: the lighter band in from
 * the outline; line: the outline), and as Parts_lightmode's (the same, recoloured by highfleetjs/tools/lightmode.py).
 */
export const BADGE_COLORS = {
  contrast: { halo: '13,45,87', fill: '69,139,211', band: '180,209,240', line: '228,239,253' },
  lightmode: { halo: '226,247,255', fill: '124,161,201', band: '44,57,71', line: '8,11,16' },
};
const BADGES = {
  /** The radiation trefoil, 1.7 blocks across: a hub and three 60-degree blades. */
  nuclear(ctx, colors) {
    const r = 21;
    const shape = new Path2D();
    shape.arc(0, 0, r * 0.19, 0, Math.PI * 2);
    for (const mid of [Math.PI / 2, Math.PI * 7 / 6, Math.PI * 11 / 6]) {
      const a0 = mid - Math.PI / 6, a1 = mid + Math.PI / 6;
      shape.moveTo(Math.cos(a0) * r, Math.sin(a0) * r);
      shape.arc(0, 0, r, a0, a1);
      shape.arc(0, 0, r * 0.36, a1, a0, true);
      shape.closePath();
    }
    drawLikePart(ctx, shape, colors);
  },
};

/** A shape in Parts_contrast's style (`colors`: a BADGE_COLORS entry; its line widths in atlas px). */
function drawLikePart(ctx, shape, colors) {
  ctx.lineJoin = 'round';
  for (const [color, w] of [[`rgba(${colors.halo},0.25)`, 6], [`rgba(${colors.halo},0.75)`, 4]]) {
    ctx.strokeStyle = color; ctx.lineWidth = w; ctx.stroke(shape);
  }
  ctx.fillStyle = `rgb(${colors.fill})`;
  ctx.fill(shape);
  ctx.save();
  ctx.clip(shape);
  for (const [color, w] of [[`rgb(${colors.band})`, 6], [`rgb(${colors.line})`, 4]]) {
    ctx.strokeStyle = color; ctx.lineWidth = w; ctx.stroke(shape);
  }
  ctx.restore();
}

/** Line segments drawn between bodies (antenna wires: joints with m_render_type=1). */
function wireSegments(ship) {
  const byId = new Map(ship.bodies.map((b) => [b.raw.m_id, b]));
  const out = [];
  for (const j of ship.raw.m_joints || []) {
    if (!j.m_render_type) continue;
    const a = byId.get(j['m_A.id']), b = byId.get(j['m_B.id']);
    if (!a || !b) continue;
    const anchor = (p, sx, sy) => {
      const c = Math.cos(p.angle), s = Math.sin(p.angle);
      return [p.x + sx * c - sy * s, p.y + sx * s + sy * c];
    };
    out.push([anchor(a, j.shiftA_x ?? 0, j.shiftA_y ?? 0), anchor(b, j.shiftB_x ?? 0, j.shiftB_y ?? 0)]);
  }
  return out;
}

/**
 * Render a ship.
 * @param ctx      2D context
 * @param ship     Ship
 * @param atlas    image of Media/Tex/Ships1.png (or the blueprint atlas)
 * @param opts     {
 *   scale:   output px per metre (default 7 = the atlas' native resolution),
 *   x, y:    output position of the world origin,
 *   wireColor: antenna wires' colour,
 *   partScale: size of each part's sprites about the part's centre: a number, or a module id -> scale
 *            map like PART_SCALE (default 1: the game's sizes; see drawList),
 *   lower:   module id -> true map of parts drawn under the rest of their floor ('all': under every other part),
 *            like PART_BACK (see drawList),
 *   art:     module id -> the one sprite drawn for the part, like PART_ART (see drawList),
 *   badges:  module id -> an icon (BADGES) drawn over the part after the whole ship, like PART_BADGE;
 *            badgeSize: their size (default 1), badgeColors: their colours (default BADGE_COLORS.contrast),
 *   snap:    sprites on whole pixels where they'd fall between them (see placeSprite),
 *   cutout:  an atlas whose sprites' shapes are cleared from what's drawn before each sprite is drawn: for an atlas
 *            of lines with nothing between them (the line-art blueprint), so a part hides what's under it,
 * }
 */
export function renderShip(ctx, ship, atlas, opts = {}) {
  const scale = opts.scale ?? PX_PER_UNIT;
  const ox = opts.x, oy = opts.y;
  const list = drawList(ship, opts);
  const wires = wireSegments(ship);
  // Wires sit behind everything else, like the game's antenna rendering.
  if (wires.length) {
    ctx.save();
    ctx.strokeStyle = opts.wireColor ?? 'rgba(40,40,40,0.9)';
    ctx.lineWidth = Math.max(1, scale / 7);
    ctx.beginPath();
    for (const [[x1, y1], [x2, y2]] of wires) {
      ctx.moveTo(ox + x1 * scale, oy + y1 * scale);
      ctx.lineTo(ox + x2 * scale, oy + y2 * scale);
    }
    ctx.stroke();
    ctx.restore();
  }
  for (const d of list) {
    const { def } = d;
    const [sx, sy] = frameRect(def, d.frame);
    ctx.save();
    placeSprite(ctx, d, ox, oy, scale, opts.snap);
    if (d.alpha < 1) ctx.globalAlpha *= d.alpha;
    if (opts.cutout) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(opts.cutout, sx, sy, def.w, def.h, -def.hx, -def.hy, def.w, def.h);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.drawImage(atlas, sx, sy, def.w, def.h, -def.hx, -def.hy, def.w, def.h);
    ctx.restore();
  }
  if (opts.badges) {
    for (const part of ship.bodies) {
      const badge = BADGES[opts.badges[part.oid]];
      if (!badge) continue;
      ctx.save();
      ctx.translate(ox + part.x * scale, oy + part.y * scale);
      const k = (scale / PX_PER_UNIT) * (opts.badgeSize ?? 1);
      ctx.scale(k, k);
      badge(ctx, opts.badgeColors ?? BADGE_COLORS.contrast);
      ctx.restore();
    }
  }
}

/** World-space bounds of everything the renderer draws (sprites + wires), in metres; opts: drawList's art. */
export function shipRenderBounds(ship, { art = null } = {}) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y) => {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  };
  for (const d of drawList(ship, { art })) {
    // Corners of the (rotated, scaled) sprite rectangle; transparent margins are included.
    const { w, h, hx, hy } = d.def;
    const c = Math.cos(d.angle), s = Math.sin(d.angle);
    for (const [px, py] of [[-hx, -hy], [w - hx, -hy], [-hx, h - hy], [w - hx, h - hy]]) {
      const lx = (px * d.sx) / PX_PER_UNIT, ly = (py * d.sy) / PX_PER_UNIT;
      add(d.x + lx * c - ly * s, d.y + lx * s + ly * c);
    }
  }
  for (const [[ax, ay], [bx, by]] of wireSegments(ship)) { add(ax, ay); add(bx, by); }
  if (x0 === Infinity) return { x0: 0, y0: 0, x1: 0, y1: 0, w: 0, h: 0 };
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}
