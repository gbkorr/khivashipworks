```
index.html        the page's markup
style.css         its styles (the touch layout's at the end)
app/              the page
  main.js           entry point: starts the page once every module has loaded
  state.js          what the modules share: elements, camera, pointer, and S (the state that gets reassigned)
  assets.js         loads the images (sprite atlases, UI sprites, font sheets) and makes the paper texture
  edit.js           the design: undo, changes, picking parts up, carrying, dropping, turning, deleting
  view.js           drawing the stage (blueprint or shaded colour), overlays, the camera
  panels.js         stat card, stats and parts list, drawn when the input is idle; header name and flagship
  input.js          mouse and keyboard on the stage
  mobile.js         touch gestures and the phone/tablet layout
  tray.js           the parts library
  dialogs.js        toasts, and in-page confirm/prompt dialogs
  files.js          New, Open, paste, drag and drop, Download, folder downloads
  formats.js        manually-implemented .zip and PDF writers
  store.js          the saved designs: IndexedDB, and the game's designs file
  library.js        the Load and Gallery menus and what they do
  menus.js          cascading menus, and the stat card preview beside them
  gallery.js        stat cards of saved designs, and the gallery popup with its PDF export
  render.js         the Render menu: PNGs of the design (colour, tactical, blueprint, line drawing)
lib/              ship model, rules, stats and rendering (no DOM besides canvases)
  data.js           loads data/*.json
  seria.js          the game's .seria text format
  ship.js           a parsed design as a list of parts
  builder.js        the editable design: placement rules, snapping, links, .seria export
  hull.js           hull art and floors, as the game's editor sets them
  stats.js          the game's stats, roles, classes and sensor arcs
  render.js         sprite rendering
  shading.js        the game's lighting, cast shadows and colour grade
  paper.js          the stage's graph paper: the blueprint, or the light theme's
  partstyles.js     per-module drawing tweaks (data/part_styles.json)
  font.js           the game's bitmap fonts
  panel.js          the stats panel's lines
  parts.js          the parts list
  statcard.js       the stat card
  stamp.js          the code printed in a stat card's texture, and reading it back from an image
  emblem.js         the eagle and coin on the card
  sharecode.js      .shipcard: a design packed into a few hundred bytes (for stamps and storage)
  pack.js           .ships: a folder of .shipcards in one file
data/             game data extracted from HighFleet
assets/           game art: sprite atlases, UI sprites, font sheets
designs/          Highfleet.ships: the game's designs
```
