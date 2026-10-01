// Stat card: the new-game ship card's look (name, ship, price on the purpose-coloured card) with more useful
// numbers: movement, combat value, anti-air, missiles, aircraft.
import UI from '../data/ui.json' with { type: 'json' };
import { computeStats } from './stats.js';
import { bakeShaded, SHADING } from './shading.js';
import { CARD, CARD_BACKGROUND, outlineImage } from './shipcard.js';
import { drawText, measureText, makeCanvas } from './font.js';
import { drawStamp, STAMP } from './stamp.js';

const CREAM = '#fffbdb', DIM = '#fffbdbb0';
const TEXT_FONT = 'flash_large', LINE = 15;
const round10 = (v) => Math.round(v / 10) * 10;

function sprite(ctx, ui, name, x, y, w, h) {
  const e = UI[name];
  if (!e || !ui) return;
  ctx.drawImage(ui, e.x, e.y, e.w, e.h, x, y, w ?? e.w, h ?? e.h);
}

/** A small radiation trefoil (like the game's strategic role icon: a blade up, two down) centred at (x, y). */
function trefoil(g, x, y, color, r = 5) {
  g.save();
  g.fillStyle = color;
  g.beginPath();
  g.arc(x, y, r * 0.22, 0, 2 * Math.PI);
  for (const a of [-90, 30, 150]) {
    const a0 = (a - 30) * Math.PI / 180, a1 = (a + 30) * Math.PI / 180;
    g.moveTo(x + r * 0.38 * Math.cos(a0), y + r * 0.38 * Math.sin(a0));
    g.arc(x, y, r, a0, a1);
    g.arc(x, y, r * 0.38, a1, a0, true);
    g.closePath();
  }
  g.fill();
  g.restore();
}

/**
 * The card sprite's own px, opaque, and nothing of its shadow (the sprite's soft black shadow is at most ~2/3
 * opaque, the card's worn edge nearly fully): a mask to cut the stamp to.
 */
const faces = new Map();
function cardFace(ui, name, opts) {
  if (faces.get(name)?.ui === ui) return faces.get(name).canvas;
  const c = makeCanvas(CARD.width, CARD.height, opts), g = c.getContext('2d');
  sprite(g, ui, name, 0, 0);
  const img = g.getImageData(0, 0, CARD.width, CARD.height);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = img.data[i] > 200 ? 255 : 0;
  g.putImageData(img, 0, 0);
  faces.set(name, { ui, canvas: c });
  return c;
}

/** The card's stat lines as [label, value, icon?] (icon: 'nuclear', drawn after the value); null is a gap between groups (movement, combat, sensors). */
export function statCardLines(s) {
  const lines = [
    ['TR/WT', s.twrFull.toFixed(1)],
    ['SPEED', `${round10(s.speedKmh)} km/h`],
    ['RANGE', `${round10(s.rangeKm)} km`],
    ['WEIGHT', `${Math.round(s.mass / 1000)} t`],
    null,
  ];
  if (Math.trunc(s.combatValue) > 0) lines.push(['COMBAT', String(Math.trunc(s.combatValue))]);
  if (s.rockets) lines.push(['ROCKETS', String(s.rockets)]);
  if (s.guidance && s.sprints) lines.push(['SPRINT', `${s.sprints} (${s.guidance})`]);
  // Nuclear missiles, when there are any, stand for the lot (a trefoil after the count).
  if (s.nukesNuclear) lines.push(['MISSILES', String(s.nukesNuclear), 'nuclear']);
  else if (s.missiles) lines.push(['MISSILES', String(s.missiles)]);
  if (s.aircraft.small || s.aircraft.large) lines.push(['AIRCRAFT', `${s.aircraft.small}/${s.aircraft.large}`]);
  if (lines.at(-1)) lines.push(null);
  if (s.radar) lines.push(['RADAR', `${round10(s.radar)} km`]);
  if (s.elint) lines.push(['ELINT', `${round10(s.elintKm)} km`]);
  if (s.irst) lines.push(['IRST', `${round10(s.irst)} km`]);
  if (!lines.at(-1)) lines.pop();
  return lines;
}

