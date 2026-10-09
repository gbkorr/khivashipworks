// The blueprint's graph paper: a block grid on blue paper with a paper texture (grain, fibres, formation) laid over it.
import { PX_PER_UNIT } from './render.js';
import { makeCanvas } from './font.js';

/** One hull block (1x1 module cell) in metres: 25 atlas px at 7 px/m. */
const CELL = 25 / PX_PER_UNIT;

export const BLUEPRINT = {
  paper: [24, 74, 133],        // background
  ink: [236, 244, 255],        // lines
  gridMinor: 0.08,             // grid line opacity
  gridMajor: 0.2,
  gridMajorEvery: 4,
};
/** The light paper (the page's light theme): drafting paper with a blue-grey grid. */
export const PAPER_LIGHT = {
  paper: [242, 238, 227],
  ink: [40, 68, 105],
  gridMinor: 0.12,
  gridMajor: 0.28,
  gridMajorEvery: 4,
};

function hash(x, y, s = 0) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 982451653);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Periodic value noise in [-0.5, 0.5]: the lattice wraps every `size` texels, so tiles repeat seamlessly.
function tileNoise(x, y, period, size, seed) {
  const n = size / period, fx = x / period, fy = y / period;
  const xi = Math.floor(fx), yi = Math.floor(fy), tx = fx - xi, ty = fy - yi;
  const u = tx * tx * (3 - 2 * tx), w = ty * ty * (3 - 2 * ty);
  const h = (i, j) => hash(((i % n) + n) % n, ((j % n) + n) % n, seed) - 0.5;
  const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w;
}

/** Signed values -> white (lighter, alpha v * gain) / black (darker, alpha -v * darkGain) specks. */
function specks(v, gain, darkGain = gain) {
  const out = new Uint8ClampedArray(v.length * 4);
  for (let i = 0; i < v.length; i++) {
    const c = v[i] > 0 ? 255 : 0;
    out[4 * i] = out[4 * i + 1] = out[4 * i + 2] = c;
    out[4 * i + 3] = Math.min(255, Math.abs(v[i]) * (v[i] > 0 ? gain : darkGain) * 255);
  }
  return out;
}

/**
 * Paper texture layers for drawGraphPaper's `texture`, as RGBA pixel tiles (put each in a canvas; see
 * paperTexture). Each is laid out in metres so it zooms and pans with the grid:
 *   grain:     fine speckle and a few pale fibres (12 texels per metre, 512 texels = ~43 m tile)
 *   formation: fine, uneven fibre clumping, as paper looks held to the light: lighter / darker flecks
 *              2-8 m across over a faint 32 m cloud (4 texels per metre, 512 texels = 128 m tile)
 * @param opts { seed (default 1), strength (overall alpha, default 1) }
 * @returns [{ name, size, perMetre, pixels }]
 */
function paperLayers(opts = {}) {
  const seed = opts.seed ?? 1, strength = opts.strength ?? 1;
  const G = 512, F = 512;
  const grain = new Float32Array(G * G);
  for (let y = 0; y < G; y++) {
    for (let x = 0; x < G; x++) {
      grain[y * G + x] = (hash(x, y, seed) - 0.5) * 0.55 + (hash(x >> 1, y >> 1, seed + 7) - 0.5) * 0.3;
    }
  }
  const fibres = Math.round((G * G) / 2500);
  for (let f = 0; f < fibres; f++) {
    let x = hash(f, 1, seed + 17) * G, y = hash(f, 2, seed + 17) * G;
    let a = hash(f, 3, seed + 17) * Math.PI * 2;
    const len = 12 + hash(f, 4, seed + 17) * 36, lift = 0.25 + hash(f, 5, seed + 17) * 0.35;
    for (let i = 0; i < len; i++) {
      a += (hash(f, 100 + i, seed + 19) - 0.5) * 0.5;
      x += Math.cos(a); y += Math.sin(a);
      const k = (((Math.round(y) % G) + G) % G) * G + (((Math.round(x) % G) + G) % G);
      grain[k] += lift * Math.sin((Math.PI * i) / len);
    }
  }
  const form = new Float32Array(F * F);
  for (let y = 0; y < F; y++) {
    for (let x = 0; x < F; x++) {
      form[y * F + x] = tileNoise(x, y, 32, F, seed + 11) * 0.5 + tileNoise(x, y, 16, F, seed + 12) * 0.35
        + tileNoise(x, y, 8, F, seed + 13) * 0.2 + tileNoise(x, y, 128, F, seed + 14) * 0.35;
    }
  }
  return [
    // Dark flecks go a little deeper than light ones lift, for more contrast against the ship's fills.
    { name: 'formation', size: F, perMetre: 4, pixels: specks(form, 0.13 * strength, 0.16 * strength) },
    { name: 'grain', size: G, perMetre: 12, pixels: specks(grain, 0.22 * strength) },
  ];
}

