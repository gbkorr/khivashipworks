// The game's sprite lighting and cast shadows, then a colour grade towards the game's on-screen colours, as a
// CPU pass over rendered pixels. The lighting is a port of RAW/Shaders/Lighting_ps.hlsl (ps_main_mid); the grade
// stands in for the game's palette dither (Dithering_ps.hlsl) and is fitted to its screenshots
// (highfleetjs/tools/grade.mjs). See SHADING-NOTES.md at the repository root.
// bakeShaded() renders a whole ship once (colour, rotated normals, depth), shades it and returns the image,
// so the shipbuilder only redoes the work when the design changes.

import { renderShip, drawList, frameRect, placeSprite, shipRenderBounds, PX_PER_UNIT } from './render.js';
import { makeCanvas } from './font.js';

// Fitted by `node highfleetjs/tools/grade.mjs --sun 0,26.565,0.25` on the lit, stage-shaded bake (paste its output here).
const GRADE = {
  tone: [
    [0.0748, 0.1445, 0.2116, 0.278, 0.3276, 0.3786, 0.4458, 0.4829, 0.5323, 0.5713, 0.6242, 0.6772, 0.7465, 0.793, 0.8266, 0.8609, 0.9021],
    [0.0989, 0.1587, 0.2167, 0.2774, 0.3261, 0.3888, 0.4476, 0.4667, 0.4948, 0.518, 0.562, 0.6094, 0.6674, 0.7082, 0.7523, 0.815, 0.8867],
    [0.1121, 0.1584, 0.2016, 0.2422, 0.2767, 0.3309, 0.3808, 0.386, 0.3946, 0.4165, 0.4599, 0.5023, 0.5506, 0.5938, 0.6429, 0.7128, 0.7945],
  ],
  chroma: [
    [[0.1944, 0.2024, 0.2049], [-0.0893, -0.0834, -0.0555], [-0.0502, -0.1015, -0.2517]],
    [[-0.136, -0.0446, 0.1097], [-0.0033, -0.0111, 0.0082], [0.3738, 0.1743, -0.3302]],
    [[-0.2216, -0.1088, -0.0527], [0.0164, -0.0181, -0.0217], [0.4969, 0.3785, 0.2502]],
  ],
};

export const SHADING = {
  // Lighting_ps ps_main_mid, with the constants the game uploads in its shipyard/hangar renderer
  // (FUN_140300db0: a fixed noon sun; FUN_14030f250 is the same at the current time of day):
  //   sun_direction = (-sin a, cos a, 0.5) with a = pi  ->  straight down the screen, tilted to the viewer
  //   sun_color     = time-of-day table entry 14 at noon, (255, 252, 242) / 255, a = min(1, 0.9) = 0.9
  //   sky_color     = (0.8, 0.9, 1.0), a = clamp(0.9 - sun.a, 0, 0.2) = 0 at noon
  //   light = ambient + sky + sun * (bumped ? 0.3 + N.L : 1)      (point lights left out)
  // The hangar lights ships with this same noon sun, plus some flat light: ambient 0.25, fitted to the hangar
  // screenshots (highfleetjs/tools/grade.mjs, with the grade; the fit is flat from 0.2 to 0.3). Fitting the sun too lands
  // within a few degrees of the game's (0, -1, 0.5) once stage shading is in.
  lighting: true,
  sunDir: [0, -1, 0.5], // screen space, y down
  sun: [1, 252 / 255, 242 / 255, 0.9], // rgb, intensity
  sky: [0.8, 0.9, 1.0, 0],
  ambient: 0.25,
  // Lighting_ps stage shading, for z > 0 (z = the depth buffer: draw layer / stageLayers):
  //   base += _middle * (2z - 0.3); base = lerp(base, _middle, 0.1)
  // _middle is the time-of-day table's entry 6 at noon, (214, 183, 139) (FUN_140217470, table at 0x1403c11d4).
  stage: true, middle: [214 / 255, 183 / 255, 139 / 255], stageLayers: 70,
  // Lighting_ps cast shadows: march up-left from each pixel through the depth (draw layer) buffer; a pixel
  // is shadowed when a layer k above it lies within k * shadowPx along the diagonal (max 39 steps).
  // shadowPx ~5 from the shader's comment ("~5 px per layer"); strength 0.6 towards black.
  shadows: true, shadowPx: 5, shadowSteps: 39, shadowStrength: 0.6,
  // Our own addition: the march reads the depth box-blurred by this radius. Thin parts a layer up (railings,
  // detail sprites, the armour's semi-transparent pixels over hull) otherwise each cast a few-pixel diagonal
  // streak the game's screenshots don't have; a 1 px bar a layer up now counts as a third of one. Solid shapes
  // keep their shadows (the screenshot fit is unchanged).
  shadowBlur: 1,
  // Colour grade: what the game's palette dither and post-processing do to colours on average, as a gradient map
  // plus chroma matrix (see gradeColor). Fitted by highfleetjs/tools/grade.mjs to examples/borey.png and voskhod.png.
  // null = the sprites' own colours.
  grade: GRADE,
};

