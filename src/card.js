// Composite layouts: the shipyard card (stats + ship) and the full sheet
// (stats | new-game card above the ship | parts list).
import { computeStats } from './stats.js';
import { renderShip, shipRenderBounds } from './render.js';
import { PART_SCALE } from './partstyles.js';
import { renderBlueprint } from './blueprint.js';
import { renderPanel, panelHeight } from './panel.js';
import { renderShipCard, className, CARD } from './shipcard.js';
import { drawText } from './font.js';
import { partsList, partsListHeight, renderPartsList, renderRolesList, rolesListHeight, PARTS } from './parts.js';
import { sortedRoles } from './shipcard.js';

/**
 * Draw the ship of a composite layout. With opts.blueprint (the blueprint atlas) the whole
 * width x height area becomes graph paper aligned to the ship's blocks; otherwise the in-game
 * sprites are drawn on a flat background. Parts are scaled by PART_SCALE unless opts.partScale is given.
 */
function drawShipArea(ctx, ship, opts, { width, height, scale, x, y }) {
  opts = { ...opts, partScale: opts.partScale ?? PART_SCALE };
  if (opts.blueprint) {
    renderBlueprint(ctx, ship, opts.blueprint, { ...opts, scale, x, y, paper: { x: 0, y: 0, w: width, h: height } });
    return;
  }
  ctx.fillStyle = opts.background ?? '#44545a';
  ctx.fillRect(0, 0, width, height);
  renderShip(ctx, ship, opts.atlas, { ...opts, scale, x, y });
}

const PANEL_W = 420;

/**
 * Shipyard-style card: stats panel on the left, ship on the right (size it with cardSize()).
 * @param opts { blueprint (blueprint atlas) or atlas (in-game sprites), fonts (or fontImage),
 *               createCanvas, background, scale, stats }
 */
export function renderCard(ctx, ship, opts = {}) {
  const stats = opts.stats ?? computeStats(ship);
  const { width, height, shipX, shipY, scale, bounds } = cardLayout(ship, opts);
  drawShipArea(ctx, ship, opts, {
    width, height, scale, x: shipX - bounds.x0 * scale, y: shipY - bounds.y0 * scale,
  });
  renderPanel(ctx, stats, { ...opts, x: 18, y: 14 });
  return stats;
}

/** Size and placement of a shipyard card for this ship. */
export function cardLayout(ship, opts = {}) {
  const scale = opts.scale ?? 7;
  const bounds = shipRenderBounds(ship);
  const panelW = 440, panelH = 720, pad = 20;
  const shipW = Math.ceil(bounds.w * scale), shipH = Math.ceil(bounds.h * scale);
  const width = panelW + shipW + pad;
  const height = Math.max(panelH, shipH + 2 * pad);
  return { width, height, shipX: panelW, shipY: Math.round((height - shipH) / 2), scale, bounds };
}
export const cardSize = (ship, opts) => { const l = cardLayout(ship, opts); return { width: l.width, height: l.height }; };

/** Layout of the full sheet: stats | card over ship | parts list. */
export function sheetLayout(ship, stats, opts = {}) {
  const scale = opts.scale ?? 7, pad = 20, gap = 30;
  const bounds = shipRenderBounds(ship);
  const shipW = Math.ceil(bounds.w * scale), shipH = Math.ceil(bounds.h * scale);
  const sections = partsList(ship, opts);
  const rolesH = rolesListHeight(sortedRoles(stats));
  const partsH = rolesH + partsListHeight(sections);
  const classH = 34;
  const midW = Math.max(CARD.width, shipW);
  const midH = CARD.height + classH + gap + shipH;
  const partsW = partsH ? PARTS.width : 0;
  const width = pad + PANEL_W + gap + midW + (partsW ? gap + partsW : 0) + pad;
  const height = pad + Math.max(panelHeight(stats), midH, partsH) + pad;
  const midX = pad + PANEL_W + gap;
  return {
    width, height, scale, bounds, sections,
    panel: { x: pad, y: pad },
    card: { x: midX + (midW - CARD.width) / 2, y: pad },
    classLine: { x: midX + midW / 2, y: pad + CARD.height + 4 },
    ship: { x: midX + (midW - shipW) / 2, y: pad + CARD.height + classH + gap },
    roles: { x: midX + midW + gap, y: pad },
    parts: { x: midX + midW + gap, y: pad + rolesH },
  };
}

/**
 * Full sheet (size it with sheetLayout(ship, stats)).
 * The ship is drawn as a blueprint when opts.blueprint is given; the new-game card always uses the
 * in-game sprites (opts.atlas).
 * @param opts { blueprint, atlas, ui, fonts, createCanvas, stats, lang, background, scale }
 */
export function renderSheet(ctx, ship, opts = {}) {
  const stats = opts.stats ?? computeStats(ship);
  const L = sheetLayout(ship, stats, opts);
  drawShipArea(ctx, ship, opts, {
    width: L.width, height: L.height, scale: L.scale,
    x: L.ship.x - L.bounds.x0 * L.scale, y: L.ship.y - L.bounds.y0 * L.scale,
  });
  renderPanel(ctx, stats, { ...opts, ...L.panel });
  renderShipCard(ctx, ship, { ...opts, stats, ...L.card });
  drawText(ctx, 'fixed_20', className(stats, opts.lang).long, L.classLine.x, L.classLine.y, '#e06868',
    { ...opts, align: 'center' });
  renderRolesList(ctx, { ...opts, stats, ...L.roles });
  if (L.sections.length) renderPartsList(ctx, ship, { ...opts, sections: L.sections, ...L.parts });
  return stats;
}
