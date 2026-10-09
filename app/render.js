// The Render menu: the design (its connected parts) downloaded as a PNG at the atlas' own resolution, on a
// transparent background. Each look is an atlas and how it's drawn:
//   Color      Parts_color with the game's shading, as the stage
//   Blueprint  Parts_blueprint as the colour look draws (every part full size, plain depth order)
//   Tactical   Parts_contrast as the stage's blueprint draws it (some parts smaller, hull under the rest, icons);
//              on light paper Parts_lightmode, as the stage then draws
//   Line Art   Parts_lineart (the blueprint's lines in black) the same way, each part hiding the lines under it
import { $, S } from './state.js';
import { atlas, blueprint, lightmode, load, loadLightmode } from './assets.js';
import { connected } from './edit.js';
import { BLUEPRINT_ART } from './view.js';
import { safeFileName, toast } from './dialogs.js';
import { saveFile } from './files.js';
import { below, closeAllMenus, menus, showMenu } from './menus.js';
import { BLUEPRINT, PAPER_LIGHT } from '../lib/paper.js';
import { PART_BACK, PART_SCALE } from '../lib/partstyles.js';
import { BADGE_COLORS, PX_PER_UNIT, renderShip, shipRenderBounds } from '../lib/render.js';
import { SHADING, bakeShadedAsync } from '../lib/shading.js';
import { makeCanvas } from '../lib/font.js';

const INK = `rgb(${BLUEPRINT.ink})`;

const LOOKS = [
  { label: 'Color', file: 'color', atlas: 'Parts_color.png', shaded: true, title: 'Ingame render.' },
  {
    label: 'Blueprint', file: 'blueprint', atlas: 'Parts_blueprint.png', opts: { wireColor: INK },
    title: 'Monocolor blueprint.',
  },
  {
    label: 'Tactical', file: 'tactical', atlas: 'Parts_contrast.png', title: 'Editor aesthetic.',
    opts: { partScale: PART_SCALE, lower: PART_BACK, wireColor: INK, ...BLUEPRINT_ART },
    // On light paper (the stage's look then).
    light: {
      atlas: 'Parts_lightmode.png', opts: { wireColor: `rgb(${PAPER_LIGHT.ink})`, badgeColors: BADGE_COLORS.lightmode },
    },
  },
  {
    label: 'Line Art', file: 'lineart', atlas: 'Parts_lineart.png', opts: { wireColor: 'rgb(0,0,0)', cutout: atlas },
    title: 'Monocolor black.',
  },
];

// The atlases, the ones the page doesn't load anyway loaded the first time they're wanted.
const atlases = new Map([['Parts_color.png', atlas], ['Parts_contrast.png', blueprint]]);
function atlasOf(file) {
  if (file === 'Parts_lightmode.png') return loadLightmode().then(() => lightmode);   // (the stage's, on light paper)
  if (!atlases.has(file)) atlases.set(file, load(file).catch((err) => { atlases.delete(file); throw err; }));
  return atlases.get(file);
}

/** A look's picture of `view`, with a few px around it. */
async function picture(look, view) {
  const img = await atlasOf(look.atlas);
  if (look.shaded) return (await bakeShadedAsync(view, img, SHADING))?.canvas;
  const b = shipRenderBounds(view, look.opts);   // (at full size: parts drawn smaller fit inside)
  const s = PX_PER_UNIT, pad = 4;
  // The design origin on a whole pixel: sprites land on whole pixels, as in the atlas.
  const x = Math.ceil(pad - b.x0 * s), y = Math.ceil(pad - b.y0 * s);
  const canvas = makeCanvas(Math.ceil(x + b.x1 * s) + pad, Math.ceil(y + b.y1 * s) + pad);
  const g = canvas.getContext('2d');
  renderShip(g, view, img, { scale: s, x, y, snap: true, ...look.opts });
  return canvas;
}

async function download(look) {
  closeAllMenus();
  if (S.light && look.light) look = { ...look, atlas: look.light.atlas, opts: { ...look.opts, ...look.light.opts } };
  const { ship } = connected();
  if (!ship.parts.length) return toast('Nothing to render.');
  toast(`Rendering ${look.label.toLowerCase()}…`);
  try {
    const canvas = await picture(look, ship.view());
    if (!canvas) return toast('Nothing to render.');
    const blob = await new Promise((ok, err) => canvas.toBlob((b) => (b ? ok(b) : err(new Error('too big to save'))), 'image/png'));
    saveFile(blob, `${safeFileName(ship.name || 'ship')} (${look.file}).png`);
    toast(`Saved a ${canvas.width}×${canvas.height} render.`);
  } catch (err) {
    toast(`Couldn't render: ${err.message}.`);
  }
}

export const renderButton = $('render-button');
let renderMenu = null;
renderButton.onclick = () => {
  const wasOpen = renderMenu && menus.context[0] === renderMenu;
  closeAllMenus();
  renderMenu = null;
  if (wasOpen) return;
  const items = LOOKS.map((l) => ({ label: l.label, title: l.title, onClick: () => download(l) }));
  renderMenu = showMenu('context', 0, items, below(renderButton, true));
};
