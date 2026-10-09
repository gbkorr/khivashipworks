// The parts library (tray) along the bottom: its tabs, the parts' thumbnails, folding and sizing it.
import { BuildModel, BuildPart, GRID, PART_TEMPLATES } from '../lib/builder.js';
import { STRINGS } from '../lib/data.js';
import { filledHull } from '../lib/hull.js';
import { makeCanvas } from '../lib/font.js';
import { PX_PER_UNIT, renderShip, shipRenderBounds } from '../lib/render.js';
import { SHADING, bakeShaded } from '../lib/shading.js';
import { S, $, footer, hotkeyHint, pointer, updatePointer } from './state.js';
import { atlas } from './assets.js';
import { deleteHeld, hold, pruneUnconnected } from './edit.js';
import { BLUEPRINT_ART, atlasNow, badgeColors, wireColor } from './view.js';

// Each tab's parts, in order; `:filled` is a filled hull (the art a generator or quarters gives it), an item of its
// own. Parts on no list stay out of the library (they still open in a design).
const hulls = (kind) => ['1X1_04', '1X1_01', '2X1_01', '2X2_04', '2X2_02', '2X2_03', '2X2_01'].map((s) => `MDL_${kind}${s}`);
const GROUPS = [
  ['Hull', [...hulls('FERMA'), 'MDL_FERMA2X2_01:filled', 'MDL_FERMA2X1_01:filled']],
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
  'MDL_FERMA2X1_01:filled': '1x2 FILLED',
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
  MDL_MISSILE_DRUM_01: 'MISSILE DRUM', MDL_FCR_03: 'FCR ?', MDL_LRRADIO_01: 'ARRAY',
};
const partName = (oid) => {
  const n = STRINGS[oid];
  return n && n !== '-' ? n : oid.replace(/^MDL_/, '').replace(/_/g, ' ').toLowerCase();
};
// Small modules (and the filled 2x1 hull) the library shows and hands out turned a quarter clockwise.
const TURNED = new Set(['MDL_FUEL_01', 'MDL_GENERATOR_02', 'MDL_QUARTERS_02', 'MDL_AMMO', 'MDL_FSS_02', 'MDL_BOMB_01',
  'MDL_FERMA2X1_01:filled']);
// Library items: { key, oid, raw (template), angle, name }. A part comes out of the library at `angle`: its
// template's (the aircraft, taken from designs, are turned a quarter there), TURNED a quarter more.
export const trayItem = (key) => {
  const [oid, filled] = key.split(':');
  const raw = PART_TEMPLATES[oid];
  const angle = (raw.m_angle ?? 0) + (TURNED.has(key) ? Math.PI / 2 : 0);
  return { key, oid, raw: filled ? filledHull(raw) : raw, angle, name: LABELS[key] ?? partName(oid) };
};
const trayGroups = new Map(GROUPS.map(([g, keys]) => [g, keys.filter((k) => PART_TEMPLATES[k.split(':')[0]]).map(trayItem)]));
// All: every part of the other tabs, tab by tab, in a tray that wraps and scrolls (its height dragged by the tab row).
const ALL = 'All';
const allItems = [...trayGroups.values()].flat();

let tab = 'Hull';
let lastTab = 'Hull';   // the tab before All, which All's button goes back to
const thumbs = [];
export function buildTray() {
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
    el.dataset.key = item.key;
    const c = document.createElement('canvas');
    const label = document.createElement('span');
    label.textContent = item.name;
    el.append(c, label);
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (S.held) return deleteHeld();   // putting a part back in the library deletes it
      updatePointer(e);
      const p = new BuildPart(item.oid, pointer.wx, pointer.wy, item.angle, item.raw);
      S.trayPress = { cx: e.clientX, cy: e.clientY };
      S.selection.clear();
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
  trayBar.replaceChildren(tab === ALL && !on ? '↕ library' : `${on ? '▴' : '▾'} library`, hotkeyHint('L'));
}
export function setCollapsed(on) {
  document.querySelector('footer').classList.toggle('collapsed', on);
  labelTrayBar();
  try { localStorage.setItem('shipbuilder.trayCollapsed', on ? '1' : ''); } catch { /* storage may be off */ }
}

try { setCollapsed(localStorage.getItem('shipbuilder.trayCollapsed') === '1'); } catch { setCollapsed(false); }

// While parts are in hand the library is a bin: dropped there, they're deleted. Dropped on its prune bin (at the
// right), every part not connected to the bridge goes with them. The prune bin shows once the parts have been
// off the library, so a part just taken from it can't land there straight away.
const pruneBin = $('prune-bin');
const inside = (el, x, y) => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
};
/** What's at a page point (client px) to drop parts on: 'prune', 'bin' or null. */
export const binAt = (x, y) => (inside(pruneBin, x, y) ? 'prune' : inside(footer, x, y) ? 'bin' : null);
/** Light the bin the parts in hand are over (binAt's; null: neither, and the prune bin may show from now on). */
export function markBin(bin) {
  if (!bin) footer.classList.add('prune-ready');
  footer.classList.toggle('over', bin === 'bin');
  footer.classList.toggle('over-prune', bin === 'prune');
}
/** Delete the held parts, dropped on `bin` (binAt's). */
export const trashHeld = (bin) => (bin === 'prune' ? pruneUnconnected(true) : deleteHeld());
footer.addEventListener('pointerdown', (e) => {
  if (e.button === 0 && S.held && S.mode === 'carry') { e.preventDefault(); trashHeld(binAt(e.clientX, e.clientY)); }
});

