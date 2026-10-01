// Blueprint aesthetic: a hand-sketched, white-on-blue version of the ship sprites on graph paper.
//
// The sketch look is baked into a converted copy of the sprite atlas (see blueprintAtlas /
// tools/blueprint.mjs), so drawing a blueprint is just renderShip() with that atlas.
// Everything here is plain pixel/geometry code: it runs in the browser and in Node.
// The contrast variant (tools/blueprint.mjs --contrast) draws each sprite with its part style
// (src/partstyles.js, data/part_styles.json): structure ghosted back, important modules bright and
// outlined, some parts tinted.
import SPRITES from '../data/sprites.json' with { type: 'json' };
import { renderShip, shipRenderBounds, frameRect, PX_PER_UNIT } from './render.js';
import { PART_SCALE, PART_STYLES, spriteBlueprintStyle } from './partstyles.js';

/** One hull block (1x1 module cell) in metres: 25 atlas px at 7 px/m. */
export const CELL = 25 / PX_PER_UNIT;

export const BLUEPRINT = {
  paper: [24, 74, 133],        // background
  fill: [38, 99, 166],         // ship parts
  ink: [236, 244, 255],        // lines, details, hatching
  gridMinor: 0.08,             // grid line opacity
  gridMajor: 0.2,
  gridMajorEvery: 4,
};

// ---- noise ------------------------------------------------------------------------------
function hash(x, y, s = 0) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 982451653);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x, y, s = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const ramp = (v, a, b) => clamp01((v - a) / (b - a));

// ---- sprite conversion -------------------------------------------------------------------
const LIGHT = (() => { const l = [-0.45, -0.65, 0.9], n = Math.hypot(...l); return l.map((v) => v / n); })();

/** Bilinear sample of a float map (clamped to the rect). */
function sample(map, w, h, x, y) {
  x = x < 0 ? 0 : x > w - 1 ? w - 1 : x;
  y = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
  const xi = Math.min(w - 2, Math.floor(x)), yi = Math.min(h - 2, Math.floor(y));
  if (xi < 0 || yi < 0) return map[Math.round(y) * w + Math.round(x)];
  const fx = x - xi, fy = y - yi, i = yi * w + xi;
  return map[i] * (1 - fx) * (1 - fy) + map[i + 1] * fx * (1 - fy)
    + map[i + w] * (1 - fx) * fy + map[i + w + 1] * fx * fy;
}

/**
 * Hatching intensity at (x, y) for darkness d: short, slightly wavy strokes; a second (crossed)
 * and third (dense) layer come in as the area gets darker.
 */
function hatch(x, y, d, sp) {
  let v = 0;
  const layers = [[1, 0, 0.12, 0.32], [-1, 0.37, 0.55, 0.75], [1, 0.5, 0.8, 0.95]];
  for (let L = 0; L < layers.length; L++) {
    const [dir, shift, a, b] = layers[L];
    if (d <= a) break;
    // u runs across the strokes, t along them (45° / -45°).
    const u = (x + dir * y) * Math.SQRT1_2 / sp + shift + (noise(x * 0.07, y * 0.07, 11 + L) - 0.5) * 0.9;
    const t = (dir * x - y) * Math.SQRT1_2;
    const k = Math.floor(u);
    const segLen = 7 + hash(k, L, 3) * 16;
    const tt = t + hash(k, L, 5) * segLen;
    const s = Math.floor(tt / segLen), ft = tt / segLen - s;
    if (hash(k, s, 7 + L) > 0.82) continue;                        // gap in the stroke
    const strength = ramp(d + (hash(k, s, 13 + L) - 0.5) * 0.25, a, b);
    if (strength <= 0) continue;
    const dist = Math.abs(u - k - 0.5) * sp;                          // px from the stroke centre
    const line = clamp01(1.3 - dist / 0.6);
    const taper = clamp01(Math.min(ft, 1 - ft) * segLen / 2.5);
    v = Math.max(v, line * taper * strength * (0.65 + 0.35 * hash(k, s, 17 + L)));
  }
  return v;
}

/**
 * Convert one sprite (RGBA, w x h) to the blueprint style.
 * @param src     Uint8ClampedArray RGBA colour pixels
 * @param normal  Uint8ClampedArray RGBA normal-map pixels of the same size, or null
 * @param opts    { hatchSpacing (px, default 4.2), palette (default BLUEPRINT),
 *                  style: { fill, inkColor (colours, default the palette's), ink, detail, hatch, sil
 *                           (gains, default 1), silWidth (px, default 1), halo (px, default 0), haloColor,
 *                           haloAlpha } (see the "contrast" entries of data/part_styles.json) }
 * @returns       Uint8ClampedArray RGBA
 */
