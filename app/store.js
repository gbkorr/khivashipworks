// The ship library: designs in folders, each folder one pack of its designs' .shipcards (lib/pack.js). Highfleet,
// the game's designs, is a file on the site (designs/Highfleet.ships) and can't be changed; the other folders are
// kept in this browser (IndexedDB 'khiva-shipworks', store 'folders': { name, order, pack }). A design is known by
// its folder and its name, which is unique within the folder. Listed designs are
// { folder, name, parts, flagship, saved (ms; 0 for the game's), shipcard }. No UI here: errors are thrown.
import { encodePack, decodePack } from '../lib/pack.js';
import { encodeDesign, decodeDesign } from '../lib/sharecode.js';

export const SAVED = 'Saved', HIGHFLEET = 'Highfleet';
export const readOnly = (folder) => folder === HIGHFLEET;

/** `name`, or with a number after it if `taken` has it already. */
export function freeName(name, taken) {
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name} (${i})`)) return `${name} (${i})`;
}

let highfleet = null;
/** The game's designs (none if the file can't be had; tried again next time). */
function gameDesigns() {
  return highfleet ??= fetch(new URL('../designs/Highfleet.ships', import.meta.url))
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
    .then((b) => decodePack(new Uint8Array(b)))
    .catch(() => { highfleet = null; return []; });
}

let db = null;
function openDb() {
  return db ??= new Promise((ok, err) => {
    const req = indexedDB.open('khiva-shipworks', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('folders', { keyPath: 'name' }).put({ name: SAVED, order: 0, pack: encodePack([]) });
    };
    req.onsuccess = () => ok(req.result);
    req.onerror = () => err(req.error);
  });
}
const done = (req) => new Promise((ok, err) => { req.onsuccess = () => ok(req.result); req.onerror = () => err(req.error); });
const finished = (tx) => new Promise((ok, err) => { tx.oncomplete = () => ok(); tx.onerror = tx.onabort = () => err(tx.error); });

/**
 * Run `change(t)` in one transaction over the folders: t.get(name) -> { name, order, designs } | undefined,
 * t.has(name), t.put({ name, order, designs }), t.delete(name). It may only await t's own calls (anything else
 * would end the transaction), so the designs to add are packed before. Resolves with what `change` returns, once
 * written.
 */
async function write(change) {
  const tx = (await openDb()).transaction('folders', 'readwrite'), store = tx.objectStore('folders');
  const t = {
    get: async (name) => {
      const r = await done(store.get(name));
      return r && { name: r.name, order: r.order, designs: decodePack(r.pack) };
    },
    has: async (name) => name === HIGHFLEET || (await done(store.getKey(name))) !== undefined,
    names: async () => new Set([HIGHFLEET, ...await done(store.getAllKeys())]),
    put: ({ name, order, designs }) => store.put({ name, order, pack: encodePack(designs) }),
    delete: (name) => store.delete(name),
  };
  const out = finished(tx);
  let result;
  try { result = await change(t); } catch (err) { out.catch(() => {}); tx.abort(); throw err; }
  await out;
  return result;
}
/** A folder to put designs in: its record, or a new one (Saved first, others in the order they're made). */
const folderFor = async (t, name) => (await t.get(name)) ?? { name, order: name === SAVED ? 0 : Date.now(), designs: [] };
const persist = () => navigator.storage?.persist?.();   // ask the browser not to clear the designs to free space

/** The folders in order, each with its designs (newest first; the game's by name): [{ name, ships }]. */
export async function listFolders() {
  const records = await done((await openDb()).transaction('folders').objectStore('folders').getAll());
  const folders = records.map((r) => ({ name: r.name, order: r.order, designs: decodePack(r.pack) }));
  folders.push({ name: HIGHFLEET, order: 1, designs: await gameDesigns() });
  return folders.sort((a, b) => a.order - b.order).map(({ name, designs }) => ({
    name,
    ships: designs.map((d) => ({ folder: name, ...d })).sort((a, b) => b.saved - a.saved || a.name.localeCompare(b.name)),
  }));
}

/** A listed design, under its listed name. */
export async function designOf(ship) {
  const m = await decodeDesign(ship.shipcard);
  m.name = ship.name;
  return m;
}

/** A design (BuildModel or { name, flagship, parts }) as a folder keeps it, saved now. */
export const entryOf = async (m, saved = Date.now()) =>
  ({ name: m.name, parts: m.parts.length, flagship: !!m.flagship, saved, shipcard: await encodeDesign(m) });

/** Save `entry` (entryOf) into `folder`, over the design of its name there and the one named `replace`. */
export async function saveDesign(folder, entry, replace = null) {
  await write(async (t) => {
    const f = await folderFor(t, folder);
    f.designs = f.designs.filter((d) => d.name !== entry.name && d.name !== replace);
    f.designs.push(entry);
    t.put(f);
  });
  persist();
}

export async function deleteDesign(ship) {
  await write(async (t) => {
    const f = await t.get(ship.folder);
    if (!f) return;
    f.designs = f.designs.filter((d) => d.name !== ship.name);
    t.put(f);
  });
}

/**
 * Move a design to another folder (made if need be), copied if it's the game's; numbered if the folder has one of
 * its name. @returns { name, copied }
 */
export async function moveDesign(ship, to) {
  if (readOnly(to)) throw new Error(`${to} can't be changed`);
  const copied = readOnly(ship.folder);
  const { folder, ...entry } = ship;
  const name = await write(async (t) => {
    const into = await folderFor(t, to);
    const name = freeName(ship.name, new Set(into.designs.map((d) => d.name)));
    into.designs.push({ ...entry, name });
    if (!copied) {
      const from = await t.get(folder);
      from.designs = from.designs.filter((d) => d.name !== ship.name);
      t.put(from);
    }
    t.put(into);
    return name;
  });
  return { name, copied };
}