/**
 * The ship shaded like the hangar (cast shadows and the colour grade; opts.shading overrides SHADING) at `scale`
 * px/m, with the card's light outline. opts.bake: a picture to use instead ({ canvas, x0, y0, scale } like
 * bakeShaded's; e.g. the ship as a blueprint).
 * @returns { canvas, x0, y0 } — the canvas' top-left sits at world (x0, y0); null for an empty ship
 */
export function shadedPicture(ship, atlas, scale, opts = {}) {
  const mk = (w, h) => makeCanvas(w, h, opts);
  const bake = opts.bake ?? bakeShaded(ship, atlas, mk, { ...SHADING, ...opts.shading });
  if (!bake) return null;
  // The same bake at the same scale and outline gives the same picture (a card redrawn for a new name).
  const key = `${scale},${opts.outline ?? 2},${opts.outlineColor}`, hit = pictures.get(bake);
  if (hit?.key === key) return hit.pic;
  const pic = picture(bake, scale, opts, mk);
  pictures.set(bake, { key, pic });
  return pic;
}
const pictures = new WeakMap();
function picture(bake, scale, opts, mk) {
  const k = scale / bake.scale;
  const img = mk(Math.ceil(bake.canvas.width * k), Math.ceil(bake.canvas.height * k));
  img.getContext('2d').drawImage(bake.canvas, 0, 0, bake.canvas.width * k, bake.canvas.height * k);
  const outline = opts.outline ?? 2, pad = outline + 1;
  const padded = mk(img.width + 2 * pad, img.height + 2 * pad);
  padded.getContext('2d').drawImage(img, pad, pad);
  return {
    canvas: outline ? outlineImage(padded, outline, opts.outlineColor, opts) : padded,
    x0: bake.x0 - pad / scale, y0: bake.y0 - pad / scale,
  };
}

/**
 * Draw a stat card (CARD.width x CARD.height incl. shadow) with its top-left at (x, y).
 * @param opts { atlas (in-game sprites), ui, fonts, stats, flagship, shading, bake (see shadedPicture), createCanvas,
 *               stamp (bytes to print over the card as its texture, see stamp.js; export at 3x for it to survive
 *               recompression and screenshots) }
 * @returns { stats, stamped, stamp } — stamped is false when opts.stamp didn't fit; stamp = { size, level }
 */
