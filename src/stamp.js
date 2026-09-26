// Card stamp: bytes printed as a grid of ink cells over the whole stat card, like a texture, readable back from a
// recompressed (JPEG/WebP), rescaled or screenshotted copy of the card.
//
// The Highfleet eagle, printed in the top left under the name and the ship, and the price's coin in the bottom
// right are the anchors: the reader finds the pair anywhere in an image (the eagle by what of it shows), which
// gives the card's position and scale, then locks onto the cells' own edges for the exact pitch, so the card can
// be part of a larger screenshot, at any size it's still legible at. Filler cells continue the grid over the rest
// of the card, so the whole card reads as one texture. Cells are 4/3 card px (4 px in a 3x export) times 4, 3,
// 2, 1.5, 1.25 or 1: the encoder picks the largest cells the payload fits in, so smaller designs survive being
// shown smaller; the reader tries each size.
//
// The byte stream is split into Reed-Solomon blocks (GF(256)), interleaved byte by byte over the whole grid, and
// whitened with a fixed pseudo-random sequence so ink and bare card come out about even. What the card draws over
// the stamp (ship, name, stats, price) reads as erasures, which RS repairs at twice the rate of plain errors. RS
// rebuilds a block from any large enough subset of its bytes, parity or data alike, so nothing needs to sit in a
// safer spot: interleaving spreads every block over the whole card, so the ship, the text or a cropped edge takes
// a little from each block rather than all of one. The encoder knows what the card covers, and picks the cell
// size and parity so each block keeps a margin for misread cells. The reader tries each parity level; a CRC
// confirms the right one.

import { COIN, EAGLE, eagleLoops, fillEagle } from './emblem.js';

// ---- geometry (card px, relative to the card sprite's top-left) ----------------------------------------------
export const STAMP = {
  x: 14, y: 16, w: 362, h: 212,         // the card face, inside its darker worn rim and rounded corners
  cell: 4 / 3,                           // smallest cell; layouts use 4x, 3x, 2x, 1.5x, 1.25x or 1x this
  sizes: [4, 3, 2, 1.5, 1.25, 1],
  ink: 0.88, markInk: 0.55,              // cell ink and the eagle: card colour times this (lighter ink
                                         // costs legibility at small sizes; 0.88 keeps it)
  // The eagle (emblem.js), top left under the name: with the coin (bottom right, drawn by the card) it's how the reader finds the
  // card and its scale. The name and the ship may cover parts of it. Cells stay clear of its box and a quiet
  // margin around it.
  emblem: { x: 16, y: 16, h: 88 },
  quiet: 3,
  coin: { x: 348, y: 188, d: 27 },       // the price's coin (statcard.js)
  // The card sprite: cells continue over all of it as filler (random, read by nobody), under the eagle and out to
  // the edges, so the stamp reads as the card's texture; the card cuts them to its shape.
  texture: { w: 394, h: 249 },
};
/** Parity per block, as a fraction of the block, from most to least robust. */
const LEVELS = [0.85, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3];
const HEADER = 4;       // length (2) + CRC16 (2)
const HALO = 2;         // card px around what's drawn over the stamp that a small copy blurs away (see erasuresPerBlock)
/** Parity kept free for misread cells (each costs twice an erasure), as a share of a block: big cells misread less. */
const margin = (size) => (size >= 3 ? 0.03 : size >= 2 ? 0.045 : 0.06);

/** The eagle's box with its quiet margin, [x, y, w, h] in card px: no stamp cells there. */
export const emblemBox = () => {
  const { x, y, h } = STAMP.emblem, q = STAMP.quiet;
  return [x - q, y - q, h * (EAGLE.w / EAGLE.h) + 2 * q, h + 2 * q];
};

// ---- GF(256) Reed-Solomon (after "Reed-Solomon codes for coders", Wikiversity) -----------------------------
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x; LOG[x] = i;
    x <<= 1;
    if (x & 256) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const div = (a, b) => (a ? EXP[(LOG[a] + 255 - LOG[b]) % 255] : 0);
const pow = (a, n) => EXP[(((LOG[a] * n) % 255) + 255) % 255];
const inv = (a) => EXP[255 - LOG[a]];
const polyScale = (p, x) => p.map((c) => mul(c, x));
function polyAdd(p, q) {
  const r = new Array(Math.max(p.length, q.length)).fill(0);
  for (let i = 0; i < p.length; i++) r[i + r.length - p.length] = p[i];
  for (let i = 0; i < q.length; i++) r[i + r.length - q.length] ^= q[i];
  return r;
}
function polyMul(p, q) {
  const r = new Array(p.length + q.length - 1).fill(0);
  for (let j = 0; j < q.length; j++) for (let i = 0; i < p.length; i++) r[i + j] ^= mul(p[i], q[j]);
  return r;
}
function polyEval(p, x) {
  let y = p[0];
  for (let i = 1; i < p.length; i++) y = mul(y, x) ^ p[i];
  return y;
}
const generators = new Map();
function generator(nsym) {
  if (!generators.has(nsym)) {
    let g = [1];
    for (let i = 0; i < nsym; i++) g = polyMul(g, [1, pow(2, i)]);
    generators.set(nsym, g);
  }
  return generators.get(nsym);
}
function rsEncode(msg, nsym) {
  const gen = generator(nsym);
  const out = [...msg, ...new Array(nsym).fill(0)];
  for (let i = 0; i < msg.length; i++) {
    const c = out[i];
    if (c) for (let j = 1; j < gen.length; j++) out[i + j] ^= mul(gen[j], c);
  }
  for (let i = 0; i < msg.length; i++) out[i] = msg[i];
  return out;
}
const syndromes = (msg, nsym) => [0, ...Array.from({ length: nsym }, (_, i) => polyEval(msg, pow(2, i)))];
function correctErrata(msg, synd, errPos) {
  const coefPos = errPos.map((p) => msg.length - 1 - p);
  let loc = [1];
  for (const i of coefPos) loc = polyMul(loc, polyAdd([1], [pow(2, i), 0]));
  const rsynd = [...synd].reverse();
  let evalr = polyMul(rsynd, loc);
  evalr = evalr.slice(evalr.length - loc.length).reverse();
  const X = coefPos.map((p) => pow(2, -(255 - p)));
  const E = new Array(msg.length).fill(0);
  X.forEach((Xi, i) => {
    const Xinv = inv(Xi);
    let prime = 1;
    for (let j = 0; j < X.length; j++) if (j !== i) prime = mul(prime, 1 ^ mul(Xinv, X[j]));
    const y = mul(Xi, polyEval([...evalr].reverse(), Xinv));
    if (!prime) throw new Error('rs: bad locator');
    E[errPos[i]] = div(y, prime);
  });
  return polyAdd(msg, E);
}
function errorLocator(synd, nsym, eraseCount) {
  let loc = [1], old = [1];
  const shift = synd.length - nsym;
  for (let i = 0; i < nsym - eraseCount; i++) {
    const K = i + shift;   // Forney syndromes: the erasures are already factored out
    let delta = synd[K];
    for (let j = 1; j < loc.length; j++) delta ^= mul(loc[loc.length - 1 - j], synd[K - j]);
    old = [...old, 0];
    if (delta) {
      if (old.length > loc.length) {
        const next = polyScale(old, delta);
        old = polyScale(loc, inv(delta));
        loc = next;
      }
      loc = polyAdd(loc, polyScale(old, delta));
    }
  }
  while (loc.length && !loc[0]) loc.shift();
  const errs = loc.length - 1;
  if ((errs - eraseCount) * 2 + eraseCount > nsym) throw new Error('rs: too many errors');
  return loc;
}
function forneySyndromes(synd, pos, n) {
  const f = synd.slice(1);
  for (const p of pos) {
    const x = pow(2, n - 1 - p);
    for (let j = 0; j < f.length - 1; j++) f[j] = mul(f[j], x) ^ f[j + 1];
  }
  return f;
}
/** Correct a codeword (message + nsym parity) with known erasure positions; returns the message. */
function rsDecode(word, nsym, erasures = []) {
  if (erasures.length > nsym) throw new Error('rs: too many erasures');
  const msg = [...word];
  for (const e of erasures) msg[e] = 0;
  let synd = syndromes(msg, nsym);
  if (Math.max(...synd) === 0) return msg.slice(0, msg.length - nsym);
  const fsynd = forneySyndromes(synd, erasures, msg.length);
  const loc = errorLocator(fsynd, nsym, erasures.length).reverse();
  const errPos = [];
  for (let i = 0; i < msg.length; i++) if (polyEval(loc, pow(2, i)) === 0) errPos.push(msg.length - 1 - i);
  if (errPos.length !== loc.length - 1) throw new Error('rs: could not locate errors');
  const fixed = correctErrata(msg, synd, [...erasures, ...errPos]);
  synd = syndromes(fixed, nsym);
  if (Math.max(...synd) !== 0) throw new Error('rs: could not correct');
  return fixed.slice(0, fixed.length - nsym);
}



