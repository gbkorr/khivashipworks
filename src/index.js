// highfleetjs — parse, render and evaluate HighFleet ship designs (.seria).
export { parseSeria, serializeSeria, encodeSeria } from './seria.js';
export { Ship, Part } from './ship.js';
export {
  computeStats, computeRoles, computeClass, computePurpose, moduleGroup,
  CATEGORY, MASS_CLASSES, PURPOSES, ROLES, G,
} from './stats.js';
export { shadePixels, lightPixels, gradePixels, gradeColor, bakeShaded, bakeShadedAsync, SHADING } from './shading.js';
export { renderShip, drawList, frameRect, wireSegments, shipRenderBounds, PX_PER_UNIT } from './render.js';
export {
  PART_STYLES, PART_SCALE, PART_FRAMES, spriteAttributes, moduleAttributes, spriteBlueprintStyle, partScales,
  partFrames, tintColor,
} from './partstyles.js';
export {
  renderBlueprint, blueprintLayout, blueprintAtlas, blueprintPixels, drawGraphPaper, paperLayers, paperTexture, gridOrigin,
  BLUEPRINT, CELL,
} from './blueprint.js';
export { renderPanel, statLines, panelHeight, PANEL } from './panel.js';
export { drawText, measureText, FONTS } from './font.js';
export { renderCard, cardLayout, cardSize, renderSheet, sheetLayout } from './card.js';
export {
  partsList, partsListHeight, renderPartsList, renderRolesList, rolesListHeight, PART_SECTIONS, PARTS,
  renderRuledList, ruledListLines, RULED,
} from './parts.js';
export {
  renderShipCard, renderShipInfo, renderShipPreview, previewLayout, shipInfoLayout,
  cardText, mainModules, sortedRoles, className, shipPicture, outlineImage, CARD, CARD_BACKGROUND,
} from './shipcard.js';
export { renderStatCard, statCardLines, statCardSize, shadedPicture } from './statcard.js';
export {
  encodeDesign, decodeDesign, deflate, inflate, OIDS, embedSeria, designFromCard, SERIA_CHUNK,
} from './sharecode.js';
export { addChunk, readChunk } from './pngchunk.js';
export { drawStamp, readStamp, stampCells, stampCapacity, STAMP } from './stamp.js';
export {
  BuildModel, BuildPart, PART_TEMPLATES, BRIDGE, GRID, EXTRA_RULES, computeLinks, dependents, overlaps, canPlace, placement,
  snapOffset, rotateParts, normAngle,
} from './builder.js';
export { filledHull } from './hull.js';
