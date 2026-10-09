// The shipyard stats panel's lines (after FUN_1400d6f70 in Highfleet.exe): label / value rows, warnings in red.

const i = Math.trunc;
const pct = (part, total) => (total ? i((part / total) * 100) : 0);

/**
 * The panel as data: { rows: [{ label, value, red }] } (label '' = blank spacer row). Power, ammo, crew and evac
 * pods read "have/need (p%)".
 */
export function statLines(s) {
  const rows = [];
  const row = (label, value, red = false) => rows.push({ label, value, red });
  /** "have/need (p%)" (p: have over need). */
  const need = (have, needed, unit = '') => `${i(have)}/${i(needed)}${unit} (${needed ? i((have / needed) * 100) : 100}%)`;
  const canFly = s.twr >= 1;
  row('THRUST/WEIGHT', canFly ? s.twr.toFixed(1) : 'LOW THRUST!', !canFly);
  row('CRUISE SPEED', canFly ? `${i(s.speedKmh)} km/h` : 'LOW THRUST!', !canFly);
  if (s.fuelCapacity > 0) {
    row('RANGE', `${i(s.rangeKm)} km`);
    row('CONSUMPTION', `${i(s.consumption)} t per 1000 km`);
  } else {
    row('RANGE', 'NO FUEL!', true);
    row('CONSUMPTION', 'NO FUEL!', true);
  }
  const fp = s.firepower.total;
  row('FIREPOWER', fp > 0 ? `${i(fp)}` : 'ARMLESS', !(fp > 0));

  const groups = [['WEAPON', 'weapon'], ['FUEL', 'fuel'], ['ARMOR', 'armor'], ['SYSTEMS', 'systems'], ['HULL', 'hull'], ['MISC', 'misc']];
  row('PARTS', `${s.partCount}`);
  row('SIZE', `${i(s.size.w)}x${i(s.size.h)} m`);
  row('MASS', `${i(s.mass / 1000)} t`);
  for (const [name, key] of groups) {
    const v = key === 'fuel'
      ? `${pct(s.massBy.fuel, s.mass)} % (${i(s.fuelCapacity / 1000)} t)`
      : `${pct(s.massBy[key], s.mass)} %`;
    row(`    - ${name}`, v);
  }
  row('THRUST', `${i(s.thrustTotal / 1e6)} MN`);
  row('COMBAT TIME', `${i(s.combatTime)} sec`);
  row('POWER', need(s.powerTotal / 1000, s.powerNeed / 1000, ' MW'), s.powerNeed > s.powerTotal);
  row('AMMO', need(s.ammo, s.ammoNeed), s.ammoNeed > s.ammo);
  row('IR SIGN', `${i(s.irKm)} km CHANCE ${i(s.irChance)}`);
  row('RD SIGN', `${i(s.rdKm)} km CHANCE ${i(s.rdChance)}`);
  if (s.radar) row('RADAR', `${i(s.radar)} km`);
  if (s.tracking) row('TRACKING', `${i(s.tracking)} km`);
  if (s.guidance) row('GUIDANCE', `${i(s.guidance)}`);
  if (s.elint) row('ELINT', `${i(s.elintKm)} km`);
  if (s.irst) row('IRST', `${i(s.irst)} km`);
  if (s.jammer) row('JAMMER', `${i(s.jammer)} km`);
  row('CREW', need(s.crewCapacity, s.crewNeed), s.crewNeed > s.crewCapacity);
  if (s.crewCapacity) row('EVAC PODS', need(s.evacPods, s.evacPodsNeed), s.evacPods < s.evacPodsNeed);
  // Not in the game's panel.
  row('FSS', `${s.extinguishers}`);
  if (s.sprints) row('SPRINTS', `${s.sprints}`);
  row('', '');
  row('PRICE', `${i(s.price)}`);
  for (const [name, key] of groups) row(`    - ${name}`, `${pct(s.priceBy[key], s.price)} %`);
  row('COMBAT VALUE', `${i(s.combatValue)}`);
  return { rows };
}
