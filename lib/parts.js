// The parts list: the ship's roles, then its important modules grouped into sections, written on ruled paper (the
// page draws the paper in CSS): one entry per line, the module icon (cropped to its picture, without the blank name
// strip) left of the margin, count and name right of it; section titles carry their total ("SENSORS: 3").
import { UI, STRINGS, MODULES } from './data.js';
import { CATEGORY, ROLES } from './stats.js';
import { drawText, makeCanvas, measureText } from './font.js';

/** Sections in display order; a module goes into the first section whose category mask matches. */
const PART_SECTIONS = [
  { id: 'weapons', title: 'WEAPONS', mask: CATEGORY.GUN | CATEGORY.KAZ | CATEGORY.FLARES },
  { id: 'missiles', title: 'MISSILES', mask: CATEGORY.MISSILE | CATEGORY.NUKE | CATEGORY.BOMB },
  { id: 'aircraft', title: 'AIRCRAFT', mask: CATEGORY.CRAFT },
  { id: 'sensors', title: 'SENSORS', mask: CATEGORY.SENSOR | CATEGORY.IRST | CATEGORY.JAMMER },
  { id: 'engines', title: 'ENGINES', mask: CATEGORY.ENGINE },
];

const tr = (key) => STRINGS[key] ?? key;

/** Non-zero roles, highest first (ties keep the game's role order). */
function sortedRoles(stats) {
  return ROLES.map(([id], i) => ({ id, value: stats.roles.values[id], i }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value || a.i - b.i)
    .map(({ id, value }) => ({ id, value, label: tr(`LABLE_${id}`) }));
}

/**
 * Important modules grouped by section:
 * [{ id, title, items: [{ oid, icon, name, count }] }] (empty sections omitted).
 */
export function partsList(ship) {
  const sections = PART_SECTIONS.map((s) => ({ ...s, items: [] }));
  const other = { id: 'other', title: 'OTHER', items: [] };
  const seen = new Map();
  for (const p of ship.bodies) {
    const m = MODULES[p.oid];
    if (!m?.important) continue;
    if (seen.has(p.oid)) { seen.get(p.oid).count++; continue; }
    const item = { oid: p.oid, icon: m.icon_name ?? p.oid, count: 1, name: tr(p.oid) };
    seen.set(p.oid, item);
    (sections.find((s) => (m.category ?? 0) & s.mask) ?? other).items.push(item);
  }
  return [...sections, other].filter((s) => s.items.length);
}

export const RULED = {
  line: 26, pad: 8, margin: 48,                       // margin = x of the vertical margin rule
  icon: { y: 25, h: 73 },                             // picture band of the 98x98 module icons
  colors: { ink: '#ecf4ff', accent: '#ff9d8f' },
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

const multipliedCache = new Map();
/** `sheet` multiplied by `color` (white turns that colour, its greys darker), made once per colour. */
function multiplied(sheet, color) {
  if (!multipliedCache.has(color)) {
    const c = makeCanvas(sheet.width, sheet.height), g = c.getContext('2d');
    g.drawImage(sheet, 0, 0);
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = color;
    g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(sheet, 0, 0);
    multipliedCache.set(color, c);
  }
  return multipliedCache.get(color);
}

/**
 * Draw the ruled list's entries with its top-left at the context's origin; returns its height.
 * @param opts { stats (required), ui, fonts, sections (from partsList), width, colors (default RULED.colors; its
 *               optional `roles` darkens the white role icons to that colour, for light paper) }
 */
export function renderRuledList(ctx, opts) {
  const R = RULED, L = R.line, w = opts.width, col = opts.colors ?? R.colors;
  const roles = sortedRoles(opts.stats);
  const rows = [];
  if (roles.length) {
    rows.push({ title: 'ROLES' });
    for (const r of roles) rows.push({ role: `role_${r.id.slice(5)}`, count: String(r.value), name: r.label });
  }
  for (const s of opts.sections) {
    rows.push({ title: `${s.title}: ${s.items.reduce((n, it) => n + it.count, 0)}` });
    for (const it of s.items) rows.push({ icon: it.icon, count: `${it.count}x`, name: it.name });
  }
  const FONT = 'dinpro_14_reg';
  const textY = L - 20, countW = measureText(FONT, '00x');
  const left = R.margin + 6, right = w - R.pad;
  rows.forEach((r, i) => {
    const y = i * L;
    if (r.title) {
      drawText(ctx, FONT, r.title, left, y + textY, col.accent, opts);
      return;
    }
    // Icon, fitted into the line left of the margin.
    const e = UI[r.icon ?? r.role];
    if (e) {
      const band = r.icon ? R.icon : { y: 0, h: e.h };
      const ih = L - 4, iw = Math.min(R.margin - R.pad - 4, (e.w / band.h) * ih);
      const sheet = r.role && col.roles ? multiplied(opts.ui, col.roles) : opts.ui;
      ctx.drawImage(sheet, e.x, e.y + band.y, e.w, band.h, R.margin - 4 - iw, y + 2, iw, ih);
    }
    drawText(ctx, FONT, r.count, left + countW, y + textY, col.ink, { ...opts, align: 'right' });
    const nx = left + countW + 8;
    drawText(ctx, FONT, fit(FONT, r.name, right - nx), nx, y + textY, col.ink, opts);
  });
  return rows.length * L;
}