/** Weights of the two knots around v (0..1) on n evenly spaced knots: [index of the lower one, its weight]. */
function knot(v, n) {
  const x = Math.min(1, Math.max(0, v)) * (n - 1), i = Math.min(n - 2, Math.floor(x));
  return [i, 1 - (x - i)];
}

/**
 * The colour grade of one colour (r, g, b 0..1) -> [r, g, b] (unclamped). A gradient map over luminance (each
 * output channel a piecewise-linear curve of L), plus the colour's chroma (rgb - L) through a 3x3 matrix that
 * itself varies piecewise-linearly with L: grays follow the curves, colours are desaturated and shifted around
 * them, and nothing extrapolates wildly for colours the fit barely saw.
 * @param grade { tone: [3][nTone] knot values, chroma: [3 out][3 in][nChroma] }
 */
function gradeColor(grade, r, g, b) {
  const L = 0.299 * r + 0.587 * g + 0.114 * b;
  const [ti, tw] = knot(L, grade.tone[0].length), [ci, cw] = knot(L, grade.chroma[0][0].length);
  const d = [r - L, g - L, b - L];
  return [0, 1, 2].map((ch) => {
    const t = grade.tone[ch], m = grade.chroma[ch];
    let v = t[ti] * tw + t[ti + 1] * (1 - tw);
    for (let j = 0; j < 3; j++) v += d[j] * (m[j][ci] * cw + m[j][ci + 1] * (1 - cw));
    return v;
  });
}

/** Rows per step of the per-pixel passes (see bakeShadedAsync). */
const BAND = 16;
/** Run a step generator (see bakeSteps) to the end; its return value. */
function run(steps) {
  for (;;) { const r = steps.next(); if (r.done) return r.value; }
}

/**
 * Shade pixels in place, a yield after every band of rows: lighting and cast shadows, then the colour grade.
 * @param color   RGBA of the unlit render (premultiplied or not: only straight colour is used)
 * @param normal  RGBA of the same view rendered from the normal-map atlas (0,0,0 = no bump: flat lit)
 * @param w, h    size
 * @param depth   per pixel (RGBA stride): red = draw layer + 1 times coverage (0 = empty), green = sprite
 *                ambient (m_ambient, 0..1); for cast shadows, stage shading and self-lit sprites, or null
 */
function* shadeSteps(color, normal, w, h, o, depth) {
  const sd = depth && o.shadows ? yield* shadowDepthSteps(depth, w, h, o.shadowBlur) : null;
  for (let y = 0; y < h; y += BAND) {
    const y1 = Math.min(h, y + BAND);
    lightRows(color, normal, w, o, depth, sd, y, y1);
    if (o.grade) {
      // Self-lit sprites (m_ambient) keep their own colours in that share: the grade was fitted to lit pixels, and
      // took the bridge's white emblem to a dim beige where the game shows it white.
      const i0 = 4 * w * y, i1 = 4 * w * y1, before = depth && color.slice(i0, i1);
      gradeRange(color, i0, i1, o.grade);
      if (before) {
        for (let i = i0; i < i1; i += 4) {
          const a = depth[i + 1];
          if (a > 0) for (let k = 0; k < 3; k++) color[i + k] += (before[i - i0 + k] - color[i + k]) * a;
        }
      }
    }
    yield;
  }
}

