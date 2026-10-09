// The stage: the design drawn on the graph paper (as a blueprint, or in colour with the game's shading), what's
// hovered, selected or in hand over it, and the camera.
import { GRID } from '../lib/builder.js';
import { BLUEPRINT, PAPER_LIGHT, drawGraphPaper } from '../lib/paper.js';
import { PART_ART, PART_BACK, PART_BADGE, PART_SCALE } from '../lib/partstyles.js';
import { BADGE_COLORS, drawList, renderShip, shipRenderBounds } from '../lib/render.js';
import { SHADING, bakeShaded } from '../lib/shading.js';
import { SENSOR_ARCS, SENSOR_RAY, sensorOrigin, sensorSectors, sensorValue } from '../lib/stats.js';
import { S, MAX_ZOOM, cam, canvas, carrying, ctx, footer, rgba } from './state.js';
import { atlas, blueprint, lightmode, paper } from './assets.js';
import { connected } from './edit.js';

// Over the stage: a part breaking a rule; fits; selected; parked (allowed, but a module isn't on a slot). (Its ink
// is the paper's: sheet().ink.)
const WARN = [255, 138, 122], GOOD = [158, 230, 168], SELECT = [255, 215, 106];
const PARKED = [255, 190, 110];
// A part merely left off the ship (model.validate()'s problems): cut off from the bridge, and a module maybe off
// its slot too.
const offShip = (msgs) => msgs.includes('not connected to the bridge')
  && msgs.every((m) => m === 'not connected to the bridge' || m === 'not on a compatible slot');

/** What the hull-only button hides: modules (parts mounted on others), and sensors, the antenna included. */
const bareHides = (p) => p.mounted || sensorValue(p.oid) !== null || p.oid === 'MDL_ANTENNA_01';

/** The stage's paper: the blueprint, or the light theme's. */
export const sheet = () => (S.light ? PAPER_LIGHT : BLUEPRINT);
/** The current look's antenna wire colour and sprite atlas. */
export const wireColor = () => (S.colour ? 'rgba(40,40,40,0.9)' : rgba(sheet().ink, 0.8));
/** (On light paper, Parts_contrast stands in while Parts_lightmode loads.) */
export const atlasNow = () => (S.colour ? atlas : S.light && lightmode ? lightmode : blueprint);
/** renderShip options for the blueprint's own art: the crew quarters' cabins alone, and icons over parts. */
export const BLUEPRINT_ART = { art: PART_ART, badges: PART_BADGE };
/** The icons' colours for the current atlas (renderShip's badgeColors). */
export const badgeColors = () => (atlasNow() === lightmode ? BADGE_COLORS.lightmode : BADGE_COLORS.contrast);

function tracePoly(poly) {
  ctx.beginPath();
  poly.forEach(([x, y], i) => {
    const sx = cam.ox + x * cam.scale, sy = cam.oy + y * cam.scale;
    if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy);
  });
  ctx.closePath();
}

let frame = 0;
export function draw() {
  if (frame) return;
  frame = requestAnimationFrame(() => { frame = 0; paint(); });
}

// The game's lighting, cast shadows and colour grade (lib/shading.js), each with its own toggle. They're baked
// into an image of the ship at the atlas' resolution, redone only when the design (version) or the toggles change;
// panning and zooming just redraw it. While parts are carried the ship's bake is kept as it was (re-baking a ship
// takes a while): the spots moved parts left are washed out, and the parts in hand get a small bake of their own,
// keyed without the drag offset, so moving them only moves it. The drop re-bakes the ship once.

export const bakes = {
  still: { key: '', bake: null, version: -1 }, held: { key: '', bake: null },
  bare: { key: '', bake: null },   // the hull-only button's view
};
/** What a bake depends on: the options and the drawn sprites (shifted back by `shift`). */
export const bakeKey = (view, opts, shift = [0, 0]) => `${opts.lighting},${opts.shadows},${!!opts.grade};` + drawList(view).map((d) =>
  `${d.sprite.name},${(d.x - shift[0]).toFixed(5)},${(d.y - shift[1]).toFixed(5)},${d.angle},${d.sx},${d.sy},${d.z},${d.frame},${d.alpha}`).join(';');