// ---- layouts -------------------------------------------------------------------------------------------------
function crc16(bytes) {
  let c = 0xffff;
  for (const b of bytes) {
    c ^= b << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  return c;
}
/** Fixed whitening sequence (mulberry32). */
function whitening(n, seed) {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    out[i] = (t ^ (t >>> 14)) & 255;
  }
  return out;
}

/**
 * The grid for cells `size` times the smallest: cols x rows over the stamp area, and the data cells as grid
 * indices, 8 per byte. A byte is a 4x2 tile of cells (compact, so fewer bytes straddle the edge of the ship or the
 * text over the stamp); tiles touching the eagle's box are left out.
 */
const layouts = new Map();
function layout(size) {
  if (layouts.has(size)) return layouts.get(size);
  const S = STAMP, cell = S.cell * size;
  const cols = Math.floor(S.w / cell), rows = Math.floor(S.h / cell);
  const [bx, by, bw, bh] = emblemBox();
  const reserved = (x0, y0) => x0 < bx + bw && x0 + cell > bx && y0 < by + bh && y0 + cell > by;
  const data = [];
  for (let tr = 0; tr + 2 <= rows; tr += 2) {
    for (let tc = 0; tc + 4 <= cols; tc += 4) {
      const tile = [];
      for (let r = tr; r < tr + 2; r++) for (let c = tc; c < tc + 4; c++) tile.push(r * cols + c);
      if (tile.every((i) => !reserved(S.x + (i % cols) * cell, S.y + Math.floor(i / cols) * cell))) data.push(...tile);
    }
  }
  const bytes = data.length / 8;
  const blocks = Math.ceil(bytes / 255);
  const L = {
    size, cell, cols, rows, data, bytes, blocks,
    blockLen: (b) => Math.floor(bytes / blocks) + (b < bytes % blocks ? 1 : 0),
    white: whitening(bytes, 0x48464332 + Math.round(size * 2)),   // "HFC2"
  };
  L.parity = (level, b) => Math.round(L.blockLen(b) * LEVELS[level]);
  L.capacity = (level) => {
    let n = 0;
    for (let b = 0; b < blocks; b++) n += L.blockLen(b) - L.parity(level, b);
    return n - HEADER;
  };
  layouts.set(size, L);
  return L;
}

/** Largest payload (bytes) a stamp can carry at all: smallest cells, least parity, nothing over the stamp. */
export const stampCapacity = () => layout(1).capacity(LEVELS.length - 1);

/**
 * Erased bytes per block for a layout, given what covers the card: covered = { data (1 per card px), width }.
 * Cells within HALO card px of something drawn over the stamp count too: on a small or blurred copy they blend
 * with it and can't be read. Without `covered`, half of every block is assumed lost.
 */
function erasuresPerBlock(L, covered) {
  const out = new Array(L.blocks).fill(0);
  if (!covered) { for (let b = 0; b < L.blocks; b++) out[b] = Math.ceil(L.blockLen(b) / 2); return out; }
  const S = STAMP, { data, width } = covered, height = data.length / width;
  const hit = (i) => {
    const c = i % L.cols, r = Math.floor(i / L.cols);
    const x0 = Math.floor(S.x + c * L.cell - HALO), x1 = Math.ceil(S.x + (c + 1) * L.cell + HALO);
    const y0 = Math.floor(S.y + r * L.cell - HALO), y1 = Math.ceil(S.y + (r + 1) * L.cell + HALO);
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(width, x1); x++) if (data[y * width + x]) return true;
    }
    return false;
  };
  for (let j = 0; j < L.bytes; j++) {
    let erased = false;
    for (let k = 0; k < 8 && !erased; k++) erased = hit(L.data[j * 8 + k]);
    if (erased) out[j % L.blocks]++;
  }
  return out;
}

/**
 * The layout and parity level for a payload: the largest cells where, at the most parity that fits the payload,
 * every block can absorb what the card covers plus a margin of misread cells. null if nothing fits.
 */
function choose(n, covered) {
  for (const size of STAMP.sizes) {
    const L = layout(size);
    const level = LEVELS.findIndex((_, l) => L.capacity(l) >= n);
    if (level < 0) continue;
    const erased = erasuresPerBlock(L, covered);
    const ok = erased.every((e, b) => e + 2 * Math.ceil(margin(size) * L.blockLen(b)) <= L.parity(level, b));
    if (ok) return { L, level };
  }
  return null;
}

