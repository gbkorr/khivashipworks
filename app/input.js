// Mouse and keyboard on the stage: picking parts up and putting them down, box select, panning (right or middle
// button, WASD), zooming and turning (wheel), and the shortcuts. Touch is mobile.js's.
import { S, $, cam, canvas, footer, pointer, toWorld, updatePointer } from './state.js';
import {
  cancelHold, chordDelete, drop, follow, hold, partAt, pruneUnconnected, removeSelection, rotate,
  selectWithHosts, undo,
} from './edit.js';
import { clampCamera, draw, fit, zoomAt } from './view.js';
import { binAt, markBin, setCollapsed, trashHeld } from './tray.js';

// The right (or middle) button pans from anywhere on the page, bar the menus (their own right-click menus), the
// ship card and the gallery (the browser's menu, to save a card), text fields and links; the browser's menu is kept for those.
const ownsRightClick = (el) => !!el.closest?.('.menu, #card-panel, #gallery, input, textarea, select, a');
window.addEventListener('contextmenu', (e) => { if (!ownsRightClick(e.target)) e.preventDefault(); });
window.addEventListener('pointerdown', (e) => {
  if ((e.button !== 2 && e.button !== 1) || ownsRightClick(e.target)) return;
  updatePointer(e);
  e.preventDefault();   // (no middle-button autoscroll)
  S.mode = S.mode === 'idle' ? 'pan' : S.mode;
  S.pan = { x: pointer.x, y: pointer.y, prevMode: S.mode };
  canvas.classList.add('panning');
});

// A second button pressed while one is down doesn't fire pointerdown, but does fire mousedown.
window.addEventListener('mousedown', (e) => {
  if ((e.buttons & 3) === 3 && (pointer.overCanvas || S.held)) { e.preventDefault(); chordDelete(); }
});

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;   // (right and middle: the page-wide pan above)
  updatePointer(e);
  if (S.mode === 'carry') return drop(e.shiftKey);
  if (S.mode !== 'idle') return;
  const part = partAt(pointer.wx, pointer.wy);
  if (e.shiftKey) {
    if (part) {
      if (S.selection.has(part)) S.selection.delete(part); else selectWithHosts([part]);
      draw();
    } else {
      S.mode = 'box';
      S.box = { x0: pointer.x, y0: pointer.y, x1: pointer.x, y1: pointer.y, add: true };
    }
    return;
  }
  if (part) {
    S.press = { cx: e.clientX, cy: e.clientY, part };
    S.mode = 'press';
  } else {
    S.selectionBeforeBox = new Set(S.selection);
    S.selection.clear();
    S.mode = 'box';
    S.box = { x0: pointer.x, y0: pointer.y, x1: pointer.x, y1: pointer.y, add: false };
    draw();
  }
});

window.addEventListener('pointermove', (e) => {
  const px = pointer.x, py = pointer.y;
  updatePointer(e);
  if (S.pan) {
    cam.ox += pointer.x - px; cam.oy += pointer.y - py;
    clampCamera();
    [pointer.wx, pointer.wy] = toWorld(pointer.x, pointer.y);
    if (S.held) follow(); else draw();
    return;
  }
  if (S.mode === 'press' || S.mode === 'tray-press') {
    const start = S.mode === 'press' ? S.press : S.trayPress;
    if (Math.hypot(e.clientX - start.cx, e.clientY - start.cy) > 5) {
      if (S.mode === 'press') {
        const parts = S.selection.has(S.press.part) ? [...S.selection] : [S.press.part];
        if (!S.selection.has(S.press.part)) S.selection.clear();
        hold(parts, S.press.part, false, 'drag');
      } else {
        S.mode = 'drag';
        follow();
      }
    }
    return;
  }
  if (S.mode === 'drag' || S.mode === 'carry') {
    markBin(binAt(e.clientX, e.clientY));
    return follow();
  }
  if (S.mode === 'box') {
    S.box.x1 = pointer.x; S.box.y1 = pointer.y;
    return draw();
  }
  if (S.mode === 'idle' && pointer.overCanvas) {
    const h = partAt(pointer.wx, pointer.wy);
    if (h !== S.hover) { S.hover = h; draw(); }
  }
});

