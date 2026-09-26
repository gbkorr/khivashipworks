// Shipbuilder page: place parts on the block grid and download the design as a .seria.
// The rules, snapping and export live in src/builder.js; this file is input handling and drawing.
import {
  BuildModel, BuildPart, PART_TEMPLATES, BRIDGE, GRID, computeLinks, placement, snapOffset,
  rotateParts, dependents, renderShip, shipRenderBounds, drawGraphPaper, paperTexture, BLUEPRINT, PART_SCALE, CATEGORY,
  computeStats, Ship, bakeShaded, bakeShadedAsync, drawList, SHADING,
  FONTS, renderPanel, panelHeight, partsList, renderRuledList, ruledListLines, RULED, renderStatCard, statCardLines, CARD,
  encodeDesign, designFromCard, filledHull,
} from './src/index.js';
import MODULES from './data/modules.json' with { type: 'json' };
import STRINGS from './data/strings.json' with { type: 'json' };

const $ = (id) => document.getElementById(id);
const load = (src) => new Promise((ok, err) => {
  const img = new Image(); img.onload = () => ok(img); img.onerror = err; img.src = src;
});
const fontNames = Object.keys(FONTS);
const [atlas, blueprint, contrastBlueprint, ui, ...fontImages] = await Promise.all([
  load('./assets/Ships1.png'), load('./assets/Ships1_blueprint.png').catch(() => null),
  load('./assets/Ships1_blueprint_contrast.png').catch(() => null), load('./assets/ui.png').catch(() => null),
  ...fontNames.map((n) => load(`./assets/fonts/${n}.png`).catch(() => null)),
]);
const fonts = Object.fromEntries(fontNames.map((n, i) => [n, fontImages[i]]));

// Paper texture (grain, fibres, blotches) laid over the graph paper; a fainter one (another sheet) on the
// panels around it, as CSS background tiles.
const makeCanvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });
const paper = paperTexture(makeCanvas);
{
  const [blotches, grain] = paperTexture(makeCanvas, { seed: 5, strength: 0.6 });
  document.documentElement.style.setProperty('--grain', `url(${grain.image.toDataURL()})`);
  document.documentElement.style.setProperty('--blotches', `url(${blotches.image.toDataURL()})`);
}

const canvas = $('view');
const ctx = canvas.getContext('2d');
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const INK = BLUEPRINT.ink, WARN = [255, 138, 122], GOOD = [158, 230, 168], SELECT = [255, 215, 106];
const PARKED = [255, 190, 110];

// ---- state ---------------------------------------------------------------------------------------
let model = BuildModel.blank('New ship');
let selection = new Set();
let hover = null;
let problems = new Map();          // part -> [message], from model.validate()
const undoStack = [];
const cam = { scale: 14, ox: 0, oy: 0 };   // device px per metre; screen position of the design origin
const MAX_ZOOM = 20;                        // css px per metre
let dpr = window.devicePixelRatio || 1;

/**
 * What the pointer is doing:
 *   idle | pan | press (left down on a part, not moved yet) | drag (group follows, button held)
 *   | carry (group follows until the next click) | box (rubber-band select)
 */
let mode = 'idle';
let pointer = { x: 0, y: 0, wx: 0, wy: 0, overCanvas: false };
let press = null;                   // { x, y, part, shift }
let box = null;                     // { x0, y0, x1, y1, add }
let held = null;                    // { group, primary, bases, grab, origin, isNew, offset, valid, freeSlots }

// Two looks: blueprint (the hand-drawn atlas on graph paper) and colour (the game's sprites with its lighting,
// cast shadows, stage shading and colour grade: SHADING). Remembered per browser.
let colour = !(contrastBlueprint || blueprint);
try { if (contrastBlueprint || blueprint) colour = localStorage.getItem('shipbuilder.mode') === 'colour'; } catch { /* storage may be off */ }
const wireColor = () => (colour ? 'rgba(40,40,40,0.9)' : rgba(BLUEPRINT.ink, 0.8));
const atlasNow = () => (colour ? atlas : contrastBlueprint || blueprint);
const toWorld = (sx, sy) => [(sx - cam.ox) / cam.scale, (sy - cam.oy) / cam.scale];

// ---- undo ------------------------------------------------------------------------------------------
function snapshot() {
  undoStack.push(model.parts.map((p) => ({ oid: p.oid, x: p.x, y: p.y, angle: p.angle, raw: p.raw })));
  if (undoStack.length > 200) undoStack.shift();
}
function undo() {
  if (held) return cancelHold();
  const s = undoStack.pop();
  if (!s) return;
  model.parts = s.map((q) => new BuildPart(q.oid, q.x, q.y, q.angle, q.raw));
  selection.clear();
  changed();
}

// ---- model changes -----------------------------------------------------------------------------------
let statsTimer = 0;
let version = 0;                    // bumped on every model change (the shaded bake is redone only then)
let edited = false;                 // changed since it was loaded or saved
function changed() {
  version++;
  edited = true;
  const v = model.validate();
  problems = v.problems;
  // Stats need the full export tree; keep them off the interaction path.
  clearTimeout(statsTimer);
  statsTimer = setTimeout(() => {
    // Not counting new parts still in hand (e.g. the copy after a shift-place), nor unconnected ones.
    const { ship: placed, loose } = connected(new Set(held?.isNew ? held.group : []));
    try {
      const ship = new Ship(placed.toTree());
      const s = computeStats(ship);
      current = { ship, stats: s, placed };
      drawSidePanels(ship, s);
    } catch { /* partial designs can trip the stats; the side panels keep the last ones */ }
  }, 120);
  draw();
}

/**
 * The design without parts left unconnected to the bridge (they aren't part of the ship: they're left out of
 * the stats, the card and the downloads; with no bridge, everything counts), nor `exclude`. Of `m`, the one being
 * built unless given.
 * @returns { ship: BuildModel, loose: number of unconnected parts }
 */
function connected(exclude = new Set(), m = model) {
  const parts = m.parts.filter((p) => !exclude.has(p));
  const hasBridge = parts.some((p) => p.oid === BRIDGE);
  const loose = new Set(hasBridge ? new BuildModel({ ...m, parts }).unconnected() : []);
  return { ship: new BuildModel({ ...m, parts: parts.filter((p) => !loose.has(p)) }), loose: loose.size };
}

function setModel(m) {
  model = m;
  selection.clear();
  held = null;
  mode = 'idle';
  undoStack.length = 0;
  $('name').value = model.name;
  $('flagship').setAttribute('aria-pressed', model.flagship);
  fit();
  // Its card (and colour bake) are made as soon as its stats are, not after the input goes idle.
  loadedNow = true;
  clearTimeout(idleTimer);
  idleTimer = 0;
  changed();
  edited = false;
}

// ---- side panels: stat card and stats (left); parts list (right) ------------------------------------------
const PAD = 14;
// The parts list's width: its longest line (NUCLEAR MISSILE CARRIER) and a little room (#parts-ruled's width).
const PARTS_W = 280;
let current = null;                 // { ship, stats, placed } of the placed parts, from the last stats update
function drawSidePanels(ship, stats) {
  const c = $('stats-panel');
  c.width = CARD.width;
  c.height = panelHeight(stats);
  renderPanel(c.getContext('2d'), stats, { fonts, x: PAD, y: 0 });

  // Ruled list; the rules themselves are the side panel's CSS background, so they carry on below it.
  const sections = partsList(ship);
  const h = ruledListLines(stats, sections) * RULED.line;
  const p = $('parts-panel'), k = window.devicePixelRatio || 1;
  p.width = PARTS_W * k; p.height = Math.max(1, h * k);
  p.style.width = `${PARTS_W}px`; p.style.height = `${h}px`;
  p.hidden = !h;
  const g = p.getContext('2d');
  g.scale(k, k);
  // Headers in the page's coral (the CSS --warn).
  renderRuledList(g, ship, { ui, fonts, stats, sections, width: PARTS_W, lines: false, colors: { accent: '#ff9d8f' } });
  p.nextElementSibling.textContent = h ? '' : 'No weapons, sensors or engines yet.';

  cardWanted = true;
  whenIdle();
}

// The stat card is drawn at 3x, the size it's saved at: its stamp (the design, printed in the right column) is
// made to survive recompression at that size. The sidebar shows it scaled down.
const CARD_SCALE = 3;
/** The design code for the stamp: the placed parts, with the current name and flagship flag. */
const cardCode = () => encodeDesign({ name: model.name, flagship: model.flagship, parts: current.placed.parts });
const cardVisible = () => !$('side-stats').classList.contains('collapsed') && !$('card-section').classList.contains('collapsed');

