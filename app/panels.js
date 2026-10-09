// The side panels: the stat card and the stats (left), the parts list (right), drawn when the input is idle; the
// foldable sections; the name and flagship controls.
import { drawText, measureText } from '../lib/font.js';
import { statLines } from '../lib/panel.js';
import { RULED, partsList, renderRuledList, ruledListLines } from '../lib/parts.js';
import { SHADING, bakeShadedAsync } from '../lib/shading.js';
import { encodeDesign } from '../lib/sharecode.js';
import { CARD, renderStatCard, statCardLines } from '../lib/statcard.js';
import { S, $, canvas, carrying, hotkeyHint } from './state.js';
import { atlas, fonts, ui } from './assets.js';
import { bakeKey, bakes, refreshStill } from './view.js';

// The parts list's width: its longest line (NUCLEAR MISSILE CARRIER) and a little room (#parts-ruled's width).
const PARTS_W = 280;
const STATS_W = 394, STATS_PAD = 14, STATS_LINE = 21, STATS_FONT = 'dinpro_14_reg';   // the card's width

/**
 * The page's ink and coral (the CSS --ink and --warn), which the light paper changes; there the ink darkens the
 * role icons too.
 */
function inks() {
  const css = getComputedStyle(document.documentElement), ink = css.getPropertyValue('--ink').trim();
  return { ink, accent: css.getPropertyValue('--warn').trim(), roles: S.light ? ink : null };
}

export function drawSidePanels(ship, stats) {
  // Stats as label / value rows, in the ruled list's font; warnings in coral.
  const colors = inks();
  const rows = statLines(stats).rows, sk = window.devicePixelRatio || 1;
  const valueX = STATS_PAD + Math.max(...rows.map((r) => measureText(STATS_FONT, r.label))) + 16;
  const sp = $('stats-panel'), sh = rows.length * STATS_LINE;
  sp.width = STATS_W * sk; sp.height = sh * sk;
  sp.style.width = `${STATS_W}px`; sp.style.height = `${sh}px`;
  const sg = sp.getContext('2d');
  sg.scale(sk, sk);
  rows.forEach((r, i) => {
    const c = r.red ? colors.accent : colors.ink, y = i * STATS_LINE + 1;
    if (r.label) for (const [t, x] of [[r.label, STATS_PAD], [r.value, valueX]]) drawText(sg, STATS_FONT, t, x, y, c, { fonts });
  });

  // Ruled list; the rules themselves are the side panel's CSS background, so they carry on below it.
  const sections = partsList(ship);
  const h = ruledListLines(stats, sections) * RULED.line;
  const p = $('parts-panel'), k = window.devicePixelRatio || 1;
  p.width = PARTS_W * k; p.height = Math.max(1, h * k);
  p.style.width = `${PARTS_W}px`; p.style.height = `${h}px`;
  p.hidden = !h;
  const g = p.getContext('2d');
  g.scale(k, k);
  // Headers in the page's coral.
  renderRuledList(g, { ui, fonts, stats, sections, width: PARTS_W, colors });
  p.nextElementSibling.textContent = h ? '' : 'No weapons, sensors or engines yet.';

  cardWanted = true;
  whenIdle();
}

// The stat card is drawn at 3x, the size it's saved at: its stamp (the design, printed in the right column) is
// made to survive recompression at that size. The sidebar shows it scaled down.
export const CARD_SCALE = 3;
/** The design code for the stamp: the placed parts, with the current name and flagship flag. */
const cardCode = () => encodeDesign({ name: S.model.name, flagship: S.model.flagship, parts: S.current.placed.parts });
const cardVisible = () => !$('side-stats').classList.contains('collapsed') && !$('card-section').classList.contains('collapsed');