/**
 * Lighting_ps over rows y0..y1: stage shading (if o.stage), sun/sky lighting (if o.lighting) and cast shadows, in
 * place, given the shadow march's depth (sd).
 */
function lightRows(color, normal, w, o, depth, sd, y0, y1) {
  const L = Math.hypot(...o.sunDir), lx = o.sunDir[0] / L, ly = o.sunDir[1] / L, lz = o.sunDir[2] / L;
  const sun = o.sun.slice(0, 3).map((v) => v * o.sun[3]);
  const base = o.sky.slice(0, 3).map((v) => v * o.sky[3] + o.ambient);
  const lit = o.lighting, keep = 1 - o.shadowStrength;
  const mid = o.middle.map((v) => v * 255);
  for (let y = y0, i = 4 * w * y0; y < y1; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      if (!color[i + 3]) continue;
      // A sprite's ambient (m_ambient, from the depth pass' green) is self-lit: it takes that share out of the
      // stage shading, the light and the shadow (ps_main_mid's `unambient`).
      const amb = depth ? depth[i + 1] : 0, un = 1 - amb;
      if (o.stage && depth && depth[i]) {
        // Stage shading: raised sprites lighter, low ones a little darker, all 10% towards _middle.
        const c = ((2 * (depth[i] - 1)) / o.stageLayers - 0.3) * un;
        for (let k = 0; k < 3; k++) {
          const v = color[i + k] + mid[k] * c;
          color[i + k] = v + (mid[k] - v) * 0.1 * un;
        }
      }
      let lr = 1, lg = 1, lb = 1;
      if (lit) {
        const nr = normal[i], ng = normal[i + 1], nb = normal[i + 2];
        let k = 1; // flat-lit sprites get the whole sun
        if (nr || ng || nb) {
          // Bumped: lighting_simple * (1 - 0.7) + lighting_bump, i.e. 0.3 of the flat sun plus N.L.
          const nx = nr / 127.5 - 1, ny = ng / 127.5 - 1, nz = nb / 127.5 - 1, nl = Math.hypot(nx, ny, nz) || 1;
          k = 0.3 + Math.max(0, (nx * lx + ny * ly + nz * lz) / nl);
        }
        lr = amb + (base[0] + sun[0] * k) * un; lg = amb + (base[1] + sun[1] * k) * un; lb = amb + (base[2] + sun[2] * k) * un;
      }
      if (sd && depth[i]) {
        const z = sd[i];
        for (let d = 1; d <= o.shadowSteps && d <= x && d <= y; d++) {
          // int delta = 350 * (z2 - z): truncated, so a fraction of a layer casts little or nothing.
          if (Math.trunc((sd[i - 4 * d * (w + 1)] - z) * o.shadowPx) >= d) {
            const f = 1 - (1 - keep) * un;
            lr *= f; lg *= f; lb *= f;
            break;
          }
        }
      }
      color[i] *= lr; color[i + 1] *= lg; color[i + 2] *= lb;
    }
  }
}

/** The depth the shadow march reads: box-blurred by radius r (0 = as is), in the same RGBA-stride layout. Steps. */
function* shadowDepthSteps(depth, w, h, r) {
  if (!r) return depth;
  const tmp = new Float32Array(w * h), out = new Float32Array(depth.length), n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += depth[4 * (y * w + Math.min(w - 1, Math.max(0, x + k)))];
      tmp[y * w + x] = s / n;
    }
    if (y % BAND === BAND - 1) yield;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x];
      out[4 * (y * w + x)] = s / n;
    }
    if (y % BAND === BAND - 1) yield;
  }
  return out;
}