// Work that stalls the page for a moment on a large ship waits until IDLE ms after the last input (and nothing is
// carried), so it doesn't break into a pan, a drag or a zoom: bringing the colour bake up to date (also in blueprint
// mode, so switching to colour finds it ready), then the card, drawn from that bake. Moving the pointer counts only
// while a button is down or a part is held; plain mouse motion doesn't hold it up. A newly loaded design doesn't
// wait (loadedNow), nor does anything in colour mode: the stage bakes each change straight away, and the card
// just follows it. Otherwise the work is done a few ms at a time and dropped the moment an input comes in (what was
// half done is thrown away), to be taken up again once the input is idle again; a newly loaded design's isn't
// dropped for input.
const IDLE = 50;
let lastInput = 0, idleTimer = 0, cardWanted = false, cardShown = '', loadedNow = false;
for (const type of ['pointermove', 'pointerdown', 'pointerup', 'wheel', 'keydown']) {
  window.addEventListener(type, (e) => {
    if (type === 'pointermove' && !e.buttons && !held) return;
    lastInput = performance.now();
  }, { capture: true, passive: true });
}
function whenIdle() {
  if (idleTimer) return;
  const check = () => {
    const wait = loadedNow || colour ? 0 : IDLE - (performance.now() - lastInput);
    if (wait > 0 || carrying()) { idleTimer = setTimeout(check, Math.max(20, wait)); return; }
    idleTimer = 0;
    idleWork();
  };
  idleTimer = setTimeout(check, 0);
}
let working = null;
async function idleWork() {
  if (working) return;   // (loadedNow stays set for the run after this one)
  const started = performance.now(), v = version, loaded = loadedNow;
  loadedNow = false;
  // Dropped: an input since this started (unless in colour, where nothing waits, or for a newly loaded design),
  // or another change.
  const dropped = () => (!colour && !loaded && lastInput > started) || version !== v || carrying();
  working = (async () => {
    if (!(await refreshStillAsync(dropped))) return false;
    if (!cardWanted || !current || !cardVisible()) return true;
    cardWanted = false;   // (a request arriving while this runs sets it again)
    const cur = current, code = await cardCode();
    if (dropped()) return !(cardWanted = true);
    // Not redrawn when it would come out the same (same design code, stats and colour).
    const key = `${code.join(',')};${JSON.stringify(statCardLines(cur.stats))};${cur.stats.price};${cur.stats.class.purpose}`;
    if (key !== cardShown) {
      const pic = await cardPicture(cur, dropped);
      if (!pic && dropped()) return !(cardWanted = true);
      await new Promise((ok) => setTimeout(ok, 0));   // the card in a task of its own
      if (dropped()) return !(cardWanted = true);
      drawCard($('card-panel'), cur, code, pic);
      cardShown = key;
    }
    return true;
  })();
  const done = await working;
  working = null;
  // Dropped, or another change or card request came in meanwhile: again, once the input is idle.
  if (!done || version !== v || cardWanted) whenIdle();
}

/** refreshStill, a few ms at a time (at once in colour mode); false if `dropped()` stopped it first. */
async function refreshStillAsync(dropped) {
  const S = bakes.still;
  if (carrying()) return false;
  if (S.version === version) return true;
  if (colour) { refreshStill(); return true; }
  const v = version, view = model.view(), key = bakeKey(view, SHADING);
  if (key !== S.key) {
    const bake = await bakeShadedAsync(view, atlas, newCanvas, SHADING, { cancelled: dropped });
    if (dropped()) return false;
    Object.assign(S, { key, bake, shift: [0, 0] });
  }
  S.version = v;
  return true;
}

// The card's ship is always in colour: the stage's colour bake, unless parts are left unconnected (the card leaves
// them out): then a bake of its own, once per design (not per name or flagship change).
let cardPic = null, cardPicKey = '';
async function cardPicture({ placed }, dropped) {
  if (placed.parts.length === model.parts.length) return bakes.still.bake;
  const view = placed.view(), key = bakeKey(view, SHADING);
  if (key !== cardPicKey) {
    const bake = await bakeShadedAsync(view, atlas, newCanvas, SHADING, { cancelled: dropped });
    if (dropped()) return null;
    cardPicKey = key; cardPic = bake;
  }
  return cardPic;
}
/** @returns whether the stamp was printed (`m`: the design it's of, the one being built unless given) */
function drawCard(c, cur, code, pic, m = model) {
  const { ship, stats } = cur;
  c.width = CARD.width * CARD_SCALE; c.height = CARD.height * CARD_SCALE;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.scale(CARD_SCALE, CARD_SCALE);
  ship.name = m.name;
  const { stamped } = renderStatCard(g, ship, {
    atlas, ui, fonts, stats, bake: pic, flagship: m.flagship, createCanvas: newCanvas, stamp: code,
  });
  return stamped;
}

// Foldable sections (remembered per browser): the two sidebars (to the bar on their inner edge), the card
// above the stats (up to its title bar), and the shortcuts on the stage (to theirs).
const sections = [
  [$('side-stats'), $('side-stats').querySelector(':scope > .fold-bar'), (on) => `${on ? '▸' : '◂'} stats`],
  [$('side-parts'), $('side-parts').querySelector(':scope > .fold-bar'), (on) => `${on ? '◂' : '▸'} parts`],
  [$('card-section'), $('card-bar'), (on) => `${on ? '▸' : '▾'} ship card`],
  [$('help'), $('help-bar'), (on) => `${on ? '▸' : '▾'} shortcuts`],
];
for (const [el, button, label] of sections) {
  const key = `shipbuilder.${el.id}Collapsed`;
  const set = (on) => {
    el.classList.toggle('collapsed', on);
    // The arrow stands upright on the vertical bars.
    const [arrow, text] = label(on).split(/ (.*)/);
    button.replaceChildren(Object.assign(document.createElement('span'), { className: 'arrow', textContent: arrow }), ` ${text}`);
    try { localStorage.setItem(key, on ? '1' : ''); } catch { /* storage may be off */ }
  };
  button.onclick = () => {
    set(!el.classList.contains('collapsed'));
    if (current) drawSidePanels(current.ship, current.stats);   // the card isn't drawn while hidden
  };
  let on = false;
  try { on = localStorage.getItem(key) === '1'; } catch { /* storage may be off */ }
  set(on);
}

// ---- hit testing -------------------------------------------------------------------------------------
function inside(poly, x, y) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
/** Topmost part under a design point: modules above structure, then by render layer. */
function partAt(wx, wy, exclude = null) {
  let best = null, rank = -Infinity;
  for (const p of model.parts) {
    if (exclude?.has(p)) continue;
    const b = p.bounds();
    if (wx < b.x0 || wx > b.x1 || wy < b.y0 || wy > b.y1 || !inside(p.polygon(), wx, wy)) continue;
    const r = (p.mounted ? 100 : 0) + (p.raw.m_layer ?? 0) + (p.raw.m_stage ?? 0) / 100;
    if (r >= rank) { rank = r; best = p; }
  }
  return best;
}

// ---- moving parts ----------------------------------------------------------------------------------
/** Pick up parts (with whatever is mounted on them) so they follow the pointer. */
function hold(parts, primary, isNew, holdMode, grab = null) {
  if (!isNew) snapshot();
  const group = isNew ? parts : dependents(model.parts, parts);
  if (isNew) model.parts.push(...parts);
  const origin = new Map(group.map((p) => [p, { x: p.x, y: p.y, angle: p.angle }]));
  const bases = new Map(group.map((p) => [p, [p.x, p.y]]));
  // One part is held by its middle; a multiselection keeps where it was grabbed.
  const single = parts.length === 1;
  grab ??= single ? centerOffset(primary) : isNew ? [0, 0] : [pointer.wx - primary.x, pointer.wy - primary.y];
  held = { group, primary, bases, grab, origin, isNew, single, offset: [0, 0], valid: false, freeSlots: [] };
  // Where moved parts were: the shaded view keeps its bake until the drop, with these spots washed out.
  held.ghost = isNew ? [] : group.map((p) => p.polygon());
  held.version = version;
  held.freeSlots = freeSlotsFor(held);
  mode = holdMode;
  canvas.classList.add('holding');
  follow();
}

/** From a part's origin to the middle of its footprint. */
function centerOffset(p) {
  const b = p.bounds();
  return [(b.x0 + b.x1) / 2 - p.x, (b.y0 + b.y1) / 2 - p.y];
}

/** Free slots on the rest of the ship that the held primary part could plug into (drawn as hints). */
function freeSlotsFor(h) {
  if (!h.primary.mounted) return [];
  const inGroup = new Set(h.group);
  const others = model.parts.filter((p) => !inGroup.has(p));
  const links = computeLinks(others);
  const want = h.primary.slots().filter((s) => s.mount).map((s) => s.type);
  return others.flatMap((p) => p.slots())
    .filter((s) => !s.mount && !links.linkOf(s) && want.some((t) => (s.type & t) === t));
}

function follow() {
  if (!held) return;
  const { primary, bases, grab } = held;
  const [bx, by] = bases.get(primary);
  const dx = pointer.wx - grab[0] - bx, dy = pointer.wy - grab[1] - by;
  const [sx, sy] = snapOffset(model.parts, held.group, primary, dx, dy, bases);
  held.offset = [sx, sy];
  for (const p of held.group) {
    const [x, y] = bases.get(p);
    p.x = x + sx; p.y = y + sy;
  }
  const at = placement(model.parts, held.group);
  held.valid = at.ok;
  held.attached = at.attached;
  held.reason = at.reason;
  draw();
}

/** Why a group can't go where it is, from placement().reason. */
function reason(why) {
  return why === 'slot' ? 'must be placed on hull' : 'overlaps another part';
}

/** Put the held group down. With shift, a copy stays in hand (duplicate). */
function drop(duplicate = false) {
  if (!held) return;
  if (!held.valid) {
    toast(`Can't place: ${reason(held.reason)}.`);
    // A carried part stays in hand until it finds a spot (or Esc); a dragged one goes back.
    if (mode !== 'carry') cancelHold();
    return;
  }
  if (held.isNew) {
    undoStack.push(model.parts.filter((p) => !held.group.includes(p)).map((p) => ({ oid: p.oid, x: p.x, y: p.y, angle: p.angle, raw: p.raw })));
  }
  const placed = held.group;
  lastDrop = { parts: placed, time: performance.now() };
  const { primary, grab } = held;
  held = null;
  mode = 'idle';
  canvas.classList.remove('holding');
  selection = new Set(placed.length > 1 && !duplicate ? placed : []);
  changed();
  if (duplicate) {
    const copies = new Map(placed.map((p) => [p, p.clone()]));
    hold([...copies.values()], copies.get(primary), true, 'carry', grab);
  }
}

let lastDrop = null;
let selectionBeforeBox = new Set();

