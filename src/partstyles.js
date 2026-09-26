// Part styles: how each kind of part is drawn, set by named groups in data/part_styles.json.
//
// A group picks parts and gives them attributes:
//   { "sprites": ["armor_*", ...],   atlas sprite names (* = any characters): baked looks
//     "modules": ["MDL_FUEL_02", ...], module ids (exact): per-part attributes applied at draw time
//     "contrast": "system",           a key of "contrast" (blueprint drawing parameters)
//     "color": "silver",              a key of "colors" (tint, see tintColor)
//     "size": 0.8,                    sprite scale about the part's centre (ship views)
//     "frame": 60 }                   animation frame to draw (every view; e.g. parked aircraft)
// A part gets the attributes of every group that picks it; later groups win.
// contrast and color are baked into the contrast blueprint atlas, one look per sprite (a sprite shared
// by several modules looks the same in all of them), so they go with "sprites". size is applied per
// placed part by renderShip, and so is frame, so they go with "modules".
import STYLES from '../data/part_styles.json' with { type: 'json' };

export const PART_STYLES = STYLES;

const globs = new Map();
function globMatch(pattern, name) {
  let re = globs.get(pattern);
  if (!re) {
    re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    globs.set(pattern, re);
  }
  return re.test(name);
}

/** Merged attributes of the groups whose `key` list ('sprites' or 'modules') matches name. */
function attributes(key, name, styles) {
  const out = { groups: [] };
  for (const [id, g] of Object.entries(styles.groups)) {
    const hit = key === 'sprites' ? g.sprites?.some((p) => globMatch(p, name)) : g.modules?.includes(name);
    if (!hit) continue;
    out.groups.push(id);
    for (const [k, v] of Object.entries(g)) if (k !== 'sprites' && k !== 'modules') out[k] = v;
  }
  return out;
}

/** Attributes of an atlas sprite: { groups, contrast, color, ... }. */
export function spriteAttributes(name, styles = PART_STYLES) {
  return attributes('sprites', name, styles);
}

/** Attributes of a module (part) id: { groups, size, ... }. */
export function moduleAttributes(oid, styles = PART_STYLES) {
  return attributes('modules', oid, styles);
}

const toLinear = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const toSrgb = (v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
/** Oklab lightness (0-1) of an sRGB colour: perceived brightness, fair to saturated blues. */
function oklabL([r, g, b]) {
  [r, g, b] = [r, g, b].map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

/**
 * Tint a colour: keep its perceived brightness (Oklab lightness), take the hue and saturation of
 * `tint`. The "colors" entries are such tints, e.g. a light neutral grey for silver.
 */
export function tintColor(rgb, tint) {
  // Scaling linear RGB by k scales Oklab L by cbrt(k).
  const k = (oklabL(rgb) / oklabL(tint)) ** 3;
  return tint.map((v) => Math.max(0, Math.min(255, toSrgb(toLinear(v) * k))));
}

/**
 * blueprintPixels style for a sprite (contrast parameters with its colour applied to the fill and
 * ink), or null when no group gives it a contrast.
 * @param palette  the blueprint palette (BLUEPRINT), for the ink colour
 */
export function spriteBlueprintStyle(name, palette, styles = PART_STYLES) {
  const a = spriteAttributes(name, styles);
  const base = a.contrast && styles.contrast[a.contrast];
  if (!base) return null;
  const tint = a.color && styles.colors[a.color];
  if (!tint) return base;
  return { ...base, fill: tintColor(base.fill ?? palette.fill, tint), inkColor: tintColor(palette.ink, tint) };
}

/** Module id -> value map of one per-module attribute, over every group that sets it. */
function moduleMap(key, styles) {
  const out = {};
  for (const g of Object.values(styles.groups)) {
    if (g[key] === undefined) continue;
    for (const oid of g.modules ?? []) out[oid] = g[key];
  }
  return out;
}

/** Module id -> size map (the default renderShip partScale for ship views). */
export const partScales = (styles = PART_STYLES) => moduleMap('size', styles);
/** Module id -> animation frame map (drawList's default frames). */
export const partFrames = (styles = PART_STYLES) => moduleMap('frame', styles);

/** Default part sizes for the ship views (from PART_STYLES). */
export const PART_SCALE = partScales();
/**
 * Default animation frames. Aircraft sprites are an 81-frame roll; designs store frame 0, the plan
 * view, but the game draws parked aircraft side-on (frame 60, canopy and fin up).
 */
export const PART_FRAMES = partFrames();