/** bakeShaded(view), redone only when its key changes. */
function bakeCached(slot, view, opts, shift = [0, 0]) {
  const key = bakeKey(view, opts, shift);
  const c = bakes[slot];
  if (key !== c.key) {
    c.key = key;
    c.bake = bakeShaded(view, atlas, opts);
    c.shift = shift;
  }
  return c.bake && { ...c.bake, x0: c.bake.x0 + shift[0] - c.shift[0], y0: c.bake.y0 + shift[1] - c.shift[1] };
}
function drawBake(b) {
  if (!b) return;
  const k = cam.scale / b.scale;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(b.canvas, cam.ox + b.x0 * cam.scale, cam.oy + b.y0 * cam.scale, b.canvas.width * k, b.canvas.height * k);
}
/**
 * Whether the ship's bake is held as it is: parts are being carried and the bake is of the design as it was when
 * they were picked up (a shift-place drops parts and picks up copies at once: the drop still gets baked first).
 */
const frozen = () => carrying() && !!bakes.still.bake && bakes.still.version === S.held.version;
/** Bring the colour bake of the design (the stage's, bakes.still) up to date; not while parts are carried. */
export function refreshStill() {
  const still = bakes.still;
  if (carrying() || still.version === S.version) return;
  bakeCached('still', S.model.view(), SHADING);
  still.version = S.version;
}
/** `view`: the whole design, or only the parts in hand while frozen. */
function paintShaded(view) {
  const opts = SHADING;
  // Antenna mast segments (p<uid>a<k>) belong to their antenna.
  const inHand = new Set(carrying() ? S.held.group.map((p) => `p${p.uid}`) : []);
  const isHeld = (b) => inHand.has(b.raw.m_id.replace(/a\d+$/, ''));
  const still = bakes.still;
  if (!frozen() && still.version !== S.version) {
    bakeCached('still', { ...view, bodies: view.bodies.filter((b) => !isHeld(b)) }, opts);
    still.version = S.version;
  }
  drawBake(still.bake);
  if (frozen() && S.held.ghost.length) {
    ctx.fillStyle = rgba(sheet().paper, 0.7);
    for (const poly of S.held.ghost) { tracePoly(poly); ctx.fill(); }
  }
  if (inHand.size) drawBake(bakeCached('held', { ...view, bodies: view.bodies.filter(isHeld) }, opts, S.held.offset));
}

// A hovered sensor's coverage, as the game shows it: the degrees its rays trace (stats.js, sensorSectors), out to
// the rays' reach. Yellow: clear; grey: behind hull only (half); red: blocked.
const COVER_CLEAR = [240, 210, 70], COVER_HALF = [105, 105, 105], COVER_BLOCKED = [220, 40, 40];
let coverage = { key: '', sectors: null, origin: null };
function sensorCoverage(part) {
  const key = `${S.version}:${part.uid}`;
  if (coverage.key !== key) {
    // Parts left unconnected to the bridge aren't part of the ship, so they don't block (the hovered sensor
    // itself is traced either way).
    const parts = connected().ship.parts;
    const view = S.model.view(parts.includes(part) ? parts : [...parts, part]);
    const body = view.bodies.find((b) => b.build === part);
    const sectors = body && sensorSectors(view, body);
    coverage = { key, sectors, origin: sectors && sensorOrigin(body) };
  }
  return coverage;
}
function paintCoverage(part) {
  const { sectors, origin } = sensorCoverage(part);
  if (!sectors) return;
  const full = sensorValue(part.oid);
  const cx = cam.ox + origin[0] * cam.scale, cy = cam.oy + origin[1] * cam.scale, r = SENSOR_RAY * cam.scale;
  // A circle around the sensor is left clear, so the arcs don't cover it.
  const reach = Math.max(...part.polygon().map(([x, y]) => Math.hypot(x - origin[0], y - origin[1])));
  const hole = 0.6 * Math.max(reach + 1, 1.75 * GRID) * cam.scale;   // (its art reaches past its mesh)
  // Degree a points along (-sin a, cos a), i.e. canvas angle a + 90 degrees. Each traced degree gets the
  // wedge a +- 0.5; runs of equal values are drawn as one.
  const rad = (deg) => (deg + 90) * Math.PI / 180;
  const traced = (i) => SENSOR_ARCS.some(([a, b]) => i >= a && i <= b);
  for (let i = 0; i < 360; i++) {
    if (!traced(i)) continue;
    let j = i;
    while (j + 1 < 360 && traced(j + 1) && sectors[j + 1] === sectors[i]) j++;
    const v = sectors[i];
    const c = v === 0 ? COVER_BLOCKED : v < full ? COVER_HALF : COVER_CLEAR;
    ctx.beginPath();
    ctx.arc(cx, cy, r, rad(i - 0.5), rad(j + 0.5));
    ctx.arc(cx, cy, Math.min(hole, r), rad(j + 0.5), rad(i - 0.5), true);
    ctx.closePath();
    ctx.fillStyle = rgba(c, c === COVER_CLEAR ? 0.38 : 0.45);
    ctx.fill();
    ctx.strokeStyle = rgba(c, 0.85);
    ctx.lineWidth = Math.max(1, S.dpr);
    ctx.beginPath();
    ctx.arc(cx, cy, r, rad(i - 0.5), rad(j + 0.5));
    ctx.stroke();
    i = j;
  }
}