/**
 * Left and right button together: delete, like Del. Whichever button lands first already did something
 * (a left click puts a carried part down or picks one up, a right press starts panning); undo that.
 */
function chordDelete() {
  if (pan) { pan = null; canvas.classList.remove('panning'); if (mode === 'pan') mode = 'idle'; }
  if (held) return deleteHeld();
  if (mode === 'press') {
    if (!selection.has(press.part)) { selection.clear(); selection.add(press.part); }
    mode = 'idle';
  } else if (mode === 'box') {
    // The left press on empty space cleared the selection; the chord means the one before it.
    if (!box.add) selection = selectionBeforeBox;
    box = null;
    mode = 'idle';
  } else if (lastDrop && performance.now() - lastDrop.time < 400) {
    selection = new Set(lastDrop.parts.filter((p) => model.parts.includes(p)));
  }
  lastDrop = null;
  removeSelection();
}

/** Delete every part with no connection to the bridge (things left off to the side). */
function pruneUnconnected() {
  if (held) cancelHold();
  if (!model.parts.some((p) => p.oid === BRIDGE)) return toast('No bridge: nothing counts as connected.');
  const gone = new Set(model.unconnected());
  if (!gone.size) return toast('Every part is connected.');
  snapshot();
  model.parts = model.parts.filter((p) => !gone.has(p));
  for (const p of gone) selection.delete(p);
  toast(`Deleted ${gone.size} unconnected part${gone.size > 1 ? 's' : ''}.`);
  changed();
}

/** Delete the held group (Del, or dropping it back on the parts tray). */
function deleteHeld() {
  if (!held) return;
  if (held.isNew) return cancelHold();
  const gone = new Set(held.group);
  model.parts = model.parts.filter((p) => !gone.has(p));   // hold() already saved the undo step
  held = null;
  mode = 'idle';
  canvas.classList.remove('holding');
  selection.clear();
  changed();
}

/** Add parts to the selection together with the hull they're mounted on, so the group can move. */
function selectWithHosts(parts) {
  const { host } = computeLinks(model.parts);
  for (const p of parts) {
    for (let q = p, n = 0; q && n < 50; q = host.get(q), n++) selection.add(q);
  }
}

function cancelHold() {
  if (!held) return;
  if (held.isNew) {
    const drop = new Set(held.group);
    model.parts = model.parts.filter((p) => !drop.has(p));
  } else {
    for (const [p, o] of held.origin) Object.assign(p, o);
    undoStack.pop();
  }
  held = null;
  mode = 'idle';
  canvas.classList.remove('holding');
  changed();
}

/** R / shift+wheel: turn the held group, or the selection, by quarter turns (1 = 90 degrees clockwise). */
function rotate(turns = 1) {
  turns = ((turns % 4) + 4) % 4;
  if (!turns) return;
  if (held) {
    const { primary } = held;
    for (let i = 0; i < turns; i++) rotateParts(held.group, primary.x, primary.y);
    // Keep the current offset: the rotated positions become the new bases.
    for (const p of held.group) held.bases.set(p, [p.x - held.offset[0], p.y - held.offset[1]]);
    // Turning about the primary part leaves it (and so a multiselection's grab) in place; a single part
    // is re-centred on the cursor.
    if (held.single) held.grab = centerOffset(primary);
    held.freeSlots = freeSlotsFor(held);
    follow();
    return;
  }
  if (!selection.size) return toast('Select parts (or hold one) to rotate.');
  snapshot();
  const group = dependents(model.parts, [...selection]);
  const before = new Map(group.map((p) => [p, { x: p.x, y: p.y, angle: p.angle }]));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of group) {
    const b = p.bounds();
    x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
  }
  for (let i = 0; i < turns; i++) rotateParts(group, (x0 + x1) / 2, (y0 + y1) / 2);
  const primary = group.find((p) => !p.mounted) ?? group[0];
  const bases = new Map(group.map((p) => [p, [p.x, p.y]]));
  const [dx, dy] = snapOffset(model.parts, group, primary, 0, 0, bases);
  for (const p of group) { p.x += dx; p.y += dy; }
  const at = placement(model.parts, group);
  if (!at.ok) {
    for (const [p, o] of before) Object.assign(p, o);
    undoStack.pop();
    toast(`Can't rotate here: ${reason(at.reason)}.`);
  }
  changed();
}

function removeSelection() {
  if (held) return deleteHeld();
  if (!selection.size) return;
  snapshot();
  const gone = new Set(dependents(model.parts, [...selection]));
  model.parts = model.parts.filter((p) => !gone.has(p));
  selection.clear();
  changed();
}

// ---- drawing -----------------------------------------------------------------------------------------
function tracePoly(poly) {
  ctx.beginPath();
  poly.forEach(([x, y], i) => {
    const sx = cam.ox + x * cam.scale, sy = cam.oy + y * cam.scale;
    if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy);
  });
  ctx.closePath();
}

let frame = 0;
function draw() {
  if (frame) return;
  frame = requestAnimationFrame(() => { frame = 0; paint(); });
}

// The game's lighting, cast shadows and colour grade (src/shading.js), each with its own toggle. They're baked
// into an image of the ship at the atlas' resolution, redone only when the design (version) or the toggles change;
// panning and zooming just redraw it. While parts are carried the ship's bake is kept as it was (re-baking a ship
// takes a while): the spots moved parts left are washed out, and the parts in hand get a small bake of their own,
// keyed without the drag offset, so moving them only moves it. The drop re-bakes the ship once.
const newCanvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });
const shading = () => colour;
const carrying = () => !!held && (mode === 'drag' || mode === 'carry');
const bakes = { still: { key: '', bake: null, version: -1 }, held: { key: '', bake: null } };
/** What a bake depends on: the options and the drawn sprites (shifted back by `shift`). */
const bakeKey = (view, opts, shift = [0, 0]) => `${opts.lighting},${opts.shadows},${!!opts.grade};` + drawList(view).map((d) =>
  `${d.sprite.name},${(d.x - shift[0]).toFixed(5)},${(d.y - shift[1]).toFixed(5)},${d.angle},${d.sx},${d.sy},${d.z},${d.frame},${d.alpha}`).join(';');
/** bakeShaded(view), redone only when its key changes. */
function bakeCached(slot, view, opts, shift = [0, 0]) {
  const key = bakeKey(view, opts, shift);
  const c = bakes[slot];
  if (key !== c.key) {
    c.key = key;
    c.bake = bakeShaded(view, atlas, newCanvas, opts);
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
const frozen = () => carrying() && !!bakes.still.bake && bakes.still.version === held.version;
/** Bring the colour bake of the design (the stage's, bakes.still) up to date; not while parts are carried. */
function refreshStill() {
  const S = bakes.still;
  if (carrying() || S.version === version) return;
  bakeCached('still', model.view(), SHADING);
  S.version = version;
}
/** `view`: the whole design, or only the parts in hand while frozen. */
function paintShaded(view) {
  const opts = SHADING;
  // Antenna mast segments (p<uid>a<k>) belong to their antenna.
  const inHand = new Set(carrying() ? held.group.map((p) => `p${p.uid}`) : []);
  const isHeld = (b) => inHand.has(b.raw.m_id.replace(/a\d+$/, ''));
  const S = bakes.still;
  if (!frozen() && S.version !== version) {
    bakeCached('still', { ...view, bodies: view.bodies.filter((b) => !isHeld(b)) }, opts);
    S.version = version;
  }
  drawBake(S.bake);
  if (frozen() && held.ghost.length) {
    ctx.fillStyle = rgba(BLUEPRINT.paper, 0.7);
    for (const poly of held.ghost) { tracePoly(poly); ctx.fill(); }
  }
  if (inHand.size) drawBake(bakeCached('held', { ...view, bodies: view.bodies.filter(isHeld) }, opts, held.offset));
}

function paint() {
  // The tray shows as a bin while parts are being moved (not while a thumbnail is only pressed).
  const moving = carrying();
  footer.classList.toggle('holding', moving);
  if (!moving) footer.classList.remove('over');
  const w = canvas.width, h = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawGraphPaper(ctx, 0, 0, w, h, {
    cell: GRID * cam.scale, originX: cam.ox, originY: cam.oy,
    texture: paper,
  });
  // Design origin marker (the bridge's home).
  ctx.strokeStyle = rgba(INK, 0.25);
  ctx.lineWidth = dpr;
  ctx.beginPath();
  ctx.arc(cam.ox, cam.oy, 4 * dpr, 0, Math.PI * 2);
  ctx.stroke();

  if (shading()) paintShaded(frozen() ? model.view(held.group) : model.view());
  else {
    const view = model.view();
    renderShip(ctx, view, atlasNow(), {
      scale: cam.scale, x: cam.ox, y: cam.oy, partScale: PART_SCALE, wireColor: wireColor(),
    });
  }

  const lw = Math.max(1, dpr * 1.2);
  // Parts breaking a rule.
  if (!held) {
    for (const [p] of problems) {
      tracePoly(p.polygon());
      ctx.fillStyle = rgba(WARN, 0.18); ctx.fill();
      ctx.strokeStyle = rgba(WARN, 0.9); ctx.lineWidth = lw; ctx.stroke();
    }
  }
  // Hover and selection.
  if (hover && !held && mode === 'idle') {
    tracePoly(hover.polygon());
    ctx.strokeStyle = rgba(INK, 0.7); ctx.lineWidth = lw; ctx.stroke();
  }
  for (const p of selection) {
    tracePoly(p.polygon());
    ctx.fillStyle = rgba(SELECT, 0.12); ctx.fill();
    ctx.strokeStyle = rgba(SELECT, 0.95); ctx.lineWidth = lw * 1.5; ctx.stroke();
  }
  // The held group: slot hints, then the parts tinted by whether they can go here.
  if (held) {
    ctx.fillStyle = rgba(GOOD, 0.55);
    for (const s of held.freeSlots) {
      ctx.beginPath();
      ctx.arc(cam.ox + s.x * cam.scale, cam.oy + s.y * cam.scale, Math.max(2.5 * dpr, cam.scale * 0.25), 0, Math.PI * 2);
      ctx.fill();
    }
    // Green: fits; amber: allowed but a module isn't on a slot (parked); red: overlaps, can't drop.
    const c = !held.valid ? WARN : held.attached ? GOOD : PARKED;
    for (const p of held.group) {
      tracePoly(p.polygon());
      ctx.fillStyle = rgba(c, 0.2); ctx.fill();
      ctx.strokeStyle = rgba(c, 0.95); ctx.lineWidth = lw * 1.5; ctx.stroke();
    }
  }
  if (box) {
    ctx.setLineDash([5 * dpr, 4 * dpr]);
    ctx.strokeStyle = rgba(INK, 0.9); ctx.lineWidth = lw;
    ctx.fillStyle = rgba(INK, 0.06);
    const x = Math.min(box.x0, box.x1), y = Math.min(box.y0, box.y1);
    ctx.fillRect(x, y, Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0));
    ctx.strokeRect(x, y, Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0));
    ctx.setLineDash([]);
  }
}