export function blueprintPixels(src, w, h, normal = null, opts = {}) {
  const P = opts.palette ?? BLUEPRINT;
  const S = opts.style ?? {};
  const fill = S.fill ?? P.fill, inkColor = S.inkColor ?? P.ink;
  const gInk = S.ink ?? 1, gDet = S.detail ?? 1, gHatch = S.hatch ?? 1, gSil = S.sil ?? 1;
  const sp = opts.hatchSpacing ?? 4.2;
  const n = w * h;
  const A = new Float32Array(n), Lum = new Float32Array(n), Shade = new Float32Array(n);
  const Nx = normal ? new Float32Array(n) : null, Ny = normal ? new Float32Array(n) : null;
  for (let i = 0; i < n; i++) {
    const r = src[4 * i], g = src[4 * i + 1], b = src[4 * i + 2];
    A[i] = src[4 * i + 3] / 255;
    Lum[i] = (0.3 * r + 0.59 * g + 0.11 * b) / 255;
    let shade = Lum[i];
    if (normal) {
      const nx = normal[4 * i] / 127.5 - 1, ny = normal[4 * i + 1] / 127.5 - 1, nz = normal[4 * i + 2] / 127.5 - 1;
      Nx[i] = nx; Ny[i] = ny;
      const lambert = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
      shade = 0.65 * shade + 0.35 * lambert;
    }
    Shade[i] = shade;
  }

  // Distance (px, up to r) from an opaque pixel to the nearest transparent one, or from a
  // transparent pixel to the nearest opaque one (opaque = false).
  const search = (x, y, r, opaque = true) => {
    const R = Math.ceil(r);
    let best = r + 1;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const d = Math.hypot(dx, dy);
        if (d >= best) continue;
        const xx = x + dx, yy = y + dy;
        const a = xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : A[yy * w + xx];
        if (opaque ? a < 0.5 : a >= 0.5) best = d;
      }
    }
    return best;
  };
  const silR = S.silWidth ?? 1;

  // Edge maps: silhouette (alpha), details (colour + normal-map discontinuities).
  const Sil = new Float32Array(n), Grad = new Float32Array(n), Det = new Float32Array(n);
  const grads = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (A[i] < 0.5) continue;
      let minA = 1;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          const a = xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : A[yy * w + xx];
          if (a < minA) minA = a;
        }
      }
      Sil[i] = minA < 0.5 ? 1 : 0;
      if (!Sil[i] && silR > 1) Sil[i] = ramp(silR + 0.5 - search(x, y, silR + 1), 0, 1);
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) continue;
      // Sobel per colour channel; transparent neighbours count as this pixel, so the rim
      // (already drawn by the silhouette) does not register as detail.
      let g2 = 0;
      for (let c = 0; c < 3; c++) {
        const V = (dx, dy) => {
          const j = (y + dy) * w + x + dx;
          return (A[j] > 0.5 ? src[4 * j + c] : src[4 * i + c]) / 255;
        };
        const gx = (V(1, -1) + 2 * V(1, 0) + V(1, 1) - V(-1, -1) - 2 * V(-1, 0) - V(-1, 1)) / 4;
        const gy = (V(-1, 1) + 2 * V(0, 1) + V(1, 1) - V(-1, -1) - 2 * V(0, -1) - V(1, -1)) / 4;
        g2 = Math.max(g2, gx * gx + gy * gy);
      }
      Grad[i] = Math.sqrt(g2);
      grads.push(Grad[i]);
    }
  }
  // Threshold relative to the sprite's own contrast, so dull grey parts keep their detail
  // and busy, high-contrast parts are not drowned in lines.
  grads.sort((p, q) => p - q);
  const p85 = grads.length ? grads[Math.floor(grads.length * 0.85)] : 0;
  const lo = Math.min(0.12, Math.max(0.03, p85 * 0.65)), hi = lo * 2.6;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (A[i] < 0.5) continue;
      let e = ramp(Grad[i], lo, hi);
      if (normal) {
        const gn = Math.hypot(Nx[i + 1] - Nx[i - 1], Ny[i + w] - Ny[i - w], Nx[i + w] - Nx[i - w], Ny[i + 1] - Ny[i - 1]);
        e = Math.max(e, ramp(gn, 0.5, 1.1) * 0.7);
      }
      Det[i] = e;
    }
  }

  const out = new Uint8ClampedArray(n * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a = A[i];
      if (a <= 0.01) continue;
      // Wobbly, doubled strokes: sample the edge maps at two noise-displaced positions.
      const ox1 = (noise(x * 0.09, y * 0.09, 1) - 0.5) * 1.6, oy1 = (noise(x * 0.09, y * 0.09, 2) - 0.5) * 1.6;
      const ox2 = (noise(x * 0.05, y * 0.05, 3) - 0.5) * 2.6, oy2 = (noise(x * 0.05, y * 0.05, 4) - 0.5) * 2.6;
      const sil = Math.max(Sil[i], sample(Sil, w, h, x + ox1, y + oy1) * 0.9, sample(Sil, w, h, x + ox2, y + oy2) * 0.45);
      const det = Math.max(sample(Det, w, h, x + ox1 * 0.6, y + oy1 * 0.6), sample(Det, w, h, x + ox2, y + oy2) * 0.2);
      // Pencil pressure varies along the lines.
      const pressure = 0.7 + 0.3 * noise(x * 0.15, y * 0.15, 6);
      const dark = ramp(0.68 - Shade[i], 0, 0.45);
      const ht = hatch(x, y, dark, sp);
      const ink = gInk * Math.max(sil * 0.95 * gSil, det * 0.85 * pressure * gDet, ht * 0.8 * gHatch);
      // Fill: flat blue with a faint watercolour wash; lit areas a touch lighter.
      const wash = (noise(x * 0.04, y * 0.04, 8) - 0.5) * 0.12 + (Lum[i] - 0.5) * 0.12;
      for (let c = 0; c < 3; c++) {
        const f = fill[c] * (1 + wash);
        out[4 * i + c] = f + (inkColor[c] - f) * ink;
      }
      out[4 * i + 3] = 255 * (a >= 0.5 ? 1 : a * 2 * Math.max(a, ink));
    }
  }
  // Knockout halo: a dark band just outside the silhouette, under the sprite's soft rim.
  if (S.halo) {
    const hc = S.haloColor ?? P.paper, ha = S.haloAlpha ?? 0.8;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (A[i] >= 0.5) continue;
        const d = search(x, y, S.halo, false);
        if (d > S.halo) continue;
        const hA = ha * clamp01((S.halo + 0.5 - d) / 1.5);
        const sA = out[4 * i + 3] / 255;
        const oA = sA + hA * (1 - sA);
        if (oA <= 0) continue;
        for (let c = 0; c < 3; c++) out[4 * i + c] = (out[4 * i + c] * sA + hc[c] * hA * (1 - sA)) / oA;
        out[4 * i + 3] = 255 * oA;
      }
    }
  }
  return out;
}

