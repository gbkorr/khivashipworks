// Editing the design: the undo stack, changes (and what they set off), picking parts up, carrying, dropping,
// turning and deleting them. The rules, snapping and export live in lib/builder.js.
import {
  BRIDGE, BuildModel, BuildPart, computeLinks, dependents, placement, restAngle, rotateParts, rotationStep,
  snapOffset, turnLegs, turnPart,
} from '../lib/builder.js';
import { Ship } from '../lib/ship.js';
import { computeStats } from '../lib/stats.js';
import { S, $, canvas, pointer, undoStack } from './state.js';
import { draw, fit } from './view.js';
import { drawSidePanels, loadedSoon } from './panels.js';
import { trayItem } from './tray.js';
import { toast } from './dialogs.js';

// ---- undo ------------------------------------------------------------------------------------------
function snapshot() {
  undoStack.push(S.model.parts.map((p) => ({ oid: p.oid, x: p.x, y: p.y, angle: p.angle, raw: p.raw })));
  if (undoStack.length > 200) undoStack.shift();
}
export function undo() {
  if (S.held) return cancelHold();
  const s = undoStack.pop();
  if (!s) return;
  S.model.parts = s.map((q) => new BuildPart(q.oid, q.x, q.y, q.angle, q.raw));
  S.selection.clear();
  changed();
}

// ---- model changes -----------------------------------------------------------------------------------
let statsTimer = 0;

function changed() {
  S.version++;
  S.edited = true;
  const v = S.model.validate();
  S.problems = v.problems;
  // Stats need the full export tree; keep them off the interaction path.
  clearTimeout(statsTimer);
  statsTimer = setTimeout(() => {
    // Not counting new parts still in hand (e.g. the copy after a shift-place), nor unconnected ones.
    const { ship: placed, loose } = connected(new Set(S.held?.isNew ? S.held.group : []));
    try {
      const ship = new Ship(placed.toTree());
      const s = computeStats(ship);
      S.current = { ship, stats: s, placed };
      drawSidePanels(ship, s);
    } catch { /* partial designs can trip the stats; the side panels keep the last ones */ }
  }, 120);
  draw();
}

/**
 * The design without parts left unconnected to the bridge (they aren't part of the ship: they're left out of
 * the stats, the card and the downloads; with no bridge, everything counts), nor `exclude`. Of `m`, the one being
 * built unless given.
 * @returns { ship: BuildModel, loose: number of unconnected parts }
 */
export function connected(exclude = new Set(), m = S.model) {
  const parts = m.parts.filter((p) => !exclude.has(p));
  const hasBridge = parts.some((p) => p.oid === BRIDGE);
  const loose = new Set(hasBridge ? new BuildModel({ ...m, parts }).unconnected() : []);
  return { ship: new BuildModel({ ...m, parts: parts.filter((p) => !loose.has(p)) }), loose: loose.size };
}

export function setModel(m) {
  S.model = m;
  S.selection.clear();
  S.held = null;
  S.mode = 'idle';
  undoStack.length = 0;
  $('name').value = S.model.name;
  $('flagship').setAttribute('aria-pressed', S.model.flagship);
  fit();
  // Its card (and colour bake) are made as soon as its stats are, not after the input goes idle.
  loadedSoon();
  changed();
  S.edited = false;
}

// ---- hit testing -------------------------------------------------------------------------------------
function inside(poly, x, y) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
/** Topmost part under a design point: modules above structure, then by render layer. */
export function partAt(wx, wy, exclude = null) {
  let best = null, rank = -Infinity;
  for (const p of S.model.parts) {
    if (exclude?.has(p)) continue;
    const b = p.bounds();
    if (wx < b.x0 || wx > b.x1 || wy < b.y0 || wy > b.y1 || !inside(p.polygon(), wx, wy)) continue;
    const r = (p.mounted ? 100 : 0) + (p.raw.m_layer ?? 0) + (p.raw.m_stage ?? 0) / 100;
    if (r >= rank) { rank = r; best = p; }
  }
  return best;
}

// ---- moving parts ----------------------------------------------------------------------------------
/** Pick up parts (with whatever is mounted on them) so they follow the pointer. */
export function hold(parts, primary, isNew, holdMode, grab = null) {
  if (!isNew) snapshot();
  const group = isNew ? parts : dependents(S.model.parts, parts);
  if (isNew) S.model.parts.push(...parts);
  const origin = new Map(group.map((p) => [p, { x: p.x, y: p.y, angle: p.angle }]));
  const bases = new Map(group.map((p) => [p, [p.x, p.y]]));
  // One part is held by its middle; a multiselection keeps where it was grabbed.
  const single = parts.length === 1;
  grab ??= single ? centerOffset(primary) : isNew ? [0, 0] : [pointer.wx - primary.x, pointer.wy - primary.y];
  S.held = { group, primary, bases, grab, origin, isNew, single, offset: [0, 0], valid: false, freeSlots: [] };
  // Where moved parts were: the shaded view keeps its bake until the drop, with these spots washed out.
  S.held.ghost = isNew ? [] : group.map((p) => p.polygon());
  S.held.version = S.version;
  S.held.freeSlots = freeSlotsFor(S.held);
  S.mode = holdMode;
  canvas.classList.add('holding');
  follow();
}