function resize() {
  dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
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
function clampCamera() {
  const inHand = new Set(held?.group ?? []);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of model.parts) {
    if (inHand.has(p)) continue;
    const b = p.bounds();
    x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
  }
  if (x0 === Infinity) return;
  const clamp = (o, lo, hi, size) => {
    // Screen extent of the ship is o + lo*scale .. o + hi*scale; keep `keep` px of it inside 0..size.
    const keep = Math.min(KEEP_VISIBLE * dpr, (hi - lo) * cam.scale);
    return Math.min(Math.max(o, keep - hi * cam.scale), size - keep - lo * cam.scale);
  };
  cam.ox = clamp(cam.ox, x0, x1, canvas.width);
  cam.oy = clamp(cam.oy, y0, y1, canvas.height);
}

/** Zoom and pan so the whole design fits (F). */
function fit() {
  resize();
  const b = model.parts.length ? shipRenderBounds(model.view()) : { x0: -10, y0: -10, x1: 10, y1: 10, w: 20, h: 20 };
  const w = Math.max(b.w, 20 * GRID), h = Math.max(b.h, 12 * GRID);
  cam.scale = Math.max(2 * dpr, Math.min(MAX_ZOOM * dpr, 0.8 * Math.min(canvas.width / w, canvas.height / h)));
  cam.ox = canvas.width / 2 - ((b.x0 + b.x1) / 2) * cam.scale;
  cam.oy = canvas.height / 2 - ((b.y0 + b.y1) / 2) * cam.scale;
  draw();
}

let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---- pointer input -------------------------------------------------------------------------------------
function updatePointer(e) {
  const r = canvas.getBoundingClientRect();
  pointer.x = (e.clientX - r.left) * dpr;
  pointer.y = (e.clientY - r.top) * dpr;
  pointer.overCanvas = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  [pointer.wx, pointer.wy] = toWorld(pointer.x, pointer.y);
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// A second button pressed while one is down doesn't fire pointerdown, but does fire mousedown.
window.addEventListener('mousedown', (e) => {
  if ((e.buttons & 3) === 3 && (pointer.overCanvas || held)) { e.preventDefault(); chordDelete(); }
});

canvas.addEventListener('pointerdown', (e) => {
  updatePointer(e);
  if (e.button === 2 || e.button === 1) {
    mode = mode === 'idle' ? 'pan' : mode;
    pan = { x: pointer.x, y: pointer.y, prevMode: mode };
    canvas.classList.add('panning');
    return;
  }
  if (e.button !== 0) return;
  if (mode === 'carry') return drop(e.shiftKey);
  if (mode !== 'idle') return;
  const part = partAt(pointer.wx, pointer.wy);
  if (e.shiftKey) {
    if (part) {
      if (selection.has(part)) selection.delete(part); else selectWithHosts([part]);
      draw();
    } else {
      mode = 'box';
      box = { x0: pointer.x, y0: pointer.y, x1: pointer.x, y1: pointer.y, add: true };
    }
    return;
  }
  if (part) {
    press = { cx: e.clientX, cy: e.clientY, part };
    mode = 'press';
  } else {
    selectionBeforeBox = new Set(selection);
    selection.clear();
    mode = 'box';
    box = { x0: pointer.x, y0: pointer.y, x1: pointer.x, y1: pointer.y, add: false };
    draw();
  }
});

let pan = null;
window.addEventListener('pointermove', (e) => {
  const px = pointer.x, py = pointer.y;
  updatePointer(e);
  if (pan) {
    cam.ox += pointer.x - px; cam.oy += pointer.y - py;
    clampCamera();
    [pointer.wx, pointer.wy] = toWorld(pointer.x, pointer.y);
    if (held) follow(); else draw();
    return;
  }
  if (mode === 'press' || mode === 'tray-press') {
    const start = mode === 'press' ? press : trayPress;
    if (Math.hypot(e.clientX - start.cx, e.clientY - start.cy) > 5) {
      if (mode === 'press') {
        const parts = selection.has(press.part) ? [...selection] : [press.part];
        if (!selection.has(press.part)) selection.clear();
        hold(parts, press.part, false, 'drag');
      } else {
        mode = 'drag';
        follow();
      }
    }
    return;
  }
  if (mode === 'drag' || mode === 'carry') {
    footer.classList.toggle('over', overFooter(e));
    return follow();
  }
  if (mode === 'box') {
    box.x1 = pointer.x; box.y1 = pointer.y;
    return draw();
  }
  if (mode === 'idle' && pointer.overCanvas) {
    const h = partAt(pointer.wx, pointer.wy);
    if (h !== hover) { hover = h; draw(); }
  }
});

window.addEventListener('pointerup', (e) => {
  updatePointer(e);
  if (pan && (e.button === 2 || e.button === 1)) {
    if (mode === 'pan') mode = 'idle';
    pan = null;
    canvas.classList.remove('panning');
    return;
  }
  if (e.button !== 0) return;
  if (mode === 'press') {
    // A click: pick the part (or the selection it belongs to) up; the next click puts it down.
    const parts = selection.has(press.part) ? [...selection] : [press.part];
    if (!selection.has(press.part)) selection.clear();
    hold(parts, press.part, false, 'carry');
  } else if (mode === 'tray-press') {
    mode = 'carry';
    follow();
  } else if (mode === 'drag') {
    if (overFooter(e)) return deleteHeld();
    if (held?.isNew && !pointer.overCanvas) return cancelHold();
    drop(e.shiftKey);
  } else if (mode === 'box') {
    const [ax, ay] = toWorld(Math.min(box.x0, box.x1), Math.min(box.y0, box.y1));
    const [bx, by] = toWorld(Math.max(box.x0, box.x1), Math.max(box.y0, box.y1));
    if (!box.add) selection.clear();
    if (bx - ax > 1e-6 || by - ay > 1e-6) {
      selectWithHosts(model.parts.filter((p) => {
        const b = p.bounds();
        return b.x0 < bx && b.x1 > ax && b.y0 < by && b.y1 > ay;
      }));
    }
    box = null;
    mode = 'idle';
    draw();
  }
});

// Shift+wheel turns parts: one quarter turn per notch (clockwise when scrolling down), rate-limited so
// touchpads don't spin them.
let wheelTurn = 0, wheelTurnAt = 0;
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  updatePointer(e);
  if (e.shiftKey) {
    const d = e.deltaY || e.deltaX;   // some browsers turn shift+wheel into horizontal scroll
    wheelTurn += d * (e.deltaMode === 1 ? 33 : 1);
    const now = performance.now();
    if (Math.abs(wheelTurn) >= 50 && now - wheelTurnAt > 120) {
      rotate(wheelTurn > 0 ? 1 : -1);
      wheelTurn = 0;
      wheelTurnAt = now;
    }
    return;
  }
  const k = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
  const scale = Math.max(1.5 * dpr, Math.min(MAX_ZOOM * dpr, cam.scale * k));
  cam.ox = pointer.x - (pointer.x - cam.ox) * (scale / cam.scale);
  cam.oy = pointer.y - (pointer.y - cam.oy) * (scale / cam.scale);
  cam.scale = scale;
  clampCamera();
  [pointer.wx, pointer.wy] = toWorld(pointer.x, pointer.y);
  if (held) follow(); else draw();
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type === 'text') return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); return undo(); }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (PAN_KEYS[k]) { e.preventDefault(); panKeys.add(k); return startKeyPan(); }
  if (k === 'r') { e.preventDefault(); rotate(); }
  else if (k === 'delete' || k === 'backspace') { e.preventDefault(); if (e.shiftKey) pruneUnconnected(); else removeSelection(); }
  else if (k === 'escape') { if (held) cancelHold(); else { selection.clear(); draw(); } }
  else if (k === 'f') fit();
});
window.addEventListener('keyup', (e) => panKeys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => panKeys.clear());

