// Stat cards of saved designs (for the menus' previews and the gallery), and the gallery: every card of a folder in
// a popup, sorted and filtered, exported as a PDF.
import { STRINGS } from '../lib/data.js';
import { makeCanvas } from '../lib/font.js';
import { SHADING, bakeShadedAsync } from '../lib/shading.js';
import { encodeDesign } from '../lib/sharecode.js';
import { Ship } from '../lib/ship.js';
import { CARD } from '../lib/statcard.js';
import { MASS_CLASSES, PURPOSES, ROLES, computeStats } from '../lib/stats.js';
import { $ } from './state.js';
import { atlas } from './assets.js';
import { connected } from './edit.js';
import { CARD_SCALE, drawCard } from './panels.js';
import { safeFileName, toast } from './dialogs.js';
import { downloadFolder, saveFile } from './files.js';
import { pdf } from './formats.js';
import { loadShip } from './library.js';
import { closeAllMenus } from './menus.js';
import { designOf, freeName } from './store.js';

// Hovering a design shows its stat card beside the list: drawn a step at a time, and dropped if the pointer leaves
// first. Drawn once per saved version (and name), then kept as a PNG (an object URL; a 3x canvas would be a few MB),
// for the hover and the gallery alike.
const previewCards = new Map();     // folder + name -> { key, card: Promise<{ url, info } | null>, done, aborted }
const cardId = (ship) => `${ship.folder}\n${ship.name}`;

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
  const pic = await bakeShadedAsync(placed.view(), atlas, SHADING, { cancelled });
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
  name, price: s.price, combat: s.combatValue, speed: s.speedKmh,
  range: s.fuelCapacity > 0 ? s.rangeKm : 0, mass: s.mass, parts: s.partCount,
  roles: ROLES.map(([id]) => id).filter((id) => s.roles.values[id] > 0), purpose: s.class.purpose ?? 'GROUND_VEHICLE',
  size: s.class.purpose ? s.class.size : null,
});
/** The card of a saved design ({ url: an object URL of its PNG, info: cardInfo }), drawn a step at a time; null if
 * it was aborted (see abortCard) first. */
export function cardOfShip(ship) {
  const id = cardId(ship), key = ship.saved, got = previewCards.get(id);
  if (got?.key === key && !got.aborted) return got.card;
  got?.card.then((c) => c && URL.revokeObjectURL(c.url), () => {});   // an older version's
  const entry = { key, done: false, aborted: false };
  const cancelled = () => entry.aborted;
  entry.card = drawShipCard(ship, cancelled).then(async (c) => c && {
    url: URL.createObjectURL(await new Promise((ok) => c.canvas.toBlob(ok))), info: cardInfo(c.stats, c.name),
  });
  entry.card.then((c) => { entry.done = true; if (!c && previewCards.get(id) === entry) previewCards.delete(id); },
    () => previewCards.delete(id));
  previewCards.set(id, entry);
  return entry.card;
}
/** Stop drawing a design's card, if it isn't done yet. */
export function abortCard(ship) {
  const entry = previewCards.get(cardId(ship));
  if (!entry || entry.done) return;
  entry.aborted = true;
  previewCards.delete(cardId(ship));
}

// ---- the gallery: every card of a folder, three to a row, in a popup ----------------------------------------------
// The cards come from the hover's cache (cardOfShip), drawn there one after another under a progress bar, and are
// shown once all are, sorted and filtered by what cardInfo keeps. Closed early, those drawn so far stay cached for
// next time. A card loads its design; Export makes a PDF of the cards shown, with their designs attached.
export const gallery = $('gallery');
const GALLERY_SORTS = [
  ['price', 'Price'], ['combat', 'Combat value'],
  ['speed', 'Cruise speed'], ['range', 'Range'], ['mass', 'Mass'], ['parts', 'Parts'], ['name', 'Name'],
];
const classLabel = (id) => STRINGS[`${id}_CLASS`] ?? id;
const PURPOSE_ORDER = [...Object.values(PURPOSES).map(([id]) => id), 'GROUND_VEHICLE'];
const SIZE_ORDER = MASS_CLASSES.map(([, id]) => id);
const gallerySort = { key: 'price', desc: false };   // kept from one gallery to the next
let galleryRun = null;              // { cancelled, ship (the one being drawn) } of the one open
export function openGallery(f) {
  closeAllMenus();
  const run = { cancelled: false, ship: null };
  galleryRun = run;
  const el = (tag, props, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  const n = f.ships.length, designs = (k) => `${k} design${k !== 1 ? 's' : ''}`;
  const bar = el('progress', { max: n, value: 0 });
  const status = el('div', { className: 'status', textContent: `Drawing ${n} card${n !== 1 ? 's' : ''}…` });
  const grid = el('div', { className: 'grid', hidden: true });
  const body = el('div', { className: 'body' }, el('div', { className: 'loading' }, bar, status), grid);
  const exportButton = el('button', { textContent: 'Export', title: 'Export as PDF (re-importable).', disabled: true });
  const downloadButton = el('button', { textContent: 'Download', title: 'Download as .seria zip.' });
  const closeButton = el('button', { textContent: 'Close' });
  const count = el('span', { className: 'title', textContent: `${f.name} · ${designs(n)}` });
  const head = el('div', { className: 'head' }, count, el('span', { className: 'grow' }), exportButton, downloadButton, closeButton);
  // Sort (a stat, either way) and filters (role, type, size: those the folder has), once the cards are drawn.
  const sortBy = el('select', {}, ...GALLERY_SORTS.map(([value, label]) => el('option', { value, textContent: label })));
  const sortDir = el('button', { className: 'dir', title: 'Sort direction.' });
  const roleFilter = el('select', {});
  const typeFilter = el('select', {});
  const sizeFilter = el('select', {});
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
      it.img = el('img', { src: it.url, alt: it.ship.name });
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
      (id) => STRINGS[`LABLE_${id}`] ?? id);
    fill(typeFilter, 'All', items.map((it) => [it.info.purpose]).sort((a, b) => byOrder(PURPOSE_ORDER)(a[0], b[0])), classLabel);
    fill(sizeFilter, 'All', items.map((it) => [it.info.size]).sort((a, b) => byOrder(SIZE_ORDER)(a[0], b[0])), classLabel);
    sortBy.value = gallerySort.key;
    let shown = [];
    const show = () => {
      const role = roleFilter.value, type = typeFilter.value, size = sizeFilter.value, { key, desc } = gallerySort;
      sortDir.textContent = desc ? '↓' : '↑';
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

/** The cards ({ ship, url }) as a PDF download. */
async function exportGallery(name, items) {
  const cw = CARD.width, ch = CARD.height, gap = PDF_GAP, pad = gap * 2, k = CARD_SCALE;
  const w = pad * 2 + PDF_COLUMNS * cw + (PDF_COLUMNS - 1) * gap, h = pad * 2 + PDF_ROWS * ch + (PDF_ROWS - 1) * gap;
  const c = makeCanvas(w * k, h * k), g = c.getContext('2d');
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
  saveFile(pdf(pages, PDF_WIDTH, (PDF_WIDTH * h) / w, { title: name, files }), `${safeFileName(name)} gallery.pdf`);
}