/** Byte i of the interleaved stream belongs to block i % blocks, position floor(i / blocks). */
function toStream(L, level, payload) {
  const data = [payload.length >> 8, payload.length & 255, ...payload];
  const crc = crc16(data);
  data.push(crc >> 8, crc & 255);
  // Filler after the data, so the stamp always covers its whole area.
  while (data.length < L.capacity(level) + HEADER) data.push(0);
  const blocks = [];
  let at = 0;
  for (let b = 0; b < L.blocks; b++) {
    const k = L.blockLen(b) - L.parity(level, b);
    blocks.push(rsEncode(data.slice(at, at + k), L.parity(level, b)));
    at += k;
  }
  const stream = new Uint8Array(L.bytes);
  for (let i = 0; i < L.bytes; i++) stream[i] = blocks[i % L.blocks][Math.floor(i / L.blocks)] ^ L.white[i];
  return stream;
}

/**
 * The stamp for a payload: { size (cell multiple), level (parity), cols, rows, cells (grid, 1 = ink) }, or null if
 * it doesn't fit. `covered` (optional): what the card draws over the stamp, { data: 1 per covered card px, width }.
 */
export function stampCells(payload, covered = null) {
  const pick = choose(payload.length, covered);
  if (!pick) return null;
  const { L, level } = pick;
  const stream = toStream(L, level, payload);
  const cells = new Uint8Array(L.cols * L.rows);
  for (let i = 0; i < L.bytes * 8; i++) cells[L.data[i]] = (stream[i >> 3] >> (7 - (i & 7))) & 1;
  return { size: L.size, level: LEVELS[level], cols: L.cols, rows: L.rows, cells };
}

/**
 * Print the stamp on a card whose sprite top-left is at (x, y), in card px (scale the context for a larger export):
 * the eagle, and cells over the whole card sprite's box (see STAMP.texture; cut them to the card's shape).
 * @param covered see stampCells
 * @returns { size, level, cells } of the printed stamp, or null if the payload doesn't fit (filler only)
 */
export function drawStamp(ctx, payload, x = 0, y = 0, covered = null) {
  const st = stampCells(payload, covered);
  const S = STAMP;
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  const grey = (f) => { const v = Math.round(255 * f); return `rgb(${v},${v},${v})`; };
  // The eagle even when the payload doesn't fit: the card's layout leaves room for it.
  ctx.fillStyle = grey(S.markInk);
  fillEagle(ctx, x + S.emblem.x, y + S.emblem.y, S.emblem.h);
  // The cells: the stamp's where it has them, filler everywhere else on the card (on the same grid).
  const size = st ? st.size : 1.5, L = layout(size), u = S.cell * size;
  const isData = new Uint8Array(L.cols * L.rows);
  if (st) for (const i of L.data) isData[i] = 1;
  const ink = (c, r) => {
    if (st && c >= 0 && r >= 0 && c < L.cols && r < L.rows && isData[r * L.cols + c]) return st.cells[r * L.cols + c];
    let h = Math.imul(c + 0x9e37, 0x85ebca6b) ^ Math.imul(r + 0x79b9, 0xc2b2ae35);
    h = Math.imul(h ^ (h >>> 15), 0x27d4eb2f);
    return (h ^ (h >>> 13)) & 1;
  };
  const c0 = -Math.ceil(S.x / u), c1 = Math.ceil((S.texture.w - S.x) / u);
  const r0 = -Math.ceil(S.y / u), r1 = Math.ceil((S.texture.h - S.y) / u);
  ctx.fillStyle = grey(S.ink);
  // Runs of ink in a row become one rectangle (no seams between cells).
  for (let r = r0; r < r1; r++) {
    for (let c = c0; c < c1;) {
      if (!ink(c, r)) { c++; continue; }
      let e = c;
      while (e < c1 && ink(e, r)) e++;
      ctx.fillRect(x + S.x + c * u, y + S.y + r * u, (e - c) * u, u);
      c = e;
    }
  }
  ctx.restore();
  return st && { size: st.size, level: st.level, cells: st.cells };
}

// ---- reading: finding the card -------------------------------------------------------------------------------
// The eagle (top left) and the price's coin (bottom right) are found as templates (normalised cross-correlation)
// over a range of scales: the eagle over the whole image at low resolution, then the coin where the eagle puts it.
// The two, far apart, give the card's position and its scale in x and y (screenshots come upright and
// unstretched, so there's no rotation to find). The cell edges then fix the pitch and phase exactly (lockGrid).
function lumaOf({ data, width, height }) {
  const l = new Float32Array(width * height);
  for (let i = 0, j = 0; j < l.length; i += 4, j++) l[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  return l;
}

/** Summed-area table of l (w x h), (w + 1) x (h + 1). */
function integral(l, w, h) {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += l[y * w + x];
      I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row;
    }
  }
  return I;
}
/** Sum over [x0, x1) x [y0, y1) with fractional edges (the table is exact bilinear between its knots). */
function boxSum(I, w, h, x0, y0, x1, y1) {
  const at = (x, y) => {
    x = Math.max(0, Math.min(w, x)); y = Math.max(0, Math.min(h, y));
    const xi = Math.min(w - 1, Math.floor(x)), yi = Math.min(h - 1, Math.floor(y)), fx = x - xi, fy = y - yi, W = w + 1;
    const a = I[yi * W + xi], b = I[yi * W + xi + 1], c = I[(yi + 1) * W + xi], d = I[(yi + 1) * W + xi + 1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
  return at(x1, y1) - at(x0, y1) - at(x1, y0) + at(x0, y0);
}
/**
 * The image area from (X0, Y0), W x H level px of 1/f image px each (f <= 1), as box averages: a level px (x, y)
 * covers image [X0 + x / f, X0 + (x + 1) / f) and likewise in y.
 */
function shrink(I, w, h, f, X0 = 0, Y0 = 0, W = Math.floor(w * f), H = Math.floor(h * f)) {
  const out = new Float32Array(W * H), a = f * f;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      out[y * W + x] = boxSum(I, w, h, X0 + x / f, Y0 + y / f, X0 + (x + 1) / f, Y0 + (y + 1) / f) * a;
    }
  }
  return { l: out, w: W, h: H, X0, Y0, f };
}

/**
 * Templates at card resolution: { x, y (card position of the top left), w, h, v (luma-like value per card px),
 * m (how much of the px belongs to the template) }.
 */