// WASD pans the view (moves the camera that way) while held.
const PAN_KEYS = { w: [0, 1], a: [1, 0], s: [0, -1], d: [-1, 0] };
const PAN_SPEED = 910;   // css px per second
const panKeys = new Set();
let panLast = 0;
function startKeyPan() {
  if (panLast) return;
  panLast = performance.now();
  const step = (now) => {
    if (!panKeys.size) { panLast = 0; return; }
    const dt = Math.min(0.05, (now - panLast) / 1000);
    panLast = now;
    for (const k of panKeys) {
      cam.ox += PAN_KEYS[k][0] * PAN_SPEED * dpr * dt;
      cam.oy += PAN_KEYS[k][1] * PAN_SPEED * dpr * dt;
    }
    clampCamera();
    [pointer.wx, pointer.wy] = toWorld(pointer.x, pointer.y);
    if (held) follow(); else draw();
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---- parts tray ------------------------------------------------------------------------------------------
const C = CATEGORY;
const GROUPS = [
  ['Hull', C.HULL | C.BRIDGE | C.DECK],
  ['Armor', C.ARMOR],
  ['Weapons', C.GUN | C.BOMB],
  ['Missiles', C.MISSILE | C.NUKE],
  ['Propulsion', C.ENGINE | C.LEG],
  ['Systems', C.FUEL | C.AMMO | C.FSS | C.EVAC | C.SYSTEM | C.FLARES | C.KAZ],
  ['Sensors', C.SENSOR | C.IRST | C.JAMMER],
];
const EXTRA_GROUP = { MDL_WHEEL_01: 'Propulsion', MDL_ANTENNA_01: 'Sensors', MDL_LRRADIO_01: 'Sensors' };
const partName = (oid) => {
  const n = STRINGS.en[oid];
  return n && n !== '-' ? n : oid.replace(/^MDL_/, '').replace(/_/g, ' ').toLowerCase();
};
// Library items: { key, oid, raw (template), name }. Most are a module's own template; the filled 2x2 hulls
// (the art a generator or quarters gives them) follow their plain hull as items of their own.
const FILLED = { MDL_FERMA2X2_01: 'FILLED HULL' };
// Parts left out of the library (they can still be opened in a design).
const NOT_IN_TRAY = new Set(['MDL_CANNON_HARPOON', 'MDL_TORPEDO_300', 'MDL_CANNON_04', 'MDL_MISSILE_CLUSTER_SFW_01', 'MDL_FCR_03']);
const trayGroups = new Map([...GROUPS.map(([g]) => [g, []]), ['Other', []]]);
for (const oid of Object.keys(PART_TEMPLATES)) {
  if (PART_TEMPLATES[oid].noTray || NOT_IN_TRAY.has(oid)) continue;
  const cat = MODULES[oid]?.category ?? 0;
  // Reinforced hull goes with the armor.
  const g = EXTRA_GROUP[oid] ?? (oid.startsWith('MDL_HARD') ? 'Armor' : GROUPS.find(([, bits]) => cat & bits)?.[0] ?? 'Other');
  if (g === 'Other') continue;   // the tab stays, empty for now
  trayGroups.get(g).push({ key: oid, oid, raw: PART_TEMPLATES[oid], name: partName(oid) });
  if (FILLED[oid]) trayGroups.get(g).push({ key: `${oid}:filled`, oid, raw: filledHull(PART_TEMPLATES[oid]), name: FILLED[oid] });
}

let tab = 'Hull';
const thumbs = [];
function buildTray() {
  const tabs = $('tabs');
  tabs.replaceChildren(trayBar, ...[...trayGroups.keys()].map((g) => {
    const b = document.createElement('button');
    b.textContent = g;
    b.className = g === tab ? 'active' : '';
    b.onclick = () => { tab = g; setCollapsed(false); buildTray(); };
    return b;
  }));
  thumbs.length = 0;
  $('tray').replaceChildren(...trayGroups.get(tab).map((item) => {
    const el = document.createElement('div');
    el.className = 'part';
    el.title = `${item.name}\n${item.oid}`;
    const c = document.createElement('canvas');
    const label = document.createElement('span');
    label.textContent = item.name;
    el.append(c, label);
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (held) return deleteHeld();   // putting a part back in the library deletes it
      updatePointer(e);
      const p = new BuildPart(item.oid, pointer.wx, pointer.wy, 0, item.raw);
      trayPress = { cx: e.clientX, cy: e.clientY };
      selection.clear();
      hold([p], p, true, 'tray-press');
    });
    thumbs.push([c, item]);
    return el;
  }));
  layoutTray();
  drawThumbs();
}

// One row if every tab's parts fit in one across the tray, else two for all of them (so the library keeps its
// height from tab to tab); each row reads left to right.
const TILE = 96, TILE_GAP = 6, TRAY_PAD = 10;
const longestTab = Math.max(...[...trayGroups.values()].map((g) => g.length));
function layoutTray() {
  const tray = $('tray');
  if (!tray.clientWidth) return;   // folded
  const rows = longestTab * TILE + (longestTab - 1) * TILE_GAP <= tray.clientWidth - 2 * TRAY_PAD ? 1 : 2;
  tray.style.gridTemplateRows = `repeat(${rows}, 110px)`;
  tray.style.gridTemplateColumns = `repeat(${Math.ceil(trayGroups.get(tab).length / rows)}, ${TILE}px)`;
}
new ResizeObserver(layoutTray).observe(document.querySelector('footer'));
let trayPress = null;

// The parts tray folds down to its tab row (remembered per browser): the row's label, or a click on the row
// outside the tabs, folds it; picking a tab opens it.
const trayBar = $('tray-bar');
const toggleTray = () => setCollapsed(!document.querySelector('footer').classList.contains('collapsed'));
trayBar.onclick = toggleTray;
$('tabs').addEventListener('click', (e) => { if (e.target === e.currentTarget) toggleTray(); });
function setCollapsed(on) {
  document.querySelector('footer').classList.toggle('collapsed', on);
  trayBar.textContent = `${on ? '▴' : '▾'} library`;
  trayBar.title = on ? 'Show the library' : 'Hide the library';
  try { localStorage.setItem('shipbuilder.trayCollapsed', on ? '1' : ''); } catch { /* storage may be off */ }
}
try { setCollapsed(localStorage.getItem('shipbuilder.trayCollapsed') === '1'); } catch { setCollapsed(false); }
const footer = document.querySelector('footer');
const overFooter = (e) => {
  const r = footer.getBoundingClientRect();
  return e.clientY >= r.top && e.clientY <= r.bottom && e.clientX >= r.left && e.clientX <= r.right;
};
footer.addEventListener('pointerdown', (e) => {
  if (e.button === 0 && held && mode === 'carry') { e.preventDefault(); deleteHeld(); }
});

// Small modules drawn at the block scale (as big as a 1x1 hull) rather than filling their box.
const TRUE_SIZE = new Set(['MDL_MISSILE_03', 'MDL_EVAC', 'MDL_KAZ', 'MDL_TORPEDO_300', 'MDL_FLARES']);
// In colour, thumbnails are shaded like the ship: one bake per part (made on first show, then reused).
const thumbBakes = new Map();
/** Draw a part's view at `scale` px per metre with the design origin at (x, y), in the current look. */
function drawThumb(g, key, view, scale, x, y) {
  if (!colour) return renderShip(g, view, atlasNow(), { scale, x, y, wireColor: wireColor() });
  if (!thumbBakes.has(key)) thumbBakes.set(key, bakeShaded(view, atlas, newCanvas, SHADING));
  const b = thumbBakes.get(key);
  if (!b) return;
  const k = scale / b.scale;
  g.imageSmoothingEnabled = true;
  g.drawImage(b.canvas, x + b.x0 * scale, y + b.y0 * scale, b.canvas.width * k, b.canvas.height * k);
}
function drawThumbs() {
  const k = window.devicePixelRatio || 1;
  for (const [c, item] of thumbs) {
    const { oid, key } = item;
    c.width = 90 * k; c.height = 88 * k;
    const g = c.getContext('2d');
    const part = new BuildPart(oid, 0, 0, 0, item.raw);
    const view = new BuildModel({ parts: [part] }).view();
    const f = part.bounds(), fw = (f.x1 - f.x0) / GRID, fh = (f.y1 - f.y0) / GRID;
    const blocks = TRUE_SIZE.has(oid) || (!part.mounted && [fw, fh].every((v) => v > 0.5 && Math.abs(v - Math.round(v)) < 0.25));
    g.clearRect(0, 0, c.width, c.height);
    if (blocks) {
      // Grid-sized structure (hull, armor...) is sized by its block footprint so blocks compare: a 2x2
      // fills the box, a 1x1 half of it. So are TRUE_SIZE modules.
      const s = (0.82 * Math.min(c.width, c.height)) / (GRID * Math.max(2, Math.round(fw), Math.round(fh)));
      const cx = (f.x0 + f.x1) / 2, cy = (f.y0 + f.y1) / 2;
      drawThumb(g, key, view, s, c.width / 2 - cx * s, c.height / 2 - cy * s);
      continue;
    }
    // Anything else fills its box. Sprite rects have uneven transparent margins, so fit to the drawn pixels.
    const b = shipRenderBounds(view);
    const s0 = Math.min(c.width / (b.w || 1), c.height / (b.h || 1));
    drawThumb(g, key, view, s0, -b.x0 * s0, -b.y0 * s0);
    const px = g.getImageData(0, 0, c.width, c.height).data;
    let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        if (px[(y * c.width + x) * 4 + 3] < 16) continue;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) continue;
    const k2 = Math.min((c.width - 2 * k) / (x1 - x0 + 1), (c.height - 2 * k) / (y1 - y0 + 1));
    const s = s0 * k2;
    // Content centre in design units, then centre it in the box.
    const mx = b.x0 + (x0 + x1 + 1) / 2 / s0, my = b.y0 + (y0 + y1 + 1) / 2 / s0;
    g.clearRect(0, 0, c.width, c.height);
    drawThumb(g, key, view, s, c.width / 2 - mx * s, c.height / 2 - my * s);
  }
}

