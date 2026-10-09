// The game data (data/*.json, extracted from the game by highfleetjs/tools/extract.mjs), fetched once when the page
// loads: FONTS (glyph tables), MODULES (per-module values), STYLES (part_styles.json), TEMPLATES (part_templates.json:
// the parts the builder places), SPRITES (atlas sprite rects), STRINGS (English names and labels), UI (UI sprite rects).
const load = (name) => fetch(new URL(`../data/${name}.json`, import.meta.url)).then((r) => {
  if (!r.ok) throw new Error(`data/${name}.json: ${r.status} ${r.statusText}`);
  return r.json();
});

export const [FONTS, MODULES, STYLES, TEMPLATES, SPRITES, STRINGS, UI] = await Promise.all(
  ['fonts', 'modules', 'part_styles', 'part_templates', 'sprites', 'strings', 'ui'].map(load));
