// Shipbuilder page: place parts on the block grid and download the design as a .seria.
// The rules, snapping and export live in src/builder.js; this file is input handling and drawing.
import {
  BuildModel, BuildPart, PART_TEMPLATES, BRIDGE, GRID, computeLinks, placement, snapOffset,
  rotateParts, rotationStep, turnPart, turnLegs, restAngle, dependents, renderShip, shipRenderBounds, drawGraphPaper, paperTexture, BLUEPRINT, PART_SCALE, PART_BACK,
  computeStats, MASS_CLASSES, PURPOSES, ROLES, Ship, bakeShaded, bakeShadedAsync, drawList, SHADING,
  FONTS, drawText, measureText, statLines, partsList, renderRuledList, ruledListLines, RULED, renderStatCard, statCardLines, CARD,
  encodeDesign, decodeDesign, deflate, designFromCard, filledHull,
} from './src/index.js';
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

// Paper texture (grain, fibres, formation) laid over the graph paper; a fainter one (another sheet) on the
// panels around it, as CSS background tiles.
const makeCanvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });
const paper = paperTexture(makeCanvas);
{
  const [formation, grain] = paperTexture(makeCanvas, { seed: 5, strength: 0.6 });
  document.documentElement.style.setProperty('--grain', `url(${grain.image.toDataURL()})`);
  document.documentElement.style.setProperty('--formation', `url(${formation.image.toDataURL()})`);
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
// The parts list's width: its longest line (NUCLEAR MISSILE CARRIER) and a little room (#parts-ruled's width).
const PARTS_W = 280;
const STATS_W = 394, STATS_PAD = 14, STATS_LINE = 21, STATS_FONT = 'dinpro_14_reg';   // the card's width
let current = null;                 // { ship, stats, placed } of the placed parts, from the last stats update
function drawSidePanels(ship, stats) {
  // Stats as label / value rows, in the ruled list's font; warnings in coral (the CSS --warn).
  const rows = statLines(stats).rows, sk = window.devicePixelRatio || 1;
  const valueX = STATS_PAD + Math.max(...rows.map((r) => measureText(STATS_FONT, r.label))) + 16;
  const sp = $('stats-panel'), sh = rows.length * STATS_LINE;
  sp.width = STATS_W * sk; sp.height = sh * sk;
  sp.style.width = `${STATS_W}px`; sp.style.height = `${sh}px`;
  const sg = sp.getContext('2d');
  sg.scale(sk, sk);
  rows.forEach((r, i) => {
    const c = r.red ? '#ff9d8f' : '#ecf4ff', y = i * STATS_LINE + 1;
    if (r.label) for (const [t, x] of [[r.label, STATS_PAD], [r.value, valueX]]) drawText(sg, STATS_FONT, t, x, y, c, { fonts });
  });

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

// A left click on the ship card folds it, like its title bar.
$('card-panel').addEventListener('click', () => $('card-bar').click());

// A click anywhere on the shortcuts folds them; scrolling over them still zooms.
$('help').addEventListener('click', (e) => { if (!$('help-bar').contains(e.target)) $('help-bar').click(); });
$('help').addEventListener('wheel', (e) => {
  e.preventDefault();
  canvas.dispatchEvent(new WheelEvent('wheel', e));
}, { passive: false });

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
  // Only what's under the pointer: a chord elsewhere leaves the selection be.
  const under = partAt(pointer.wx, pointer.wy);
  if (!under || !dependents(model.parts, [...selection]).includes(under)) return draw();
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

/**
 * Turn a group by `dir` steps (dir > 0: clockwise). A lone part turns by its own step (90, 45 or 15 degrees;
 * false if it doesn't turn), and so do legs, each chain about its top mount. Any other group turns by quarters
 * about (cx, cy), and its parts that don't turn on their own go back to their resting angle.
 */
function turnGroup(group, dir, cx, cy) {
  if (group.length === 1) return turnPart(group[0], dir);
  if (turnLegs(model.parts, group, dir)) return true;
  for (let i = 0; i < ((dir % 4) + 4) % 4; i++) rotateParts(group, cx, cy);
  for (const p of group) if (!rotationStep(p.oid)) p.angle = restAngle(p.oid);
  return true;
}

const allLegs = (group) => group.every((p) => p.joint === 'leg');

/** R / shift+wheel: turn the held group, or the selection, by `dir` steps (> 0 clockwise, < 0 anticlockwise). */
function rotate(dir = 1) {
  if (!dir) return;
  const fixed = (p) => toast(`${trayItem(p.oid).name} doesn't rotate.`);
  if (held) {
    const { primary } = held;
    const [px, py] = [primary.x, primary.y];
    if (!turnGroup(held.group, dir, primary.x, primary.y)) return fixed(primary);
    // Keep the current offset: the rotated positions become the new bases.
    for (const p of held.group) held.bases.set(p, [p.x - held.offset[0], p.y - held.offset[1]]);
    // Turning about the primary part leaves it (and so a multiselection's grab) in place; legs keep their
    // pivot where it is, and any other single part is re-centred on the cursor.
    if (allLegs(held.group)) held.grab = [held.grab[0] - (primary.x - px), held.grab[1] - (primary.y - py)];
    else if (held.single) held.grab = centerOffset(primary);
    held.freeSlots = freeSlotsFor(held);
    follow();
    return;
  }
  if (!selection.size) return toast('Select parts (or hold one) to rotate.');
  const group = dependents(model.parts, [...selection]);
  const before = new Map(group.map((p) => [p, { x: p.x, y: p.y, angle: p.angle }]));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of group) {
    const b = p.bounds();
    x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
  }
  snapshot();
  if (!turnGroup(group, dir, (x0 + x1) / 2, (y0 + y1) / 2)) { undoStack.pop(); return fixed(group[0]); }
  // Snap by the structure, or by the top of a leg chain.
  const { host } = computeLinks(model.parts);
  const primary = group.find((p) => !p.mounted) ?? group.find((p) => !group.includes(host.get(p))) ?? group[0];
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
      scale: cam.scale, x: cam.ox, y: cam.oy, partScale: PART_SCALE, lower: PART_BACK, wireColor: wireColor(),
    });
  }

  const lw = Math.max(1, dpr * 1.2);
  // Parts breaking a rule (being left unconnected doesn't count: that's just work in progress).
  if (!held) {
    for (const [p, msgs] of problems) {
      if (msgs.every((m) => m === 'not connected to the bridge')) continue;
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
  const t = $('toast'), g = $('gallery');
  (g.open ? g : $('stage')).append(t);   // over the gallery while it's open (a modal hides the page)
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

// The right (or middle) button pans from anywhere on the page, bar the menus (their own right-click menus), the
// ship card and the gallery (the browser's menu, to save a card), text fields and links; the browser's menu is kept for those.
const ownsRightClick = (el) => !!el.closest?.('.menu, #card-panel, #gallery, input, textarea, select, a');
window.addEventListener('contextmenu', (e) => { if (!ownsRightClick(e.target)) e.preventDefault(); });
window.addEventListener('pointerdown', (e) => {
  if ((e.button !== 2 && e.button !== 1) || ownsRightClick(e.target)) return;
  updatePointer(e);
  e.preventDefault();   // (no middle-button autoscroll)
  mode = mode === 'idle' ? 'pan' : mode;
  pan = { x: pointer.x, y: pointer.y, prevMode: mode };
  canvas.classList.add('panning');
});

// A second button pressed while one is down doesn't fire pointerdown, but does fire mousedown.
window.addEventListener('mousedown', (e) => {
  if ((e.buttons & 3) === 3 && (pointer.overCanvas || held)) { e.preventDefault(); chordDelete(); }
});

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;   // (right and middle: the page-wide pan above)
  updatePointer(e);
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

// Shift+wheel turns parts: one step per wheel notch (anticlockwise when scrolling down). A notch is the
// smallest wheel-sized delta seen so far, so an event that coalesces several notches turns several steps.
// Touchpads (small deltas) build up to a step, rate-limited so they don't spin parts.
let wheelTurn = 0, wheelTurnAt = 0, wheelNotch = Infinity;
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  updatePointer(e);
  if (e.shiftKey) {
    const d = (e.deltaY || e.deltaX) * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 800 : 1);   // shift+wheel may scroll horizontally
    if (Math.abs(d) >= 40) {
      wheelNotch = Math.min(wheelNotch, Math.abs(d));
      wheelTurn = 0;
      return rotate(-Math.sign(d) * Math.max(1, Math.round(Math.abs(d) / wheelNotch)));
    }
    wheelTurn += d;
    const now = performance.now();
    if (Math.abs(wheelTurn) >= 50 && now - wheelTurnAt > 120) {
      rotate(wheelTurn > 0 ? -1 : 1);
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
  // Fold or open the stats (T), the parts list (P) and the library (L), as their bars do; on All too.
  else if (k === 't' && !e.repeat) $('side-stats').querySelector(':scope > .fold-bar').click();
  else if (k === 'p' && !e.repeat) $('side-parts').querySelector(':scope > .fold-bar').click();
  else if (k === 'l' && !e.repeat) setCollapsed(!footer.classList.contains('collapsed'));
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
// Each tab's parts, in order; `:filled` is a filled 2x2 hull (the art a generator or quarters gives it), an item of
// its own. Parts on no list stay out of the library (they still open in a design).
const hulls = (kind) => ['1X1_04', '1X1_01', '2X1_01', '2X2_04', '2X2_02', '2X2_03', '2X2_01'].map((s) => `MDL_${kind}${s}`);
const GROUPS = [
  ['Hull', [...hulls('FERMA'), 'MDL_FERMA2X2_01:filled']],
  ['Reinforced', hulls('HARD')],
  ['Structural', ['MDL_FERMA4X4_01', 'MDL_COMBRIDGE_01', 'MDL_DECK_01', 'MDL_ARMOR2X1_01', 'MDL_ARMOR1X1_01', 'MDL_ARMOR1X1_02',
    'MDL_ARMOR1X1_03', 'MDL_ARMOR1X1_04']],
  ['Propulsion', ['MDL_ENGINE_03', 'MDL_ENGINE_04', 'MDL_ENGINE_05', 'MDL_ENGINE_01', 'MDL_ENGINE_02', 'MDL_LEG_01', 'MDL_LEG_02',
    'MDL_LEG_03', 'MDL_LEG_04', 'MDL_WHEEL_01']],
  ['Weapons', ['MDL_CANNON_30_6', 'MDL_CANNON_57_2', 'MDL_CANNON_100_2', 'MDL_CANNON_130', 'MDL_CANNON_180', 'MDL_CANNON_180_2',
    'MDL_CANNON_305_2', 'MDL_RSZO_220']],
  ['Missiles', ['MDL_NUKE_01_CONV', 'MDL_NUKE_02_CONV', 'MDL_NUKE_03_CONV', 'MDL_NUKE_04_CONV', 'MDL_NUKE_01', 'MDL_NUKE_02',
    'MDL_NUKE_03', 'MDL_NUKE_04']],
  ['Tactical', ['MDL_MISSILE_03', 'MDL_KAZ', 'MDL_FLARES', 'MDL_EVAC', 'MDL_FSS_02', 'MDL_BOMB_01', 'MDL_MISSILE_01',
    'MDL_MISSILE_02', 'CRAFT_LA29', 'CRAFT_T7']],
  ['Systems', ['MDL_FUEL_02', 'MDL_FUEL_03', 'MDL_FUEL_01', 'MDL_GENERATOR_01', 'MDL_GENERATOR_02',
    'MDL_QUARTERS_01', 'MDL_QUARTERS_02', 'MDL_AMMO_02', 'MDL_AMMO']],
  ['Sensors', ['MDL_ANTENNA_01', 'MDL_RADAR_01', 'MDL_RADAR_02', 'MDL_FCR_01', 'MDL_FCR_02', 'MDL_SPO_01',
    'MDL_SPO_02', 'MDL_IRST_01', 'MDL_JAMMER_01']],
  ['Hidden', ['MDL_CANNON_HARPOON', 'MDL_CANNON_04', 'MDL_PROTECTOR_01', 'MDL_MISSILE_CLUSTER_SFW_01', 'MDL_TORPEDO_300',
    'MDL_LCARGO_01', 'MDL_MISSILE_DRUM_01', 'MDL_FCR_03', 'MDL_LRRADIO_01']],
];
// What the library calls each part (others go by their name in the game).
const LABELS = {
  MDL_FERMA1X1_04: '1/2', MDL_FERMA1X1_01: '1x1', MDL_FERMA2X1_01: '2x1', MDL_FERMA2X2_04: 'TRI',
  MDL_FERMA2X2_02: 'QUARTER', MDL_FERMA2X2_03: 'KNOB', MDL_FERMA2X2_01: 'HULL', 'MDL_FERMA2X2_01:filled': 'FILLED',
  MDL_HARD1X1_04: '1/2', MDL_HARD1X1_01: '1x1', MDL_HARD2X1_01: '2x1', MDL_HARD2X2_04: 'TRI',
  MDL_HARD2X2_02: 'QUARTER', MDL_HARD2X2_03: 'KNOB', MDL_HARD2X2_01: 'HULL',
  MDL_FERMA4X4_01: 'LARGE HULL', MDL_COMBRIDGE_01: 'BRIDGE', MDL_DECK_01: 'FLIGHT DECK', MDL_ARMOR2X1_01: 'LARGE ARMOR',
  MDL_ARMOR1X1_01: 'ARMOR', MDL_ARMOR1X1_02: 'QUARTER', MDL_ARMOR1X1_03: 'TRI', MDL_ARMOR1X1_04: 'CORNER',
  MDL_LEG_01: 'LEG S', MDL_LEG_02: 'LEG M', MDL_LEG_03: 'LEG L', MDL_LEG_04: 'LEG XL', MDL_WHEEL_01: 'WHEEL',
  MDL_CANNON_30_6: 'CIWS', MDL_CANNON_57_2: 'VYMPEL', MDL_CANNON_100_2: 'AK-100', MDL_CANNON_130: 'MOLOT',
  MDL_CANNON_180: 'MK-180', MDL_CANNON_180_2: 'SARMAT', MDL_CANNON_305_2: 'SQUALL', MDL_RSZO_220: 'MRL',
  MDL_MISSILE_03: 'SPRINT', MDL_KAZ: 'PALASH', MDL_FLARES: 'FLARES', MDL_EVAC: 'EVAC', MDL_FSS_02: 'FSS',
  MDL_BOMB_01: 'FAB', MDL_MISSILE_01: 'ZENITH', MDL_MISSILE_02: 'NADIR', CRAFT_T7: 'T-7', CRAFT_LA29: 'LA-29',
  MDL_FUEL_02: 'FUEL L', MDL_FUEL_03: 'FUEL M', MDL_FUEL_01: 'FUEL S', MDL_GENERATOR_01: 'POWER M',
  MDL_GENERATOR_02: 'POWER S', MDL_QUARTERS_01: 'CREW M', MDL_QUARTERS_02: 'CREW S', MDL_AMMO_02: 'AMMO M',
  MDL_AMMO: 'AMMO S',
  MDL_ANTENNA_01: 'ANTENNA', MDL_RADAR_01: 'RADAR L', MDL_RADAR_02: 'RADAR M', MDL_FCR_01: 'FCR M', MDL_FCR_02: 'FCR S',
  MDL_SPO_01: 'ELINT M', MDL_SPO_02: 'ELINT S', MDL_IRST_01: 'MARS', MDL_JAMMER_01: 'LAGOON',
  MDL_CANNON_HARPOON: 'HARPOON', MDL_CANNON_04: 'CANNON 04', MDL_PROTECTOR_01: 'PROTECTOR',
  MDL_MISSILE_CLUSTER_SFW_01: 'CLUSTER', MDL_TORPEDO_300: 'TORPEDO', MDL_LCARGO_01: 'CARGO',
  MDL_MISSILE_DRUM_01: 'MISSILE DRUM', MDL_FCR_03: 'FCR', MDL_LRRADIO_01: 'ARRAY',
};
const partName = (oid) => {
  const n = STRINGS.en[oid];
  return n && n !== '-' ? n : oid.replace(/^MDL_/, '').replace(/_/g, ' ').toLowerCase();
};
// Library items: { key, oid, raw (template), name }. A part comes out of the library at its template's angle
// (the aircraft, taken from designs, are turned a quarter there).
const trayItem = (key) => {
  const [oid, filled] = key.split(':');
  const raw = PART_TEMPLATES[oid];
  return { key, oid, raw: filled ? filledHull(raw) : raw, name: LABELS[key] ?? partName(oid) };
};
const trayGroups = new Map(GROUPS.map(([g, keys]) => [g, keys.filter((k) => PART_TEMPLATES[k.split(':')[0]]).map(trayItem)]));
// All: every part of the other tabs, tab by tab, in a tray that wraps and scrolls (its height dragged by the tab row).
const ALL = 'All';
const allItems = [...trayGroups.values()].flat();

let tab = 'Hull';
let lastTab = 'Hull';   // the tab before All, which All's button goes back to
const thumbs = [];
function buildTray() {
  const tabs = $('tabs');
  tabs.replaceChildren(trayBar, ...[...trayGroups.keys(), ALL].map((g) => {
    const b = document.createElement('button');
    b.textContent = g;
    b.className = g === tab ? 'active' : '';
    if (g === ALL) b.id = 'all-tab';
    b.onclick = () => {
      if (g !== ALL) tab = g;
      else if (tab === ALL) { if (!footer.classList.contains('collapsed')) tab = lastTab; }   // (folded: just opens it)
      else { lastTab = tab; tab = ALL; }
      setCollapsed(false);
      buildTray();
    };
    return b;
  }));
  footer.classList.toggle('all', tab === ALL);
  labelTrayBar();
  thumbs.length = 0;
  $('tray').replaceChildren(...(tab === ALL ? allItems : trayGroups.get(tab)).map((item) => {
    const el = document.createElement('div');
    el.className = 'part';
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
      const p = new BuildPart(item.oid, pointer.wx, pointer.wy, item.raw.m_angle ?? 0, item.raw);
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
  if (tab === ALL) {
    tray.style.gridTemplateRows = tray.style.gridTemplateColumns = '';   // (the stylesheet's: wrap to the width)
    sizeAllTray();
    return;
  }
  tray.style.height = tray.style.paddingBlock = '';
  if (!tray.clientWidth) return;   // folded
  const rows = longestTab * TILE + (longestTab - 1) * TILE_GAP <= tray.clientWidth - 2 * TRAY_PAD ? 1 : 2;
  tray.style.gridTemplateRows = `repeat(${rows}, 110px)`;
  tray.style.gridTemplateColumns = `repeat(${Math.ceil(trayGroups.get(tab).length / rows)}, ${TILE}px)`;
}
new ResizeObserver(layoutTray).observe(document.querySelector('footer'));
let trayPress = null;
/** The All tray at allHeight; dragged right down, it loses its padding too and closes up to the tab row. */
function sizeAllTray() {
  const tray = $('tray');
  tray.style.height = `${allHeight}px`;
  tray.style.paddingBlock = allHeight < 2 * 8 + 1 ? '0' : '';
}
let allHeight = 2 * 110 + 6 + 2 * 8 + 1;   // the All tray's height (px): two rows to start with
try { const h = localStorage.getItem('shipbuilder.allHeight'); if (h) allHeight = Number(h) || 0; } catch { /* storage may be off */ }

// The parts tray folds down to its tab row (remembered per browser): the row's label, or a click on the row
// outside the tabs, folds it; picking a tab opens it. On the All tab the row is dragged instead, to size the tray.
const trayBar = $('tray-bar');
const toggleTray = () => tab !== ALL && setCollapsed(!document.querySelector('footer').classList.contains('collapsed'));
trayBar.onclick = toggleTray;
$('tabs').addEventListener('click', (e) => { if (e.target === e.currentTarget) toggleTray(); });
$('tabs').addEventListener('pointerdown', (e) => {
  if (tab !== ALL || e.button !== 0 || (e.target !== e.currentTarget && e.target !== trayBar)) return;
  e.preventDefault();
  const tray = $('tray'), y0 = e.clientY, h0 = tray.offsetHeight;
  const move = (ev) => {
    allHeight = Math.round(Math.max(0, Math.min(innerHeight * 0.75, h0 + y0 - ev.clientY)));
    sizeAllTray();
  };
  const end = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    try { localStorage.setItem('shipbuilder.allHeight', String(allHeight)); } catch { /* storage may be off */ }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
});
function labelTrayBar() {
  const on = footer.classList.contains('collapsed');
  trayBar.textContent = tab === ALL && !on ? '↕ library' : `${on ? '▴' : '▾'} library`;
  trayBar.title = tab === ALL && !on ? 'Drag to size the library' : on ? 'Show the library' : 'Hide the library';
}
function setCollapsed(on) {
  document.querySelector('footer').classList.toggle('collapsed', on);
  labelTrayBar();
  try { localStorage.setItem('shipbuilder.trayCollapsed', on ? '1' : ''); } catch { /* storage may be off */ }
}
const footer = document.querySelector('footer');
try { setCollapsed(localStorage.getItem('shipbuilder.trayCollapsed') === '1'); } catch { setCollapsed(false); }
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
    const part = new BuildPart(oid, 0, 0, item.raw.m_angle ?? 0, item.raw);
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
// ---- dialogs: in-page stand-ins for confirm() and prompt() --------------------------------------------------
const dialog = $('dialog');
/**
 * Ask the user something in a dialog over the page. Resolves to true / false, or with `input` (the starting
 * text) to the text entered / null. opts { ok, cancel: button labels, input, danger: the OK button in the warning
 * colour }. Enter is OK; Escape, Cancel or a click outside is Cancel.
 */
function ask(message, { ok = 'OK', cancel = 'Cancel', input, danger = false } = {}) {
  const el = (tag, props) => Object.assign(document.createElement(tag), props);
  const field = input === undefined ? null : el('input', { type: 'text', value: input, spellcheck: false });
  const okButton = el('button', { textContent: ok, className: danger ? 'danger' : '' });
  const cancelButton = el('button', { textContent: cancel });
  const body = el('div', { className: 'body' });
  body.append(el('p', { textContent: message }), ...(field ? [field] : []), el('div', { className: 'buttons' }));
  body.lastChild.append(cancelButton, okButton);
  dialog.replaceChildren(body);
  dialog.showModal();
  if (field) { field.focus(); field.select(); } else okButton.focus();
  return new Promise((resolve) => {
    const finish = (yes) => {
      dialog.close();
      resolve(field ? (yes ? field.value : null) : yes);
    };
    okButton.onclick = () => finish(true);
    cancelButton.onclick = () => finish(false);
    dialog.oncancel = (e) => { e.preventDefault(); finish(false); };
    dialog.onclick = (e) => { if (e.target === dialog) finish(false); };
    // The page's own shortcuts don't see keys pressed here.
    dialog.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && e.target !== cancelButton) { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    };
  });
}

/** Whether the current design can be replaced: unedited, or the user says so. */
const mayDiscard = async (what) => !edited || model.parts.length <= 1 ||
  ask(`${what} Unsaved changes are lost.`, { ok: 'Discard changes', danger: true });
$('new').onclick = async () => {
  if (!await mayDiscard('Start a new design?')) return;
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
    if (isPdf(bytes)) return importPdf(name, bytes);
    if (!isImage(bytes)) setModel(BuildModel.fromSeria(buffer));
    else {
      const got = await designFromCard(await imagePixels(bytes));
      if (!got) return toast(`Unable to read ${name}; try with a higher resolution.`);
      setModel(got);
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
$('open').onclick = () => { closeAllMenus(); $('file').click(); };

// ---- the ship list: designs saved in this browser, in folders ------------------------------------------------
// IndexedDB. Stores: ships (the list: id, name, folder, parts, flagship, saved), designs (each saved design as a
// .shipcard by id: the parts, packed as the card's stamp packs them (encodeDesign), a few hundred bytes; read only
// to load it) and folders (name, order). A name is unique within its folder. The game's own designs (npm run
// designs: assets/designs/) are listed in a Highfleet folder; their .shipcard is fetched from `url` when needed.
// A .shipcard keeps the parts, the name and the flagship flag: all a design is. What else a .seria sets per part
// (floors, mirroring, fuel load...) the game works out again on load, as toSeria does. Before version 5 designs were kept as .seria; those are packed on the next visit
// (packSerias), and any that can't be (a module the code doesn't know) stay a .seria. Highfleet
// can't be changed: not renamed, deleted or merged, nothing put in or taken out (a design dragged out of it is
// copied), and a design loaded from it is saved to Saved; it can be duplicated into an ordinary folder.
const SAVED = 'Saved', HIGHFLEET = 'Highfleet';
const readOnly = (folder) => folder === HIGHFLEET;
const DESIGNS = './assets/designs/';
let loadedId = null;                // the saved design the current one was loaded from or saved as
let shipsDb = null;
function openShips() {
  return shipsDb ??= new Promise((ok, err) => {
    const req = indexedDB.open('shipbuilder', 5);
    req.onupgradeneeded = (e) => {
      const db = req.result, tx = req.transaction, old = e.oldVersion;
      const create = () => {
        db.createObjectStore('ships', { keyPath: 'id', autoIncrement: true });
        db.createObjectStore('designs', { keyPath: 'id' });
      };
      if (old < 2) db.createObjectStore('folders', { keyPath: 'name' });
      const folders = tx.objectStore('folders');
      folders.delete('SAVED');
      folders.delete('EXAMPLES');
      folders.put({ name: SAVED, order: 0 });
      folders.put({ name: HIGHFLEET, order: 1 });
      try { localStorage.removeItem('shipbuilder.designsListed'); } catch { /* storage may be off */ }   // (versions 2, 3)
      if (!old) return create();
      if (old === 4) {
        // The .serias move to designs as they are, to be packed once the database is open.
        const store = db.createObjectStore('designs', { keyPath: 'id' });
        tx.objectStore('serias').getAll().onsuccess = (b) => {
          for (const r of b.target.result) store.put(r);
          db.deleteObjectStore('serias');
        };
        return;
      }
      // Up to version 3 designs were keyed by name (unique across folders; version 1 kept the .seria in the record,
      // and had no folders). SAVED is now Saved; EXAMPLES (Borey and Voskhod, copied in) gave way to Highfleet, the
      // copies going and anything saved into it moving to Saved.
      tx.objectStore('ships').getAll().onsuccess = (a) => {
        const list = a.target.result;
        const rebuild = (serias) => {
          db.deleteObjectStore('ships');
          if (old >= 2) db.deleteObjectStore('serias');
          create();
          const ships = tx.objectStore('ships'), store = tx.objectStore('designs');
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
    req.onsuccess = () => ok(packSerias(req.result).then(listGameDesigns));
    req.onerror = () => err(req.error);
  });
}
/** Saved designs still kept as .seria packed into .shipcards (see above). */
async function packSerias(db) {
  try {
    const old = (await done(db.transaction('designs').objectStore('designs').getAll())).filter((r) => r.seria);
    const packed = [];
    for (const { id, seria } of old) {
      try { packed.push({ id, shipcard: await encodeDesign(BuildModel.fromSeria(seria)) }); } catch { /* stays a .seria */ }
    }
    if (packed.length) {
      const tx = db.transaction('designs', 'readwrite');
      for (const r of packed) tx.objectStore('designs').put(r);
      await finished(tx);
    }
  } catch { /* tried again next time */ }
  return db;
}
/**
 * The game's designs into the Highfleet folder (on every visit: it can't be changed): any missing, and the file of
 * any listed from an older extract (a .seria then).
 */
async function listGameDesigns(db) {
  try {
    const index = await (await fetch(`${DESIGNS}index.json`)).json();
    const tx = db.transaction(['ships'], 'readwrite'), ships = tx.objectStore('ships');
    const listed = new Map((await done(ships.getAll())).filter((s) => s.folder === HIGHFLEET).map((s) => [s.name, s]));
    for (const d of index) {
      const url = DESIGNS + encodeURIComponent(d.file), got = listed.get(d.name);
      if (!got) ships.add({ name: d.name, folder: HIGHFLEET, parts: d.parts, flagship: d.flagship, saved: 0, url });
      else if (got.url !== url) ships.put({ ...got, url });
    }
    await finished(tx);
  } catch { /* not extracted here */ }
  return db;
}
/** A listed design (saved in the browser, or the game's), under its listed name. */
async function designOf(ship) {
  const { designs } = await shipTx(['designs']);
  const got = await done(designs.get(ship.id));
  let m;
  if (got) m = got.shipcard ? await decodeDesign(got.shipcard) : BuildModel.fromSeria(got.seria);
  else {
    if (!ship.url) throw new Error('its design is missing');
    const res = await fetch(ship.url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    m = await decodeDesign(new Uint8Array(await res.arrayBuffer()));
  }
  m.name = ship.name;
  return m;
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
/** Copy designs (their .shipcard too, if saved) into `folder`, under `names` (one each). In an open transaction `t`. */
async function copyShips(t, ships, folder, names) {
  for (const [i, { id, ...ship }] of ships.entries()) {
    const copy = await done(t.ships.add({ ...ship, folder, name: names[i] }));
    const got = await done(t.designs.get(id));
    if (got) t.designs.put({ ...got, id: copy });
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
    if (same && same.id !== loadedId && !await ask(`Replace "${name}" in ${folder}?`, { ok: 'Replace', danger: true })) return;
    // The whole design, unconnected parts too: it's work in progress. Over the one it was loaded from (renamed, if
    // it was), unless another of the new name is replaced.
    const shipcard = await encodeDesign(model);
    const target = same ?? (from?.folder === folder ? from : null);
    const t = await shipTx(['ships', 'designs', 'folders'], true);
    if (!await done(t.folders.get(folder))) t.folders.put({ name: folder, order: folder === SAVED ? 0 : Date.now() });
    const ship = { name, folder, parts: model.parts.length, flagship: model.flagship, saved: Date.now() };
    const id = await done(t.ships.put(target ? { ...ship, id: target.id } : ship));
    t.designs.put({ id, shipcard });
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
  if (!await mayDiscard(`Load ${ship.name}?`)) return false;
  try {
    setModel(await designOf(ship));
    loadedId = ship.id;
    return true;
  } catch (err) { toast(`Couldn't load ${ship.name}: ${err.message}.`); return false; }
}
async function deleteShip(ship) {
  if (readOnly(ship.folder)) return;
  if (!await ask(`Delete the saved ship "${ship.name}"? This can't be undone.`, { ok: 'Delete', danger: true })) return;
  try {
    const t = await shipTx(['ships', 'designs'], true);
    t.ships.delete(ship.id);
    t.designs.delete(ship.id);
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
    const t = await shipTx(['ships', 'designs', 'folders'], true);
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
/**
 * A folder of .serias (the game's Ships folder, say) saved as a new folder of designs, each packed into a .shipcard
 * like a saved one; other files are skipped. Numbered if there's a folder of that name already. (A gallery PDF is
 * taken the same way: importPdf.)
 */
async function importFolder(name, files) {
  const serias = files.filter((f) => /\.seria$/i.test(f.name));
  if (!serias.length) return toast(`No .seria files in ${name}.`);
  // Read and packed first: a transaction closes if it waits on anything else.
  const designs = [], failed = [];
  for (const f of serias) {
    try {
      const m = BuildModel.fromSeria(await f.arrayBuffer());
      if (!m.parts.length) throw new Error('no parts');
      designs.push({ name: m.name?.trim() || f.name.replace(/\.seria$/i, ''), parts: m.parts.length, flagship: m.flagship,
        saved: f.lastModified || Date.now(), shipcard: await encodeDesign(m) });
    } catch { failed.push(f.name); }
  }
  if (!designs.length) return toast(`Couldn't read any of the ${serias.length} .serias in ${name}.`);
  return importDesigns(name, designs, failed);
}
/** Designs ({ name, parts, flagship, saved, shipcard }) saved as a new folder (numbered if `name` is taken). */
async function importDesigns(name, designs, failed = []) {
  try {
    const t = await shipTx(['ships', 'designs', 'folders'], true);
    const folder = freeName(name, new Set((await done(t.folders.getAll())).map((f) => f.name)));
    t.folders.put({ name: folder, order: Date.now() });
    const taken = new Set();
    for (const { shipcard, ...ship } of designs) {
      ship.name = freeName(ship.name, taken);
      taken.add(ship.name);
      const id = await done(t.ships.add({ ...ship, folder }));
      t.designs.put({ id, shipcard });
    }
    await t.done;
    navigator.storage?.persist?.();
    toast(`Saved ${designs.length} design${designs.length > 1 ? 's' : ''} to ${folder}` +
      (failed.length ? ` (couldn't read ${failed.length}: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}).` : '.'));
    closeAllMenus();
    openShipList(folder);
  } catch (err) { toast(`Couldn't save ${name}: ${err.message}.`); }
}
/** A copy of a folder and its designs: "<name> Copy". */
async function duplicateFolder({ name, ships }) {
  try {
    const t = await shipTx(['ships', 'designs', 'folders'], true);
    const to = freeName(`${name} Copy`, new Set((await done(t.folders.getAll())).map((f) => f.name)));
    t.folders.put({ name: to, order: Date.now() });
    await copyShips(t, ships, to, ships.map((s) => s.name));
    await t.done;
    toast(`Duplicated ${name} as ${to}.`);
    refreshShipList(to);
  } catch (err) { toast(`Couldn't duplicate ${name}: ${err.message}.`); }
}
/**
 * A folder's designs as a .zip of a folder of .serias (the complement of importFolder), each as the Download button
 * makes it: unconnected parts left out.
 */
async function downloadFolder({ name, ships }) {
  if (!ships.length) return toast(`${name} has no designs.`);
  const files = [], failed = [], taken = new Set();
  let loose = 0;
  for (const ship of ships) {
    try {
      const got = connected(new Set(), await designOf(ship));
      loose += got.loose;
      const file = freeName(safeFileName(ship.name), taken);
      taken.add(file);
      files.push({ name: `${file}.seria`, bytes: got.ship.toSeria() });
    } catch { failed.push(ship.name); }
  }
  const folder = safeFileName(name);
  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await zip(files.map((f) => ({ ...f, name: `${folder}/${f.name}` }))));
    a.download = `${folder}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (err) { return toast(`Couldn't download ${name}: ${err.message}.`); }
  toast(`Downloaded ${files.length} design${files.length !== 1 ? 's' : ''} from ${name}` +
    ` as ${folder}.zip` +
    (loose ? `, leaving out ${loose} unconnected part${loose > 1 ? 's' : ''}` : '') +
    (failed.length ? ` (couldn't make ${failed.length}: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''})` : '') + '.');
}
/** A .zip of `files` ({ name, bytes }), each deflated. */
async function zip(files) {
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
  const what = `the folder "${name}"${n ? ` and the ${n} design${n > 1 ? 's' : ''} in it` : ''}`;
  if (!await ask(`Delete ${what}? This can't be undone.`, { ok: 'Delete', danger: true })) return;
  try {
    const t = await shipTx(['ships', 'designs', 'folders'], true);
    for (const s of ships) { t.ships.delete(s.id); t.designs.delete(s.id); }
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
const folderName = async (message, name = '') => (await ask(message, { input: name }))?.trim() || null;

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
      { label: 'Gallery', onClick: () => openGallery(f) },
      { label: 'Duplicate', onClick: () => { closeMenus('context'); duplicateFolder(f); } },
      { label: 'Download', onClick: () => { closeMenus('context'); downloadFolder(f); } },
    ] : [
      { label: 'Gallery', onClick: () => openGallery(f) },
      { label: 'Download', onClick: () => { closeMenus('context'); downloadFolder(f); } },
      { label: 'Rename…', onClick: async () => { const n = await folderName('Rename the folder:', f.name); if (n && n !== f.name) renameFolder(f.name, n); else closeMenus('context'); } },
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
    onClick: async () => { const n = await folderName('New folder name:'); if (n) newFolder(n); },
    onDrop: async (ship) => { const n = await folderName(`New folder for ${ship.name}:`); if (n) moveShip(ship, n); },
  });
  const root = showMenu('load', 0, items, below(loadButton));
  loadButton.setAttribute('aria-expanded', true);
  const i = folders.findIndex((f) => f.name === folder);
  if (i >= 0) root.querySelectorAll('.item')[i].click();
  root.querySelector('.row:last-child .item').classList.add('new');
}
// Hovering a design shows its stat card beside the list: drawn a step at a time, and dropped if the pointer leaves
// first. Drawn once per saved version (and name), then kept as a PNG (an object URL; a 3x canvas would be a few MB),
// for the hover and the gallery alike.
const previewCards = new Map();     // design id -> { key, card: Promise<{ url, info } | null>, done, aborted }
const preview = Object.assign(document.createElement('div'), { id: 'card-preview', hidden: true });
document.body.append(preview);
let previewing = null;
const nextTask = () => new Promise((ok) => setTimeout(ok, 0));
/** A saved design's card ({ canvas, stats, name }), drawn a step at a time; null if `cancelled()` first. */
async function drawShipCard(ship, cancelled = () => false) {
  const m = await designOf(ship);
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
  return { canvas: c, stats, name: m.name };
}
/** What the gallery sorts and filters by, from a card's stats. */
const cardInfo = (s, name) => ({
  name, price: s.price, combat: s.combatValue, firepower: s.firepower.total, twr: s.twr, speed: s.speedKmh,
  range: s.fuelCapacity > 0 ? s.rangeKm : 0, mass: s.mass, parts: s.partCount,
  roles: ROLES.map(([id]) => id).filter((id) => s.roles.values[id] > 0), purpose: s.class.purpose ?? 'GROUND_VEHICLE',
  size: s.class.purpose ? s.class.size : null,
});
/** The card of a saved design ({ url: an object URL of its PNG, info: cardInfo }), drawn a step at a time; null if
 * it was aborted (see abortCard) first. */
function cardOfShip(ship) {
  const key = `${ship.saved};${ship.name}`, got = previewCards.get(ship.id);
  if (got?.key === key && !got.aborted) return got.card;
  got?.card.then((c) => c && URL.revokeObjectURL(c.url), () => {});   // an older version's
  const entry = { key, done: false, aborted: false };
  const cancelled = () => entry.aborted;
  entry.card = drawShipCard(ship, cancelled).then(async (c) => c && {
    url: URL.createObjectURL(await new Promise((ok) => c.canvas.toBlob(ok))), info: cardInfo(c.stats, c.name),
  });
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
    if (previewing === item && c) placePreview(item, Object.assign(document.createElement('img'), { src: c.url, alt: '' }));
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

// ---- the gallery: every card of a folder, three to a row, in a popup ----------------------------------------------
// The cards come from the hover's cache (cardOfShip), drawn there one after another under a progress bar, and are
// shown once all are, sorted and filtered by what cardInfo keeps. Closed early, those drawn so far stay cached for
// next time. A card loads its design; Export makes a PDF of the cards shown, with their designs attached.
const gallery = $('gallery');
const GALLERY_SORTS = [
  ['price', 'Price'], ['combat', 'Combat value'],
  ['speed', 'Cruise speed'], ['range', 'Range'], ['mass', 'Mass'], ['parts', 'Parts'], ['name', 'Name'],
];
const classLabel = (id) => STRINGS.en[`${id}_CLASS`] ?? id;
const PURPOSE_ORDER = [...Object.values(PURPOSES).map(([id]) => id), 'GROUND_VEHICLE'];
const SIZE_ORDER = MASS_CLASSES.map(([, id]) => id);
const gallerySort = { key: 'price', desc: false };   // kept from one gallery to the next
let galleryRun = null;              // { cancelled, ship (the one being drawn) } of the one open
function openGallery(f) {
  closeAllMenus();
  const run = { cancelled: false, ship: null };
  galleryRun = run;
  const el = (tag, props, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  const n = f.ships.length, designs = (k) => `${k} design${k !== 1 ? 's' : ''}`;
  const bar = el('progress', { max: n, value: 0 });
  const status = el('div', { className: 'status', textContent: `Drawing ${n} card${n !== 1 ? 's' : ''}…` });
  const grid = el('div', { className: 'grid', hidden: true });
  const body = el('div', { className: 'body' }, el('div', { className: 'loading' }, bar, status), grid);
  const exportButton = el('button', { textContent: 'Export', title: `Save the cards shown as a PDF, ${PDF_COLUMNS * PDF_ROWS} to a page, their designs attached (open it here to get them back as a folder)`, disabled: true });
  const downloadButton = el('button', { textContent: 'Download', title: 'Download the folder as .serias (a .zip)' });
  const closeButton = el('button', { textContent: 'Close' });
  const count = el('span', { className: 'title', textContent: `${f.name} · ${designs(n)}` });
  const head = el('div', { className: 'head' }, count, el('span', { className: 'grow' }), exportButton, downloadButton, closeButton);
  // Sort (a stat, either way) and filters (role, type, size: those the folder has), once the cards are drawn.
  const sortBy = el('select', { title: 'Sort by' }, ...GALLERY_SORTS.map(([value, label]) => el('option', { value, textContent: label })));
  const sortDir = el('button', { className: 'dir' });
  const roleFilter = el('select', { title: 'Show only ships with this role' });
  const typeFilter = el('select', { title: 'Show only this type of ship' });
  const sizeFilter = el('select', { title: 'Show only ships of this size' });
  const tools = el('div', { className: 'tools', hidden: true },
    el('label', {}, 'Sort', sortBy), sortDir, el('span', { className: 'gap' }),
    el('label', {}, 'Role', roleFilter), el('label', {}, 'Type', typeFilter), el('label', {}, 'Size', sizeFilter));
  gallery.replaceChildren(head, tools, body);
  gallery.showModal();
  closeButton.focus();
  closeButton.onclick = () => gallery.close();
  downloadButton.onclick = () => downloadFolder(f);
  if (!n) status.textContent = 'No designs here yet.';

  (async () => {
    const items = [], failed = [];
    for (const [i, ship] of f.ships.entries()) {
      run.ship = ship;
      try {
        const c = await cardOfShip(ship);
        if (run.cancelled) return;
        if (c) items.push({ ship, ...c });
      } catch { failed.push(ship.name); }
      if (run.cancelled) return;
      bar.value = i + 1;
      status.textContent = `Drawing cards: ${i + 1} / ${n}`;
    }
    run.ship = null;
    if (!n) return;
    for (const it of items) {
      it.img = el('img', { src: it.url, alt: it.ship.name, title: `Load ${it.ship.name}` });
      it.img.onclick = async () => { if (await loadShip(it.ship)) gallery.close(); };
    }
    // Each filter lists what the folder has (with counts), in the game's order.
    const fill = (select, any, ids, label) => {
      const counts = new Map();
      for (const id of ids.flat()) if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
      select.replaceChildren(el('option', { value: '', textContent: any }),
        ...[...counts].map(([id, k]) => el('option', { value: id, textContent: `${label(id)} (${k})` })));
    };
    const byOrder = (order) => (a, b) => order.indexOf(a) - order.indexOf(b);
    fill(roleFilter, 'All', items.map((it) => it.info.roles).flat().sort(byOrder(ROLES.map(([id]) => id))).map((r) => [r]),
      (id) => STRINGS.en[`LABLE_${id}`] ?? id);
    fill(typeFilter, 'All', items.map((it) => [it.info.purpose]).sort((a, b) => byOrder(PURPOSE_ORDER)(a[0], b[0])), classLabel);
    fill(sizeFilter, 'All', items.map((it) => [it.info.size]).sort((a, b) => byOrder(SIZE_ORDER)(a[0], b[0])), classLabel);
    sortBy.value = gallerySort.key;
    let shown = [];
    const show = () => {
      const role = roleFilter.value, type = typeFilter.value, size = sizeFilter.value, { key, desc } = gallerySort;
      sortDir.textContent = desc ? '↓' : '↑';
      sortDir.title = desc ? 'Highest first (click for lowest first)' : 'Lowest first (click for highest first)';
      shown = items.filter((it) => (!role || it.info.roles.includes(role)) && (!type || it.info.purpose === type) && (!size || it.info.size === size));
      const v = (it) => it.info[key];
      shown.sort((a, b) => (key === 'name' ? v(a).localeCompare(v(b)) : v(a) - v(b)) * (desc ? -1 : 1) || a.info.name.localeCompare(b.info.name));
      grid.replaceChildren(...shown.map((it) => it.img));
      count.textContent = `${f.name} · ${shown.length === items.length ? designs(items.length) : `${shown.length} of ${designs(items.length)}`}`;
      exportButton.disabled = !shown.length;
    };
    sortBy.onchange = () => { gallerySort.key = sortBy.value; show(); };
    sortDir.onclick = () => { gallerySort.desc = !gallerySort.desc; show(); };
    roleFilter.onchange = typeFilter.onchange = sizeFilter.onchange = show;
    show();
    body.firstChild.remove();
    grid.hidden = tools.hidden = false;
    exportButton.onclick = async () => {
      exportButton.disabled = true;
      try { await exportGallery(f.name, shown); } catch (err) { toast(`Couldn't export ${f.name}: ${err.message}.`); }
      exportButton.disabled = false;
    };
    if (failed.length) toast(`Couldn't draw ${failed.length} card${failed.length > 1 ? 's' : ''}: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}.`);
  })();
}
gallery.addEventListener('close', () => {
  if (!galleryRun) return;
  galleryRun.cancelled = true;
  if (galleryRun.ship) abortCard(galleryRun.ship);   // (the cards already drawn stay cached)
  galleryRun = null;
  $('stage').append($('toast'));
  gallery.replaceChildren();
});
gallery.addEventListener('keydown', (e) => e.stopPropagation());   // not the page's shortcuts

// The PDF: pages of 3 x 6 cards on the gallery's dark ground, each page one JPEG at the cards' 3x, A4 wide. Each
// design is attached as its .shipcard (an embedded file, in the order shown), and the folder's name is the title,
// so importPdf can take it back as a folder.
const PDF_COLUMNS = 3, PDF_ROWS = 6, PDF_GAP = 4, PDF_WIDTH = 595;   // (gap in card px; width in pt)
const safeFileName = (n) => n.replace(/[\\/:*?"<>|]/g, '_').trim() || '_';
/** The cards ({ ship, url }) as a PDF download. */
async function exportGallery(name, items) {
  const cw = CARD.width, ch = CARD.height, gap = PDF_GAP, pad = gap * 2, k = CARD_SCALE;
  const w = pad * 2 + PDF_COLUMNS * cw + (PDF_COLUMNS - 1) * gap, h = pad * 2 + PDF_ROWS * ch + (PDF_ROWS - 1) * gap;
  const c = newCanvas(w * k, h * k), g = c.getContext('2d');
  const pages = [], perPage = PDF_COLUMNS * PDF_ROWS;
  for (let first = 0; first < items.length; first += perPage) {
    g.fillStyle = '#0b203d';   // (the CSS --panel-2)
    g.fillRect(0, 0, c.width, c.height);
    for (const [i, { url }] of items.slice(first, first + perPage).entries()) {
      const img = await createImageBitmap(await (await fetch(url)).blob());
      const x = pad + (i % PDF_COLUMNS) * (cw + gap), y = pad + Math.floor(i / PDF_COLUMNS) * (ch + gap);
      g.drawImage(img, x * k, y * k, cw * k, ch * k);
      img.close();
    }
    const jpeg = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.9));
    pages.push({ jpeg: new Uint8Array(await jpeg.arrayBuffer()), w: c.width, h: c.height });
  }
  const files = [], taken = new Set();
  for (const { ship } of items) {
    const file = freeName(safeFileName(ship.name), taken);
    taken.add(file);
    files.push({ name: `${file}.shipcard`, bytes: await encodeDesign(await designOf(ship)) });
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(pdf(pages, PDF_WIDTH, (PDF_WIDTH * h) / w, { title: name, files }));
  a.download = `${safeFileName(name)} gallery.pdf`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
/** UTF-16BE hex string (a PDF text string), and back. */
const pdfText = (t) => `<FEFF${Array.from({ length: t.length }, (_, i) => t.charCodeAt(i).toString(16).padStart(4, '0')).join('')}>`;
const fromPdfText = (hex) => String.fromCharCode(...(hex.match(/.{4}/g) ?? []).map((h) => parseInt(h, 16)));
/**
 * A PDF of `pages` ({ jpeg bytes, w, h in px }), each filling a pw x ph pt page; with a title and attached files
 * ({ name, bytes }, in order).
 */
function pdf(pages, pw, ph, { title = '', files = [] } = {}) {
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
const isPdf = (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;   // %PDF
/**
 * A gallery PDF's designs (its attached .shipcards; see pdf()) saved as a new folder, named by its title. Reads
 * the PDFs Export writes, not any PDF's attachments (no compressed object streams and such).
 */
async function importPdf(fileName, bytes) {
  const text = new TextDecoder('latin1').decode(bytes);   // (one char per byte: indices are offsets)
  const name = fromPdfText(text.match(/\/Title\s*<FEFF([0-9A-Fa-f]*)>/)?.[1] ?? '') || fileName.replace(/\.pdf$/i, '').replace(/ gallery$/, '');
  const stream = (n) => {
    const at = text.search(new RegExp(`(^|\\s)${n}\\s+0\\s+obj\\b`));
    if (at < 0) return null;
    const head = text.slice(at, at + 400).match(/\/Length\s+(\d+)[^]*?stream\r?\n/);
    if (!head) return null;
    const start = at + head.index + head[0].length;
    return bytes.slice(start, start + Number(head[1]));
  };
  const designs = [], failed = [];
  for (const [, uf, n] of text.matchAll(/\/Type\s*\/Filespec\b[^]*?\/UF\s*<FEFF([0-9A-Fa-f]*)>[^]*?\/EF\s*<<\s*\/F\s+(\d+)\s+0\s+R/g)) {
    const file = fromPdfText(uf);
    if (!/\.shipcard$/i.test(file)) continue;
    try {
      const shipcard = stream(n);
      if (!shipcard) throw new Error('missing');
      const m = await decodeDesign(shipcard);
      designs.push({ name: m.name?.trim() || file.replace(/\.shipcard$/i, ''), parts: m.parts.length, flagship: m.flagship, saved: Date.now(), shipcard });
    } catch { failed.push(file); }
  }
  if (!designs.length) return toast(failed.length ? `Couldn't read the designs in ${fileName}.` : `${fileName} has no designs attached (only the gallery's own PDFs do).`);
  return importDesigns(name, designs, failed);
}

const below = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.bottom + 4 }; };
/** After a change: the menus again, with `folder` (or the one that was open) opened. */
function refreshShipList(folder) {
  closeMenus('context');
  if (!menus.load.length) return;
  openShipList(folder ?? menus.load[0].querySelector('.item.open .label')?.textContent);
}
loadButton.onclick = () => (menus.load.length ? closeAllMenus() : openShipList());
// The Gallery menu: the folders; one opens its gallery.
const galleryButton = $('gallery-button');
let galleryMenu = null;
galleryButton.onclick = async () => {
  const wasOpen = galleryMenu && menus.context[0] === galleryMenu;
  closeAllMenus();
  galleryMenu = null;
  if (wasOpen) return;
  let folders;
  try { folders = await shipFolders(); } catch (err) {
    galleryMenu = showMenu('context', 0, [{ empty: `Saved ships are unavailable: ${err.message}.` }], below(galleryButton));
    return;
  }
  galleryMenu = showMenu('context', 0, folders.map((f) => ({ label: f.name, meta: `${f.ships.length}`, onClick: () => openGallery(f) })),
    below(galleryButton));
};
document.addEventListener('pointerdown', (e) => {
  if (dialog.contains(e.target) || gallery.contains(e.target)) return;   // the menus stay open under a dialog opened from them
  if (galleryButton.contains(e.target)) return;   // it toggles its own menu
  if (!inMenus(e.target) && !loadButton.contains(e.target)) closeAllMenus();
  else if (menus.context.length && !menus.context.some((m) => m.contains(e.target))) closeMenus('context');
}, { capture: true });
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || dialog.open || !(menus.load.length || menus.context.length)) return;
  e.stopImmediatePropagation();
  closeMenus(menus.context.length ? 'context' : 'load');
}, { capture: true });
window.addEventListener('resize', closeAllMenus);
openShips().catch(() => {});   // the examples are ready by the time the list is opened


$('download').onclick = async () => {
  const { ship, loose } = connected();
  const v = ship.validate();
  if (!v.ok && !await ask(`This design breaks some rules:\n\n${v.messages.join('\n')}\n\nDownload anyway?`, { ok: 'Download anyway' })) return;
  const blob = new Blob([ship.toSeria()], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${model.name.replace(/[\\/:*?"<>|]/g, '_')}.seria`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  if (loose) toast(`Left out ${loose} unconnected part${loose > 1 ? 's' : ''}.`);
};
// One button flips between the looks; it names the one it switches to.
const modeButton = $('mode');
function showMode() {
  modeButton.textContent = colour ? 'Blueprint' : 'Render';
  modeButton.title = colour
    ? 'Show the blueprint: hand-drawn parts on graph paper'
    : "Show the game's look: its sprites with lighting, shadows and colors";
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
  // Folders are saved as folders of designs; the entries have to be taken before anything is awaited.
  const dirs = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter((d) => d?.isDirectory);
  if (dirs.length) {
    for (const d of dirs) await importFolder(d.name, await filesIn(d));
    return;
  }
  const f = e.dataTransfer.files[0];
  if (f) open(await f.arrayBuffer(), f.name);
});
/** The files in a dropped folder, and its subfolders'. */
async function filesIn(dir) {
  const reader = dir.createReader(), out = [];
  // readEntries gives them a batch at a time, then an empty one.
  for (let batch; (batch = await new Promise((ok, err) => reader.readEntries(ok, err))).length;) {
    for (const en of batch) {
      if (en.isDirectory) out.push(...await filesIn(en));
      else out.push(await new Promise((ok, err) => en.file(ok, err)));
    }
  }
  return out;
}

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
