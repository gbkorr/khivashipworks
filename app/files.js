// Files in and out: New, Open (a .seria, a stat card image, a gallery PDF), paste, drag and drop (folders of
// .serias too), Download (.seria), and a folder downloaded as a .zip of .serias.
import { BuildModel } from '../lib/builder.js';
import { makeCanvas } from '../lib/font.js';
import { decodeDesign, designFromCard } from '../lib/sharecode.js';
import { S, $ } from './state.js';
import { connected, setModel } from './edit.js';
import { ask, mayDiscard, safeFileName, toast } from './dialogs.js';
import { fromPdfText, isPdf, zip } from './formats.js';
import { importDesigns } from './library.js';
import { closeAllMenus } from './menus.js';
import { designOf, entryOf, freeName } from './store.js';

$('new').onclick = async () => {
  if (!await mayDiscard('Start a new design?')) return;
  setModel(BuildModel.blank('New ship'));
  S.loaded = null;
};
// Stat card images (PNG, JPEG, WebP) are opened for the design they carry.
const IMAGE_MAGIC = [[0x89, 0x50, 0x4e, 0x47], [0xff, 0xd8, 0xff], [0x52, 0x49, 0x46, 0x46]];
const isImage = (b) => IMAGE_MAGIC.some((m) => m.every((v, i) => b[i] === v));
async function imagePixels(bytes) {
  const img = await createImageBitmap(new Blob([bytes]));
  const c = makeCanvas(img.width, img.height), g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  return g.getImageData(0, 0, c.width, c.height);
}
export async function open(buffer, name) {
  try {
    const bytes = new Uint8Array(buffer);
    if (isPdf(bytes)) return importPdf(name, bytes);
    if (!isImage(bytes)) setModel(BuildModel.fromSeria(buffer));
    else {
      const got = await designFromCard(await imagePixels(bytes));
      if (!got) return toast(`Unable to read ${name}; try with a higher resolution.`);
      setModel(got);
    }
    S.loaded = null;
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

/** Hand `blob` to the browser to save, as `name`. */
export function saveFile(blob, name) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/**
 * A folder of .serias (the game's Ships folder, say) saved as a new folder of designs; other files are skipped.
 * Numbered if there's a folder of that name already. (A gallery PDF is taken the same way: importPdf.)
 */
async function importFolder(name, files) {
  const serias = files.filter((f) => /\.seria$/i.test(f.name));
  if (!serias.length) return toast(`No .seria files in ${name}.`);
  const designs = [], failed = [];
  for (const f of serias) {
    try {
      const m = BuildModel.fromSeria(await f.arrayBuffer());
      if (!m.parts.length) throw new Error('no parts');
      designs.push({ ...await entryOf(m, f.lastModified || Date.now()), name: m.name?.trim() || f.name.replace(/\.seria$/i, '') });
    } catch { failed.push(f.name); }
  }
  if (!designs.length) return toast(`Couldn't read any of the ${serias.length} .serias in ${name}.`);
  return importDesigns(name, designs, failed);
}

/**
 * A folder's designs as a .zip of a folder of .serias (the complement of importFolder), each as the Download button
 * makes it: unconnected parts left out.
 */
export async function downloadFolder({ name, ships }) {
  if (!ships.length) return toast(`${name} has no designs.`);
  const files = [], failed = [], taken = new Set();
  for (const ship of ships) {
    try {
      const got = connected(new Set(), await designOf(ship));
      const file = freeName(safeFileName(ship.name), taken);
      taken.add(file);
      files.push({ name: `${file}.seria`, bytes: got.ship.toSeria() });
    } catch { failed.push(ship.name); }
  }
  const folder = safeFileName(name);
  try {
    saveFile(await zip(files.map((f) => ({ ...f, name: `${folder}/${f.name}` }))), `${folder}.zip`);
  } catch (err) { return toast(`Couldn't download ${name}: ${err.message}.`); }
  toast(`Downloaded ${files.length} design${files.length !== 1 ? 's' : ''} from ${name}` +
    ` as ${folder}.zip` +
    (failed.length ? ` (couldn't make ${failed.length}: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''})` : '') + '.');
}

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

$('download').onclick = async () => {
  const { ship } = connected();
  const v = ship.validate();
  if (!v.ok && !await ask(`This design breaks some rules:\n\n${v.messages.join('\n')}\n\nDownload anyway?`, { ok: 'Download anyway' })) return;
  const file = `${S.model.name.replace(/[\\/:*?"<>|]/g, '_')}.seria`;
  saveFile(new Blob([ship.toSeria()], { type: 'application/octet-stream' }), file);
};

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