const templates = {};
function coinTemplate() {
  if (templates.coin) return templates.coin;
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const l = b64(COIN.luma), a = b64(COIN.alpha), n = COIN.size, R = 15, N = 2 * R + 1, o = R - (n - 1) / 2;
  // The coin over a darker card (every card colour is darker than the coin), a round window around it: the price
  // ends 2 card px to its left.
  const v = new Float32Array(N * N).fill(110), m = new Float32Array(N * N);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const al = a[y * n + x] / 255;
      v[(y + o) * N + x + o] = 110 * (1 - al) + l[y * n + x] * al;
    }
  }
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) m[y * N + x] = Math.hypot(x + 0.5 - N / 2, y + 0.5 - N / 2) <= R ? 1 : 0;
  const C = STAMP.coin;
  return (templates.coin = { x: C.x + C.d / 2 - N / 2, y: C.y + C.d / 2 - N / 2, w: N, h: N, v, m });
}
function eagleTemplate() {
  if (templates.eagle) return templates.eagle;
  const S = STAMP, [bx, by, bw, bh] = emblemBox(), W = Math.ceil(bw), H = Math.ceil(bh), k = S.emblem.h / EAGLE.h;
  const cover = new Float32Array(W * H), SS = 4;
  // Coverage from SS x SS samples per card px, even-odd scanlines over the outline.
  for (let sy = 0; sy < H * SS; sy++) {
    const py = (by + (sy + 0.5) / SS - S.emblem.y) / k;
    const xs = [];
    for (const loop of eagleLoops) {
      for (let i = 0; i < loop.length; i++) {
        const [x1, y1] = loop[i], [x2, y2] = loop[(i + 1) % loop.length];
        if ((y1 <= py) !== (y2 <= py)) xs.push(S.emblem.x + (x1 + ((py - y1) / (y2 - y1)) * (x2 - x1)) * k);
      }
    }
    xs.sort((p, q) => p - q);
    for (let j = 0; j + 1 < xs.length; j += 2) {
      for (let sx = Math.max(0, Math.ceil((xs[j] - bx) * SS - 0.5)); sx < W * SS && bx + (sx + 0.5) / SS < xs[j + 1]; sx++) {
        cover[Math.floor(sy / SS) * W + Math.floor(sx / SS)] += 1 / (SS * SS);
      }
    }
  }
  const v = cover.map((c) => 255 * (1 - c * (1 - S.markInk)));
  const m = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) m[y * W + x] = Math.min(1, bw - x) * Math.min(1, bh - y);
  return (templates.eagle = { x: bx, y: by, w: W, h: H, v, m });
}

/** Card px in the eagle's box that are bare card 2 px all round (not the eagle, not near it): centres. */
let bare = null;
function bareSpots() {
  if (bare) return bare;
  const E = eagleTemplate(), out = [];
  for (let y = 2; y < E.h - 2; y++) {
    for (let x = 2; x < E.w - 2; x++) {
      let clear = true;
      for (let dy = -2; dy <= 2 && clear; dy++) for (let dx = -2; dx <= 2; dx++) if (E.v[(y + dy) * E.w + x + dx] < 254.5 || !E.m[(y + dy) * E.w + x + dx]) { clear = false; break; }
      if (clear) out.push([E.x + x + 0.5, E.y + y + 0.5]);
    }
  }
  return (bare = out);
}

/**
 * A template at k level px per card px: its px (box averages of the card px they cover) with offsets from the
 * top left, zero mean and unit norm.
 */
function sampleTemplate(T, k) {
  const W = Math.ceil(T.w * k), H = Math.ceil(T.h * k), z = [], at = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u0 = x / k, u1 = (x + 1) / k, v0 = y / k, v1 = (y + 1) / k;
      let s = 0, mw = 0;
      for (let v = Math.floor(v0); v < Math.min(T.h, Math.ceil(v1)); v++) {
        for (let u = Math.floor(u0); u < Math.min(T.w, Math.ceil(u1)); u++) {
          const o = (Math.min(u + 1, u1) - Math.max(u, u0)) * (Math.min(v + 1, v1) - Math.max(v, v0)) * T.m[v * T.w + u];
          s += T.v[v * T.w + u] * o; mw += o;
        }
      }
      if (mw < 0.5 * (u1 - u0) * (v1 - v0)) continue;
      z.push(s / mw); at.push([x, y]);
    }
  }
  const mean = z.reduce((p, q) => p + q, 0) / z.length;
  const norm = Math.sqrt(z.reduce((p, q) => p + (q - mean) ** 2, 0)) || 1;
  return { W, H, z: Float32Array.from(z, (q) => (q - mean) / norm), at };
}
/** Offsets of a sampled template's px in a level image `width` px wide. */
const offsetsIn = (t, width) => Int32Array.from(t.at, ([x, y]) => y * width + x);

/**
 * An image to match templates in, as summed-area tables: plain (luma: tables of l and l^2), or masked (only the
 * px where m is 1 count: tables of m, m v and m v^2).
 */
function plainImage(l, w, h) {
  return { w, h, tables: [integral(l, w, h), integral(l.map((q) => q * q), w, h)] };
}
function maskedImage({ v, m }, w, h) {
  const mv = new Float32Array(w * h), mvv = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) if (m[i]) { mv[i] = v[i]; mvv[i] = v[i] * v[i]; }
  return { w, h, masked: true, tables: [integral(m, w, h), integral(mv, w, h), integral(mvv, w, h)] };
}
/** An image at f level px per image px, over a window (see shrink): the mean of each table's quantity per level px. */
function level(img, f, X0, Y0, W, H) {
  const ls = img.tables.map((I) => shrink(I, img.w, img.h, f, X0, Y0, W, H).l);
  return { w: W ?? Math.floor(img.w * f), h: H ?? Math.floor(img.h * f), masked: img.masked, ls };
}

/**
 * Normalised cross-correlation of template t at top-left index `base` of a level; masked, over the px that count
 * only, and only where they're at least COVER of the template. -1 where too little counts or it's flat.
 */
