// Mobile mode: touch gestures for the stage and the parts library, and a touch-first layout of the page. All of it
// lives here, laid over app.js: app.js hands install() the controls it needs (`ui`) and otherwise knows nothing of it.
//
// The gestures take every touch (the mouse is left to app.js; a pen too, but in the mobile layout), in either layout:
//   drag a part: move it (with the selection, if it's in it) · drag the paper: pan · two fingers: zoom
//   tap a part: select it (again: deselect) · tap the paper: deselect · long press a part: add it to the selection
//   (or take it out) · long press and drag: box select, adding to the selection
//   while dragging parts, a tap with a second finger turns them
//   library: tap a part to have it in hand in the middle of the stage; drag one up out of the tray (or long press
//   it) to carry it out. Parts in hand are dragged on, and placed once let go where they fit; let go where they don't,
//   they stay in hand (tinted red) to be dragged on, placed or cancelled. Dragged onto the library, they're deleted.
//
// The layout (html.mobile, styled at the end of style.css) is for phones and tablets: a bigger header that folds to its first row,
// sidebars that open over the stage and start folded, and a toolbar for what the keyboard does on a desktop. It's on
// when the main pointer is coarse and can't hover; ?mobile=1 or ?mobile=0 forces it on or off.

const SLOP = 10;          // css px a finger goes before it's a drag rather than a tap
const LONG_PRESS = 450;   // ms
const REACH = 14;         // css px from a finger that a part still counts as touched (fingers are broad)
const LIFT = 64;          // css px a part carried out of the library is held above the finger, to be seen

const forced = new URLSearchParams(location.search).get('mobile');
export const layout = forced === '1' || (forced !== '0' && matchMedia('(pointer: coarse) and (hover: none)').matches);

document.documentElement.classList.toggle('mobile', layout);   // (its styles: style.css, at the end)

// Toolbar and header icons (24px, stroked).
const ICONS = {
  undo: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  fit: 'M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3',
  turn: 'M21 12a9 9 0 1 1-2.64-6.36L21 8M21 3v5h-5',
  copy: 'M9 9h11v11H9zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  remove: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
  cancel: 'M18 6 6 18M6 6l12 12',
  place: 'M20 6 9 17l-5-5',
  menu: 'M3 6h18M3 12h18M3 18h18',
  fold: 'm6 15 6-6 6 6',
};
const icon = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;

/**
 * Take over touch input, and lay the page out for a phone if `layout`. `ui`: app.js' controls and state (its
 * mode, the held group, the selection, the rubber band and the hovered part, as properties).
 */