function paint() {
  // The tray shows as a bin while parts are being moved (not while a thumbnail is only pressed).
  const moving = carrying();
  footer.classList.toggle('holding', moving);
  if (!moving) footer.classList.remove('over', 'over-prune', 'prune-ready');
  const w = canvas.width, h = canvas.height, INK = sheet().ink;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawGraphPaper(ctx, 0, 0, w, h, {
    cell: GRID * cam.scale, originX: cam.ox, originY: cam.oy,
    texture: paper, palette: sheet(),
  });
  // Design origin marker (the bridge's home).
  ctx.strokeStyle = rgba(INK, 0.25);
  ctx.lineWidth = S.dpr;
  ctx.beginPath();
  ctx.arc(cam.ox, cam.oy, 4 * S.dpr, 0, Math.PI * 2);
  ctx.stroke();

  // The hull-only button held (not with parts in hand): the modules and sensors are left out, overlays and all.
  const bare = S.bare && !carrying();
  const shown = (p) => !bare || !bareHides(p);
  if (S.colour && bare) drawBake(bakeCached('bare', S.model.view(S.model.parts.filter(shown)), SHADING));
  else if (S.colour) paintShaded(frozen() ? S.model.view(S.held.group) : S.model.view());
  else {
    const view = S.model.view(S.model.parts.filter(shown));
    renderShip(ctx, view, atlasNow(), {
      scale: cam.scale, x: cam.ox, y: cam.oy, partScale: PART_SCALE, lower: PART_BACK, wireColor: wireColor(),
      ...BLUEPRINT_ART, badgeColors: badgeColors(),
    });
  }

  const lw = Math.max(1, S.dpr * 1.2);
  // Parts breaking a rule. Being left off the ship doesn't count, floating modules included: that's just work in
  // progress.
  if (!S.held) {
    for (const [p, msgs] of S.problems) {
      if (offShip(msgs) || !shown(p)) continue;
      tracePoly(p.polygon());
      ctx.fillStyle = rgba(WARN, 0.18); ctx.fill();
      ctx.strokeStyle = rgba(WARN, 0.9); ctx.lineWidth = lw; ctx.stroke();
    }
  }
  // Hover and selection.
  if (S.hover && !S.held && S.mode === 'idle' && shown(S.hover)) {
    paintCoverage(S.hover);
    tracePoly(S.hover.polygon());
    ctx.strokeStyle = rgba(INK, 0.7); ctx.lineWidth = lw; ctx.stroke();
  }
  for (const p of S.selection) {
    if (!shown(p)) continue;
    tracePoly(p.polygon());
    ctx.fillStyle = rgba(SELECT, 0.12); ctx.fill();
    ctx.strokeStyle = rgba(SELECT, 0.95); ctx.lineWidth = lw * 1.5; ctx.stroke();
  }
  // The held group: slot hints, then the parts tinted by whether they can go here.
  if (S.held) {
    ctx.fillStyle = rgba(GOOD, 0.55);
    for (const s of S.held.freeSlots) {
      ctx.beginPath();
      ctx.arc(cam.ox + s.x * cam.scale, cam.oy + s.y * cam.scale, Math.max(2.5 * S.dpr, cam.scale * 0.25), 0, Math.PI * 2);
      ctx.fill();
    }
    // Green: fits; amber: allowed but a module isn't on a slot (parked); red: overlaps, can't drop.
    const c = !S.held.valid ? WARN : S.held.attached ? GOOD : PARKED;
    for (const p of S.held.group) {
      tracePoly(p.polygon());
      ctx.fillStyle = rgba(c, 0.2); ctx.fill();
      ctx.strokeStyle = rgba(c, 0.95); ctx.lineWidth = lw * 1.5; ctx.stroke();
    }
  }
  if (S.box) {
    ctx.setLineDash([5 * S.dpr, 4 * S.dpr]);
    ctx.strokeStyle = rgba(INK, 0.9); ctx.lineWidth = lw;
    ctx.fillStyle = rgba(INK, 0.06);
    const x = Math.min(S.box.x0, S.box.x1), y = Math.min(S.box.y0, S.box.y1);
    ctx.fillRect(x, y, Math.abs(S.box.x1 - S.box.x0), Math.abs(S.box.y1 - S.box.y0));
    ctx.strokeRect(x, y, Math.abs(S.box.x1 - S.box.x0), Math.abs(S.box.y1 - S.box.y0));
    ctx.setLineDash([]);
  }
  S.afterPaint?.(ctx);
}

