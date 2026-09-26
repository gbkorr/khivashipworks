// New-game ship cards and the ship description strip (main modules / description / roles).
// Reimplements FUN_140068920 (card), FUN_14007c400 (card text), FUN_14007bfc0 (main modules) and
// FUN_140209d30 (description panel) of Highfleet.exe 1.16.3.
import UI from '../data/ui.json' with { type: 'json' };
import STRINGS from '../data/strings.json' with { type: 'json' };
import MODULES from '../data/modules.json' with { type: 'json' };
import { computeStats, ROLES } from './stats.js';
import { renderShip, shipRenderBounds } from './render.js';
import { drawText, measureText, fontHeight, makeCanvas } from './font.js';

export const CARD = { width: 394, height: 249 };   // background sprite incl. shadow; card face is 380x233

const COLORS = {
  cream: '#fffbdb',     // {color=4294966235}
  sand: '#eae6cc',      // {color=4293584588}
  red: '#e06868',       // {color=4292896872}
  white: '#ffffff',
  outline: '#fffbdb',
  tile: '#5a707c',
  panelBg: '#1f2d34',
  frame: '#e6e6e6',
};

/** Card colour by purpose (FUN_140068920). */
export const CARD_BACKGROUND = {
  ATTACK: 'shipcard_red', INTERCEPTOR: 'shipcard_orange', CARRIER: 'shipcard_blue',
  STRATEGIC: 'shipcard_black', AUXILIARY: 'shipcard_green',
};

const tr = (key, lang = 'en') => STRINGS[lang]?.[key] ?? STRINGS.en[key] ?? key;
const round10 = (v) => Math.round(v / 10) * 10;

function sprite(ctx, ui, name, x, y, w, h) {
  const e = UI[name];
  if (!e || !ui) return;
  ctx.drawImage(ui, e.x, e.y, e.w, e.h, x, y, w ?? e.w, h ?? e.h);
}

/** A white-on-transparent UI sprite tinted to `color`. */
function tintedSprite(name, ui, color, opts) {
  const e = UI[name];
  const c = makeCanvas(e.w, e.h, opts);
  const g = c.getContext('2d');
  g.drawImage(ui, e.x, e.y, e.w, e.h, 0, 0, e.w, e.h);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, e.w, e.h);
  return c;
}

// ---- data ---------------------------------------------------------------------------------

/** The card's text block as lines (main block, blank line, SENSORS block) — FUN_14007c400. */
export function cardText(stats, lang = 'en') {
  const s = stats;
  const km = tr('KM', lang).toLowerCase(), kmh = tr('KMH', lang).toLowerCase();
  const lines = [
    `${tr('TWR_STAT', lang)}: ${Math.trunc(s.twrFull)}`,
    `${tr('SPEED_STAT', lang)}: ${round10(s.speedKmh)} ${kmh}`,
    `${tr('RANGE_STAT', lang)}: ${round10(s.rangeKm)} ${km}`,
  ];
  const sensors = [];
  if (s.radar) sensors.push(`${tr('RADAR_STAT', lang)}: ${round10(s.radar)} ${km}`);
  if (s.tracking) sensors.push(`${tr('TRACKING_STAT', lang)}: ${round10(s.tracking)} ${km}`);
  if (s.guidance) sensors.push(`${tr('GUIDING_STAT', lang)}: ${s.guidance} ${tr('MISS', lang)}`);
  if (s.irst) sensors.push(`${tr('IRST_STAT', lang)}: ${round10(s.irst)} ${km}`);
  if (s.elint) sensors.push(`${tr('ELINT_STAT', lang)}: ${round10(s.elintKm)} ${km}`);
  if (s.jammer) sensors.push(`${tr('JAMMER_STAT', lang)}: ${round10(s.jammer)} ${km}`);
  if (sensors.length) lines.push('', `${tr('SENSORS_STAT', lang)}:`, ...sensors);
  return lines;
}

/** Important modules with counts, in order of first appearance (FUN_14007bfc0). */
export function mainModules(ship, modules = MODULES, lang = 'en') {
  const map = new Map();
  for (const p of ship.bodies) {
    const m = modules[p.oid];
    if (!m?.important) continue;
    const e = map.get(p.oid);
    if (e) e.count++;
    else map.set(p.oid, { oid: p.oid, icon: m.icon_name ?? p.oid, name: tr(p.oid, lang), count: 1 });
  }
  return [...map.values()];
}