export function install(ui) {
  const { canvas, footer } = ui;
  const stage = canvas.parentElement, tray = footer.querySelector('#tray');

  // ---- gestures ------------------------------------------------------------------------------------------------
  // Fingers down: { x, y: where it is; x0, y0: where it came down; lx, ly: where the view last followed it (client
  // px); src: 'stage' | 'tile' (a library part) | 'bin' (the library while parts are in hand); moved: past SLOP }.
  const touches = new Map();
  /**
   * The gesture, from its first finger (a) and a second (b):
   *   press (on a part or the paper) | long (pressed a while, not moved) | box | pan | pinch (a and b) | none (nothing to do)
   *   | drag (parts in hand follow a; a tap of b turns them)
   *   | press-held, press-empty (on the parts in hand, or off them) | tile (a library part) | bin
   */
  let g = null;

  // (A pen works as a mouse, but in the mobile layout as a finger.)
  const isTouch = (e) => e.pointerType === 'touch' || (layout && e.pointerType === 'pen');
  const take = (e) => { e.stopImmediatePropagation(); if (e.cancelable) e.preventDefault(); };
  canvas.addEventListener('pointerdown', (e) => { if (isTouch(e)) { take(e); down(e, 'stage'); } }, true);
  footer.addEventListener('pointerdown', (e) => {
    if (!isTouch(e)) return;
    const tile = e.target.closest?.('.part');
    if (ui.carrying()) { take(e); down(e, 'bin'); }
    else if (tile && tray.contains(tile)) { take(e); down(e, 'tile', tile); }
  }, true);
  // (On the window: a touch keeps to the element it came down on, but it needn't.)
  window.addEventListener('pointermove', (e) => { if (touches.has(e.pointerId)) { take(e); move(e); } }, true);
  window.addEventListener('pointerup', (e) => { if (touches.has(e.pointerId)) { take(e); up(e, false); } }, true);
  window.addEventListener('pointercancel', (e) => { if (touches.has(e.pointerId)) { take(e); up(e, true); } }, true);
  // A part carried out of the library mustn't scroll the tray.
  footer.addEventListener('touchmove', (e) => { if (g?.kind === 'drag' && e.cancelable) e.preventDefault(); }, { passive: false });

  const rect = () => canvas.getBoundingClientRect();
  const screen = (x, y) => { const r = rect(); return [(x - r.left) * ui.dpr, (y - r.top) * ui.dpr]; };
  const world = (x, y) => ui.toWorld(...screen(x, y));
  const pointTo = (t) => ui.updatePointer({ clientX: t.x, clientY: t.y });
  const buzz = () => { try { navigator.vibrate?.(15); } catch { /* not everywhere */ } };

  // Where a finger touches: right under it, then rings around it.
  const AROUND = [[0, 0], ...[0.5, 1].flatMap((k) => Array.from({ length: 8 }, (_, i) => [k * Math.cos(i * Math.PI / 4), k * Math.sin(i * Math.PI / 4)]))];
  /** The topmost part a finger touches, bar those in `exclude`. */
  function partNear(t, exclude) {
    const [wx, wy] = world(t.x, t.y), d = (REACH * ui.dpr) / ui.cam.scale;
    for (const [dx, dy] of AROUND) {
      const p = ui.partAt(wx + dx * d, wy + dy * d, exclude);
      if (p) return p;
    }
    return null;
  }
  const onHeld = (t) => {
    const inHand = new Set(ui.held.group);
    return !!partNear(t, new Set(ui.model.parts.filter((p) => !inHand.has(p))));
  };

  /** Move the view by (dx, dy) css px; parts being dragged keep to their finger. */
  function panBy(dx, dy) {
    ui.cam.ox += dx * ui.dpr;
    ui.cam.oy += dy * ui.dpr;
    ui.clampCamera();
    if (g?.kind === 'drag') { pointTo(g.a); ui.follow(); } else ui.draw();
  }
  const panTo = (t) => { panBy(t.x - t.lx, t.y - t.ly); t.lx = t.x; t.ly = t.y; };
  /** A finger left down once its gesture is over: nothing more until it lifts (the view doesn't jump). */
  const idleWith = (t) => { g = { kind: 'none', a: t }; };
  const spread = () => Math.max(1, Math.hypot(g.a.x - g.b.x, g.a.y - g.b.y));
  /** Two fingers: their spread zooms, about the point between them where they came down (they don't pan). */
  function pinch() {
    const dist = spread();
    ui.zoomAt(...g.at, (ui.cam.scale * dist) / g.dist);
    g.dist = dist;
    ui.draw();
  }

  function down(e, src, tile) {
    const t = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, src, moved: false };
    touches.set(e.pointerId, t);
    if (g) return second(t);
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();   // (the keyboard goes)
    pointTo(t);
    if (src === 'bin') g = { kind: 'bin', a: t };
    else if (src === 'tile') {
      g = { kind: 'tile', a: t, item: ui.trayItem(tile.dataset.key) };
      g.timer = setTimeout(() => { if (g?.kind === 'tile') { buzz(); pickUp(); } }, LONG_PRESS);
    } else if (ui.held) g = { kind: onHeld(t) ? 'press-held' : 'press-empty', a: t };
    else {
      g = { kind: 'press', a: t, part: partNear(t), at: [ui.pointer.wx, ui.pointer.wy] };
      g.timer = setTimeout(longPress, LONG_PRESS);
    }
  }

  /** Another finger: a second one pinches, or helps a drag; any more (or one on the library) do nothing. */
  function second(t) {
    if (t.src !== 'stage' || g.b) return;
    if (g.kind === 'drag') { g.b = t; return; }
    if (!['press', 'long', 'box', 'pan', 'press-held', 'press-empty'].includes(g.kind)) return;
    clearTimeout(g.timer);
    if (g.kind === 'box') { ui.box = null; ui.mode = 'idle'; }
    g = { kind: 'pinch', a: g.a, b: t };
    g.at = screen((g.a.x + t.x) / 2, (g.a.y + t.y) / 2);
    g.dist = spread();
    ui.draw();
  }

  function longPress() {
    if (g?.kind !== 'press' || g.a.moved) return;
    g.kind = 'long';
    buzz();
    ui.draw();   // (a ring under the finger: afterPaint)
  }

  function move(e) {
    const t = touches.get(e.pointerId);
    t.x = e.clientX; t.y = e.clientY;
    t.moved ||= Math.hypot(t.x - t.x0, t.y - t.y0) > SLOP;
    if (!g || (t !== g.a && t !== g.b)) return;
    if (g.kind === 'pinch') return pinch();
    if (t === g.b) return;   // a drag's second finger (it only taps)
    switch (g.kind) {
      case 'press':
        if (!t.moved) return;
        clearTimeout(g.timer);
        if (g.part) return grab();
        g.kind = 'pan';
        return panTo(t);
      case 'press-held':
        if (t.moved) carryOn();
        return;
      case 'press-empty':
        if (!t.moved) return;
        g.kind = 'pan';
        return panTo(t);
      case 'pan':
        return panTo(t);
      case 'long': {
        if (!t.moved) return;
        g.kind = 'box';
        ui.mode = 'box';
        const [x, y] = screen(t.x0, t.y0);
        ui.box = { x0: x, y0: y, x1: x, y1: y, add: true };
      }
      // falls through
      case 'box':
        [ui.box.x1, ui.box.y1] = screen(t.x, t.y);
        return ui.draw();
      case 'drag':
        return dragTo(t);
      case 'tile': {
        if (!t.moved) return;
        // Across the tray (out of a row of parts, or sideways out of All's columns): the part comes out with the
        // finger. Along it, the tray scrolls.
        const dx = Math.abs(t.x - t.x0), dy = Math.abs(t.y - t.y0);
        if (footer.classList.contains('all') ? dx > dy : dy > dx) { clearTimeout(g.timer); return pickUp(); }
        clearTimeout(g.timer);
        g.kind = 'none';
        return;
      }
      case 'bin':
        if (t.moved) g.kind = 'none';
    }
  }

  /** A finger lifts (or the browser takes it: `cancelled`). */
  function up(e, cancelled) {
    const t = touches.get(e.pointerId);
    touches.delete(e.pointerId);
    if (!g || (t !== g.a && t !== g.b)) return;
    clearTimeout(g.timer);
    if (g.kind === 'pinch') return idleWith(t === g.a ? g.b : g.a);
    if (t === g.b) {
      g.b = null;
      if (!t.moved && !cancelled) turn();
      return;
    }
    const was = g;
    g = null;
    if (cancelled) {
      if (was.kind === 'drag') { ui.markBin(null); ui.cancelHold(); }
      if (was.kind === 'box') { ui.box = null; ui.mode = 'idle'; }
    } else {
      switch (was.kind) {
        case 'press': select(was.part); break;
        case 'long': toggle(was.part); break;
        case 'box': ui.finishBox(); break;
        case 'drag': release(t); break;
        case 'press-held': ui.drop(); break;   // a tap on the parts in hand puts them down, if they fit there
        case 'tile': addPart(was.item); break;
        case 'bin': ui.trashHeld(ui.binAt(was.a.x0, was.a.y0)); swallowClick(); break;   // (not a tab picked as well)
      }
    }
    if (was.b) idleWith(was.b);
    syncHover();
    ui.draw();
  }

  function swallowClick() {
    const stop = (e) => { e.stopPropagation(); e.preventDefault(); };
    window.addEventListener('click', stop, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', stop, true), 500);
  }

  /** A tap on a part selects it alone (a tap on the only one selected deselects it); on the paper, deselects. */
  function select(part) {
    const sel = ui.selection, only = part && sel.size === 1 && sel.has(part);
    sel.clear();
    if (part && !only) sel.add(part);
  }
  /** Long press: a part into the selection (with what it's mounted on, so they can move together), or out. */
  function toggle(part) {
    if (!part) return;
    if (ui.selection.has(part)) ui.selection.delete(part);
    else ui.selectWithHosts([part]);
  }
  /** On touch the hovered part (outlined; a sensor's coverage shown) is the one selected, if there's one. */
  function syncHover() {
    const [only] = ui.selection.size === 1 ? ui.selection : [];
    ui.hover = only && ui.model.parts.includes(only) ? only : null;
  }

  /** Pick up the pressed part (with the selection, if it's in it), held by the spot the finger took it by. */
  function grab() {
    const { part } = g, sel = ui.selection;
    const parts = sel.has(part) ? [...sel] : [part];
    if (!sel.has(part)) sel.clear();
    pointTo(g.a);
    ui.hold(parts, part, false, 'drag', [g.at[0] - part.x, g.at[1] - part.y]);
    g.kind = 'drag';
  }
  /** Drag the parts in hand on from where they are. */
  function carryOn() {
    const h = ui.held, [wx, wy] = world(g.a.x0, g.a.y0);
    h.grab = [wx - h.primary.x, wy - h.primary.y];
    ui.mode = 'drag';
    g.kind = 'drag';
    dragTo(g.a);
  }
  /** Carry the pressed library part out, above the finger. */
  function pickUp() {
    const { item } = g;
    pointTo(g.a);
    const p = new ui.BuildPart(item.oid, ui.pointer.wx, ui.pointer.wy, item.angle, item.raw);
    ui.selection.clear();
    const [cx, cy] = ui.centerOffset(p);
    ui.hold([p], p, true, 'drag', [cx, cy + (LIFT * ui.dpr) / ui.cam.scale]);
    g.kind = 'drag';
    ui.markBin('bin');
  }
  function dragTo(t) {
    pointTo(t);
    ui.markBin(ui.binAt(t.x, t.y));
    ui.follow();
  }
  /** Let go of dragged parts: onto the library deletes them; off the stage, they go back. */
  function release(t) {
    ui.markBin(null);
    pointTo(t);
    const bin = ui.binAt(t.x, t.y);
    if (bin) return ui.trashHeld(bin);
    if (!ui.pointer.overCanvas) return ui.cancelHold();
    // Placed if they fit here; if not, they stay in hand (a toast says why), to be dragged on.
    ui.mode = 'carry';
    ui.drop();
  }
  /** A tapped library part: in hand in the middle of the stage, to be dragged into place. */
  let addedOnce = false;
  function addPart(item) {
    const r = rect();
    pointTo({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    const p = new ui.BuildPart(item.oid, ui.pointer.wx, ui.pointer.wy, item.angle, item.raw);
    ui.selection.clear();
    ui.hold([p], p, true, 'carry', ui.centerOffset(p));
    if (!addedOnce) ui.toast('Drag the part into place.');
    addedOnce = true;
  }

  /**
   * Turn the parts in hand (or the selection) a step clockwise. A lone part in hand turns about its middle, which
   * stays where it was: under the finger dragging it, or where it lies.
   */
  function turn() {
    const h = ui.held;
    if (!h) return ui.rotate(1);
    const p = h.primary, pt = ui.pointer;
    if (g?.kind !== 'drag') [pt.wx, pt.wy] = [p.x + h.grab[0], p.y + h.grab[1]];
    const [cx, cy] = ui.centerOffset(p), rel = [pt.wx - p.x - cx, pt.wy - p.y - cy];
    ui.rotate(1);
    if (ui.held === h && h.single && p.joint !== 'leg') {
      const [nx, ny] = ui.centerOffset(p);
      h.grab = [nx + rel[0], ny + rel[1]];
      ui.follow();
    }
  }
  /** Copies of the selection in hand, over the originals: to be dragged where they go. */
  function copy() {
    const group = ui.dependents(ui.model.parts, [...ui.selection]);
    if (!group.length) return;
    const copies = group.map((p) => p.clone());
    const primary = copies[group.indexOf(group.find((p) => !p.mounted) ?? group[0])];
    ui.selection.clear();
    [ui.pointer.wx, ui.pointer.wy] = [primary.x, primary.y];
    ui.hold(copies, primary, true, 'carry', [0, 0]);
    ui.toast('Drag the copy into place.');
  }

  let tools = null;
  ui.afterPaint = (ctx) => {
    // A long press: a ring under the finger (it can't be felt everywhere).
    if (g?.kind === 'long') {
      const [x, y] = screen(g.a.x0, g.a.y0), d = ui.dpr;
      ctx.beginPath();
      ctx.arc(x, y, 30 * d, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,215,106,0.15)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,215,106,0.95)';
      ctx.lineWidth = 2.5 * d;
      ctx.stroke();
    }
    if (tools) showTools();
  };

  if (!layout) return;

  // ---- the layout ----------------------------------------------------------------------------------------------
  const el = (tag, props) => Object.assign(document.createElement(tag), props);

  // A new design is framed closer: parts big enough to take with a finger.
  ui.fitBlocks = [8, 8];

  // The header folds to its first row (remembered per browser).
  const header = document.querySelector('header');
  const menuButton = el('button', { id: 'menu-toggle' });
  header.prepend(menuButton);
  const fold = (on) => {
    header.classList.toggle('collapsed', on);
    menuButton.innerHTML = icon(on ? ICONS.menu : ICONS.fold);
    menuButton.setAttribute('aria-expanded', !on);
    try { localStorage.setItem('shipbuilder.headerCollapsed', on ? '1' : ''); } catch { /* storage may be off */ }
  };
  menuButton.onclick = () => fold(!header.classList.contains('collapsed'));
  try { fold(localStorage.getItem('shipbuilder.headerCollapsed') === '1'); } catch { fold(false); }

  // The sidebars and the shortcuts start folded, leaving the stage clear (what's remembered for the desktop layout
  // stays as it was).
  for (const bar of document.querySelectorAll('#side-stats > .fold-bar, #side-parts > .fold-bar, #help-bar')) {
    const el = bar.parentElement, key = `shipbuilder.${el.id}Collapsed`;
    if (el.classList.contains('collapsed')) continue;
    let kept = null;
    try { kept = localStorage.getItem(key); } catch { /* storage may be off */ }
    bar.click();
    try { if (kept !== null) localStorage.setItem(key, kept); } catch { /* storage may be off */ }
  }
  document.querySelector('#help .help-body').innerHTML = `
    <b>drag</b> a part: move · <b>drag</b> paper: pan<br>
    <b>pinch</b>: zoom<br>
    <b>tap</b>: select · <b>hold</b>: add to selection<br>
    <b>hold+drag</b>: box select<br>
    <b>second finger tap</b> while dragging: rotate<br>
    <b>tap</b> or <b>drag up</b> a library part: add it<br>
    <b>drag onto the library</b>: delete`;

  // The toolbar: what the keyboard does on a desktop.
  tools = el('div', { id: 'touch-tools' });
  const button = (label, d, action) => {
    const b = el('button', { title: label, innerHTML: `${icon(d)}<span>${label}</span>` });
    b.onclick = () => { action(); syncHover(); ui.draw(); };
    tools.append(b);
    return b;
  };
  const b = {
    undo: button('Undo', ICONS.undo, () => ui.undo()),
    fit: button('Fit', ICONS.fit, () => ui.fit()),
    turn: button('Turn', ICONS.turn, turn),
    copy: button('Copy', ICONS.copy, copy),
    remove: button('Delete', ICONS.remove, () => ui.removeSelection()),
    clear: button('Clear', ICONS.cancel, () => { if (ui.held) ui.cancelHold(); else ui.selection.clear(); }),
    place: button('Place', ICONS.place, () => ui.drop()),
  };
  b.place.classList.add('go');
  stage.append(tools);
  function showTools() {
    const held = !!ui.held, any = held || ui.selection.size > 0, carried = held && ui.mode === 'carry';
    b.undo.disabled = !ui.canUndo();
    b.turn.hidden = b.remove.hidden = b.clear.hidden = !any;
    b.copy.hidden = held || !any;
    b.place.hidden = !carried;
    const clear = held ? 'Cancel' : 'Clear';
    if (b.clear.title !== clear) { b.clear.title = clear; b.clear.lastChild.textContent = clear; }
  }
}