export function resize() {
  S.dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * S.dpr)), h = Math.max(1, Math.round(r.height * S.dpr));
  if (canvas.width === w && canvas.height === h) return;
  // Keep the view centred on the same point.
  const cx = canvas.width ? (canvas.width / 2 - cam.ox) / cam.scale : 0;
  const cy = canvas.height ? (canvas.height / 2 - cam.oy) / cam.scale : 0;
  canvas.width = w; canvas.height = h;
  cam.ox = w / 2 - cx * cam.scale; cam.oy = h / 2 - cy * cam.scale;
  clampCamera();
  paint();
}

/**
 * Keep part of the ship on screen: panning (or zooming) stops once only a sliver of it is left in view.
 * Parts in hand don't count, so carrying something off to the side doesn't drag the limit along.
 */
const KEEP_VISIBLE = 80;   // css px of the ship that must stay on screen (or all of it, if smaller)
export function clampCamera() {
  const inHand = new Set(S.held?.group ?? []);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of S.model.parts) {
    if (inHand.has(p)) continue;
    const b = p.bounds();
    x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
  }
  if (x0 === Infinity) return;
  const clamp = (o, lo, hi, size) => {
    // Screen extent of the ship is o + lo*scale .. o + hi*scale; keep `keep` px of it inside 0..size.
    const keep = Math.min(KEEP_VISIBLE * S.dpr, (hi - lo) * cam.scale);
    return Math.min(Math.max(o, keep - hi * cam.scale), size - keep - lo * cam.scale);
  };
  cam.ox = clamp(cam.ox, x0, x1, canvas.width);
  cam.oy = clamp(cam.oy, y0, y1, canvas.height);
}

/** Zoom and pan so the whole design fits (F), framing at least fitBlocks (wide, high). */

export function fit() {
  resize();
  const b = S.model.parts.length ? shipRenderBounds(S.model.view()) : { x0: -10, y0: -10, x1: 10, y1: 10, w: 20, h: 20 };
  const w = Math.max(b.w, S.fitBlocks[0] * GRID), h = Math.max(b.h, S.fitBlocks[1] * GRID);
  cam.scale = Math.max(2 * S.dpr, Math.min(MAX_ZOOM * S.dpr, 0.8 * Math.min(canvas.width / w, canvas.height / h)));
  cam.ox = canvas.width / 2 - ((b.x0 + b.x1) / 2) * cam.scale;
  cam.oy = canvas.height / 2 - ((b.y0 + b.y1) / 2) * cam.scale;
  draw();
}

/** Zoom to `scale` device px per metre (within limits), keeping the screen point (x, y) where it is. */
export function zoomAt(x, y, scale) {
  scale = Math.max(1.5 * S.dpr, Math.min(MAX_ZOOM * S.dpr, scale));
  cam.ox = x - (x - cam.ox) * (scale / cam.scale);
  cam.oy = y - (y - cam.oy) * (scale / cam.scale);
  cam.scale = scale;
  clampCamera();
}
