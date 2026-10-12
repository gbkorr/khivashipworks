// The parts list: the ship's roles, then its important modules grouped into sections, written on ruled paper (the
// page draws the paper and prints the rows as text: app/panels.js, style.css): one entry per line, the module icon
// (cropped to its picture, without the blank name strip) left of the margin, count and name right of it; section
// titles carry their total ("SENSORS: 3").
import { UI, STRINGS, MODULES } from './data.js';
import { CATEGORY, ROLES } from './stats.js';
import { makeCanvas } from './font.js';

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

/** The list as rows: { title } section headers over their { icon | role, count, name } entries. */
export function ruledRows(stats, sections) {
  const roles = sortedRoles(stats);
  const rows = [];
  if (roles.length) {
    rows.push({ title: 'ROLES' });
    for (const r of roles) rows.push({ role: `role_${r.id.slice(5)}`, count: String(r.value), name: r.label });
  }
  for (const s of sections) {
    rows.push({ title: `${s.title}: ${s.items.reduce((n, it) => n + it.count, 0)}` });
    for (const it of s.items) rows.push({ icon: it.icon, count: `${it.count}x`, name: it.name });
  }
  return rows;
}

// The icons' size: fitted into the 26px line, in the 48px of paper left of the margin rule (both style.css).
const ICON_H = 22, ICON_MAX_W = 36;
const BAND = { y: 25, h: 73 };   // picture band of the 98x98 module icons

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
 * A row's icon (a module's picture band, or a role glyph) on a canvas of its own; null if it has none.
 * The optional `tint` darkens the white role icons to that colour, for light paper.
 */
export function rowIcon(row, ui, tint) {
  const e = UI[row.icon ?? row.role];
  if (!e) return null;
  const band = row.icon ? BAND : { y: 0, h: e.h };
  const w = Math.min(ICON_MAX_W, (e.w / band.h) * ICON_H), k = window.devicePixelRatio || 1;
  const c = makeCanvas(Math.round(w * k), Math.round(ICON_H * k));
  c.style.width = `${w}px`; c.style.height = `${ICON_H}px`;
  const g = c.getContext('2d');
  g.drawImage(row.role && tint ? multiplied(ui, tint) : ui, e.x, e.y + band.y, e.w, band.h, 0, 0, c.width, c.height);
  return c;
}
