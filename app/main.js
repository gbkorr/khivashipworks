// Khiva Shipworks, a shipbuilder for HighFleet: the page's entry point. The modules only declare things and hook up
// their own elements as they load; everything that starts the page happens here, once they all have.
import * as mobile from './mobile.js';
import { $, canvas, cam, pointer, footer, undoStack, toWorld, updatePointer, carrying, S } from './state.js';
import {
  setModel, partAt, centerOffset, selectWithHosts, hold, follow, drop, cancelHold, rotate, removeSelection, undo,
} from './edit.js';
import { draw, fit, zoomAt, clampCamera, resize } from './view.js';
import { drawSidePanels, wakeIdle } from './panels.js';
import { finishBox } from './input.js';
import { binAt, buildTray, drawThumbs, markBin, trashHeld, trayItem } from './tray.js';
import { toast } from './dialogs.js';
import { loadLightmode } from './assets.js';
import { open } from './files.js';
import './library.js';
import './gallery.js';
import './render.js';
import { listFolders } from './store.js';
import { BuildPart, dependents } from '../lib/builder.js';

// Two buttons, one per look; the one showing is pressed.
const modeButtons = { blueprint: $('mode-blueprint'), colour: $('mode-colour') };
function showMode() {
  modeButtons.blueprint.setAttribute('aria-pressed', !S.colour);
  modeButtons.colour.setAttribute('aria-pressed', S.colour);
}
function setMode(colour) {
  if (colour === S.colour) return;
  S.colour = colour;
  try { localStorage.setItem('shipbuilder.mode', S.colour ? 'colour' : 'blueprint'); } catch { /* storage may be off */ }
  showMode();
  drawThumbs();
  draw();
  // In colour a card waiting for the input to go idle needn't wait any more.
  if (S.colour) wakeIdle();
}
modeButtons.blueprint.onclick = () => setMode(false);
modeButtons.colour.onclick = () => setMode(true);
showMode();

// Two papers: the blueprint, and light drafting paper (html.light: the page's colours, the stage's graph paper, the
// side panels' ink). The ship and cards are drawn the same on either. Remembered per browser (index.html applies it
// before the first paint).
const themeButtons = { dark: $('theme-dark'), light: $('theme-light') };
function showTheme() {
  themeButtons.dark.setAttribute('aria-pressed', !S.light);
  themeButtons.light.setAttribute('aria-pressed', S.light);
}
function setTheme(light) {
  if (light === S.light) return;
  S.light = light;
  document.documentElement.classList.toggle('light', light);
  try { localStorage.setItem('shipbuilder.theme', light ? 'light' : 'dark'); } catch { /* storage may be off */ }
  showTheme();
  if (S.current) drawSidePanels(S.current.ship, S.current.stats);
  drawThumbs();
  draw();
  // Its blueprint atlas, the first time.
  if (light) loadLightmode().then(() => { if (S.light) { drawThumbs(); draw(); } }, (err) => toast(err.message));
}
themeButtons.dark.onclick = () => setTheme(false);
themeButtons.light.onclick = () => setTheme(true);
showTheme();

// The hull-only button: only while it's held down, the stage shows just the structure (no modules or sensors).
const bareButton = $('bare');
function setBare(on) {
  if (on === S.bare) return;
  S.bare = on;
  bareButton.setAttribute('aria-pressed', on);
  draw();
}
bareButton.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  bareButton.setPointerCapture(e.pointerId);
  setBare(true);
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  bareButton.addEventListener(type, () => setBare(false));
}

// Their hotkeys: 1 blueprint, 2 colour, 3 dark paper, 4 light paper; M held hides the modules, like the button.
const LOOK_KEYS = { 1: () => setMode(false), 2: () => setMode(true), 3: () => setTheme(false), 4: () => setTheme(true) };
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type === 'text') return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  if (LOOK_KEYS[e.key]) LOOK_KEYS[e.key]();
  else if (e.key.toLowerCase() === 'm') setBare(true);
});
window.addEventListener('keyup', (e) => { if (e.key.toLowerCase() === 'm') setBare(false); });
window.addEventListener('blur', () => setBare(false));

// The mobile mode (mobile.js) drives the page through these.
mobile.install({
  canvas, footer, cam, pointer, toWorld, updatePointer, partAt, centerOffset, dependents, selectWithHosts, BuildPart, trayItem,
  hold, follow, drop, cancelHold, rotate, removeSelection, finishBox, undo, fit, zoomAt, clampCamera, draw, toast,
  binAt, markBin, trashHeld, carrying, canUndo: () => !!S.held || undoStack.length > 0,
  get model() { return S.model; },
  get dpr() { return S.dpr; },
  get mode() { return S.mode; }, set mode(m) { S.mode = m; },
  get held() { return S.held; },
  get selection() { return S.selection; }, set selection(s) { S.selection = s; },
  get box() { return S.box; }, set box(b) { S.box = b; },
  get hover() { return S.hover; }, set hover(h) { S.hover = h; },
  set afterPaint(f) { S.afterPaint = f; },
  set fitBlocks(v) { S.fitBlocks = v; },
});

new ResizeObserver(() => resize()).observe(canvas);
buildTray();
listFolders().catch(() => {});   // the game's designs are ready by the time the list is opened
setModel(S.model);
// ?ship=<url of a .seria, stat card or gallery PDF> opens it.
const initial = new URLSearchParams(location.search).get('ship');
if (initial) {
  fetch(initial).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
    .then((buffer) => open(buffer, initial), (err) => toast(`Couldn't open ${initial}: ${err.message}.`));
}
