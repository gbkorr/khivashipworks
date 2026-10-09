// The images the page draws with, loaded before anything else runs: the game's sprite atlas (Parts_color), the same
// drawn as a blueprint (Parts_contrast: highfleetjs/tools/blueprint.mjs --contrast), the UI sprites and the font glyph
// sheets. And the paper. (The light paper's blueprint, Parts_lightmode, is loaded once it's first wanted; the other
// atlases, Parts_blueprint and Parts_lineart, are only for the Render menu: render.js loads them when they're wanted.)
import { FONTS } from '../lib/data.js';
import { paperTexture } from '../lib/paper.js';

export const load = (path) => new Promise((ok, err) => {
  const img = new Image();
  img.onload = () => ok(img);
  img.onerror = () => err(new Error(`Couldn't load assets/${path}`));
  img.src = new URL(`../assets/${path}`, import.meta.url).href;
});
const fontNames = Object.keys(FONTS);
const images = await Promise.all([
  load('Parts_color.png'), load('Parts_contrast.png'), load('ui.png'), ...fontNames.map((n) => load(`fonts/${n}.png`)),
]).catch((err) => {
  document.getElementById('toast').textContent = `${err.message}: the page can't start.`;
  document.getElementById('toast').classList.add('show');
  throw err;
});
export const [atlas, blueprint, ui] = images;
export const fonts = Object.fromEntries(fontNames.map((n, i) => [n, images[3 + i]]));

// The blueprint for light paper (Parts_contrast recoloured: highfleetjs/tools/lightmode.py): null until it's loaded,
// with the rest if the page opens on light paper (index.html set html.light), else on the first switch to it.
export let lightmode = null;
let lightmodeLoad = null;
export const loadLightmode = () => (lightmodeLoad ??= load('Parts_lightmode.png').then((img) => { lightmode = img; }));
if (document.documentElement.classList.contains('light')) await loadLightmode().catch(() => {});

// Paper texture (grain, fibres, formation) laid over the graph paper; a fainter one (another sheet) on the
// panels around it, as CSS background tiles.
export const paper = paperTexture();
{
  const [formation, grain] = paperTexture({ seed: 5, strength: 0.6 });
  document.documentElement.style.setProperty('--grain', `url(${grain.image.toDataURL()})`);
  document.documentElement.style.setProperty('--formation', `url(${formation.image.toDataURL()})`);
}