// ---- header controls --------------------------------------------------------------------------------------
$('name').addEventListener('input', (e) => {
  model.name = e.target.value.trim() || 'New ship';
  edited = true;
  if (current) drawSidePanels(current.ship, current.stats);
});
$('flagship').onclick = () => {
  model.flagship = !model.flagship;
  edited = true;
  $('flagship').setAttribute('aria-pressed', model.flagship);
  if (current) drawSidePanels(current.ship, current.stats);
};
/** Whether the current design can be replaced: unedited, or the user says so. */
const mayDiscard = (what) => !edited || model.parts.length <= 1 || confirm(`${what} Unsaved changes are lost.`);
$('new').onclick = () => {
  if (!mayDiscard('Start a new design?')) return;
  setModel(BuildModel.blank('New ship'));
  loadedId = null;
};
// Stat card images (PNG, JPEG, WebP) are opened for the design they carry.
const IMAGE_MAGIC = [[0x89, 0x50, 0x4e, 0x47], [0xff, 0xd8, 0xff], [0x52, 0x49, 0x46, 0x46]];
const isImage = (b) => IMAGE_MAGIC.some((m) => m.every((v, i) => b[i] === v));
async function imagePixels(bytes) {
  const img = await createImageBitmap(new Blob([bytes]));
  const c = newCanvas(img.width, img.height), g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  return g.getImageData(0, 0, c.width, c.height);
}
async function open(buffer, name) {
  try {
    const bytes = new Uint8Array(buffer);
    if (!isImage(bytes)) setModel(BuildModel.fromSeria(buffer));
    else {
      const got = await designFromCard(bytes, () => imagePixels(bytes));
      if (!got) return toast(`Unable to read ${name}; try with a higher resolution.`);
      setModel(got.model);
    }
    loadedId = null;
  } catch (err) {
    toast(`Couldn't open ${name}: ${err.message}.`);
  }
}
$('file').onchange = async (e) => {
  const f = e.target.files[0];
  if (f) open(await f.arrayBuffer(), f.name);
  e.target.value = '';
};

// ---- the ship list: designs saved in this browser, in folders ------------------------------------------------
// IndexedDB (a .seria is a few hundred KB, too big for localStorage's few MB). Stores: ships (the list: id, name,
// folder, parts, flagship, saved), serias (each saved design's .seria by id, read only to load it) and folders
// (name, order). A name is unique within its folder. The game's own designs (npm run designs: assets/designs/)
// are listed in a Highfleet folder; their .seria is fetched from `url` when needed. Highfleet
// can't be changed: not renamed, deleted or merged, nothing put in or taken out (a design dragged out of it is
// copied), and a design loaded from it is saved to Saved; it can be duplicated into an ordinary folder.
const SAVED = 'Saved', HIGHFLEET = 'Highfleet';
const readOnly = (folder) => folder === HIGHFLEET;
const DESIGNS = './assets/designs/';
let loadedId = null;                // the saved design the current one was loaded from or saved as
let shipsDb = null;
function openShips() {
  return shipsDb ??= new Promise((ok, err) => {
    const req = indexedDB.open('shipbuilder', 4);
    req.onupgradeneeded = (e) => {
      const db = req.result, tx = req.transaction, old = e.oldVersion;
      const create = () => {
        db.createObjectStore('ships', { keyPath: 'id', autoIncrement: true });
        db.createObjectStore('serias', { keyPath: 'id' });
      };
      if (old < 2) db.createObjectStore('folders', { keyPath: 'name' });
      const folders = tx.objectStore('folders');
      folders.delete('SAVED');
      folders.delete('EXAMPLES');
      folders.put({ name: SAVED, order: 0 });
      folders.put({ name: HIGHFLEET, order: 1 });
      try { localStorage.removeItem('shipbuilder.designsListed'); } catch { /* storage may be off */ }   // (versions 2, 3)
      if (!old) return create();
      // Up to version 3 designs were keyed by name (unique across folders; version 1 kept the .seria in the record,
      // and had no folders). SAVED is now Saved; EXAMPLES (Borey and Voskhod, copied in) gave way to Highfleet, the
      // copies going and anything saved into it moving to Saved.
      tx.objectStore('ships').getAll().onsuccess = (a) => {
        const list = a.target.result;
        const rebuild = (serias) => {
          db.deleteObjectStore('ships');
          if (old >= 2) db.deleteObjectStore('serias');
          create();
          const ships = tx.objectStore('ships'), store = tx.objectStore('serias');
          for (const { seria, ...ship } of list) {
            if (ship.saved === 0 && !ship.url) continue;
            if (!ship.folder || ship.folder === 'SAVED' || ship.folder === 'EXAMPLES') ship.folder = SAVED;
            const data = seria ?? serias.get(ship.name);
            ships.add(ship).onsuccess = (ev) => { if (data) store.put({ id: ev.target.result, seria: data }); };
          }
        };
        if (old < 2) rebuild(new Map());
        else tx.objectStore('serias').getAll().onsuccess = (b) => rebuild(new Map(b.target.result.map((r) => [r.name, r.seria])));
      };
    };
    req.onsuccess = () => ok(listGameDesigns(req.result));
    req.onerror = () => err(req.error);
  });
}
/** Any of the game's designs missing from the Highfleet folder into it (on every visit: it can't be changed). */
async function listGameDesigns(db) {
  try {
    const index = await (await fetch(`${DESIGNS}index.json`)).json();
    const tx = db.transaction(['ships'], 'readwrite'), ships = tx.objectStore('ships');
    const listed = namesIn(await done(ships.getAll()), HIGHFLEET);
    for (const d of index) {
      if (!listed.has(d.name)) ships.add({ name: d.name, folder: HIGHFLEET, parts: d.parts, flagship: d.flagship, saved: 0, url: DESIGNS + encodeURIComponent(d.file) });
    }
    await finished(tx);
  } catch { /* not extracted here */ }
  return db;
}
/** A listed design's .seria: saved in the browser, or the game's. */
async function seriaOf(ship) {
  const { serias } = await shipTx(['serias']);
  const got = await done(serias.get(ship.id));
  if (got) return got.seria;
  if (!ship.url) throw new Error('its design is missing');
  const res = await fetch(ship.url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}
const done = (req) => new Promise((ok, err) => { req.onsuccess = () => ok(req.result); req.onerror = () => err(req.error); });
const finished = (tx) => new Promise((ok, err) => { tx.oncomplete = () => ok(); tx.onerror = tx.onabort = () => err(tx.error); });
/** A transaction over `stores` (names): its stores by name, and its completion. */
async function shipTx(stores, write = false) {
  const tx = (await openShips()).transaction(stores, write ? 'readwrite' : 'readonly');
  return { ...Object.fromEntries(stores.map((s) => [s, tx.objectStore(s)])), done: finished(tx) };
}
/** The folders in order, each with its designs (newest first; the game's by name). */
async function shipFolders() {
  const { ships, folders } = await shipTx(['ships', 'folders']);
  const [all, dirs] = await Promise.all([done(ships.getAll()), done(folders.getAll())]);
  const byName = new Map(dirs.sort((a, b) => a.order - b.order).map((f) => [f.name, []]));
  for (const s of all) {
    if (!byName.has(s.folder)) byName.set(s.folder, []);
    byName.get(s.folder).push(s);
  }
  for (const list of byName.values()) list.sort((a, b) => b.saved - a.saved || a.name.localeCompare(b.name));
  return [...byName].map(([name, ships]) => ({ name, ships }));
}
const namesIn = (ships, folder) => new Set(ships.filter((s) => s.folder === folder).map((s) => s.name));
/** `name`, or with a number after it if `taken` has it already. */
function freeName(name, taken) {
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name} (${i})`)) return `${name} (${i})`;
}
/** Copy designs (their .seria too, if saved) into `folder`, under `names` (one each). In an open transaction `t`. */
async function copyShips(t, ships, folder, names) {
  for (const [i, { id, ...ship }] of ships.entries()) {
    const copy = await done(t.ships.add({ ...ship, folder, name: names[i] }));
    const got = await done(t.serias.get(id));
    if (got) t.serias.put({ id: copy, seria: got.seria });
  }
}

async function saveShip() {
  const name = model.name;
  try {
    const { ships } = await shipTx(['ships']);
    const all = await done(ships.getAll());
    const from = all.find((s) => s.id === loadedId);
    const folder = from && !readOnly(from.folder) ? from.folder : SAVED;
    const same = all.find((s) => s.folder === folder && s.name === name);
    if (same && same.id !== loadedId && !confirm(`Replace "${name}" in ${folder}?`)) return;
    // The whole design, unconnected parts too: it's work in progress. Over the one it was loaded from (renamed, if
    // it was), unless another of the new name is replaced.
    const seria = model.toSeria();
    const target = same ?? (from?.folder === folder ? from : null);
    const t = await shipTx(['ships', 'serias', 'folders'], true);
    if (!await done(t.folders.get(folder))) t.folders.put({ name: folder, order: folder === SAVED ? 0 : Date.now() });
    const ship = { name, folder, parts: model.parts.length, flagship: model.flagship, saved: Date.now() };
    const id = await done(t.ships.put(target ? { ...ship, id: target.id } : ship));
    t.serias.put({ id, seria });
    await t.done;
    navigator.storage?.persist?.();   // ask the browser not to clear it to free space
    loadedId = id;
    edited = false;
    toast(`Saved ${name}${from && readOnly(from.folder) ? ` to ${folder}` : ''}.`);
  } catch (err) {
    toast(`Couldn't save ${name}: ${err.message}.`);
  }
}
$('save').onclick = saveShip;
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveShip(); }
});

