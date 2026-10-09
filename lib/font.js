// Bitmap text using the game's HGE fonts (data/fonts.json + assets/fonts/<name>.png).
import { FONTS } from './data.js';

export const makeCanvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });

const tintCache = new WeakMap();

/** Glyph sheet recoloured to `color` (sheets are white on transparent). */
function tinted(sheet, color) {
  let byColor = tintCache.get(sheet);
  if (!byColor) tintCache.set(sheet, (byColor = new Map()));
  let c = byColor.get(color);
  if (!c) {
    c = makeCanvas(sheet.width, sheet.height);
    const g = c.getContext('2d');
    g.drawImage(sheet, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = color;
    g.fillRect(0, 0, c.width, c.height);
    byColor.set(color, c);
  }
  return c;
}

// Glyph tables are indexed by cp1251 byte; map non-ASCII characters (Cyrillic etc.) to it.
const CP1251 = new Map();
const cp1251 = new TextDecoder('windows-1251');
for (let b = 128; b < 256; b++) CP1251.set(cp1251.decode(new Uint8Array([b])), b);
const code = (ch) => { const c = ch.charCodeAt(0); return c < 128 ? c : CP1251.get(ch) ?? 63; };
const glyph = (font, ch) => font.glyphs[code(ch)] ?? font.glyphs[63];

/** Advance width of `text` in px. */
export function measureText(fontName, text) {
  const font = FONTS[fontName];
  let w = 0;
  for (const ch of text) {
    const [, , gw, , pre, post] = glyph(font, ch);
    w += pre + gw + post;
  }
  return w;
}

/**
 * Draw text in a game font.
 * @param opts { fonts: { [name]: glyph sheet image }, align: 'left'|'center'|'right' }
 * (x, y) is the top-left of the line (or top-centre / top-right with align). Returns the advance width.
 */
export function drawText(ctx, fontName, text, x, y, color, opts = {}) {
  const font = FONTS[fontName];
  const width = measureText(fontName, text);
  const x0 = opts.align === 'right' ? x - width : opts.align === 'center' ? x - width / 2 : x;
  const img = tinted(opts.fonts[fontName], color);
  let cx = x0;
  for (const ch of text) {
    const [gx, gy, gw, gh, pre, post] = glyph(font, ch);
    cx += pre;
    if (gw > 0) ctx.drawImage(img, gx, gy, gw, gh, Math.round(cx), Math.round(y), gw, gh);
    cx += gw + post;
  }
  return width;
}