/** A folder's designs into another (numbered where it has one of the same name); the folder goes. @returns Map(old name -> new) */
export async function mergeFolders(from, into) {
  return write(async (t) => {
    const src = await t.get(from), dst = await folderFor(t, into);
    const taken = new Set(dst.designs.map((d) => d.name)), names = new Map();
    for (const d of src?.designs ?? []) {
      const name = freeName(d.name, taken);
      taken.add(name);
      names.set(d.name, name);
      dst.designs.push({ ...d, name });
    }
    t.delete(from);
    t.put(dst);
    return names;
  });
}

/** Designs (entryOf's) as a new folder, `name` numbered if it's taken. @returns the folder's name */
export async function importDesigns(name, designs) {
  const folder = await write(async (t) => {
    const folder = freeName(name, await t.names()), taken = new Set();
    const named = designs.map((d) => {
      const n = freeName(d.name, taken);
      taken.add(n);
      return { ...d, name: n };
    });
    t.put({ name: folder, order: Date.now(), designs: named });
    return folder;
  });
  persist();
  return folder;
}

/** A copy of a folder and its designs, as "<name> Copy". @returns the copy's name */
export async function duplicateFolder(name) {
  const game = readOnly(name) ? await gameDesigns() : null;
  return write(async (t) => {
    const to = freeName(`${name} Copy`, await t.names());
    t.put({ name: to, order: Date.now(), designs: game ?? (await t.get(name))?.designs ?? [] });
    return to;
  });
}

/** @returns false if there's a folder named `to` already */
export async function renameFolder(from, to) {
  return write(async (t) => {
    if (await t.has(to)) return false;
    const f = await t.get(from);
    t.delete(from);
    t.put({ ...f, name: to });
    return true;
  });
}

export async function deleteFolder(name) {
  await write(async (t) => t.delete(name));
}

export async function newFolder(name) {
  await write(async (t) => {
    if (!await t.has(name)) t.put({ name, order: Date.now(), designs: [] });
  });
}