/** Non-zero roles, highest first (ties keep the game's role order). */
export function sortedRoles(stats) {
  return ROLES.map(([id], i) => ({ id, value: stats.roles.values[id], i }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value || a.i - b.i)
    .map(({ id, value }) => ({ id, value, label: tr(`LABLE_${id}`) }));
}

/** Localised class names for a stats object. */
export function className(stats, lang = 'en') {
  const c = stats.class;
  if (!c.purpose) return { long: tr('GROUND_VEHICLE_CLASS', lang), short: tr('GROUND_VEHICLE_ABR_CLASS', lang) };
  // The game uses LIGHT_CRUISER_CLASS for the abbreviation as well.
  const sizeAbr = c.size === 'LIGHT_CRUISER' ? 'LIGHT_CRUISER_CLASS' : `${c.size}_ABR_CLASS`;
  return {
    long: `${tr(`${c.purpose}_CLASS`, lang)} ${tr(`${c.size}_CLASS`, lang)}`,
    short: `${tr(`${c.purpose}_ABR_CLASS`, lang)} ${tr(sizeAbr, lang)}`,
  };
}

// ---- ship picture with outline --------------------------------------------------------------

/** Ship rendered to its own canvas with a light outline (the card image). */
export function shipPicture(ship, atlas, scale, opts = {}) {
  const outline = opts.outline ?? 2;
  const b = shipRenderBounds(ship);
  const pad = outline + 1;
  const w = Math.ceil(b.w * scale) + 2 * pad, h = Math.ceil(b.h * scale) + 2 * pad;
  const img = makeCanvas(w, h, opts);
  renderShip(img.getContext('2d'), ship, atlas, { ...opts, partScale: 1, scale, x: pad - b.x0 * scale, y: pad - b.y0 * scale });
  return { canvas: outline ? outlineImage(img, outline, opts.outlineColor, opts) : img, bounds: b, pad };
}

/** `img` with a light outline `outline` px wide around its opaque pixels (drawn inside its own size). */
export function outlineImage(img, outline = 2, color = COLORS.outline, opts = {}) {
  const w = img.width, h = img.height;
  const sil = makeCanvas(w, h, opts);
  const sg = sil.getContext('2d');
  sg.drawImage(img, 0, 0);
  sg.globalCompositeOperation = 'source-in';
  sg.fillStyle = color ?? COLORS.outline;
  sg.fillRect(0, 0, w, h);
  const out = makeCanvas(w, h, opts);
  const og = out.getContext('2d');
  for (let dy = -outline; dy <= outline; dy++) {
    for (let dx = -outline; dx <= outline; dx++) {
      if (dx * dx + dy * dy <= outline * outline + 1) og.drawImage(sil, dx, dy);
    }
  }
  og.drawImage(img, 0, 0);
  return out;
}

// ---- card -----------------------------------------------------------------------------------

/**
 * Draw a new-game ship card (394x249 incl. shadow) with its top-left at (x, y).
 * @param opts { atlas, ui, fonts, stats, lang, flagship, outline, createCanvas }
 */
export function renderShipCard(ctx, ship, opts = {}) {
  const stats = opts.stats ?? computeStats(ship);
  const lang = opts.lang ?? 'en';
  const x = opts.x ?? 0, y = opts.y ?? 0;
  const cx = x + UI.shipcard_red.hx, cy = y + UI.shipcard_red.hy;   // card centre

  sprite(ctx, opts.ui, CARD_BACKGROUND[stats.class.purpose] ?? 'shipcard_black', x, y);

  // Ship picture: 3.5 px/m, shrunk to fit 210x160 (by the ship's SIZE box), centred at (-70, +10).
  const ppm = 3.5;
  const fit = Math.min(1, 210 / (stats.size.w * ppm), 160 / (stats.size.h * ppm));
  if (opts.atlas) {
    const pic = shipPicture(ship, opts.atlas, ppm * fit, opts);
    // Centre the SIZE box (not the sprite bounds, which include antennas) on the anchor.
    const sb = stats.sizeBox;
    const scale = ppm * fit;
    const px = cx - 70 - ((sb.x0 + sb.w / 2) - pic.bounds.x0) * scale - pic.pad;
    const py = cy + 10 - ((sb.y0 + sb.h / 2) - pic.bounds.y0) * scale - pic.pad;
    ctx.drawImage(pic.canvas, Math.round(px), Math.round(py));
  }

  // Caption (ship name, upper case), optional flagship star.
  const name = (ship.name || '').toUpperCase();
  // {max=220}: squeeze long names horizontally to 220 px.
  const fullW = measureText('dinpro_30_black', name);
  const sq = Math.min(1, 220 / Math.max(1, fullW));
  ctx.save();
  ctx.translate(cx - 175, cy - 106);
  ctx.scale(sq, 1);
  drawText(ctx, 'dinpro_30_black', name, 0, 0, COLORS.cream, opts);
  ctx.restore();
  const nameW = fullW * sq;
  if (opts.flagship) sprite(ctx, opts.ui, 'flagship_star', cx - 175 + nameW + 6, cy - 102);

  // Text block
  const lh = fontHeight('flash_large') - 1;
  let ty = cy - 90;
  for (const line of cardText(stats, lang)) {
    if (line) drawText(ctx, 'flash_large', line, cx + 50, ty, COLORS.cream, opts);
    ty += lh;
  }

  // Price + coin, right-aligned at (+170, +60)
  const coin = 27;
  const priceRight = cx + 170 - coin - 2;
  drawText(ctx, 'dinpro_30_black', String(Math.trunc(stats.price)), priceRight, cy + 60, COLORS.cream,
    { ...opts, align: 'right' });
  sprite(ctx, opts.ui, 'coin_01', cx + 170 - coin, cy + 60 + 4, coin, coin);
  return stats;
}

// ---- description strip -------------------------------------------------------------------------

function frame(ctx, x, y, w, h, title, opts) {
  ctx.save();
  ctx.strokeStyle = COLORS.frame;
  ctx.lineWidth = 3;
  const tw = title ? measureText('vcr_12', title) + 12 : 0;
  const mx = x + w / 2;
  ctx.beginPath();
  ctx.moveTo(mx - tw / 2, y + 1.5); ctx.lineTo(x + 1.5, y + 1.5); ctx.lineTo(x + 1.5, y + h - 1.5);
  ctx.lineTo(x + w - 1.5, y + h - 1.5); ctx.lineTo(x + w - 1.5, y + 1.5); ctx.lineTo(mx + tw / 2, y + 1.5);
  ctx.stroke();
  ctx.restore();
  if (title) drawText(ctx, 'vcr_12', title, mx, y - 4, COLORS.frame, { ...opts, align: 'center' });
}

const TILE = 98, TILE_STEP = 110, TILES_PER_ROW = 5, ROLE_ROW = 56;

/** Size of the description strip for a ship. */
export function shipInfoLayout(ship, stats, opts = {}) {
  const mods = mainModules(ship, opts.modules, opts.lang);
  const roles = sortedRoles(stats);
  const modRows = Math.max(1, Math.ceil(mods.length / TILES_PER_ROW));
  const modsW = opts.modules === false ? 0 : 25 * 2 + TILES_PER_ROW * TILE_STEP - (TILE_STEP - TILE);
  const nameW = Math.max(measureText('dinpro_30_black', ship.name || ''),
    measureText('fixed_20', className(stats, opts.lang).long));
  const descW = Math.max(213, nameW + 40), rolesW = 146, gap = 13;
  const height = Math.max(185, 44 + modRows * TILE_STEP, 30 + roles.length * ROLE_ROW);
  const width = (modsW ? modsW + gap : 0) + descW + gap + rolesW;
  return { width, height, mods, roles, modsW, descW, rolesW, gap };
}

/**
 * Draw the MAIN MODULES / DESCRIPTION / ROLES strip with its top-left at (x, y).
 * @param opts { ui, fonts, stats, lang, modules: false to omit the modules box, background }
 */
export function renderShipInfo(ctx, ship, opts = {}) {
  const stats = opts.stats ?? computeStats(ship);
  const lang = opts.lang ?? 'en';
  const L = shipInfoLayout(ship, stats, opts);
  let x = opts.x ?? 0;
  const y = opts.y ?? 0, h = L.height;
  if (opts.background !== null) {
    ctx.fillStyle = opts.background ?? COLORS.panelBg;
    ctx.fillRect(x, y, L.width, h);
  }

  if (L.modsW) {
    frame(ctx, x, y, L.modsW, h, tr('MAINMODULES_LABLE', lang), opts);
    const tile = opts.ui ? tintedSprite('icon_back_02', opts.ui, COLORS.tile, opts) : null;
    L.mods.forEach((m, i) => {
      const tx = x + 25 + (i % TILES_PER_ROW) * TILE_STEP;
      const ty = y + 44 + Math.floor(i / TILES_PER_ROW) * TILE_STEP;
      if (tile) ctx.drawImage(tile, tx, ty);
      sprite(ctx, opts.ui, m.icon, tx, ty);
      // Label (up to two lines) in the top of the tile.
      // The game breaks names at the first space ("IRS-1 / Mars").
      const sp = m.name.indexOf(' ');
      const lines = sp > 0 ? [m.name.slice(0, sp), m.name.slice(sp + 1)] : [m.name];
      lines.forEach((l, k) => drawText(ctx, 'vcr_12', l, tx + TILE / 2, ty + (lines.length > 1 ? 2 : 6) + k * 10, COLORS.white,
        { ...opts, align: 'center' }));
      if (m.count > 1) drawText(ctx, 'vcr_12', String(m.count), tx + 7, ty + TILE - 20, COLORS.white, opts);
    });
    x += L.modsW + L.gap;
  }

  // Description
  frame(ctx, x, y, L.descW, h, tr('SHIPDESC_LABLE', lang), opts);
  const mid = x + L.descW / 2;
  drawText(ctx, 'dinpro_30_black', ship.name || '', mid, y + 22, COLORS.sand, { ...opts, align: 'center' });
  drawText(ctx, 'fixed_20', className(stats, lang).long, mid, y + 55, COLORS.red, { ...opts, align: 'center' });
  const price = String(Math.trunc(stats.price));
  const coin = 27, pw = measureText('dinpro_30_black', price) + 2 + coin;
  drawText(ctx, 'dinpro_30_black', price, mid - pw / 2, y + 80, COLORS.cream, opts);
  sprite(ctx, opts.ui, 'coin_01', mid + pw / 2 - coin, y + 84, coin, coin);
  x += L.descW + L.gap;

  // Roles
  frame(ctx, x, y, L.rolesW, h, tr('ROLES_LABLE', lang), opts);
  L.roles.forEach((r, i) => {
    const ry = y + 22 + i * ROLE_ROW;
    drawText(ctx, 'dinpro_45_black', String(r.value), x + 70, ry - 4, COLORS.white, { ...opts, align: 'right' });
    sprite(ctx, opts.ui, `role_${r.id.slice(5)}`, x + 80, ry);
  });
  return { stats, width: L.width, height: h };
}

/** Card with the description strip underneath. Returns { width, height } needed via previewSize(). */
export function previewLayout(ship, stats, opts = {}) {
  const info = shipInfoLayout(ship, stats, opts);
  const pad = opts.padding ?? 16;
  return {
    width: Math.max(CARD.width, info.width) + 2 * pad,
    height: CARD.height + 12 + info.height + 2 * pad,
    pad, info,
  };
}

/** Render card + description strip on a dark background (like the new-game screen). */
export function renderShipPreview(ctx, ship, opts = {}) {
  const stats = opts.stats ?? computeStats(ship);
  const L = previewLayout(ship, stats, opts);
  ctx.fillStyle = opts.background ?? COLORS.panelBg;
  ctx.fillRect(0, 0, L.width, L.height);
  renderShipCard(ctx, ship, { ...opts, stats, x: L.pad + (L.width - 2 * L.pad - CARD.width) / 2, y: L.pad });
  renderShipInfo(ctx, ship, {
    ...opts, stats, background: null,
    x: L.pad + (L.width - 2 * L.pad - L.info.width) / 2, y: L.pad + CARD.height + 12,
  });
  return stats;
}