// Work that stalls the page for a moment on a large ship waits until IDLE ms after the last input (and nothing is
// carried), so it doesn't break into a pan, a drag or a zoom: bringing the colour bake up to date (also in blueprint
// mode, so switching to colour finds it ready), then the card, drawn from that bake. Moving the pointer counts only
// while a button is down or a part is held; plain mouse motion doesn't hold it up. A newly loaded design doesn't
// wait (loadedNow), nor does anything in colour mode: the stage bakes each change straight away, and the card
// just follows it. Otherwise the work is done a few ms at a time and dropped the moment an input comes in (what was
// half done is thrown away), to be taken up again once the input is idle again; a newly loaded design's isn't
// dropped for input.
const IDLE = 50;
let lastInput = 0, idleTimer = 0, cardWanted = false, cardShown = '', loadedNow = false;
for (const type of ['pointermove', 'pointerdown', 'pointerup', 'wheel', 'keydown']) {
  window.addEventListener(type, (e) => {
    if (type === 'pointermove' && !e.buttons && !S.held) return;
    lastInput = performance.now();
  }, { capture: true, passive: true });
}
function whenIdle() {
  if (idleTimer) return;
  const check = () => {
    const wait = loadedNow || S.colour ? 0 : IDLE - (performance.now() - lastInput);
    if (wait > 0 || carrying()) { idleTimer = setTimeout(check, Math.max(20, wait)); return; }
    idleTimer = 0;
    idleWork();
  };
  idleTimer = setTimeout(check, 0);
}
/** A newly loaded design: its card is made as soon as its stats are, not after the input goes idle. */
export function loadedSoon() {
  loadedNow = true;
  clearTimeout(idleTimer);
  idleTimer = 0;
}
/** Do the idle work now if it's waiting (in colour mode nothing waits for the input). */
export function wakeIdle() {
  if (!idleTimer) return;
  clearTimeout(idleTimer);
  idleTimer = 0;
  whenIdle();
}
let working = null;
async function idleWork() {
  if (working) return;   // (loadedNow stays set for the run after this one)
  const started = performance.now(), v = S.version, fresh = loadedNow;
  loadedNow = false;
  // Dropped: an input since this started (unless in colour, where nothing waits, or for a newly loaded design),
  // or another change.
  const dropped = () => (!S.colour && !fresh && lastInput > started) || S.version !== v || carrying();
  working = (async () => {
    if (!(await refreshStillAsync(dropped))) return false;
    if (!cardWanted || !S.current || !cardVisible()) return true;
    cardWanted = false;   // (a request arriving while this runs sets it again)
    const cur = S.current, code = await cardCode();
    if (dropped()) return !(cardWanted = true);
    // Not redrawn when it would come out the same (same design code, stats and colour).
    const key = `${code.join(',')};${JSON.stringify(statCardLines(cur.stats))};${cur.stats.price};${cur.stats.class.purpose}`;
    if (key !== cardShown) {
      const pic = await cardPicture(cur, dropped);
      if (!pic && dropped()) return !(cardWanted = true);
      await new Promise((ok) => setTimeout(ok, 0));   // the card in a task of its own
      if (dropped()) return !(cardWanted = true);
      drawCard($('card-panel'), cur, code, pic);
      cardShown = key;
    }
    return true;
  })();
  const done = await working;
  working = null;
  // Dropped, or another change or card request came in meanwhile: again, once the input is idle.
  if (!done || S.version !== v || cardWanted) whenIdle();
}

/** refreshStill, a few ms at a time (at once in colour mode); false if `dropped()` stopped it first. */
async function refreshStillAsync(dropped) {
  const still = bakes.still;
  if (carrying()) return false;
  if (still.version === S.version) return true;
  if (S.colour) { refreshStill(); return true; }
  const v = S.version, view = S.model.view(), key = bakeKey(view, SHADING);
  if (key !== still.key) {
    const bake = await bakeShadedAsync(view, atlas, SHADING, { cancelled: dropped });
    if (dropped()) return false;
    Object.assign(still, { key, bake, shift: [0, 0] });
  }
  still.version = v;
  return true;
}

