// What the modules share: the page's main elements, the camera and the pointer, and S, the state that gets
// reassigned (one module can't assign another's variables, so it all lives on one object).
import { BuildModel } from '../lib/builder.js';

export const $ = (id) => document.getElementById(id);
export const canvas = $('view');
export const ctx = canvas.getContext('2d');
export const footer = document.querySelector('footer');
/** A fold bar's hotkey, after its label (hidden in the mobile layout). */
export const hotkeyHint = (key) =>
  Object.assign(document.createElement('span'), { className: 'hotkey', textContent: ` (${key})` });
export const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

export const cam = { scale: 14, ox: 0, oy: 0 };   // device px per metre; screen position of the design origin
export const MAX_ZOOM = 20;                        // css px per metre
export const pointer = { x: 0, y: 0, wx: 0, wy: 0, overCanvas: false };   // device px on the stage; design metres
export const undoStack = [];

export const S = {
  model: BuildModel.blank('New ship'),
  version: 0,                    // bumped on every model change (the shaded bake is redone only then)
  edited: false,                 // changed since it was loaded or saved
  loaded: null,                  // { folder, name }: the saved design the current one was loaded from or saved as
  current: null,                 // { ship, stats, placed } of the placed parts, from the last stats update
  problems: new Map(),           // part -> [message], from model.validate()
  selection: new Set(),
  hover: null,                   // the part under the pointer
  /**
   * What the pointer is doing:
   *   idle | pan | press (left down on a part, not moved yet) | drag (group follows, button held)
   *   | carry (group follows until the next click) | box (rubber-band select) | tray-press (a library part pressed)
   */
  mode: 'idle',
  press: null,                   // { cx, cy (client px), part }
  trayPress: null,               // { cx, cy }
  box: null,                     // { x0, y0, x1, y1, add }
  pan: null,                     // { x, y, prevMode }: right or middle button panning
  /**
   * The parts in hand (see hold): { group, primary, bases, grab, origin, isNew, single, offset, valid, attached, reason,
   * freeSlots, ghost (where they were, washed out of the frozen bake), version (the design's when picked up) }
   */
  held: null,
  lastDrop: null,                // { parts, time } of the last drop (a quick chord after it deletes them)
  selectionBeforeBox: new Set(), // (a chord during a box select means the selection before it)
  // Two looks: blueprint (the hand-drawn atlas on graph paper) and colour (the game's sprites with its lighting,
  // cast shadows, stage shading and colour grade: SHADING). Remembered per browser.
  colour: false,
  light: document.documentElement.classList.contains('light'),   // the light paper (index.html sets it first)
  bare: false,                   // the hull-only button is held down: the stage leaves modules and sensors out
  dpr: window.devicePixelRatio || 1,
  fitBlocks: [20, 12],           // fit() frames at least this many blocks (wide, high)
  afterPaint: null,              // set by the mobile mode (mobile.js): its overlays and toolbar
};
try { S.colour = localStorage.getItem('shipbuilder.mode') === 'colour'; } catch { /* storage may be off */ }

export const toWorld = (sx, sy) => [(sx - cam.ox) / cam.scale, (sy - cam.oy) / cam.scale];
export function updatePointer(e) {
  const r = canvas.getBoundingClientRect();
  pointer.x = (e.clientX - r.left) * S.dpr;
  pointer.y = (e.clientY - r.top) * S.dpr;
  pointer.overCanvas = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  [pointer.wx, pointer.wy] = toWorld(pointer.x, pointer.y);
}
/** Whether parts in hand are being moved (not only pressed). */
export const carrying = () => !!S.held && (S.mode === 'drag' || S.mode === 'carry');