export function renderStatCard(ctx, ship, opts = {}) {
  const stats = opts.stats ?? computeStats(ship);
  const x = opts.x ?? 0, y = opts.y ?? 0;
  const background = CARD_BACKGROUND[stats.class.purpose] ?? 'shipcard_black';
  sprite(ctx, opts.ui, background, x, y);

  // Ship: as on the game's card, 3.5 px/m, shrunk to fit 210x160 by its SIZE box, centred at (-70, +18).
  const ppm = 3.5, sb = stats.sizeBox;
  const scale = ppm * Math.min(1, 210 / (sb.w * ppm), 160 / (sb.h * ppm));
  const pic = opts.atlas && sb.w && sb.h ? shadedPicture(ship, opts.atlas, scale, opts) : null;
  const lines = statCardLines(stats);
  const price = String(Math.trunc(stats.price));

  /** Everything drawn over the card's texture, with the card's top-left at (ox, oy). */
  const over = (g, ox, oy) => {
    const cx = ox + UI.shipcard_red.hx, cy = oy + UI.shipcard_red.hy;   // card centre
    if (pic) {
      const px = cx - 70 - (sb.x0 + sb.w / 2 - pic.x0) * scale;
      const py = cy + 18 - (sb.y0 + sb.h / 2 - pic.y0) * scale;
      // Kept left of the stats column (antennas, legs, overhangs); drawn over the stamp's eagle.
      g.save();
      g.beginPath();
      g.rect(ox, oy, 240, CARD.height);
      g.clip();
      g.drawImage(pic.canvas, Math.round(px), Math.round(py));
      g.restore();
    }

    // Name (upper case, squeezed to 220 px like the game, star included), optional flagship star.
    const name = (ship.name || '').toUpperCase();
    const fullW = measureText('dinpro_30_black', name);
    const star = opts.flagship ? UI.flagship_star.w + 6 : 0;
    const sq = Math.min(1, (220 - star) / Math.max(1, fullW));
    g.save();
    g.translate(cx - 175, cy - 106);
    g.scale(sq, 1);
    drawText(g, 'dinpro_30_black', name, 0, 0, CREAM, opts);
    g.restore();
    if (opts.flagship) sprite(g, opts.ui, 'flagship_star', cx - 175 + fullW * sq + 6, cy - 102);

    // Stats: labels and a value column, their tops level with the name's (the font has 4 px above its capitals).
    // A long list closes up to keep a gap above the price (its last line's top by y 164).
    const valueX = cx + 50 + Math.max(...lines.filter(Boolean).map(([l]) => measureText(TEXT_FONT, l))) + 10;
    // (A line takes a full step, a gap between groups half of one.)
    const top = cy - 100, steps = lines.slice(0, -1).reduce((n, line) => n + (line ? 1 : 0.5), 0);
    const step = Math.min(LINE, (cy + 40 - top) / Math.max(1, steps));
    let ty = top;
    lines.forEach((line, i) => {
      if (i) ty += lines[i - 1] ? step : step / 2;
      if (!line) return;
      drawText(g, TEXT_FONT, line[0], cx + 50, Math.round(ty), DIM, opts);
      drawText(g, TEXT_FONT, line[1], valueX, Math.round(ty), CREAM, opts);
      if (line[2] === 'nuclear') trefoil(g, valueX + measureText(TEXT_FONT, line[1]) + 7, Math.round(ty) + 7.5, CREAM);
    });

    // Price + coin, bottom right; the stamp's reader finds the card by the coin (STAMP.coin). The price ends just
    // inside the coin sprite's transparent margin, a few px short of its disc.
    const C = STAMP.coin;
    drawText(g, 'dinpro_30_black', price, ox + C.x, oy + C.y - 3, CREAM, { ...opts, align: 'right' });
    sprite(g, opts.ui, 'coin_01', ox + C.x, oy + C.y, C.d, C.d);
  };

  let stamp = null;
  if (opts.stamp) {
    // What the card draws over its texture, so the stamp can size its cells and parity around it.
    const m = makeCanvas(CARD.width, CARD.height, opts);
    const mg = m.getContext('2d');
    over(mg, 0, 0);
    const px = mg.getImageData(0, 0, CARD.width, CARD.height).data;
    const covered = new Uint8Array(CARD.width * CARD.height);
    for (let i = 0; i < covered.length; i++) covered[i] = px[i * 4 + 3] > 24 ? 1 : 0;
    // On a layer of its own at the context's resolution, cut to the card itself (its worn edge, not its shadow),
    // then printed.
    const k = ctx.getTransform().a;
    const layer = makeCanvas(Math.round(CARD.width * k), Math.round(CARD.height * k), opts), lg = layer.getContext('2d');
    lg.scale(k, k);
    stamp = drawStamp(lg, opts.stamp, 0, 0, { data: covered, width: CARD.width });
    if (opts.ui) {
      lg.globalCompositeOperation = 'destination-in';
      lg.imageSmoothingEnabled = false;
      lg.drawImage(cardFace(opts.ui, background, opts), 0, 0);
    }
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(layer, x, y, CARD.width, CARD.height);
    ctx.restore();
  }
  over(ctx, x, y);
  return { stats, stamped: !!stamp, stamp };
}

export const statCardSize = () => ({ width: CARD.width, height: CARD.height });
