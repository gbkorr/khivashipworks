// Vertical parts list: the ship's important modules grouped into sections, each row showing the
// module icon with its count and name as text.
import UI from '../data/ui.json' with { type: 'json' };
import STRINGS from '../data/strings.json' with { type: 'json' };
import MODULES from '../data/modules.json' with { type: 'json' };
import { CATEGORY } from './stats.js';
import { sortedRoles } from './shipcard.js';
import { drawText, measureText, makeCanvas } from './font.js';

/** Sections in display order; a module goes into the first section whose category mask matches. */
export const PART_SECTIONS = [
  { id: 'weapons', title: 'WEAPONS', mask: CATEGORY.GUN | CATEGORY.KAZ | CATEGORY.FLARES },
  { id: 'missiles', title: 'MISSILES', mask: CATEGORY.MISSILE | CATEGORY.NUKE | CATEGORY.BOMB },
  { id: 'aircraft', title: 'AIRCRAFT', mask: CATEGORY.CRAFT },
  { id: 'sensors', title: 'SENSORS', mask: CATEGORY.SENSOR | CATEGORY.IRST | CATEGORY.JAMMER },
  { id: 'engines', title: 'ENGINES', mask: CATEGORY.ENGINE },
];

const km = (v) => `${Math.round(v)} km`;
/** One-line summary of what a module contributes. */
function detail(m) {
  if (m.mdl_thrust) return `${Math.round(m.mdl_thrust_map / 1e6)} MN cruise, ${Math.round(m.mdl_thrust / 1e6)} MN max`;
  if (m.mdl_radar && m.mdl_tracking) return `radar ${km(m.mdl_radar)}, ${m.mdl_guiding} miss.`;
  if (m.mdl_radar) return `radar ${km(m.mdl_radar)}`;
  if (m.mdl_elint) return `ELINT ${km(m.mdl_elint * 750)}`;
  if (m.mdl_irst) return `IRST ${km(m.mdl_irst)}`;
  if (m.mdl_jammer) return `jammer ${km(m.mdl_jammer)}`;
  if (m.missile_explosive > 100000) return 'nuclear';
  return '';
}
/** Shorter detail for the one-line ruled list. */
function shortDetail(m) {
  if (m.mdl_thrust) return `${Math.round(m.mdl_thrust_map / 1e6)}/${Math.round(m.mdl_thrust / 1e6)} MN`;
  if (m.mdl_radar && m.mdl_tracking) return `${km(m.mdl_radar)}, ${m.mdl_guiding} msl`;
  return detail(m);
}

/**
 * Important modules grouped by section:
 * [{ id, title, items: [{ oid, icon, name, count, detail, short }] }] (empty sections omitted).
 */
export function partsList(ship, opts = {}) {
  const modules = opts.modules ?? MODULES;
  const lang = opts.lang ?? 'en';
  const sections = PART_SECTIONS.map((s) => ({ ...s, items: [] }));
  const other = { id: 'other', title: 'OTHER', items: [] };
  const seen = new Map();
  for (const p of ship.bodies) {
    const m = modules[p.oid];
    if (!m?.important) continue;
    if (seen.has(p.oid)) { seen.get(p.oid).count++; continue; }
    const item = {
      oid: p.oid, icon: m.icon_name ?? p.oid, count: 1, detail: detail(m), short: shortDetail(m),
      name: STRINGS[lang]?.[p.oid] ?? STRINGS.en[p.oid] ?? p.oid,
    };
    seen.set(p.oid, item);
    (sections.find((s) => (m.category ?? 0) & s.mask) ?? other).items.push(item);
  }
  return [...sections, other].filter((s) => s.items.length);
}

export const PARTS = { width: 270, icon: 56, row: 64, header: 30, gap: 10 };

/** Height of the list for a ship. */
export function partsListHeight(sections) {
  return sections.reduce((h, s) => h + PARTS.header + s.items.length * PARTS.row + PARTS.gap, 0);
}

/**
 * Draw the parts list with its top-left at (x, y).
 * @param opts { ui, fonts, lang, sections (from partsList), width }
 */
export function renderPartsList(ctx, ship, opts = {}) {
  const sections = opts.sections ?? partsList(ship, opts);
  const P = PARTS, w = opts.width ?? P.width;
  const x = opts.x ?? 0;
  let y = opts.y ?? 0;
  const ui = opts.ui;
  let tile = null;
  if (ui) {
    const e = UI.icon_back_02;
    tile = makeCanvas(e.w, e.h, opts);
    const g = tile.getContext('2d');
    g.drawImage(ui, e.x, e.y, e.w, e.h, 0, 0, e.w, e.h);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = '#5a707c';
    g.fillRect(0, 0, e.w, e.h);
  }
  for (const s of sections) {
    // Header: title + rule + total count
    const total = s.items.reduce((n, it) => n + it.count, 0);
    const tw = drawText(ctx, 'dinpro_14_reg', s.title, x, y + 4, '#eae6cc', opts);
    const cnt = String(total);
    drawText(ctx, 'dinpro_14_reg', cnt, x + w, y + 4, '#8fa3ad', { ...opts, align: 'right' });
    ctx.fillStyle = '#5a707c';
    ctx.fillRect(x + tw + 8, y + 13, w - tw - 16 - measureText('dinpro_14_reg', cnt), 1);
    y += P.header;
    for (const it of s.items) {
      if (tile) ctx.drawImage(tile, x, y, P.icon, P.icon);
      const e = UI[it.icon];
      if (e && ui) ctx.drawImage(ui, e.x, e.y, e.w, e.h, x, y, P.icon, P.icon);
      const cw = drawText(ctx, 'dinpro_30_black', `${it.count}x`, x + P.icon + 10, y + 2, '#ffffff', opts);
      const tx = x + P.icon + 10 + Math.max(cw, measureText('dinpro_30_black', '00x')) + 8;
      drawText(ctx, 'dinpro_14_reg', it.name, tx, y + 6, '#ffffff', opts);
      if (it.detail) drawText(ctx, 'dinpro_14_reg', it.detail, tx, y + 26, '#8fa3ad', opts);
      y += P.row;
    }
    y += P.gap;
  }
  return y - (opts.y ?? 0);
}

