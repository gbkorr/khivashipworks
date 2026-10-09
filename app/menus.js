// Cascading menus (the Load and Gallery menus, and right-click menus over them), and the stat card preview shown
// beside a design in them.
import { loadButton } from './library.js';
import { cardOfShip } from './gallery.js';

// ---- cascading menus ---------------------------------------------------------------------------------------------
// A stack of lists per menu; hovering an item with a submenu opens it to the side (after a moment if another is
// open, so the pointer can cross other items on its way there). Items can be dragged onto others.
export const menus = { load: [], context: [] };
let hoverTimer = 0;
const dropTargets = new WeakMap();   // item element -> { accepts(data), onDrop(data) }
export function closeMenus(stack, from = 0) {
  for (const m of menus[stack].splice(from)) {
    if (m.contains(previewing)) hideCardPreview();
    m.remove();
  }
  if (stack === 'load' && !menus.load.length) loadButton.setAttribute('aria-expanded', false);
}
export function closeAllMenus() { closeMenus('context'); closeMenus('load'); hideCardPreview(); }
export const inMenus = (el) => [...menus.load, ...menus.context].some((m) => m.contains(el));

/**
 * Show `items` as level `level` of a stack: at a point ({ x, y }; snug: just as wide as the items, not at least
 * the usual width) or beside an item (its element) of the level below. Items: { label, meta, submenu: () => items,
 * onClick, onDelete, onContext(event), drag: data, accepts(data), onDrop(data), onHover(on, element), star: flagship,
 * title: tooltip } or { empty: text }.
 */
export function showMenu(stack, level, items, at) {
  closeMenus(stack, level);
  const menu = document.createElement('div');
  menu.className = `menu ${stack}`;
  if (at.snug) menu.classList.add('snug');
  menu.addEventListener('pointerenter', () => clearTimeout(hoverTimer));
  menu.addEventListener('contextmenu', (e) => e.preventDefault());
  for (const it of items) menu.append(it.empty ? Object.assign(document.createElement('div'), { className: 'empty', textContent: it.empty }) : menuItem(it, stack, level));
  document.body.append(menu);
  menus[stack][level] = menu;
  const w = menu.offsetWidth, h = menu.offsetHeight;
  let x, y;
  if (at instanceof Element) {
    const r = at.getBoundingClientRect(), p = at.closest('.menu').getBoundingClientRect();
    x = p.right - 1 + w > innerWidth - 8 ? p.left + 1 - w : p.right - 1;
    y = r.top - 5;
  } else ({ x, y } = at);
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - 8 - w))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - 8 - h))}px`;
  return menu;
}
function menuItem(it, stack, level) {
  const row = document.createElement('div');
  row.className = 'row';
  const b = document.createElement('button');
  b.className = 'item';
  b.innerHTML = '<span class="label"></span><span class="meta"></span>';
  b.firstChild.textContent = it.label;
  if (it.star) b.firstChild.insertAdjacentHTML('beforeend', ' <span class="star">★</span>');
  b.lastChild.textContent = it.meta ?? '';
  if (it.title) b.title = it.title;
  if (it.submenu) b.insertAdjacentHTML('beforeend', '<span class="arrow">▸</span>');
  row.append(b);
  const open = () => {
    for (const o of row.parentNode.querySelectorAll('.item.open')) o.classList.remove('open');
    if (!it.submenu) return closeMenus(stack, level + 1);
    b.classList.add('open');
    showMenu(stack, level + 1, it.submenu(), b);
  };
  b.addEventListener('pointerenter', () => {
    clearTimeout(hoverTimer);
    // Off to another item: a right-click menu from this stack goes (it would end up under the new submenu).
    if (stack === 'load') closeMenus('context');
    if (menus[stack].length > level + 1) hoverTimer = setTimeout(open, 150);
    else open();
  });
  let dragged = false;
  b.onclick = () => {
    if (dragged) return void (dragged = false);
    it.onClick ? it.onClick() : open();
  };
  if (it.onContext) b.addEventListener('contextmenu', (e) => { open(); it.onContext(e); });
  if (it.onHover) {
    b.addEventListener('pointerenter', () => it.onHover(true, b));
    b.addEventListener('pointerleave', () => it.onHover(false, b));
  }
  if (it.onDrop) dropTargets.set(b, it);
  if (it.drag !== undefined) {
    // Dragged (past a few px): a label follows the pointer, and the item under it that takes it lights up.
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      let ghost = null, target = null;
      const move = (ev) => {
        if (!ghost) {
          if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 5) return;
          ghost = Object.assign(document.createElement('div'), { className: 'drag-ghost', textContent: it.label });
          document.body.append(ghost);
          hideCardPreview();
          b.setPointerCapture(e.pointerId);   // (no hovering other items open their submenus meanwhile)
        }
        ghost.style.left = `${ev.clientX + 12}px`;
        ghost.style.top = `${ev.clientY + 8}px`;
        const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.item');
        const d = over && dropTargets.get(over);
        const t = d && d.accepts?.(it.drag) !== false ? over : null;
        if (t !== target) { target?.classList.remove('drop'); t?.classList.add('drop'); target = t; }
      };
      const end = (ev) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        if (!ghost) return;
        ghost.remove();
        target?.classList.remove('drop');
        dragged = true;
        setTimeout(() => { dragged = false; }, 0);   // (the click that may follow the release)
        if (target && ev.type === 'pointerup') dropTargets.get(target).onDrop(it.drag);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    });
  }
  if (it.onDelete) {
    const del = Object.assign(document.createElement('button'), { className: 'delete', textContent: '×' });
    del.onclick = it.onDelete;
    row.append(del);
  }
  return row;
}

/** Where a menu opens under a button (`snug`: showMenu's). */
export const below = (el, snug = false) => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.bottom + 4, snug };
};

// ---- the card preview: a design's stat card beside the menu item hovered (the cards: gallery.js) -------------------
const preview = Object.assign(document.createElement('div'), { id: 'card-preview', hidden: true });
document.body.append(preview);
export let previewing = null;

/** Show a design's card beside the list, level with its item (once drawn; unless the pointer has left by then). */
export function showCardPreview(ship, item) {
  previewing = item;
  cardOfShip(ship).then((c) => {
    if (previewing === item && c) placePreview(item, Object.assign(document.createElement('img'), { src: c.url, alt: '' }));
  }, (err) => {
    if (previewing === item) placePreview(item, Object.assign(document.createElement('div'), { className: 'drawing', textContent: `Couldn't draw the card: ${err.message}.` }));
  });
}
function placePreview(item, content) {
  preview.replaceChildren(content);
  preview.hidden = false;
  const m = item.closest('.menu').getBoundingClientRect(), r = item.getBoundingClientRect();
  const w = preview.offsetWidth, h = preview.offsetHeight;
  const x = m.right + 6 + w > innerWidth - 8 ? m.left - 6 - w : m.right + 6;
  preview.style.left = `${Math.max(8, x)}px`;
  preview.style.top = `${Math.max(8, Math.min(r.top + r.height / 2 - h / 2, innerHeight - 8 - h))}px`;
}
export function hideCardPreview() {
  previewing = null;
  preview.hidden = true;
  preview.replaceChildren();
}
window.addEventListener('pointerdown', (e) => { if (e.button === 0) hideCardPreview(); }, { capture: true });
window.addEventListener('wheel', hideCardPreview, { capture: true, passive: true });