/** From a part's origin to the middle of its footprint. */
export function centerOffset(p) {
  const b = p.bounds();
  return [(b.x0 + b.x1) / 2 - p.x, (b.y0 + b.y1) / 2 - p.y];
}

/** Free slots on the rest of the ship that the held primary part could plug into (drawn as hints). */
function freeSlotsFor(h) {
  if (!h.primary.mounted) return [];
  const inGroup = new Set(h.group);
  const others = S.model.parts.filter((p) => !inGroup.has(p));
  const links = computeLinks(others);
  const want = h.primary.slots().filter((s) => s.mount).map((s) => s.type);
  return others.flatMap((p) => p.slots())
    .filter((s) => !s.mount && !links.linkOf(s) && want.some((t) => (s.type & t) === t));
}

export function follow() {
  if (!S.held) return;
  const { primary, bases, grab } = S.held;
  const [bx, by] = bases.get(primary);
  const dx = pointer.wx - grab[0] - bx, dy = pointer.wy - grab[1] - by;
  const [sx, sy] = snapOffset(S.model.parts, S.held.group, primary, dx, dy, bases);
  S.held.offset = [sx, sy];
  for (const p of S.held.group) {
    const [x, y] = bases.get(p);
    p.x = x + sx; p.y = y + sy;
  }
  const at = placement(S.model.parts, S.held.group);
  S.held.valid = at.ok;
  S.held.attached = at.attached;
  S.held.reason = at.reason;
  draw();
}

/** Why a group can't go where it is, by placement().reason. */
const REASONS = {
  overlap: 'overlaps another part', slot: 'must be placed on hull', deck: 'aircraft must be placed on a flight deck',
};
const reason = (why) => REASONS[why] ?? REASONS.overlap;

/** Put the held group down. With shift, a copy stays in hand (duplicate). */
export function drop(duplicate = false) {
  if (!S.held) return;
  if (!S.held.valid) {
    toast(`Can't place: ${reason(S.held.reason)}.`);
    // A carried part stays in hand until it finds a spot (or Esc); a dragged one goes back.
    if (S.mode !== 'carry') cancelHold();
    return;
  }
  if (S.held.isNew) {
    undoStack.push(S.model.parts.filter((p) => !S.held.group.includes(p)).map((p) => ({ oid: p.oid, x: p.x, y: p.y, angle: p.angle, raw: p.raw })));
  }
  const placed = S.held.group;
  S.lastDrop = { parts: placed, time: performance.now() };
  const { primary, grab } = S.held;
  S.held = null;
  S.mode = 'idle';
  canvas.classList.remove('holding');
  S.selection = new Set(placed.length > 1 && !duplicate ? placed : []);
  changed();
  if (duplicate) {
    const copies = new Map(placed.map((p) => [p, p.clone()]));
    hold([...copies.values()], copies.get(primary), true, 'carry', grab);
  }
}

/**
 * Left and right button together: delete, like Del. Whichever button lands first already did something
 * (a left click puts a carried part down or picks one up, a right press starts panning); undo that.
 */
export function chordDelete() {
  if (S.pan) { S.pan = null; canvas.classList.remove('panning'); if (S.mode === 'pan') S.mode = 'idle'; }
  if (S.held) return deleteHeld();
  if (S.mode === 'press') {
    if (!S.selection.has(S.press.part)) { S.selection.clear(); S.selection.add(S.press.part); }
    S.mode = 'idle';
  } else if (S.mode === 'box') {
    // The left press on empty space cleared the selection; the chord means the one before it.
    if (!S.box.add) S.selection = S.selectionBeforeBox;
    S.box = null;
    S.mode = 'idle';
  } else if (S.lastDrop && performance.now() - S.lastDrop.time < 400) {
    S.selection = new Set(S.lastDrop.parts.filter((p) => S.model.parts.includes(p)));
  }
  S.lastDrop = null;
  // Only what's under the pointer: a chord elsewhere leaves the selection be.
  const under = partAt(pointer.wx, pointer.wy);
  if (!under || !dependents(S.model.parts, [...S.selection]).includes(under)) return draw();
  removeSelection();
}

/**
 * Delete every part with no connection to the bridge (things left off to the side). `withHeld`: the held parts too
 * (dropped on the library's prune bin), in the same undo step.
 */
export function pruneUnconnected(withHeld = false) {
  const saved = withHeld && S.held && !S.held.isNew;   // (hold() saved the undo step already)
  if (withHeld) deleteHeld();
  else if (S.held) cancelHold();
  if (!S.model.parts.some((p) => p.oid === BRIDGE)) return toast('No bridge: nothing counts as connected.');
  const gone = new Set(S.model.unconnected());
  if (!gone.size) return toast('Every part is connected.');
  if (!saved) snapshot();
  S.model.parts = S.model.parts.filter((p) => !gone.has(p));
  for (const p of gone) S.selection.delete(p);
  toast(`Deleted ${gone.size} unconnected part${gone.size > 1 ? 's' : ''}.`);
  changed();
}