async function loadShip(ship) {
  closeAllMenus();
  if (!mayDiscard(`Load ${ship.name}?`)) return;
  try {
    const m = BuildModel.fromSeria(await seriaOf(ship));
    m.name = ship.name;
    setModel(m);
    loadedId = ship.id;
  } catch (err) { toast(`Couldn't load ${ship.name}: ${err.message}.`); }
}
async function deleteShip(ship) {
  if (readOnly(ship.folder)) return;
  if (!confirm(`Delete the saved ship "${ship.name}"? This can't be undone.`)) return;
  try {
    const t = await shipTx(['ships', 'serias'], true);
    t.ships.delete(ship.id);
    t.serias.delete(ship.id);
    await t.done;
    if (loadedId === ship.id) loadedId = null;
    toast(`Deleted ${ship.name}.`);
  } catch (err) { toast(`Couldn't delete ${ship.name}: ${err.message}.`); }
  refreshShipList();
}
/** Move a design to another folder (copied, out of Highfleet); numbered if the folder has one of its name. */
async function moveShip(ship, folder) {
  if (ship.folder === folder) return;
  if (readOnly(folder)) return toast(`${folder} can't be changed.`);
  const copy = readOnly(ship.folder);
  try {
    const t = await shipTx(['ships', 'serias', 'folders'], true);
    if (!await done(t.folders.get(folder))) t.folders.put({ name: folder, order: Date.now() });
    const name = freeName(ship.name, namesIn(await done(t.ships.getAll()), folder));
    if (copy) await copyShips(t, [ship], folder, [name]);
    else t.ships.put({ ...ship, folder, name });
    await t.done;
    toast(`${copy ? 'Copied' : 'Moved'} ${ship.name} to ${folder}${name !== ship.name ? ` as ${name}` : ''}.`);
  } catch (err) { toast(`Couldn't move ${ship.name}: ${err.message}.`); }
  refreshShipList(folder);
}
/** A folder's designs into another (numbered where it has one of the same name); the folder goes. */
async function mergeFolders(from, into) {
  if (readOnly(from) || readOnly(into)) return;
  try {
    const t = await shipTx(['ships', 'folders'], true);
    const all = await done(t.ships.getAll()), taken = namesIn(all, into);
    for (const s of all.filter((s) => s.folder === from)) {
      const name = freeName(s.name, taken);
      taken.add(name);
      t.ships.put({ ...s, folder: into, name });
    }
    t.folders.delete(from);
    await t.done;
    toast(`Merged ${from} into ${into}.`);
  } catch (err) { toast(`Couldn't merge ${from}: ${err.message}.`); }
  refreshShipList(into);
}
/** A copy of a folder and its designs: "<name> Copy". */
async function duplicateFolder({ name, ships }) {
  try {
    const t = await shipTx(['ships', 'serias', 'folders'], true);
    const to = freeName(`${name} Copy`, new Set((await done(t.folders.getAll())).map((f) => f.name)));
    t.folders.put({ name: to, order: Date.now() });
    await copyShips(t, ships, to, ships.map((s) => s.name));
    await t.done;
    toast(`Duplicated ${name} as ${to}.`);
    refreshShipList(to);
  } catch (err) { toast(`Couldn't duplicate ${name}: ${err.message}.`); }
}
async function renameFolder(from, to) {
  if (readOnly(from)) return;
  try {
    const t = await shipTx(['ships', 'folders'], true);
    if (await done(t.folders.get(to))) return toast(`There's already a folder named ${to}.`);
    const folder = await done(t.folders.get(from));
    t.folders.delete(from);
    t.folders.put({ ...folder, name: to });
    for (const s of await done(t.ships.getAll())) if (s.folder === from) t.ships.put({ ...s, folder: to });
    await t.done;
    toast(`Renamed ${from} to ${to}.`);
  } catch (err) { toast(`Couldn't rename ${from}: ${err.message}.`); }
  refreshShipList(to);
}
async function deleteFolder({ name, ships }) {
  if (readOnly(name)) return;
  const n = ships.length;
  if (!confirm(`Delete the folder "${name}"${n ? ` and the ${n} design${n > 1 ? 's' : ''} in it` : ''}? This can't be undone.`)) return;
  try {
    const t = await shipTx(['ships', 'serias', 'folders'], true);
    for (const s of ships) { t.ships.delete(s.id); t.serias.delete(s.id); }
    t.folders.delete(name);
    await t.done;
    if (ships.some((s) => s.id === loadedId)) loadedId = null;
    toast(`Deleted ${name}.`);
  } catch (err) { toast(`Couldn't delete ${name}: ${err.message}.`); }
  refreshShipList();
}
async function newFolder(name) {
  try {
    const t = await shipTx(['folders'], true);
    if (!await done(t.folders.get(name))) t.folders.put({ name, order: Date.now() });
    await t.done;
  } catch (err) { toast(`Couldn't make ${name}: ${err.message}.`); }
  refreshShipList(name);
}
const folderName = (message, name = '') => prompt(message, name)?.trim() || null;

// ---- cascading menus: the Load menu (folders, their designs to the side) and right-click menus over it --------
// A stack of lists per menu; hovering an item with a submenu opens it to the side (after a moment if another is
// open, so the pointer can cross other items on its way there). Items can be dragged onto others.
const menus = { load: [], context: [] };
let hoverTimer = 0;
const dropTargets = new WeakMap();   // item element -> { accepts(data), onDrop(data) }
function closeMenus(stack, from = 0) {
  for (const m of menus[stack].splice(from)) {
    if (m.contains(previewing)) hideCardPreview();
    m.remove();
  }
  if (stack === 'load' && !menus.load.length) loadButton.setAttribute('aria-expanded', false);
}
function closeAllMenus() { closeMenus('context'); closeMenus('load'); hideCardPreview(); }
const inMenus = (el) => [...menus.load, ...menus.context].some((m) => m.contains(el));

/**
 * Show `items` as level `level` of a stack: at a point ({ x, y }) or beside an item (its element) of the level
 * below. Items: { label, meta, submenu: () => items, onClick, onDelete, onContext(event), drag: data,
 * accepts(data), onDrop(data), onHover(on, element), star: flagship } or { empty: text }.
 */