/** Masked matches: the share of the template that must show, and how much of a level px must be card to count. */
const COVER = 0.2, MIN_COVER = 0.5;
function ncc(lv, t, offs, base) {
  const n = offs.length, z = t.z;
  if (!lv.masked) {
    const L = lv.ls[0];
    let s1 = 0, s2 = 0, st = 0;
    for (let i = 0; i < n; i++) {
      const v = L[base + offs[i]];
      s1 += v; s2 += v * v; st += v * z[i];
    }
    const vr = s2 - (s1 * s1) / n;
    return vr < n * 36 ? -1 : st / Math.sqrt(vr);
  }
  const [M, X, XX] = lv.ls;
  let sm = 0, sx = 0, sxx = 0, st = 0, stt = 0, sxt = 0;
  for (let i = 0; i < n; i++) {
    // Level px that are only partly the card compare badly (the template's px is the mean over all of it): only
    // mostly-card px count.
    const o = base + offs[i];
    if (M[o] < MIN_COVER) continue;
    const x = X[o] / M[o], q = z[i];
    sm++; sx += x; sxx += XX[o] / M[o]; st += q; stt += q * q; sxt += x * q;
  }
  if (sm < COVER * n) return -1;
  const vx = sxx - (sx * sx) / sm, vt = stt - (st * st) / sm;
  return vx < sm * 36 || vt <= 0 ? -1 : (sxt - (sx * st) / sm) / Math.sqrt(vx * vt);
}
/** Vertex of the parabola through (-1, a), (0, b), (1, c), clamped to half a step. */
const vertex = (a, b, c) => {
  const d = a - 2 * b + c;
  return d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d)) : 0;
};

/**
 * Where a template matches anywhere in the image: [{ x, y (image position of the template's top left), s (image
 * px per card px), v (score) }], best first. Scales from `from` to 5 image px per card px, `ratio` apart, each
 * searched at a resolution where the template is about D px wide; spots that are flat or (masked) mostly don't
 * count are skipped.
 */
function search(img, T, { D, ratio, min, keep, from = 0.5 }) {
  const found = [];
  for (let s = from; s <= 5; s *= ratio) {
    const f = Math.min(1, D / (T.w * s)), lv = level(img, f), W = lv.w, H = lv.h;
    const t = sampleTemplate(T, s * f), offs = offsetsIn(t, W);
    if (t.W >= W || t.H >= H) continue;
    // Box sums over the template's rectangle, for the quick checks.
    const S = lv.ls.map((q) => integral(q, W, H)), nn = t.W * t.H, W1 = W + 1;
    const at = (x, y) => {
      const i00 = y * W1 + x, i01 = i00 + t.W, i10 = i00 + t.H * W1, i11 = i10 + t.W;
      const box = (I) => I[i11] - I[i01] - I[i10] + I[i00];
      if (lv.masked) {
        const m = box(S[0]);
        if (m < COVER * nn || box(S[2]) / m - (box(S[1]) / m) ** 2 < 36) return -1;
      } else if (box(S[1]) / nn - (box(S[0]) / nn) ** 2 < 64) return -1;
      return ncc(lv, t, offs, y * W + x);
    };
    // Every other px first (the peak is wider than a px at this size), then every px around the best of those.
    const X1 = W - t.W, Y1 = H - t.H, G = Math.floor(X1 / 2) + 1, score = new Float32Array(G * (Math.floor(Y1 / 2) + 1)).fill(-1);
    for (let y = 0; y <= Y1; y += 2) for (let x = 0; x <= X1; x += 2) score[(y / 2) * G + x / 2] = at(x, y);
    for (let gy = 0; gy <= Y1 / 2; gy++) {
      for (let gx = 0; gx <= X1 / 2; gx++) {
        const v = score[gy * G + gx];
        if (v < 0.8 * min) continue;
        let peak = true;
        for (let dy = -1; dy <= 1 && peak; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const q = (gy + dy) * G + gx + dx;
            if ((dx || dy) && gx + dx >= 0 && gy + dy >= 0 && gx + dx <= X1 / 2 && gy + dy <= Y1 / 2 && score[q] > v) { peak = false; break; }
          }
        }
        if (!peak) continue;
        let best = { v, x: 2 * gx, y: 2 * gy };
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const x = 2 * gx + dx, y = 2 * gy + dy;
            if ((dx || dy) && x >= 0 && y >= 0 && x <= X1 && y <= Y1) { const q = at(x, y); if (q > best.v) best = { v: q, x, y }; }
          }
        }
        if (best.v >= min) found.push({ x: best.x / f, y: best.y / f, s, v: best.v });
      }
    }
  }
  found.sort((p, q) => q.v - p.v);
  const kept = [];
  for (const c of found) {
    if (kept.some((k) => Math.hypot(k.x - c.x, k.y - c.y) < 0.5 * T.w * Math.min(k.s, c.s))) continue;
    kept.push(c);
    if (kept.length >= keep) break;
  }
  return kept;
}

/**
 * The best match of a template near a guess { x, y, s }: positions within r card px, scales `step` apart over
 * +-span steps, at a resolution where the template is about D px wide; sub-pixel and between scales.
 * @returns { x, y, s, v } or null
 */
function fine(img, T, g, { D, span, step, r }) {
  const f = Math.min(1, D / (T.w * g.s)), smax = g.s * step ** span, pad = r * g.s + 2;
  const X0 = Math.floor(g.x - pad), Y0 = Math.floor(g.y - pad);
  const lv = level(img, f, X0, Y0, Math.ceil((2 * pad + T.w * smax) * f) + 2, Math.ceil((2 * pad + T.h * smax) * f) + 2);
  const at = (t, offs, x, y) => (x < 0 || y < 0 || x + t.W > lv.w || y + t.H > lv.h ? -1 : ncc(lv, t, offs, y * lv.w + x));
  let best = null;
  const byScale = [];
  for (let j = -span; j <= span; j++) {
    const s = g.s * step ** j, t = sampleTemplate(T, s * f), offs = offsetsIn(t, lv.w);
    const cx = Math.round((g.x - X0) * f), cy = Math.round((g.y - Y0) * f), R = Math.ceil(r * g.s * f);
    let top = null;
    for (let y = cy - R; y <= cy + R; y++) {
      for (let x = cx - R; x <= cx + R; x++) {
        const v = at(t, offs, x, y);
        if (!top || v > top.v) top = { v, x, y };
      }
    }
    byScale.push(top.v);
    if (!best || top.v > best.v) {
      const ox = vertex(at(t, offs, top.x - 1, top.y), top.v, at(t, offs, top.x + 1, top.y));
      const oy = vertex(at(t, offs, top.x, top.y - 1), top.v, at(t, offs, top.x, top.y + 1));
      best = { x: X0 + (top.x + ox) / f, y: Y0 + (top.y + oy) / f, s, v: top.v, j };
    }
  }
  if (!best || best.v < 0) return null;
  const k = best.j + span;
  if (k > 0 && k < byScale.length - 1) best.s *= step ** vertex(byScale[k - 1], byScale[k], byScale[k + 1]);
  return best;
}