/** Delete the held group (Del, or dropping it back on the parts tray). */
export function deleteHeld() {
  if (!S.held) return;
  if (S.held.isNew) return cancelHold();
  const gone = new Set(S.held.group);
  S.model.parts = S.model.parts.filter((p) => !gone.has(p));   // hold() already saved the undo step
  S.held = null;
  S.mode = 'idle';
  canvas.classList.remove('holding');
  S.selection.clear();
  changed();
}

/** Add parts to the selection together with the hull they're mounted on, so the group can move. */
export function selectWithHosts(parts) {
  const { host } = computeLinks(S.model.parts);
  for (const p of parts) {
    for (let q = p, n = 0; q && n < 50; q = host.get(q), n++) S.selection.add(q);
  }
}

export function cancelHold() {
  if (!S.held) return;
  if (S.held.isNew) {
    const drop = new Set(S.held.group);
    S.model.parts = S.model.parts.filter((p) => !drop.has(p));
  } else {
    for (const [p, o] of S.held.origin) Object.assign(p, o);
    undoStack.pop();
  }
  S.held = null;
  S.mode = 'idle';
  canvas.classList.remove('holding');
  changed();
}

/**
 * Turn a group by `dir` steps (dir > 0: clockwise). A lone part turns by its own step (90, 45 or 15 degrees;
 * false if it doesn't turn), and so do legs, each chain about its top mount. Any other group turns by quarters
 * about (cx, cy), and its parts that don't turn on their own go back to their resting angle.
 */
function turnGroup(group, dir, cx, cy) {
  if (group.length === 1) return turnPart(group[0], dir);
  if (turnLegs(S.model.parts, group, dir)) return true;
  for (let i = 0; i < ((dir % 4) + 4) % 4; i++) rotateParts(group, cx, cy);
  for (const p of group) if (!rotationStep(p.oid)) p.angle = restAngle(p.oid);
  return true;
}

const allLegs = (group) => group.every((p) => p.joint === 'leg');

/** R / shift+wheel: turn the held group, or the selection, by `dir` steps (> 0 clockwise, < 0 anticlockwise). */
export function rotate(dir = 1) {
  if (!dir) return;
  const fixed = (p) => toast(`${trayItem(p.oid).name} doesn't rotate.`);
  if (S.held) {
    const { primary } = S.held;
    const [px, py] = [primary.x, primary.y];
    if (!turnGroup(S.held.group, dir, primary.x, primary.y)) return fixed(primary);
    // Keep the current offset: the rotated positions become the new bases.
    for (const p of S.held.group) S.held.bases.set(p, [p.x - S.held.offset[0], p.y - S.held.offset[1]]);
    // Turning about the primary part leaves it (and so a multiselection's grab) in place; legs keep their
    // pivot where it is, and any other single part is re-centred on the cursor.
    if (allLegs(S.held.group)) S.held.grab = [S.held.grab[0] - (primary.x - px), S.held.grab[1] - (primary.y - py)];
    else if (S.held.single) S.held.grab = centerOffset(primary);
    S.held.freeSlots = freeSlotsFor(S.held);
    follow();
    return;
  }
  if (!S.selection.size) return toast('Select parts (or hold one) to rotate.');
  const group = dependents(S.model.parts, [...S.selection]);
  const before = new Map(group.map((p) => [p, { x: p.x, y: p.y, angle: p.angle }]));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of group) {
    const b = p.bounds();
    x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
  }
  snapshot();
  if (!turnGroup(group, dir, (x0 + x1) / 2, (y0 + y1) / 2)) { undoStack.pop(); return fixed(group[0]); }
  // Snap by the structure, or by the top of a leg chain.
  const { host } = computeLinks(S.model.parts);
  const primary = group.find((p) => !p.mounted) ?? group.find((p) => !group.includes(host.get(p))) ?? group[0];
  const bases = new Map(group.map((p) => [p, [p.x, p.y]]));
  const [dx, dy] = snapOffset(S.model.parts, group, primary, 0, 0, bases);
  for (const p of group) { p.x += dx; p.y += dy; }
  const at = placement(S.model.parts, group);
  if (!at.ok) {
    for (const [p, o] of before) Object.assign(p, o);
    undoStack.pop();
    toast(`Can't rotate here: ${reason(at.reason)}.`);
  }
  changed();
}

export function removeSelection() {
  if (S.held) return deleteHeld();
  if (!S.selection.size) return;
  snapshot();
  const gone = new Set(dependents(S.model.parts, [...S.selection]));
  S.model.parts = S.model.parts.filter((p) => !gone.has(p));
  S.selection.clear();
  changed();
}
