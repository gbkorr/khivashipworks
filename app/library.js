// The ship list (Load menu): designs saved in this browser, in folders (store.js), and what can be done with them;
// the Gallery menu.
import { S, $ } from './state.js';
import { setModel } from './edit.js';
import { ask, dialog, folderName, mayDiscard, toast } from './dialogs.js';
import { downloadFolder } from './files.js';
import {
  below, closeAllMenus, closeMenus, hideCardPreview, inMenus, menus, previewing, showCardPreview, showMenu,
} from './menus.js';
import { abortCard, gallery, openGallery } from './gallery.js';
import { SAVED, designOf, entryOf, listFolders, readOnly } from './store.js';
import * as store from './store.js';

// ---- the ship list: designs saved in this browser, in folders (store.js) ------------------------------------------
// A design keeps the parts, the name and the flagship flag: all a design is. What else a .seria sets per part
// (floors, mirroring, fuel load...) the game works out again on load, as toSeria does. Highfleet (the game's
// designs) can't be changed: not renamed, deleted or merged, nothing put in or taken out (a design dragged out of it
// is copied), and a design loaded from it is saved to Saved; it can be duplicated into an ordinary folder.

const isLoaded = (ship) => S.loaded?.folder === ship.folder && S.loaded.name === ship.name;

async function saveShip() {
  const name = S.model.name;
  try {
    const folders = await listFolders();
    const has = (folder, n) => !!folders.find((f) => f.name === folder)?.ships.some((s) => s.name === n);
    const from = S.loaded && has(S.loaded.folder, S.loaded.name) ? S.loaded : null;
    const folder = from && !readOnly(from.folder) ? from.folder : SAVED;
    const same = has(folder, name), isFrom = from?.folder === folder && from.name === name;
    if (same && !isFrom && !await ask(`Replace "${name}" in ${folder}?`, { ok: 'Replace', danger: true })) return;
    // The whole design, unconnected parts too: it's work in progress. Over the one it was loaded from (renamed, if
    // it was), unless another of the new name is replaced.
    await store.saveDesign(folder, await entryOf(S.model), !same && from?.folder === folder ? from.name : null);
    S.loaded = { folder, name };
    S.edited = false;
    toast(`Saved ${name}${from && readOnly(from.folder) ? ` to ${folder}` : ''}.`);
  } catch (err) {
    toast(`Couldn't save ${name}: ${err.message}.`);
  }
}
$('save').onclick = saveShip;
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveShip(); }
});

export async function loadShip(ship) {
  closeAllMenus();
  if (!await mayDiscard(`Load ${ship.name}?`)) return false;
  try {
    setModel(await designOf(ship));
    S.loaded = { folder: ship.folder, name: ship.name };
    return true;
  } catch (err) { toast(`Couldn't load ${ship.name}: ${err.message}.`); return false; }
}
async function deleteShip(ship) {
  if (readOnly(ship.folder)) return;
  if (!await ask(`Delete the saved ship "${ship.name}"? This can't be undone.`, { ok: 'Delete', danger: true })) return;
  try {
    await store.deleteDesign(ship);
    if (isLoaded(ship)) S.loaded = null;
    toast(`Deleted ${ship.name}.`);
  } catch (err) { toast(`Couldn't delete ${ship.name}: ${err.message}.`); }
  refreshShipList();
}
/** Move a design to another folder (copied, out of Highfleet); numbered if the folder has one of its name. */
async function moveShip(ship, folder) {
  if (ship.folder === folder) return;
  if (readOnly(folder)) return toast(`${folder} can't be changed.`);
  try {
    const { name, copied } = await store.moveDesign(ship, folder);
    if (!copied && isLoaded(ship)) S.loaded = { folder, name };
    toast(`${copied ? 'Copied' : 'Moved'} ${ship.name} to ${folder}${name !== ship.name ? ` as ${name}` : ''}.`);
  } catch (err) { toast(`Couldn't move ${ship.name}: ${err.message}.`); }
  refreshShipList(folder);
}
/** A folder's designs into another (numbered where it has one of the same name); the folder goes. */
async function mergeFolders(from, into) {
  if (readOnly(from) || readOnly(into)) return;
  try {
    const names = await store.mergeFolders(from, into);
    if (S.loaded?.folder === from && names.has(S.loaded.name)) S.loaded = { folder: into, name: names.get(S.loaded.name) };
    toast(`Merged ${from} into ${into}.`);
  } catch (err) { toast(`Couldn't merge ${from}: ${err.message}.`); }
  refreshShipList(into);
}

/** Designs ({ name, parts, flagship, saved, shipcard }) saved as a new folder (numbered if `name` is taken). */
export async function importDesigns(name, designs, failed = []) {
  try {
    const folder = await store.importDesigns(name, designs);
    toast(`Saved ${designs.length} design${designs.length > 1 ? 's' : ''} to ${folder}` +
      (failed.length ? ` (couldn't read ${failed.length}: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}).` : '.'));
    closeAllMenus();
    openShipList(folder);
  } catch (err) { toast(`Couldn't save ${name}: ${err.message}.`); }
}
/** A copy of a folder and its designs: "<name> Copy". */
async function duplicateFolder({ name }) {
  try {
    const to = await store.duplicateFolder(name);
    toast(`Duplicated ${name} as ${to}.`);
    refreshShipList(to);
  } catch (err) { toast(`Couldn't duplicate ${name}: ${err.message}.`); }
}

async function renameFolder(from, to) {
  if (readOnly(from)) return;
  try {
    if (!await store.renameFolder(from, to)) return toast(`There's already a folder named ${to}.`);
    if (S.loaded?.folder === from) S.loaded = { ...S.loaded, folder: to };
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
    await store.deleteFolder(name);
    if (S.loaded?.folder === name) S.loaded = null;
    toast(`Deleted ${name}.`);
  } catch (err) { toast(`Couldn't delete ${name}: ${err.message}.`); }
  refreshShipList();
}
async function newFolder(name) {
  try { await store.newFolder(name); } catch (err) { toast(`Couldn't make ${name}: ${err.message}.`); }
  refreshShipList(name);
}

// The Load menu: the folders; each one's designs to its side.
export const loadButton = $('load');
async function openShipList(folder = null) {
  let folders;
  try { folders = await listFolders(); } catch (err) {
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
  const at = below(galleryButton, true);
  let folders;
  try { folders = await listFolders(); } catch (err) {
    galleryMenu = showMenu('context', 0, [{ empty: `Saved ships are unavailable: ${err.message}.` }], at);
    return;
  }
  const items = folders.map((f) => ({ label: f.name, meta: `${f.ships.length}`, onClick: () => openGallery(f) }));
  galleryMenu = showMenu('context', 0, items, at);
};
document.addEventListener('pointerdown', (e) => {
  if (dialog.contains(e.target) || gallery.contains(e.target)) return;   // the menus stay open under a dialog opened from them
  if (galleryButton.contains(e.target) || $('render-button').contains(e.target)) return;   // they toggle their own menus
  if (!inMenus(e.target) && !loadButton.contains(e.target)) closeAllMenus();
  else if (menus.context.length && !menus.context.some((m) => m.contains(e.target))) closeMenus('context');
}, { capture: true });
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || dialog.open || !(menus.load.length || menus.context.length)) return;
  e.stopImmediatePropagation();
  closeMenus(menus.context.length ? 'context' : 'load');
}, { capture: true });
window.addEventListener('resize', closeAllMenus);