// Small modules drawn at the block scale (as big as a 1x1 hull) rather than filling their box.
const TRUE_SIZE = new Set(['MDL_MISSILE_03', 'MDL_EVAC', 'MDL_KAZ', 'MDL_TORPEDO_300', 'MDL_FLARES']);
// Thumbnails are drawn from an image of the part at the atlas' own resolution, made on first show and reused: in
// colour, shaded like the ship (bakeShaded); as a blueprint, its sprites snapped to whole pixels (renderShip's snap).
const thumbBakes = new Map(), thumbBlueprints = new Map();   // (blueprints: a map per atlas)
function blueprintImage(view) {
  const b = shipRenderBounds(view, BLUEPRINT_ART), s = PX_PER_UNIT, pad = 2;
  if (!b.w || !b.h) return null;
  const x = Math.ceil(pad - b.x0 * s), y = Math.ceil(pad - b.y0 * s);
  const canvas = makeCanvas(Math.ceil(x + b.x1 * s) + pad, Math.ceil(y + b.y1 * s) + pad);
  renderShip(canvas.getContext('2d'), view, atlasNow(), {
    scale: s, x, y, wireColor: wireColor(), snap: true, ...BLUEPRINT_ART, badgeColors: badgeColors(), badgeSize: 2,
  });
  return { canvas, x0: -x / s, y0: -y / s, scale: s };
}
/**
 * Draw an image of a part (`b`: { canvas, x0, y0, scale }) at `scale` px per metre with the design origin at (x, y),
 * on whole pixels. Magnified, it's sharp bilinear: blown up a whole number of times without smoothing, then smoothed
 * down the rest of the way, so texels stay crisp squares with only a pixel of blend at their edges (bilinear on its
 * own blurs each one across its neighbours).
 */
function drawSharp(g, b, scale, x, y) {
  const k = scale / b.scale, { width: w, height: h } = b.canvas;
  let src = b.canvas;
  if (k > 1) {
    const m = Math.ceil(k - 1e-6);
    src = makeCanvas(w * m, h * m);
    const sg = src.getContext('2d');
    sg.imageSmoothingEnabled = false;
    sg.drawImage(b.canvas, 0, 0, w * m, h * m);
  }
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, Math.round(x + b.x0 * scale), Math.round(y + b.y0 * scale), Math.round(w * k), Math.round(h * k));
}
/** A part's image (drawSharp's) in the current look, made on first use. */
function thumbImage(key, view) {
  if (!S.colour && !thumbBlueprints.has(atlasNow())) thumbBlueprints.set(atlasNow(), new Map());
  const cache = S.colour ? thumbBakes : thumbBlueprints.get(atlasNow());
  if (!cache.has(key)) cache.set(key, S.colour ? bakeShaded(view, atlas, SHADING) : blueprintImage(view));
  return cache.get(key);
}
/** Where an image (drawSharp's) has drawn pixels, in design metres (measured once); null: none. */
function inkBounds(b) {
  if (b.ink !== undefined) return b.ink;
  const { width: w, height: h } = b.canvas, px = b.canvas.getContext('2d').getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] < 16) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  const s = b.scale;
  b.ink = x1 < 0 ? null : { x0: b.x0 + x0 / s, y0: b.y0 + y0 / s, x1: b.x0 + (x1 + 1) / s, y1: b.y0 + (y1 + 1) / s };
  return b.ink;
}
export function drawThumbs() {
  const k = window.devicePixelRatio || 1;
  for (const [c, item] of thumbs) {
    const { oid, key } = item;
    c.width = 90 * k; c.height = 88 * k;
    const g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    const part = new BuildPart(oid, 0, 0, item.angle, item.raw);
    const b = thumbImage(key, new BuildModel({ parts: [part] }).view()), ink = b && inkBounds(b);
    if (!ink) continue;
    // Room for the drawn pixels about (cx, cy), a pixel in from the edges.
    const fit = (cx, cy) => Math.min((c.width / 2 - k) / Math.max(cx - ink.x0, ink.x1 - cx),
      (c.height / 2 - k) / Math.max(cy - ink.y0, ink.y1 - cy));
    const f = part.bounds(), fw = (f.x1 - f.x0) / GRID, fh = (f.y1 - f.y0) / GRID;
    const blocks = TRUE_SIZE.has(oid) || (!part.mounted && [fw, fh].every((v) => v > 0.5 && Math.abs(v - Math.round(v)) < 0.25));
    // Grid-sized structure (hull, armor...) is sized by its block footprint so blocks compare: a 2x2 fills the
    // box, a 1x1 half of it. So are TRUE_SIZE modules. Anything else fills its box, fit to its drawn pixels
    // (sprite rects have uneven margins); so are blocks as far as their art would be cut off otherwise.
    let cx = (f.x0 + f.x1) / 2, cy = (f.y0 + f.y1) / 2;
    const blockScale = (0.82 * Math.min(c.width, c.height)) / (GRID * Math.max(2, Math.round(fw), Math.round(fh)));
    let s = blocks ? blockScale : Infinity;
    if (fit(cx, cy) < s) {
      cx = (ink.x0 + ink.x1) / 2; cy = (ink.y0 + ink.y1) / 2;
      s = Math.min(s, fit(cx, cy));
    }
    drawSharp(g, b, s, c.width / 2 - cx * s, c.height / 2 - cy * s);
  }
}