/** The colour grade (SHADING.grade, see gradeColor) over color[i0..i1], in place. Transparent pixels are left alone. */
function gradeRange(color, i0, i1, grade) {
  for (let i = i0; i < i1; i += 4) {
    if (!color[i + 3]) continue;
    const c = gradeColor(grade, color[i] / 255, color[i + 1] / 255, color[i + 2] / 255);
    color[i] = 255 * c[0]; color[i + 1] = 255 * c[1]; color[i + 2] = 255 * c[2];   // clamped by the typed array
  }
}

// Per-sprite images for the normal and depth passes, keyed by sprite/frame/orientation (or layer).
const normalCache = new Map(), depthCache = new Map();

/** A sprite frame's normal map, turned to world space for its rotation and mirroring (null if it has none). */
function normalSprite(atlas, def, frame, angle, fx, fy) {
  if (def.bx === undefined) return null;
  const key = `${def.bx},${def.by},${frame},${angle.toFixed(4)},${fx},${fy}`;
  let c = normalCache.get(key);
  if (c) return c;
  const [sx, sy] = frameRect({ ...def, x: def.bx, y: def.by }, frame);
  const [cx, cy] = frameRect(def, frame);
  c = makeCanvas(def.w, def.h);
  const g = c.getContext('2d', { willReadFrequently: true });
  // The normal map is opaque over the whole rect (flat normals around the shape), so it takes the colour
  // sprite's alpha: otherwise every sprite would flatten the normals of what's under its bounding box.
  g.drawImage(atlas, cx, cy, def.w, def.h, 0, 0, def.w, def.h);
  const alpha = g.getImageData(0, 0, def.w, def.h).data;
  g.clearRect(0, 0, def.w, def.h);
  g.drawImage(atlas, sx, sy, def.w, def.h, 0, 0, def.w, def.h);
  const img = g.getImageData(0, 0, def.w, def.h), p = img.data;
  const cs = Math.cos(angle), sn = Math.sin(angle);
  for (let i = 0; i < p.length; i += 4) {
    p[i + 3] = alpha[i + 3];
    if (!(p[i] || p[i + 1] || p[i + 2])) continue;
    const nx = (p[i] / 127.5 - 1) * fx, ny = (p[i + 1] / 127.5 - 1) * fy;
    p[i] = (nx * cs - ny * sn + 1) * 127.5;
    p[i + 1] = (nx * sn + ny * cs + 1) * 127.5;
  }
  g.putImageData(img, 0, 0);
  normalCache.set(key, c);
  return c;
}

/** A sprite frame's silhouette filled with z in red and its ambient (0..1) in green, like DeferringMid's depth. */
function depthSprite(atlas, def, frame, z, ambient) {
  const [sx, sy] = frameRect(def, frame);
  const key = `${sx},${sy},${def.w},${def.h},${z},${ambient}`;
  let c = depthCache.get(key);
  if (c) return c;
  c = makeCanvas(def.w, def.h);
  const g = c.getContext('2d');
  g.drawImage(atlas, sx, sy, def.w, def.h, 0, 0, def.w, def.h);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = `rgb(${z},${Math.round(ambient * 255)},0)`;
  g.fillRect(0, 0, def.w, def.h);
  depthCache.set(key, c);
  return c;
}

/**
 * Render a ship with the game's lighting, cast shadows and colour grade, at the atlas' own resolution.
 * @returns { canvas, x0, y0, scale } — draw canvas at world (x0, y0) metres, `scale` px per metre; null if empty
 */
export function bakeShaded(ship, atlas, o = SHADING) {
  return run(bakeSteps(ship, atlas, o));
}

/**
 * bakeShaded, a few ms at a time: between slices of about `budget` ms it waits for the next task, so the page
 * keeps drawing frames. Stops early (null) once `cancelled()` says the bake is no longer wanted.
 */
export async function bakeShadedAsync(ship, atlas, o = SHADING, { budget = 8, cancelled = () => false } = {}) {
  const steps = bakeSteps(ship, atlas, o);
  let t = performance.now();
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
    if (performance.now() - t < budget) continue;
    await new Promise((ok) => setTimeout(ok, 0));
    if (cancelled()) return null;
    t = performance.now();
  }
}