/** Height of the roles list. */
export const rolesListHeight = (roles) => (roles.length ? PARTS.header + roles.length * 54 + PARTS.gap : 0);

/**
 * ROLES section in the parts-list style: role icon, value and role name.
 * @param opts { ui, fonts, stats (required), x, y, width }
 */
export function renderRolesList(ctx, opts) {
  const roles = sortedRoles(opts.stats);
  if (!roles.length) return 0;
  const P = PARTS, w = opts.width ?? P.width, x = opts.x ?? 0;
  let y = opts.y ?? 0;
  const tw = drawText(ctx, 'dinpro_14_reg', 'ROLES', x, y + 4, '#eae6cc', opts);
  ctx.fillStyle = '#5a707c';
  ctx.fillRect(x + tw + 8, y + 13, w - tw - 8, 1);
  y += P.header;
  for (const r of roles) {
    const e = UI[`role_${r.id.slice(5)}`];
    if (e && opts.ui) ctx.drawImage(opts.ui, e.x, e.y, e.w, e.h, x + 4, y, e.w, e.h);
    drawText(ctx, 'dinpro_30_black', String(r.value), x + P.icon + 10, y + 4, '#ffffff', opts);
    drawText(ctx, 'dinpro_14_reg', r.label, x + P.icon + 10 + measureText('dinpro_30_black', '00x') + 8, y + 14, '#ffffff', opts);
    y += 54;
  }
  return y + P.gap - (opts.y ?? 0);
}

// ---- ruled list ---------------------------------------------------------------------------------
// A compact roles + parts list written on ruled paper: one entry per line, the module icon (cropped
// to its picture, without the blank name strip) left of the margin, count and name right of it; section titles
// carry their total ("SENSORS: 3").

export const RULED = {
  width: 300, line: 26, pad: 8, margin: 48,           // margin = x of the vertical margin rule
  icon: { y: 25, h: 73 },                             // picture band of the 98x98 module icons
  colors: { ink: '#ecf4ff', accent: '#ff8a7a', rule: '#ecf4ff33', marginRule: '#ff8a7a80' },
};

/** Lines (rows) the ruled list needs. */
export const ruledListLines = (stats, sections) =>
  (sortedRoles(stats).length ? 1 + sortedRoles(stats).length : 0) + sections.reduce((n, s) => n + 1 + s.items.length, 0);

/** `text` cut to `w` px with an ellipsis ('' if not even that fits). */
function fit(font, text, w) {
  if (measureText(font, text) <= w) return text;
  for (let n = text.length - 1; n > 0; n--) {
    const t = `${text.slice(0, n).trimEnd()}...`;
    if (measureText(font, t) <= w) return t;
  }
  return '';
}

/**
 * Draw the ruled list with its top-left at (x, y); returns its height.
 * @param opts { stats (required), ui, fonts, sections (from partsList), width, lines (draw the rules; default true), colors }
 */
export function renderRuledList(ctx, ship, opts) {
  const R = RULED, L = R.line, w = opts.width ?? R.width, col = { ...R.colors, ...opts.colors };
  const x = opts.x ?? 0, y0 = opts.y ?? 0;
  const sections = opts.sections ?? partsList(ship, opts);
  const roles = sortedRoles(opts.stats);
  const rows = [];
  if (roles.length) {
    rows.push({ title: 'ROLES' });
    for (const r of roles) rows.push({ role: `role_${r.id.slice(5)}`, count: String(r.value), name: r.label });
  }
  for (const s of sections) {
    rows.push({ title: `${s.title}: ${s.items.reduce((n, it) => n + it.count, 0)}` });
    for (const it of s.items) rows.push({ icon: it.icon, count: `${it.count}x`, name: it.name });
  }
  const FONT = 'dinpro_14_reg';
  const textY = L - 20, countW = measureText(FONT, '00x');
  const left = x + R.margin + 6, right = x + w - R.pad;
  const ui = opts.ui;
  rows.forEach((r, i) => {
    const y = y0 + i * L;
    if (opts.lines !== false) {
      ctx.fillStyle = col.rule;
      ctx.fillRect(x, y + L - 1, w, 1);
    }
    if (r.title) {
      drawText(ctx, FONT, r.title, left, y + textY, col.accent, opts);
      return;
    }
    // Icon, fitted into the line left of the margin.
    const e = ui && UI[r.icon ?? r.role];
    if (e) {
      const band = r.icon ? R.icon : { y: 0, h: e.h };
      const ih = L - 4, iw = Math.min(R.margin - R.pad - 4, (e.w / band.h) * ih);
      ctx.drawImage(ui, e.x, e.y + band.y, e.w, band.h, x + R.margin - 4 - iw, y + 2, iw, ih);
    }
    drawText(ctx, FONT, r.count, left + countW, y + textY, col.ink, { ...opts, align: 'right' });
    const nx = left + countW + 8;
    drawText(ctx, FONT, fit(FONT, r.name, right - nx), nx, y + textY, col.ink, opts);
  });
  if (opts.lines !== false && rows.length) {
    ctx.fillStyle = col.marginRule;
    ctx.fillRect(x + R.margin, y0, 1, rows.length * L);
  }
  return rows.length * L;
}