function showMenu(stack, level, items, at) {
  closeMenus(stack, level);
  const menu = document.createElement('div');
  menu.className = `menu ${stack}`;
  menu.addEventListener('pointerenter', () => clearTimeout(hoverTimer));
  menu.addEventListener('contextmenu', (e) => e.preventDefault());
  for (const it of items) menu.append(it.empty ? Object.assign(document.createElement('div'), { className: 'empty', textContent: it.empty }) : menuItem(it, stack, level));
  document.body.append(menu);
  menus[stack][level] = menu;
  const w = menu.offsetWidth, h = menu.offsetHeight;
  let x, y;
  if (at instanceof Element) {
    const r = at.getBoundingClientRect(), p = at.closest('.menu').getBoundingClientRect();
    x = p.right - 1 + w > innerWidth - 8 ? p.left + 1 - w : p.right - 1;
    y = r.top - 5;
  } else ({ x, y } = at);
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - 8 - w))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - 8 - h))}px`;
  return menu;
}
function menuItem(it, stack, level) {
  const row = document.createElement('div');
  row.className = 'row';
  const b = document.createElement('button');
  b.className = 'item';
  b.innerHTML = '<span class="label"></span><span class="meta"></span>';
  b.firstChild.textContent = it.label;
  if (it.star) b.firstChild.insertAdjacentHTML('beforeend', ' <span class="star" title="Flagship">★</span>');
  b.lastChild.textContent = it.meta ?? '';
  if (it.submenu) b.insertAdjacentHTML('beforeend', '<span class="arrow">▸</span>');
  row.append(b);
  const open = () => {
    for (const o of row.parentNode.querySelectorAll('.item.open')) o.classList.remove('open');
    if (!it.submenu) return closeMenus(stack, level + 1);
    b.classList.add('open');
    showMenu(stack, level + 1, it.submenu(), b);
  };
  b.addEventListener('pointerenter', () => {
    clearTimeout(hoverTimer);
    // Off to another item: a right-click menu from this stack goes (it would end up under the new submenu).
    if (stack === 'load') closeMenus('context');
    if (menus[stack].length > level + 1) hoverTimer = setTimeout(open, 150);
    else open();
  });
  let dragged = false;
  b.onclick = () => {
    if (dragged) return void (dragged = false);
    it.onClick ? it.onClick() : open();
  };
  if (it.onContext) b.addEventListener('contextmenu', (e) => { open(); it.onContext(e); });
  if (it.onHover) {
    b.addEventListener('pointerenter', () => it.onHover(true, b));
    b.addEventListener('pointerleave', () => it.onHover(false, b));
  }
  if (it.onDrop) dropTargets.set(b, it);
  if (it.drag !== undefined) {
    // Dragged (past a few px): a label follows the pointer, and the item under it that takes it lights up.
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      let ghost = null, target = null;
      const move = (ev) => {
        if (!ghost) {
          if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 5) return;
          ghost = Object.assign(document.createElement('div'), { className: 'drag-ghost', textContent: it.label });
          document.body.append(ghost);
          hideCardPreview();
          b.setPointerCapture(e.pointerId);   // (no hovering other items open their submenus meanwhile)
        }
        ghost.style.left = `${ev.clientX + 12}px`;
        ghost.style.top = `${ev.clientY + 8}px`;
        const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.item');
        const d = over && dropTargets.get(over);
        const t = d && d.accepts?.(it.drag) !== false ? over : null;
        if (t !== target) { target?.classList.remove('drop'); t?.classList.add('drop'); target = t; }
      };
      const end = (ev) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        if (!ghost) return;
        ghost.remove();
        target?.classList.remove('drop');
        dragged = true;
        setTimeout(() => { dragged = false; }, 0);   // (the click that may follow the release)
        if (target && ev.type === 'pointerup') dropTargets.get(target).onDrop(it.drag);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    });
  }
  if (it.onDelete) {
    const del = Object.assign(document.createElement('button'), { className: 'delete', textContent: '×', title: `Delete ${it.label} from this browser` });
    del.onclick = it.onDelete;
    row.append(del);
  }
  return row;
}

// The Load menu: the folders; each one's designs to its side.
const loadButton = $('load');
async function openShipList(folder = null) {
  let folders;
  try { folders = await shipFolders(); } catch (err) {
    showMenu('load', 0, [{ empty: `Saved ships are unavailable: ${err.message}.` }], below(loadButton));
    return;
  }
  const others = (name) => folders.filter((f) => f.name !== name);
  const shipItem = (ship) => ({
    label: ship.name,
    star: ship.flagship,
    meta: `${ship.parts} parts`,
    onClick: () => loadShip(ship),
    onDelete: readOnly(ship.folder) ? null : () => deleteShip(ship),
    drag: ship,
    onHover: (on, item) => {
      if (on) return showCardPreview(ship, item);
      if (previewing === item) hideCardPreview();
      abortCard(ship);
    },
  });
  const items = folders.map((f) => ({
    label: f.name,
    meta: `${f.ships.length}`,
    submenu: () => (f.ships.length ? f.ships.map(shipItem) : [{ empty: 'No designs here yet.' }]),
    accepts: (ship) => ship.folder !== f.name && !readOnly(f.name),
    onDrop: (ship) => moveShip(ship, f.name),
    onContext: (e) => showMenu('context', 0, readOnly(f.name) ? [
      { label: 'Duplicate', onClick: () => { closeMenus('context'); duplicateFolder(f); } },
    ] : [
      { label: 'Rename…', onClick: () => { const n = folderName('Rename the folder:', f.name); if (n && n !== f.name) renameFolder(f.name, n); else closeMenus('context'); } },
      {
        label: 'Merge with…',
        submenu: () => {
          const into = others(f.name).filter((o) => !readOnly(o.name));
          return into.length ? into.map((o) => ({ label: o.name, onClick: () => mergeFolders(f.name, o.name) })) : [{ empty: 'No other folders.' }];
        },
      },
      { label: 'Delete', onClick: () => { closeMenus('context'); deleteFolder(f); } },
    ], { x: e.clientX, y: e.clientY }),
  }));
  // A new folder: clicked for an empty one, or with a design dropped on it.
  items.push({
    label: 'New folder…',
    onClick: () => { const n = folderName('New folder name:'); if (n) newFolder(n); },
    onDrop: (ship) => { const n = folderName(`New folder for ${ship.name}:`); if (n) moveShip(ship, n); },
  });
  const root = showMenu('load', 0, items, below(loadButton));
  loadButton.setAttribute('aria-expanded', true);
  const i = folders.findIndex((f) => f.name === folder);
  if (i >= 0) root.querySelectorAll('.item')[i].click();
  root.querySelector('.row:last-child .item').classList.add('new');
}
// Hovering a design shows its stat card beside the list: drawn a step at a time, and dropped if the pointer leaves
// first. Drawn once per saved version, then kept.
const previewCards = new Map();     // design id -> { saved, card: Promise<canvas | null>, done, aborted }
const preview = Object.assign(document.createElement('div'), { id: 'card-preview', hidden: true });
document.body.append(preview);
let previewing = null;
const nextTask = () => new Promise((ok) => setTimeout(ok, 0));
/** The card of a saved design, drawn a step at a time; null if it was aborted (see abortCard) first. */
function cardOfShip(ship) {
  const got = previewCards.get(ship.id);
  if (got?.saved === ship.saved && !got.aborted) return got.card;
  const entry = { saved: ship.saved, done: false, aborted: false };
  const cancelled = () => entry.aborted;
  entry.card = (async () => {
    const seria = await seriaOf(ship);
    await nextTask();
    if (cancelled()) return null;
    const m = BuildModel.fromSeria(seria);
    m.name = ship.name;
    await nextTask();
    if (cancelled()) return null;
    const { ship: placed } = connected(new Set(), m);
    const built = new Ship(placed.toTree()), stats = computeStats(built);
    await nextTask();
    if (cancelled()) return null;
    const pic = await bakeShadedAsync(placed.view(), atlas, newCanvas, SHADING, { cancelled });
    if (cancelled()) return null;
    const code = await encodeDesign({ name: m.name, flagship: m.flagship, parts: placed.parts });
    await nextTask();
    if (cancelled()) return null;
    const c = document.createElement('canvas');
    drawCard(c, { ship: built, stats }, code, pic, m);
    return c;
  })();
  entry.card.then((c) => { entry.done = true; if (!c && previewCards.get(ship.id) === entry) previewCards.delete(ship.id); },
    () => previewCards.delete(ship.id));
  previewCards.set(ship.id, entry);
  return entry.card;
}
/** Stop drawing a design's card, if it isn't done yet. */
function abortCard(ship) {
  const entry = previewCards.get(ship.id);
  if (!entry || entry.done) return;
  entry.aborted = true;
  previewCards.delete(ship.id);
}
/** Show a design's card beside the list, level with its item (once drawn; unless the pointer has left by then). */
function showCardPreview(ship, item) {
  previewing = item;
  cardOfShip(ship).then((c) => {
    if (previewing === item && c) placePreview(item, c);
  }, (err) => {
    if (previewing === item) placePreview(item, Object.assign(document.createElement('div'), { className: 'drawing', textContent: `Couldn't draw the card: ${err.message}.` }));
  });
}
function placePreview(item, content) {
  preview.replaceChildren(content);
  preview.hidden = false;
  const m = item.closest('.menu').getBoundingClientRect(), r = item.getBoundingClientRect();
  const w = preview.offsetWidth, h = preview.offsetHeight;
  const x = m.right + 6 + w > innerWidth - 8 ? m.left - 6 - w : m.right + 6;
  preview.style.left = `${Math.max(8, x)}px`;
  preview.style.top = `${Math.max(8, Math.min(r.top + r.height / 2 - h / 2, innerHeight - 8 - h))}px`;
}
function hideCardPreview() {
  previewing = null;
  preview.hidden = true;
  preview.replaceChildren();
}
window.addEventListener('pointerdown', (e) => { if (e.button === 0) hideCardPreview(); }, { capture: true });
window.addEventListener('wheel', hideCardPreview, { capture: true, passive: true });

const below = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.bottom + 4 }; };
/** After a change: the menus again, with `folder` (or the one that was open) opened. */
function refreshShipList(folder) {
  closeMenus('context');
  if (!menus.load.length) return;
  openShipList(folder ?? menus.load[0].querySelector('.item.open .label')?.textContent);
}
loadButton.onclick = () => (menus.load.length ? closeAllMenus() : openShipList());
document.addEventListener('pointerdown', (e) => {
  if (!inMenus(e.target) && !loadButton.contains(e.target)) closeAllMenus();
  else if (menus.context.length && !menus.context.some((m) => m.contains(e.target))) closeMenus('context');
}, { capture: true });
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !(menus.load.length || menus.context.length)) return;
  e.stopImmediatePropagation();
  closeMenus(menus.context.length ? 'context' : 'load');
}, { capture: true });
window.addEventListener('resize', closeAllMenus);
openShips().catch(() => {});   // the examples are ready by the time the list is opened


$('download').onclick = () => {
  const { ship, loose } = connected();
  const v = ship.validate();
  if (!v.ok && !confirm(`This design breaks some rules:\n\n${v.messages.join('\n')}\n\nDownload anyway?`)) return;
  const blob = new Blob([ship.toSeria()], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${model.name.replace(/[\\/:*?"<>|]/g, '_')}.seria`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  if (loose) toast(`Left out ${loose} unconnected part${loose > 1 ? 's' : ''}.`);
};
// One button flips between the looks; it names the one showing.
const modeButton = $('mode');
function showMode() {
  modeButton.textContent = colour ? '◐ Color' : '▦ Blueprint';
  modeButton.title = colour
    ? "The game's look: its sprites with lighting, shadows and colors. Click for the blueprint"
    : 'The blueprint: hand-drawn parts on graph paper. Click for the game\'s colors';
}
modeButton.disabled = !(contrastBlueprint || blueprint);
modeButton.onclick = () => {
  colour = !colour;
  try { localStorage.setItem('shipbuilder.mode', colour ? 'colour' : 'blueprint'); } catch { /* storage may be off */ }
  showMode();
  drawThumbs();
  draw();
  // In colour a card waiting for the input to go idle needn't wait any more.
  if (colour && idleTimer) { clearTimeout(idleTimer); idleTimer = 0; whenIdle(); }
};
showMode();

// Ctrl+V: a pasted image (a stat card, or a screenshot with one in it) opens the design it carries; pasted .seria
// text opens directly.
document.addEventListener('paste', async (e) => {
  if (e.target instanceof HTMLInputElement) return;   // typing a name
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.kind === 'file' && i.type.startsWith('image/'));
  if (item) {
    e.preventDefault();
    const f = item.getAsFile();
    return open(await f.arrayBuffer(), 'the pasted image');
  }
  const text = e.clipboardData?.getData('text/plain');
  if (text && /m_classname\s*=/.test(text)) { e.preventDefault(); open(new TextEncoder().encode(text).buffer, 'the pasted text'); }
});

const stage = $('stage');
document.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('dragover'); });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) stage.classList.remove('dragover'); });
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  stage.classList.remove('dragover');
  const f = e.dataTransfer.files[0];
  if (f) open(await f.arrayBuffer(), f.name);
});

// For poking at the page from the console (and the UI smoke test).
window.shipbuilder = {
  get model() { return model; }, get selection() { return selection; }, cam, bakes,
  toScreen: (x, y) => [(cam.ox + x * cam.scale) / dpr, (cam.oy + y * cam.scale) / dpr],
};

new ResizeObserver(() => resize()).observe(canvas);
buildTray();
const initial = new URLSearchParams(location.search).get('ship');
if (initial) open(await (await fetch(initial)).arrayBuffer(), initial);
else setModel(model);