window.addEventListener('pointerup', (e) => {
  updatePointer(e);
  if (S.pan && (e.button === 2 || e.button === 1)) {
    if (S.mode === 'pan') S.mode = 'idle';
    S.pan = null;
    canvas.classList.remove('panning');
    return;
  }
  if (e.button !== 0) return;
  if (S.mode === 'press') {
    // A click: pick the part (or the selection it belongs to) up; the next click puts it down.
    const parts = S.selection.has(S.press.part) ? [...S.selection] : [S.press.part];
    if (!S.selection.has(S.press.part)) S.selection.clear();
    hold(parts, S.press.part, false, 'carry');
  } else if (S.mode === 'tray-press') {
    S.mode = 'carry';
    follow();
  } else if (S.mode === 'drag') {
    const bin = binAt(e.clientX, e.clientY);
    if (bin) return trashHeld(bin);
    if (S.held?.isNew && !pointer.overCanvas) return cancelHold();
    drop(e.shiftKey);
  } else if (S.mode === 'box') finishBox();
});

/** Select what the rubber band touches (added to the selection with box.add, else in place of it). */
export function finishBox() {
  const [ax, ay] = toWorld(Math.min(S.box.x0, S.box.x1), Math.min(S.box.y0, S.box.y1));
  const [bx, by] = toWorld(Math.max(S.box.x0, S.box.x1), Math.max(S.box.y0, S.box.y1));
  if (!S.box.add) S.selection.clear();
  if (bx - ax > 1e-6 || by - ay > 1e-6) {
    selectWithHosts(S.model.parts.filter((p) => {
      const b = p.bounds();
      return b.x0 < bx && b.x1 > ax && b.y0 < by && b.y1 > ay;
    }));
  }
  S.box = null;
  S.mode = 'idle';
  draw();
}

// Shift+wheel turns parts: one step per wheel notch (anticlockwise when scrolling down). A notch is the
// smallest wheel-sized delta seen so far, so an event that coalesces several notches turns several steps.
// Touchpads (small deltas) build up to a step, rate-limited so they don't spin parts.
let wheelTurn = 0, wheelTurnAt = 0, wheelNotch = Infinity;
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  updatePointer(e);
  if (e.shiftKey) {
    const d = (e.deltaY || e.deltaX) * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 800 : 1);   // shift+wheel may scroll horizontally
    if (Math.abs(d) >= 40) {
      wheelNotch = Math.min(wheelNotch, Math.abs(d));
      wheelTurn = 0;
      return rotate(-Math.sign(d) * Math.max(1, Math.round(Math.abs(d) / wheelNotch)));
    }
    wheelTurn += d;
    const now = performance.now();
    if (Math.abs(wheelTurn) >= 50 && now - wheelTurnAt > 120) {
      rotate(wheelTurn > 0 ? -1 : 1);
      wheelTurn = 0;
      wheelTurnAt = now;
    }
    return;
  }
  zoomAt(pointer.x, pointer.y, cam.scale * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)));
  [pointer.wx, pointer.wy] = toWorld(pointer.x, pointer.y);
  if (S.held) follow(); else draw();
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type === 'text') return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); return undo(); }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (PAN_KEYS[k]) { e.preventDefault(); panKeys.add(k); return startKeyPan(); }
  if (k === 'r') { e.preventDefault(); rotate(); }
  else if (k === 'delete' || k === 'backspace') { e.preventDefault(); if (e.shiftKey) pruneUnconnected(); else removeSelection(); }
  else if (k === 'escape') { if (S.held) cancelHold(); else { S.selection.clear(); draw(); } }
  else if (k === 'f') fit();
  // Fold or open the stats (T), the parts list (P) and the library (L), as their bars do; on All too.
  else if (k === 't' && !e.repeat) $('side-stats').querySelector(':scope > .fold-bar').click();
  else if (k === 'p' && !e.repeat) $('side-parts').querySelector(':scope > .fold-bar').click();
  else if (k === 'l' && !e.repeat) setCollapsed(!footer.classList.contains('collapsed'));
});
window.addEventListener('keyup', (e) => panKeys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => panKeys.clear());

// WASD pans the view (moves the camera that way) while held.
const PAN_KEYS = { w: [0, 1], a: [1, 0], s: [0, -1], d: [-1, 0] };
const PAN_SPEED = 910;   // css px per second
const panKeys = new Set();
let panLast = 0;
function startKeyPan() {
  if (panLast) return;
  panLast = performance.now();
  const step = (now) => {
    if (!panKeys.size) { panLast = 0; return; }
    const dt = Math.min(0.05, (now - panLast) / 1000);
    panLast = now;
    for (const k of panKeys) {
      cam.ox += PAN_KEYS[k][0] * PAN_SPEED * S.dpr * dt;
      cam.oy += PAN_KEYS[k][1] * PAN_SPEED * S.dpr * dt;
    }
    clampCamera();
    [pointer.wx, pointer.wy] = toWorld(pointer.x, pointer.y);
    if (S.held) follow(); else draw();
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