// The card's ship is always in colour: the stage's colour bake, unless parts are left unconnected (the card leaves
// them out): then a bake of its own, once per design (not per name or flagship change).
let cardPic = null, cardPicKey = '';
async function cardPicture({ placed }, dropped) {
  if (placed.parts.length === S.model.parts.length) return bakes.still.bake;
  const view = placed.view(), key = bakeKey(view, SHADING);
  if (key !== cardPicKey) {
    const bake = await bakeShadedAsync(view, atlas, SHADING, { cancelled: dropped });
    if (dropped()) return null;
    cardPicKey = key; cardPic = bake;
  }
  return cardPic;
}
/** @returns whether the stamp was printed (`m`: the design it's of, the one being built unless given) */
export function drawCard(c, cur, code, pic, m = S.model) {
  const { ship, stats } = cur;
  c.width = CARD.width * CARD_SCALE; c.height = CARD.height * CARD_SCALE;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.scale(CARD_SCALE, CARD_SCALE);
  ship.name = m.name;
  const { stamped } = renderStatCard(g, ship, {
    atlas, ui, fonts, stats, bake: pic, flagship: m.flagship, stamp: code,
  });
  return stamped;
}

// Foldable sections (remembered per browser): the two sidebars (to the bar on their inner edge), the card
// above the stats (up to its title bar), and the shortcuts on the stage (to theirs). The sidebars' bars show
// their hotkeys (input.js).
const sections = [
  [$('side-stats'), $('side-stats').querySelector(':scope > .fold-bar'), (on) => `${on ? '▸' : '◂'} stats`, 'T'],
  [$('side-parts'), $('side-parts').querySelector(':scope > .fold-bar'), (on) => `${on ? '◂' : '▸'} parts`, 'P'],
  [$('card-section'), $('card-bar'), (on) => `${on ? '▸' : '▾'} ship card`],
  [$('help'), $('help-bar'), (on) => `${on ? '▸' : '▾'} shortcuts`],
];
for (const [el, button, label, hotkey] of sections) {
  const key = `shipbuilder.${el.id}Collapsed`;
  const set = (on) => {
    el.classList.toggle('collapsed', on);
    // The arrow stands upright on the vertical bars.
    const [arrow, text] = label(on).split(/ (.*)/);
    button.replaceChildren(Object.assign(document.createElement('span'), { className: 'arrow', textContent: arrow }), ` ${text}`);
    if (hotkey) button.append(hotkeyHint(hotkey));
    try { localStorage.setItem(key, on ? '1' : ''); } catch { /* storage may be off */ }
  };
  button.onclick = () => {
    set(!el.classList.contains('collapsed'));
    if (S.current) drawSidePanels(S.current.ship, S.current.stats);   // the card isn't drawn while hidden
  };
  let on = false;
  try { on = localStorage.getItem(key) === '1'; } catch { /* storage may be off */ }
  set(on);
}

// A left click on the ship card folds it, like its title bar.
$('card-panel').addEventListener('click', () => $('card-bar').click());

// A click anywhere on the shortcuts folds them; scrolling over them still zooms.
$('help').addEventListener('click', (e) => { if (!$('help-bar').contains(e.target)) $('help-bar').click(); });
$('help').addEventListener('wheel', (e) => {
  e.preventDefault();
  canvas.dispatchEvent(new WheelEvent('wheel', e));
}, { passive: false });

// ---- header controls --------------------------------------------------------------------------------------
$('name').addEventListener('input', (e) => {
  S.model.name = e.target.value.trim() || 'New ship';
  S.edited = true;
  if (S.current) drawSidePanels(S.current.ship, S.current.stats);
});
$('flagship').onclick = () => {
  S.model.flagship = !S.model.flagship;
  S.edited = true;
  $('flagship').setAttribute('aria-pressed', S.model.flagship);
  if (S.current) drawSidePanels(S.current.ship, S.current.stats);
};