/** The five card backgrounds (shipcard_*): median brightness and colour (r and g over r + g + b) of the face. */
const CARDS = [
  { l: 104, r: 0.565, g: 0.238 },   // red
  { l: 166, r: 0.482, g: 0.334 },   // orange
  { l: 122, r: 0.249, g: 0.341 },   // blue
  { l: 70, r: 0.332, g: 0.332 },    // black
  { l: 133, r: 0.295, g: 0.447 },   // green
];
/**
 * The image as the eagle's template sees it: only px that could be the card count (m = 1), i.e. a card
 * background's colour at anything from the eagle's ink up to bare card (ink only darkens), allowing for a copy a
 * little brighter or darker. Which card, locally: over blocks, the coloured card with a fair share of the px
 * around; the black card only where no coloured one has (grey is also the ship's hull, shadows, dark themes). The
 * name, the ship, the coin and whatever is around the card mostly don't count, so the eagle is matched over what
 * of it shows.
 */
function cardOnly(rgb, l, w, h) {
  const NC = CARDS.length, BLACK = 3;
  const which = new Int8Array(w * h).fill(-1);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    // (Compression errs by a few levels per channel, which moves the colour of darker px more.)
    const s = rgb[j] + rgb[j + 1] + rgb[j + 2] + 1, r = rgb[j] / s, g = rgb[j + 1] / s, v = l[i], t = 0.025 + 6 / s;
    for (let c = 0; c < NC; c++) {
      const C = CARDS[c];
      if (v <= 0.8 * STAMP.markInk * 0.85 * C.l || v >= 1.1 * C.l || Math.abs(r - C.r) + Math.abs(g - C.g) >= t) continue;
      which[i] = c;
      break;
    }
  }
  const B = 32, NB = 3, bw = Math.ceil(w / B), bh = Math.ceil(h / B);
  const count = new Uint32Array(bw * bh * NC), total = new Uint32Array(bw * bh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const b = Math.floor(y / B) * bw + Math.floor(x / B), c = which[y * w + x];
      total[b]++;
      if (c >= 0) count[b * NC + c]++;
    }
  }
  const pick = new Int8Array(bw * bh).fill(-1);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const n = new Float64Array(NC);
      let all = 0;
      for (let y = Math.max(0, by - NB); y <= Math.min(bh - 1, by + NB); y++) {
        for (let x = Math.max(0, bx - NB); x <= Math.min(bw - 1, bx + NB); x++) {
          const b = y * bw + x;
          all += total[b];
          for (let c = 0; c < NC; c++) n[c] += count[b * NC + c];
        }
      }
      let best = -1;
      for (let c = 0; c < NC; c++) if (c !== BLACK && n[c] >= 0.2 * all && (best < 0 || n[c] > n[best])) best = c;
      if (best < 0 && n[BLACK] >= 0.2 * all) best = BLACK;
      pick[by * bw + bx] = best;
    }
  }
  const m = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = which[y * w + x];
      if (c >= 0 && c === pick[Math.floor(y / B) * bw + Math.floor(x / B)]) m[y * w + x] = 1;
    }
  }
  return { v: l, m };
}

/**
 * Card placements: [{ x0, y0 (image position of the card's top left), sx, sy (image px per card px), v }], one per
 * eagle that has the coin where it should be, best first; only those near the best.
 */
function findCards(rgb, l, w, h, diag) {
  const onCard = maskedImage(cardOnly(rgb, l, w, h), w, h), plain = plainImage(l, w, h);
  const E = eagleTemplate(), C = coinTemplate();
  const eagles = search(onCard, E, { D: 20, ratio: 1.12, min: 0.3, keep: 24, from: 0.6 });
  if (diag) diag.eagles = eagles;
  const ec = [E.x + E.w / 2, E.y + E.h / 2], cc = [C.x + C.w / 2, C.y + C.h / 2], out = [];
  for (const e0 of eagles) {
    // Then again, closer (with much of it hidden, the coarser fit can be a card px out).
    const e1 = fine(onCard, E, e0, { D: 40, span: 6, step: 1.02, r: 3 });
    const e = e1 && fine(onCard, E, e1, { D: 100, span: 2, step: 1.006, r: 1 });
    if (!e || e.v < 0.4) continue;
    // The eagle's scale is good to a couple of percent: the coin is within 3% of the distance between them.
    const guess = { x: e.x + (C.x - E.x) * e.s, y: e.y + (C.y - E.y) * e.s, s: e.s };
    const coin = fine(plain, C, guess, { D: 32, span: 3, step: 1.02, r: 0.03 * (C.x - E.x) });
    if (!coin || coin.v < 0.4) continue;
    const ex = e.x + (E.w / 2) * e.s, ey = e.y + (E.h / 2) * e.s, cx = coin.x + (C.w / 2) * coin.s, cy = coin.y + (C.h / 2) * coin.s;
    const sx = (cx - ex) / (cc[0] - ec[0]), sy = (cy - ey) / (cc[1] - ec[1]);
    if (!(sx > 0 && sy > 0) || Math.abs(Math.log(sx / sy)) > 0.04 || Math.abs(Math.log(sx / e.s)) > 0.06) continue;
    out.push({ x0: ex - ec[0] * sx, y0: ey - ec[1] * sy, sx, sy, v: e.v + coin.v });
  }
  out.sort((p, q) => q.v - p.v);
  const kept = out.filter((c) => c.v >= 0.6 * out[0].v);
  if (diag) diag.cards = kept;
  return kept;
}

/**
 * Lock a placement onto the cell grid of a layout: the cell edges (brightness steps between neighbouring px,
 * summed over the stamp's rows or columns) repeat at exactly the pitch, so the strongest line of their spectrum
 * near the placement's pitch gives the pitch and where the edges fall; the edge nearest the placement's is the
 * grid's. @returns the placement, adjusted
 */