/** bakeShaded's work as steps (a yield between stages and every band of rows or batch of sprites). */
function* bakeSteps(ship, atlas, o) {
  const b = shipRenderBounds(ship);
  const s = PX_PER_UNIT, pad = 2;
  if (!b.w || !b.h) return null;
  // The design origin on a whole pixel: parts sit on a 25 px grid (a block is 25/7 m at 7 px/m), so their sprites
  // then land on whole pixels too. At the bounds' fractional corner every sprite was resampled, blurring the
  // colour, normal and depth passes alike (light rims at edges; and a part rendered differently in a ship than
  // on its own, whose bounds happened to fall on whole pixels).
  const ox = Math.ceil(pad - b.x0 * s), oy = Math.ceil(pad - b.y0 * s);
  const w = Math.ceil(ox + b.x1 * s) + pad, h = Math.ceil(oy + b.y1 * s) + pad;
  const color = makeCanvas(w, h);
  const cg = color.getContext('2d', { willReadFrequently: true });
  renderShip(cg, ship, atlas, { scale: s, x: ox, y: oy, wireColor: o.wireColor, snap: true });
  yield;
  // The normal pass is only needed for lighting; the depth pass (z, and sprite ambient) for any of the three.
  const passes = [];
  if (o.lighting) passes.push([makeCanvas(w, h), (d, fx, fy) => normalSprite(atlas, d.def, d.frame, d.angle, fx, fy)]);
  if (o.shadows || o.stage || o.lighting) passes.push([makeCanvas(w, h), (d) => depthSprite(atlas, d.def, d.frame, d.z + 1, d.sprite.ambient ?? 0)]);
  const ctxs = passes.map(([c]) => c.getContext('2d', { willReadFrequently: true }));
  if (passes.length) {
    let n = 0;
    for (const d of drawList(ship)) {
      if (++n % 32 === 0) yield;
      const { def } = d;
      const fx = Math.sign(d.sx) || 1, fy = Math.sign(d.sy) || 1;
      passes.forEach(([, sprite], p) => {
        const g = ctxs[p], img = sprite(d, fx, fy);
        g.save();
        placeSprite(g, d, ox, oy, s, true);   // (where the colour pass put it)
        if (d.alpha < 1) g.globalAlpha = d.alpha;
        if (img) g.drawImage(img, -def.hx, -def.hy);
        else {
          // No normal map: clear what's under it, so it's lit flat.
          const [sx, sy] = frameRect(def, d.frame);
          g.globalCompositeOperation = 'destination-out';
          g.drawImage(atlas, sx, sy, def.w, def.h, -def.hx, -def.hy, def.w, def.h);
        }
        g.restore();
      });
    }
  }
  const data = (on) => (on ? ctxs[on === 'n' ? 0 : ctxs.length - 1].getImageData(0, 0, w, h).data : null);
  // DeferringMid writes depth premultiplied (z * alpha) and blends it, so a sprite's faint fringes add little
  // height. getImageData un-premultiplies: weight by alpha again, or a near-transparent fringe of a high sprite
  // reads as its full height and casts a thin streak of shadow.
  // Kept as floats, like the game's buffer: rounding a half-covered pixel to a whole layer lets its neighbours
  // cast a few pixels of shadow on it, which streaks every sprite with soft edges or holes (the armour, mostly).
  function* depthOf() {
    const d = data('d'), f = new Float32Array(d.length), band = 4 * w * BAND;
    yield;
    for (let i = 0; i < d.length; i += 4) {
      f[i] = (d[i] * d[i + 3]) / 255; f[i + 1] = (d[i + 1] * d[i + 3]) / 65025;
      if (i % band === 0) yield;
    }
    return f;
  }
  const img = cg.getImageData(0, 0, w, h);
  yield;
  const dep = o.shadows || o.stage || o.lighting ? yield* depthOf() : null;
  const nrm = o.lighting ? data('n') : null;
  yield;
  yield* shadeSteps(img.data, nrm, w, h, o, dep);
  cg.putImageData(img, 0, 0);
  return { canvas: color, x0: -ox / s, y0: -oy / s, scale: s };
}