/** paperLayers() as drawable canvases: [{ image, perMetre }], for drawGraphPaper's `texture`. */
export function paperTexture(opts = {}) {
  return paperLayers(opts).map(({ size, perMetre, pixels }) => {
    const c = makeCanvas(size, size);
    const g = c.getContext('2d');
    const img = g.createImageData(size, size);
    img.data.set(pixels);
    g.putImageData(img, 0, 0);
    return { image: c, perMetre };
  });
}

/**
 * Fill a rect with blueprint graph paper.
 * @param opts { cell (px, default CELL*7), originX/originY (px position of a major line),
 *               palette: paper and grid colours (default BLUEPRINT; or PAPER_LIGHT),
 *               texture: paper texture layers [{ image, perMetre }] (see paperTexture), laid over paper and
 *                 lines in design space: they pan with originX/originY and zoom with `cell` }
 */
export function drawGraphPaper(ctx, x, y, w, h, opts = {}) {
  const P = opts.palette ?? BLUEPRINT;
  const cell = opts.cell ?? CELL * PX_PER_UNIT;
  const every = P.gridMajorEvery;
  const ox = opts.originX ?? x, oy = opts.originY ?? y;
  const rgb = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  ctx.save();
  ctx.fillStyle = rgb(P.paper, 1);
  ctx.fillRect(x, y, w, h);
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  const lineW = Math.max(1, cell / 25);
  for (const major of [false, true]) {
    ctx.beginPath();
    for (const [axis, from, to, o] of [[0, x, x + w, ox], [1, y, y + h, oy]]) {
      const k0 = Math.ceil((from - o) / cell), k1 = Math.floor((to - o) / cell);
      for (let k = k0; k <= k1; k++) {
        if ((((k % every) + every) % every === 0) !== major) continue;
        // Snap to pixel centres so thin lines stay crisp.
        const p = Math.round(o + k * cell) + 0.5;
        if (axis === 0) { ctx.moveTo(p, y); ctx.lineTo(p, y + h); } else { ctx.moveTo(x, p); ctx.lineTo(x + w, p); }
      }
    }
    ctx.strokeStyle = rgb(P.ink, major ? P.gridMajor : P.gridMinor);
    ctx.lineWidth = major ? lineW * 1.6 : lineW;
    ctx.stroke();
  }
  if (opts.texture) {
    // Over the lines too, so they look printed on the paper rather than drawn on top of it.
    const pxPerMetre = cell / CELL;
    for (const { image, perMetre } of opts.texture) {
      const k = pxPerMetre / perMetre;     // screen px per texel
      const tw = image.width * k, th = image.height * k;
      const tx = ((ox % tw) + tw) % tw, ty = ((oy % th) + th) % th;
      ctx.save();
      ctx.translate(tx, ty);
      ctx.scale(k, k);
      ctx.fillStyle = ctx.createPattern(image, 'repeat');
      ctx.fillRect((x - tx) / k, (y - ty) / k, w / k, h / k);
      ctx.restore();
    }
  }
  ctx.restore();
}