function lockGrid(l, w, h, g, cell, span) {
  const S = STAMP;
  const axis = (horiz) => {
    const s = horiz ? g.sx : g.sy, o = horiz ? g.x0 : g.y0;
    const a = Math.max(0, Math.floor(o + (horiz ? S.x : S.y) * s));
    const b = Math.min((horiz ? w : h) - 1, Math.ceil(o + (horiz ? S.x + S.w : S.y + S.h) * s));
    const oo = horiz ? g.y0 : g.x0, ss = horiz ? g.sy : g.sx;
    const c0 = Math.max(0, Math.floor(oo + (horiz ? S.y : S.x) * ss));
    const c1 = Math.min(horiz ? h : w, Math.ceil(oo + (horiz ? S.y + S.h : S.x + S.w) * ss));
    // Edge profile: P[i] = sum of |l(i + 1) - l(i)| across the stamp; the edge sits at i + 1. Ink is faint, so
    // stronger steps are the ship's or the text's and are left out.
    const P = new Float64Array(Math.max(0, b - a)), E = 40;
    for (let i = a; i < b; i++) {
      let q = 0;
      if (horiz) for (let y = c0; y < c1; y++) { const d = Math.abs(l[y * w + i + 1] - l[y * w + i]); if (d < E) q += d; }
      else for (let x = c0; x < c1; x++) { const d = Math.abs(l[(i + 1) * w + x] - l[i * w + x]); if (d < E) q += d; }
      P[i - a] = q;
    }
    const coef = (p) => {
      let re = 0, im = 0;
      for (let i = 0; i < P.length; i++) {
        const t = (2 * Math.PI * (a + i + 1)) / p;
        re += P[i] * Math.cos(t); im -= P[i] * Math.sin(t);
      }
      return [re, im];
    };
    // The line: the strongest within +-span of the placement's pitch; how much it stands out: against the median
    // over +-8%.
    const p0 = cell * s, steps = 64, wide = 0.08, amps = [], ps = [];
    for (let k = 0; k <= steps; k++) {
      ps.push(p0 * (1 - wide + (2 * wide * k) / steps));
      amps.push(Math.hypot(...coef(ps[k])));
    }
    let k = -1;
    for (let j = 0; j <= steps; j++) if (Math.abs(ps[j] / p0 - 1) <= span + 1e-9 && (k < 0 || amps[j] > amps[k])) k = j;
    const p = k > 0 && k < steps ? ps[k] + vertex(amps[k - 1], amps[k], amps[k + 1]) * (ps[1] - ps[0]) : ps[k];
    const [re, im] = coef(p);
    const med = [...amps].sort((q, r) => q - r)[amps.length >> 1];
    const peak = Math.hypot(re, im) / (med || 1);
    const edge = (((Math.atan2(-im, re) / (2 * Math.PI)) * p) % p + p) % p;
    const start = o + (horiz ? S.x : S.y) * (p / cell);   // the grid's first edge, by the placement
    const snapped = edge + Math.round((start - edge) / p) * p;
    return { s: p / cell, o: snapped - (horiz ? S.x : S.y) * (p / cell), peak };
  };
  const x = axis(true), y = axis(false);
  return { ...g, x0: x.o, y0: y.o, sx: x.s, sy: y.s, peak: Math.min(x.peak, y.peak) };
}

// ---- reading: the cells --------------------------------------------------------------------------------------
/**
 * Fine-tune a card -> image mapping for a layout: the marks put it within a pixel or so, which is too loose for
 * small cells on a small card. Nudges the grid's offset and scale (in card px) to the settings where the cell
 * centres read most distinctly (ink and bare card are then furthest apart).
 */
function refine(l, w, h, L, map) {
  const S = STAMP, cx0 = S.x + S.w / 2, cy0 = S.y + S.h / 2;
  const cells = L.data.map((i) => [S.x + ((i % L.cols) + 0.5) * L.cell, S.y + (Math.floor(i / L.cols) + 0.5) * L.cell]);
  const warp = (p) => (x, y) => map(x + p[0] + p[2] * (x - cx0), y + p[1] + p[3] * (y - cy0));
  const score = (p) => {
    const m = warp(p);
    let s = 0, s2 = 0, n = 0;
    for (const [x, y] of cells) {
      const [px, py] = m(x, y);
      const ix = Math.round(px), iy = Math.round(py);
      if (ix < 0 || iy < 0 || ix >= w || iy >= h) continue;
      const v = Math.min(l[iy * w + ix], 200);   // text over the stamp doesn't count for much
      s += v; s2 += v * v; n++;
    }
    return n ? s2 / n - (s / n) ** 2 : 0;
  };
  let p = [0, 0, 0, 0], best = score(p);
  const tryAll = (qs) => { for (const q of qs) { const s = score(q); if (s > best) { best = s; p = q; } } };
  const span = (n, step) => Array.from({ length: 2 * n + 1 }, (_, k) => (k - n) * step);
  // Offset over half a cell each way, then scale over 1% each way, then finer steps of all four.
  const t = span(4, L.cell / 8), sc = span(4, 0.0025);
  tryAll(t.flatMap((dx) => t.map((dy) => [dx, dy, 0, 0])));
  const p0 = p;
  tryAll(sc.flatMap((sx) => sc.map((sy) => [p0[0], p0[1], sx, sy])));
  const steps = [L.cell / 16, L.cell / 16, 0.001, 0.001];
  for (let round = 0; round < 3; round++) {
    for (let k = 0; k < 4; k++) {
      tryAll([-1, 1].map((d) => { const q = p.slice(); q[k] += d * steps[k]; return q; }));
    }
    steps.forEach((_, k) => { steps[k] /= 2; });
  }
  return warp(p);
}

