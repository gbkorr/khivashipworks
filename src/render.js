// Canvas renderer for ships (unlit sprite compositing, no shading/post-processing).
// Works with any CanvasRenderingContext2D-compatible context: browser canvas, OffscreenCanvas,
// @napi-rs/canvas or node-canvas.
import SPRITES from '../data/sprites.json' with { type: 'json' };
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
 * part, or a map of module id -> scale (missing = 1), like PART_SCALE (src/partstyles.js); the map leaves a 2x2
 * hull with a nuke's silo tube (hull.js) at full size.
 * frames maps module id -> the animation frame to draw instead of the design's (PART_FRAMES).
 * lower maps module id -> true for parts drawn under everything else on their floor (like PART_BACK); given one,
 * the list goes floor by floor, the lowered parts' sprites first on each (in depth order among themselves); default
 * none: depth order throughout.
 * Each entry: { part, sprite, def, x, y, angle, sx, sy, z, frame, alpha }  (x, y in world units)
 */
export function drawList(ship, sprites = SPRITES, partScale = 1, frames = PART_FRAMES, lower = null) {
  const list = [];
  let order = 0;
  for (const part of ship.bodies) {
    const c = Math.cos(part.angle), s = Math.sin(part.angle);
    // A 2x2 hull showing a nuke's silo tube stays full size, the size of the nuke in it.
    const tube = part.sprites.some((sp) => sp.name?.startsWith('tube2x2_'));
    const k = typeof partScale === 'number' ? partScale : tube ? 1 : partScale?.[part.oid] ?? 1;
    for (const sp of part.sprites) {
      const def = sprites[sp.name];
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
        frame: frames[part.oid] ?? sp.frame,
        alpha: 1,
        floor: part.floor,
        back: !!lower?.[part.oid],
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
  if (lower) list.sort((a, b) => a.floor - b.floor || b.back - a.back || a.z - b.z || a.order - b.order);
  else list.sort((a, b) => a.z - b.z || a.order - b.order);
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

/** Line segments drawn between bodies (antenna wires: joints with m_render_type=1). */
export function wireSegments(ship) {
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
 * @param atlas    image of Media/Tex/Ships1.png (HTMLImageElement / ImageBitmap / canvas Image)
 * @param opts     {
 *   scale:   output px per metre (default 7 = the atlas' native resolution),
 *   x, y:    output position of the world origin (default: fit ship's bounds at the top-left),
 *   frame:   animation frame for every multi-frame sprite (turrets etc.), default: each sprite's own
 *            (the design's, or PART_FRAMES),
 *   wires:   draw antenna wires (default true), wireColor,
 *   normals: draw each sprite's normal map (Ships1.res bump=) instead of its colour, for shading.js,
 *   partScale: size of each part's sprites about the part's centre: a number, or a module id -> scale
 *            map like PART_SCALE (default 1: the game's sizes; see drawList),
 *   lower:   module id -> true map of parts drawn under the rest of their floor, like PART_BACK (see drawList),
 * }
 */
export function renderShip(ctx, ship, atlas, opts = {}) {
  const scale = opts.scale ?? PX_PER_UNIT;
  const k = scale / PX_PER_UNIT;
  let ox = opts.x, oy = opts.y;
  if (ox === undefined || oy === undefined) {
    const b = shipRenderBounds(ship);
    ox ??= -b.x0 * scale;
    oy ??= -b.y0 * scale;
  }
  const list = drawList(ship, opts.sprites, opts.partScale, undefined, opts.lower);
  const wires = opts.wires === false || opts.normals ? [] : wireSegments(ship);
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
    const bump = opts.normals && def.bx !== undefined;
    const [sx, sy] = frameRect(bump ? { ...def, x: def.bx, y: def.by } : def, opts.frame ?? d.frame);
    ctx.save();
    // Normal pass: sprites without a normal map clear what's under them (they're lit flat).
    if (opts.normals && !bump) ctx.globalCompositeOperation = 'destination-out';
    ctx.translate(ox + d.x * scale, oy + d.y * scale);
    ctx.rotate(d.angle);
    ctx.scale(d.sx * k, d.sy * k);
    if (d.alpha < 1) ctx.globalAlpha *= d.alpha;
    ctx.drawImage(atlas, sx, sy, def.w, def.h, -def.hx, -def.hy, def.w, def.h);
    ctx.restore();
  }
}

/** World-space bounds of everything the renderer draws (sprites + wires), in metres. */
export function shipRenderBounds(ship, sprites = SPRITES) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y) => {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  };
  for (const d of drawList(ship, sprites)) {
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
