// Part styles: how some modules are drawn, set by named groups in data/part_styles.json. A group lists module ids
// ("modules") and gives them attributes:
//   "size": 0.8     sprite scale about the part's centre (ship views)
//   "frame": 60     animation frame to draw (every view; e.g. parked aircraft)
//   "back": true    drawn under the rest of its floor (the blueprint view: hull and armor, so every module on them
//                   shows); "all": under every other part, whatever its floor (legs and the wheel)
//   "art": "name"   the blueprint view draws this one sprite in place of the part's own (the crew quarters' cabins,
//                   without the hull frame over them; the R-9 Sprint as cylinder_01_sprint, a sprite only
//                   Parts_contrast has: the cylinder_01 it shares with the legs, drawn as a module)
//   "badge": "kind" an icon the blueprint view draws over the part (see render.js' BADGES)
// A part gets the attributes of every group that lists it; later groups win.
import { STYLES } from './data.js';

/** Module id -> value of one attribute, over every group that sets it. */
function moduleMap(key) {
  const out = {};
  for (const g of Object.values(STYLES.groups)) {
    if (g[key] === undefined) continue;
    for (const oid of g.modules) out[oid] = g[key];
  }
  return out;
}

/** Part sizes for the ship views (renderShip's partScale). */
export const PART_SCALE = moduleMap('size');
/**
 * Animation frames (drawList's frames). Aircraft sprites are an 81-frame roll; designs store frame 0, the plan
 * view, but the game draws parked aircraft side-on (frame 60, canopy and fin up).
 */
export const PART_FRAMES = moduleMap('frame');
/** Parts the blueprint view draws under the rest of their floor, so the modules on them show (drawList's lower). */
export const PART_BACK = moduleMap('back');
/** Module id -> the one sprite the blueprint view draws for it (drawList's art). */
export const PART_ART = moduleMap('art');
/** Module id -> the icon the blueprint view draws over it (renderShip's badges). */
export const PART_BADGE = moduleMap('badge');