/** Sample a layout through a card -> image mapping and try to decode it. */
function readGrid(rgb, l, w, h, L, map, diag) {
  const S = STAMP, n = L.cols * L.rows;
  const mean = new Float32Array(n), hi = new Float32Array(n), bright = new Uint8Array(n);
  const chroma = new Float32Array(n * 2);   // mean colour as r/(r+g+b), g/(r+g+b)
  // Sample points over the middle half of a cell, in card px (3x3 of them, snapped to image pixels).
  const offs = [-0.25, 0, 0.25].map((f) => f * L.cell);
  for (let r = 0; r < L.rows; r++) {
    for (let c = 0; c < L.cols; c++) {
      const cx = S.x + (c + 0.5) * L.cell, cy = S.y + (r + 0.5) * L.cell;
      let sum = 0, k = 0, max = 0, min = 255, sr = 0, sg = 0, sb = 0;
      for (const oy of offs) {
        for (const ox of offs) {
          const [px, py] = map(cx + ox, cy + oy);
          const ix = Math.round(px), iy = Math.round(py);
          if (ix < 0 || iy < 0 || ix >= w || iy >= h) continue;
          const v = l[iy * w + ix], j = (iy * w + ix) * 4;
          sum += v; k++;
          sr += rgb[j]; sg += rgb[j + 1]; sb += rgb[j + 2];
          if (v > max) max = v;
          if (v < min) min = v;
        }
      }
      const i = r * L.cols + c;
      mean[i] = k ? sum / k : 0;
      hi[i] = max;
      const s = sr + sg + sb + 1;
      chroma[2 * i] = sr / s; chroma[2 * i + 1] = sg / s;
      // Off the image, or detail over the cell (the ship, the coin, glyph edges): can't be read.
      if (!k || max - min > 45) bright[i] = 1;
    }
  }
  // The bare card, from the eagle's box where it's bare (between its feathers and in the quiet margin) and not
  // under the name or the ship (a card's colour): brightness and colour.
  const ref = [];
  for (const [x, y] of bareSpots()) {
    const [px, py] = map(x, y);
    const ix = Math.round(px), iy = Math.round(py);
    if (ix < 0 || iy < 0 || ix >= w || iy >= h) continue;
    const j = (iy * w + ix) * 4, s = rgb[j] + rgb[j + 1] + rgb[j + 2] + 1, r = rgb[j] / s, g = rgb[j + 1] / s;
    if (!CARDS.some((c) => Math.abs(r - c.r) + Math.abs(g - c.g) < 0.05 && l[iy * w + ix] > 0.7 * c.l && l[iy * w + ix] < 1.3 * c.l)) continue;
    ref.push([l[iy * w + ix], r, g]);
  }
  if (ref.length < 8) return null;
  const median = (k) => ref.map((q) => q[k]).sort((a, b) => a - b)[ref.length >> 1];
  const bareR = median(1), bareG = median(2);
  let bare = median(0);   // a first guess: on a small copy the gaps are thin and blur with the ink around them
  // The bare card level from the cells themselves: card-coloured cells near the first guess are bare or inked,
  // about half each, so bare is near their upper quartile.
  const cardColour = (i) => Math.abs(chroma[2 * i] - bareR) + Math.abs(chroma[2 * i + 1] - bareG) <= 0.07;
  const near = L.data.filter((i) => !bright[i] && cardColour(i) && mean[i] > bare * 0.6 && mean[i] < bare * 1.5)
    .map((i) => mean[i]).sort((a, b) => a - b);
  if (near.length > 50) bare = near[Math.floor(near.length * 0.75)];
  // Nor can anything that isn't bare or inked card: cream text (the stats, even the dimmed labels, the price),
  // the ship (brighter, much darker, or another colour: ink only darkens, so the card's colour stays).
  for (const i of L.data) {
    if (hi[i] > bare + 0.4 * (255 - bare) || mean[i] > bare * 1.15 || mean[i] < bare * S.ink * 0.8 || !cardColour(i)) {
      bright[i] = 1;
    }
  }
  const grown = bright;
  // Threshold against the local average of readable data cells (whitening keeps ink and bare card even).
  const isData = new Uint8Array(n);
  for (const i of L.data) isData[i] = 1;
  const R = Math.max(3, Math.round(6 / L.size)), bits = new Uint8Array(n);
  for (let r = 0; r < L.rows; r++) {
    for (let c = 0; c < L.cols; c++) {
      let sum = 0, k = 0;
      for (let rr = Math.max(0, r - R); rr <= Math.min(L.rows - 1, r + R); rr++) {
        for (let cc = Math.max(0, c - R); cc <= Math.min(L.cols - 1, c + R); cc++) {
          const i = rr * L.cols + cc;
          if (isData[i] && !grown[i]) { sum += mean[i]; k++; }
        }
      }
      const i = r * L.cols + c;
      bits[i] = k && mean[i] < sum / k ? 1 : 0;
    }
  }
  if (diag) {
    Object.assign(diag, { size: L.size, cols: L.cols, rows: L.rows, mean, bright: grown, bits });
    (diag.attempts ??= []).push({ size: L.size, cols: L.cols, bits, bright: grown });
  }
  const stream = new Uint8Array(L.bytes), erased = new Uint8Array(L.bytes);
  for (let j = 0; j < L.bytes * 8; j++) {
    const i = L.data[j];
    stream[j >> 3] |= bits[i] << (7 - (j & 7));
    if (grown[i]) erased[j >> 3] = 1;
  }
  for (let j = 0; j < L.bytes; j++) stream[j] ^= L.white[j];
  const words = Array.from({ length: L.blocks }, () => []), erasures = Array.from({ length: L.blocks }, () => []);
  for (let j = 0; j < L.bytes; j++) {
    const b = j % L.blocks, at = Math.floor(j / L.blocks);
    words[b][at] = stream[j];
    if (erased[j]) erasures[b].push(at);
  }
  for (let level = 0; level < LEVELS.length; level++) {
    try {
      const data = [];
      for (let b = 0; b < L.blocks; b++) data.push(...rsDecode(words[b], L.parity(level, b), erasures[b]));
      const len = (data[0] << 8) | data[1];
      if (len > data.length - HEADER) continue;
      const crc = (data[len + 2] << 8) | data[len + 3];
      if (crc !== crc16(data.slice(0, len + 2))) continue;
      return Uint8Array.from(data.slice(2, len + 2));
    } catch { /* not this level */ }
  }
  return null;
}

/**
 * Read a stamp from an image showing a stat card anywhere in it (the card itself, or a screenshot with the card
 * in it), upright, at any size it is still legible at. imageData = { data, width, height }.
 * @param diag optional object, filled with what was found (eagles, card placements, and the cells read)
 * @returns the payload bytes, or null
 */
export function readStamp(imageData, diag = null) {
  const { width: w, height: h, data: rgb } = imageData;
  const l = lumaOf(imageData);
  let tried = 0;
  for (const card of findCards(rgb, l, w, h, diag)) {
    if (++tried > 3) break;
    // Sizes whose cell edges make a clear line first, largest first (a grid's edges also make lines at its
    // harmonics, the pitches of the smaller sizes); then the rest, clearest first. Only a clear line earns the
    // slower attempts (the placement as found rather than as locked, and fine-tuning).
    const locks = STAMP.sizes.map((size) => ({ L: layout(size), g: lockGrid(l, w, h, card, layout(size).cell, 0.01) }))
      .map((q, i) => ({ ...q, clear: q.g.peak >= 2.5, rank: q.g.peak >= 2.5 ? i : 100 - q.g.peak }))
      .sort((p, q) => p.rank - q.rank);
    for (const { L, g, clear } of locks) {
      // A clear line's grid, also a cell over each way (the placement may be out by half a cell or more).
      const u = L.cell, tries = [g];
      if (clear) {
        for (const dy of [0, -1, 1]) for (const dx of [0, -1, 1]) if (dx || dy) tries.push({ ...g, x0: g.x0 + dx * u * g.sx, y0: g.y0 + dy * u * g.sy });
      }
      for (const p of tries) {
        // (Placements treat px i as [i, i + 1); readGrid rounds to the nearest px centre, at i.)
        const map = (x, y) => [p.x0 + x * p.sx - 0.5, p.y0 + y * p.sy - 0.5];
        const got = readGrid(rgb, l, w, h, L, map, diag) ??
          (clear && p === g ? readGrid(rgb, l, w, h, L, refine(l, w, h, L, map), diag) : null);
        if (got) return got;
      }
    }
  }
  return null;
}