/**
 * Convert a whole sprite atlas (e.g. getImageData of Ships1.png) to the blueprint style.
 * Only sprite colour rects (every frame) are written; the result has the same layout, so it can
 * be passed to renderShip() in place of the original atlas.
 * @param image   { data: Uint8ClampedArray, width, height } RGBA
 * @param opts    blueprintPixels options, plus sprites (default data/sprites.json), onProgress(done, total),
 *                partStyles (true for PART_STYLES, or a part_styles.json-like object: style each sprite by
 *                its part style; the contrast variant)
 * @returns       Uint8ClampedArray RGBA of the same size
 */
export function blueprintAtlas(image, opts = {}) {
  const { data, width, height } = image;
  const sprites = opts.sprites ?? SPRITES;
  const out = new Uint8ClampedArray(width * height * 4);
  const read = (x0, y0, w, h) => {
    const buf = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const yy = y0 + y;
      if (yy < 0 || yy >= height) continue;
      const from = (yy * width + x0) * 4;
      buf.set(data.subarray(from, from + Math.min(w, width - x0) * 4), y * w * 4);
    }
    return buf;
  };
  const entries = Object.entries(sprites);
  let done = 0;
  for (const [name, def] of entries) {
    const style = opts.partStyles
      ? spriteBlueprintStyle(name, opts.palette ?? BLUEPRINT, opts.partStyles === true ? PART_STYLES : opts.partStyles)
      : opts.style;
    for (let f = 0; f < (def.frames || 1); f++) {
      const [x0, y0] = frameRect(def, f);
      // Normal-map frames are laid out like the colour frames, from (bx, by).
      const normal = def.bx !== undefined ? read(...frameRect({ ...def, x: def.bx, y: def.by }, f), def.w, def.h) : null;
      const px = blueprintPixels(read(x0, y0, def.w, def.h), def.w, def.h, normal, { ...opts, style });
      for (let y = 0; y < def.h; y++) {
        if (y0 + y >= height) break;
        const n = Math.min(def.w, width - x0) * 4;
        out.set(px.subarray(y * def.w * 4, y * def.w * 4 + n), ((y0 + y) * width + x0) * 4);
      }
    }
    opts.onProgress?.(++done, entries.length);
  }
  return out;
}

// ---- graph paper -------------------------------------------------------------------------

/**
 * World position of a block-grid line, so the paper lines up with the ship's modules.
 * Axis-aligned parts are centred on cells (odd sizes) or on grid lines (even sizes).
 */
export function gridOrigin(ship) {
  const votes = [new Map(), new Map()];
  for (const p of ship.parts) {
    const q = p.angle / (Math.PI / 2);
    if (Math.abs(q - Math.round(q)) > 0.01 || !p.mesh.length) continue;
    const m = p.worldMesh();
    for (let axis = 0; axis < 2; axis++) {
      const vs = m.map((pt) => pt[axis]);
      const lo = Math.min(...vs), hi = Math.max(...vs);
      const cells = Math.max(1, Math.round((hi - lo) / CELL));
      const edge = (lo + hi) / 2 - (cells * CELL) / 2;
      const key = Math.round((((edge % CELL) + CELL) % CELL) / CELL * 50) % 50;
      votes[axis].set(key, (votes[axis].get(key) || 0) + 1);
    }
  }
  return votes.map((v) => {
    let best = 0, n = -1;
    for (const [k, c] of v) if (c > n) { best = k; n = c; }
    return (best / 50) * CELL;
  });
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
export function paperLayers(opts = {}) {
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

/**
 * paperLayers() as drawable canvases: [{ image, perMetre }], ready for drawGraphPaper's `texture` /
 * renderBlueprint's `paperTexture`. `makeCanvas(w, h)` creates a canvas (browser: document.createElement;
 * Node: @napi-rs/canvas createCanvas).
 */
export function paperTexture(makeCanvas, opts = {}) {
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
 *               majorEvery (default 4), palette,
 *               texture: paper texture layers [{ image, perMetre }] (see paperTexture), laid over paper and
 *                 lines in design space: they pan with originX/originY and zoom with `cell` }
 */
export function drawGraphPaper(ctx, x, y, w, h, opts = {}) {
  const P = opts.palette ?? BLUEPRINT;
  const cell = opts.cell ?? CELL * PX_PER_UNIT;
  const every = opts.majorEvery ?? P.gridMajorEvery;
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

// ---- composition ------------------------------------------------------------------------

/** Size of a standalone blueprint render (ship bounds + margin), and where the world origin goes. */
export function blueprintLayout(ship, opts = {}) {
  const scale = opts.scale ?? PX_PER_UNIT;
  const b = shipRenderBounds(ship);
  const margin = opts.margin ?? Math.round(CELL * 4 * scale);
  const width = Math.ceil(b.w * scale + 2 * margin), height = Math.ceil(b.h * scale + 2 * margin);
  return { width, height, scale, bounds: b, x: margin - b.x0 * scale, y: margin - b.y0 * scale };
}

/**
 * Draw a ship as a blueprint: graph paper, then the sketched sprites.
 * @param atlas   the blueprint atlas (assets/Ships1_blueprint.png, or built with blueprintAtlas())
 * @param opts    { scale, x, y (px position of the world origin; default blueprintLayout),
 *                  paper: {x, y, w, h} rect to cover with graph paper (default: blueprintLayout's size;
 *                  false for none), frame, palette, partScale (default PART_SCALE) }
 */
export function renderBlueprint(ctx, ship, atlas, opts = {}) {
  const L = blueprintLayout(ship, opts);
  const scale = L.scale, x = opts.x ?? L.x, y = opts.y ?? L.y;
  const paper = opts.paper ?? { x: 0, y: 0, w: L.width, h: L.height };
  const [gx, gy] = gridOrigin(ship);
  const cell = CELL * scale;
  if (paper) {
    drawGraphPaper(ctx, paper.x, paper.y, paper.w, paper.h, {
      cell, originX: x + gx * scale, originY: y + gy * scale, palette: opts.palette,
      texture: opts.paperTexture,
    });
  }
  const ink = (opts.palette ?? BLUEPRINT).ink;
  renderShip(ctx, ship, atlas, { ...opts, partScale: opts.partScale ?? PART_SCALE, scale, x, y, wireColor: `rgba(${ink[0]},${ink[1]},${ink[2]},0.8)` });
  return { ...L, x, y };
}
