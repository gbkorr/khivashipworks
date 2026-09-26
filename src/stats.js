// Ship statistics, reimplementing the game's telemetry routine (FUN_14007fcf0 / FUN_140071380 in
// Highfleet.exe 1.15; see decompilation/README.md) and the shipyard stats panel (FUN_1400d6f70).
import MODULES from '../data/modules.json' with { type: 'json' };

export const G = 9.82;                 // gravity used for thrust/weight
const DEFAULT_HEALTH = 100;            // Body health when m_health is absent
const EVAC_SEATS = 30;                 // crew seats per evac pod (logic 210)
const SENSOR_SECTORS = 70;             // two 35-degree arcs of the 360-entry m_sectors array

// Module category bits (m_category in Libraries/OL.seria)
export const CATEGORY = {
  FUEL: 0x1, ARMOR: 0x2, FSS: 0x4, EVAC: 0x8, AMMO: 0x10, GUN: 0x20, BRIDGE: 0x40, HULL: 0x80,
  ENGINE: 0x100, CRAFT: 0x400, SYSTEM: 0x800, LEG: 0x2000, MISSILE: 0x4000, SENSOR: 0x10000,
  IRST: 0x100000, BOMB: 0x200000, JAMMER: 0x400000,
  FLARES: 0x800000, KAZ: 0x2000000, DECK: 0x4000000, NUKE: 0x8000000,
};

// m_logic values the telemetry code tests for
const LOGIC = { MISSILE: 1, MISSILE_ALT: 0x84, WEAPON_3: 3, EVAC: 210, CRAFT: 500, ANTENNA_PART: 910 };

// AA value contributed by one gun of a given m_weapon_caliber
const AA_BY_CALIBER = { 5: 10, 10: 5, 15: 2, 20: 2, 25: 1, 30: 1, 40: 1, 52: 1 };

// m_spasmcode values marking which side an engine thrusts on
const SPASM_LEFT = 102, SPASM_RIGHT = 103;

// R-9 SPRINT, the short-range missile (counted for the panel; the game doesn't show it)
const SPRINT = 'MDL_MISSILE_03';
// The guided anti-missiles (R-5 ZENITH, R-6 NADIR, R-9 SPRINT): not counted as missiles
const INTERCEPTORS = new Set(['MDL_MISSILE_01', 'MDL_MISSILE_02', SPRINT]);
// Aircraft that count as large (the rest are small: LA-29)
const LARGE_CRAFT = new Set(['CRAFT_T7', 'CRAFT_MB110']);

const has = (m, bit) => ((m.category ?? 0) & bit) !== 0;

/** Classify a module into the six mass/price groups of the shipyard panel. */
export function moduleGroup(oid, logic, modules = MODULES) {
  const m = modules[oid] || {};
  const weapon =
    (m.weapon_caliber && m.weapon_load_amount) ||
    logic === LOGIC.MISSILE || logic === LOGIC.MISSILE_ALT || logic === LOGIC.WEAPON_3 ||
    logic === LOGIC.CRAFT ||
    has(m, CATEGORY.BOMB) || has(m, CATEGORY.FLARES) || has(m, CATEGORY.KAZ) ||
    has(m, CATEGORY.NUKE) ||
    (m.mdl_ammobox && !m.mdl_ammobox_need);
  if (weapon) return 'weapon';
  if (has(m, CATEGORY.FUEL)) return 'fuel';
  if (has(m, CATEGORY.ARMOR)) return 'armor';
  const system =
    m.mdl_thrust || m.mdl_power || m.mdl_radar || m.mdl_tracking || m.mdl_guiding || m.mdl_elint ||
    m.mdl_irst || m.mdl_jammer || m.mdl_fss_capacity || logic === LOGIC.EVAC;
  if (system) return 'systems';
  if (has(m, CATEGORY.HULL)) return 'hull';
  return 'misc';
}

/** Per-sector combination of the saved m_sectors arrays (max, or sum for jammers). */
function sensorRange(parts, key, sum = false) {
  const acc = new Float64Array(360);
  let nominal = 0;
  for (const p of parts) {
    const m = p.module;
    if (!m[key]) continue;
    nominal = sum ? nominal + m[key] : Math.max(nominal, m[key]);
    const sec = p.raw.m_sectors;
    if (!Array.isArray(sec) || sec.length !== 360) continue;
    for (let i = 0; i < 360; i++) acc[i] = sum ? acc[i] + sec[i] : Math.max(acc[i], sec[i]);
  }
  if (!nominal) return 0;
  let total = 0;
  for (let i = 0; i < 360; i++) total += acc[i];
  // Designs without saved sector data (never opened in the editor): assume unobstructed.
  return total ? total / SENSOR_SECTORS : nominal;
}

const aabb = (pts) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { w: x1 - x0, h: y1 - y0 };
};

function unionBoxes(boxes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0);
    x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

/** Frame children: rotated-mesh AABB size, centred on the body position. */
function frameChildBox(p) {
  const { w, h } = aabb(p.worldMesh());
  return { x0: p.x - w / 2, y0: p.y - h / 2, x1: p.x + w / 2, y1: p.y + h / 2 };
}

/** Top-level bodies: local (unrotated) mesh AABB size, centred on the world centre of mass. */
function topLevelBox(p) {
  const { w, h } = aabb(p.mesh);
  const c = Math.cos(p.angle), s = Math.sin(p.angle);
  const mx = p.raw['m_center.x'] ?? 0, my = p.raw['m_center.y'] ?? 0;
  const cx = p.x + mx * c - my * s, cy = p.y + mx * s + my * c;
  return { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
}

/**
 * Compute ship statistics.
 * @param ship    Ship (from Ship.fromSeria)
 * @param modules optional module table (defaults to bundled data/modules.json)
 */
export function computeStats(ship, modules = MODULES) {
  const parts = ship.parts.map((p) => Object.assign(p, { module: modules[p.oid] || {} }));
  const s = {
    mass: 0, price: 0, hp: 0,
    massBy: { weapon: 0, fuel: 0, armor: 0, systems: 0, hull: 0, misc: 0 },
    priceBy: { weapon: 0, fuel: 0, armor: 0, systems: 0, hull: 0, misc: 0 },
    firepower: { guns: 0, missiles: 0, bombs: 0, crafts: 0, total: 0 },
    thrust: { left: 0, right: 0, mapLeft: 0, mapRight: 0, atLeft: 0, atRight: 0 },
    fuelCapacity: 0, fuelNeed: 0,
    powerTotal: 0, powerNeed: 0,
    ammo: 0, ammoNeed: 0,
    crewCapacity: 0, crewNeed: 0,
    fss: 0, extinguishers: 0, sprints: 0, missiles: 0, interceptors: 0, aircraft: { small: 0, large: 0 }, evacPods: 0, signatureIR: 0, guidance: 0,
    fuelTotal: 0, aaValue: 0, antiMissileLaunchers: 0, crafts: 0, nukes: 0, nukesNuclear: 0,
    counts: {},
  };

  for (const p of parts) {
    const m = p.module;
    const logic = p.raw.m_logic;
    s.counts[p.oid] = (s.counts[p.oid] || 0) + 1;
    s.mass += p.mass;
    if (!modules[p.oid]) { s.massBy.misc += p.mass; continue; }
    s.hp += p.raw.m_health ?? DEFAULT_HEALTH;
    const price = m.price ?? 0;
    s.price += price;
    const g = moduleGroup(p.oid, logic, modules);
    s.massBy[g] += p.mass;
    s.priceBy[g] += price;

    // Thrust, split by side (m_spasmcode 102 = left, 103 = right).
    if (m.mdl_thrust) {
      const codes = p.raw.m_spasmcode || [];
      const side = codes.includes(SPASM_LEFT) ? 'Left' : codes.includes(SPASM_RIGHT) ? 'Right' : null;
      if (side) {
        s.thrust[side.toLowerCase()] += m.mdl_thrust;
        s.thrust['map' + side] += m.mdl_thrust_map ?? 0;
        s.thrust['at' + side] += m.mdl_at ?? 0;
      }
    }
    // Firepower
    if (m.weapon_caliber && m.weapon_load_amount) s.firepower.guns += 2 * (m.mdl_ammobox_need ?? 0);
    if (logic === LOGIC.MISSILE || logic === LOGIC.MISSILE_ALT) s.firepower.missiles += 1;
    if (has(m, CATEGORY.BOMB)) s.firepower.bombs += 1;
    if (logic === LOGIC.CRAFT) s.firepower.crafts += 1;

    if (m.mdl_fuel_capacity) {
      s.fuelCapacity += m.mdl_fuel_capacity;
      s.fuelTotal += p.raw.m_mdl_fuel ?? 0;          // fuel currently loaded in the tank
    } else if (m.mdl_fuel_need) s.fuelNeed += m.mdl_fuel_need;
    // AA value from gun calibre (FUN_140071380)
    if (m.weapon_caliber && m.weapon_load_amount) s.aaValue += AA_BY_CALIBER[m.weapon_caliber] ?? 0;
    if (logic === LOGIC.WEAPON_3) s.antiMissileLaunchers += 1;
    if (logic === LOGIC.CRAFT) {
      s.crafts += 1;
      s.aircraft[LARGE_CRAFT.has(p.oid) ? 'large' : 'small'] += 1;
    }
    if (INTERCEPTORS.has(p.oid)) s.interceptors += 1;
    else if (has(m, CATEGORY.MISSILE) || has(m, CATEGORY.NUKE)) s.missiles += 1;
    if (has(m, CATEGORY.NUKE)) {
      s.nukes += 1;
      if ((m.missile_explosive ?? 0) > 100000) s.nukesNuclear += 1;
    }
    if (m.mdl_power) s.powerTotal += m.mdl_power;
    else if (m.mdl_power_need) s.powerNeed += m.mdl_power_need;
    if (m.mdl_ammobox) s.ammo += m.mdl_ammobox;
    else if (m.mdl_ammobox_need) s.ammoNeed += m.mdl_ammobox_need;
    if (m.mdl_crew_capacity) s.crewCapacity += m.mdl_crew_capacity;
    if (m.mdl_crew_need) s.crewNeed += m.mdl_crew_need;
    if (m.mdl_fss_capacity) s.fss += m.mdl_fss_capacity;
    if (has(m, CATEGORY.FSS)) s.extinguishers += 1;
    if (p.oid === SPRINT) s.sprints += 1;
    if (m.mdl_guiding) s.guidance += m.mdl_guiding;
    if (m.signature_ir) s.signatureIR += m.signature_ir;
    if (logic === LOGIC.EVAC) s.evacPods += 1;
  }
  const fp = s.firepower;
  fp.total = fp.guns + fp.missiles + fp.bombs + fp.crafts;

  // Thrust / weight (both sides need thrust, otherwise 0).
  const weight = s.mass * G;
  const t = s.thrust;
  s.thrustTotal = t.mapLeft + t.mapRight;                           // N, cruise thrust
  s.twr = t.mapLeft > 0 && t.mapRight > 0 ? s.thrustTotal / weight : 0;
  s.twrFull = t.left > 0 && t.right > 0 ? (t.left + t.right) / weight : 0;
  // Cruise airspeed (m/s)
  s.airspeed = s.twr > 1 ? 50 * Math.sqrt(s.twr - 1) : 0;
  s.speedKmh = s.airspeed * 3.6;

  // Fuel
  s.rangeKm = s.fuelNeed && s.airspeed ? (s.fuelCapacity / s.fuelNeed) * s.airspeed / 1000 : 0;
  s.consumption = s.airspeed ? (s.fuelNeed * 1e6 / s.airspeed) / 1000 : 0;   // t per 1000 km
  s.combatTime = s.fuelNeed ? s.fuelCapacity / (s.fuelNeed * 50) : 0;        // s

  // Size & signatures
  // The RD signature is the area of the Frame's box (the hull). SIZE is that box united with the
  // boxes of the top-level bodies (legs, engines, guns...), excluding antenna segments.
  const frameParts = parts.filter((p) => p.inFrame);
  const frame = unionBoxes((frameParts.length ? frameParts : parts).map(frameChildBox));
  s.signatureRD = frame.w * frame.h;
  s.signature = Math.sqrt(s.signatureRD) / 3;
  const top = parts.filter((p) => !p.inFrame && p.raw.m_logic !== LOGIC.ANTENNA_PART);
  const all = unionBoxes([frame, ...top.map(topLevelBox)]);
  s.size = { w: all.w, h: all.h };
  s.sizeBox = { x0: all.x0, y0: all.y0, w: all.w, h: all.h };   // world coords of the SIZE box

  // Ship radius (m_tele_r): furthest extent of the Frame / top-level bodies from the size-box centre.
  // The game uses a lookup-table sqrt (resolution 0.1 m^2) for squared distances below 10000.
  const tsqrt = (d2) => (d2 >= 10000 ? Math.sqrt(d2) : Math.sqrt(Math.floor(d2 * 10) / 10));
  const cx = all.x0 + all.w / 2, cy = all.y0 + all.h / 2;
  let r = 0;
  if (frameParts.length) {
    const fx = frame.x0 + frame.w / 2, fy = frame.y0 + frame.h / 2;
    r = tsqrt((fx - cx) ** 2 + (fy - cy) ** 2) + Math.hypot(frame.w / 2, frame.h / 2);
  }
  for (const p of ship.bodies.filter((b) => !b.inFrame)) {
    const b = p.mesh.length ? topLevelBox(p) : { x0: p.x, x1: p.x, y0: p.y, y1: p.y };
    const bx = (b.x0 + b.x1) / 2, by = (b.y0 + b.y1) / 2;
    r = Math.max(r, tsqrt((bx - cx) ** 2 + (by - cy) ** 2) + Math.hypot((b.x1 - b.x0) / 2, (b.y1 - b.y0) / 2));
  }
  s.radius = r;
  s.irKm = (s.signatureIR / 35) * 300;
  s.rdKm = (s.signatureRD / 2500) * 500;
  const chance = (km) => {
    if (!s.airspeed) return 100;
    const x = ((km * 1000 - 1000) / s.airspeed - 900) / 1800;
    return (1 - Math.min(1, Math.max(0, x))) * 100;
  };
  s.irChance = chance(s.irKm);
  s.rdChance = chance(s.rdKm);

  // Sensors (km)
  s.radar = sensorRange(parts, 'mdl_radar');
  s.tracking = sensorRange(parts, 'mdl_tracking');
  s.elint = sensorRange(parts, 'mdl_elint');
  s.elintKm = s.elint * 750;
  s.irst = sensorRange(parts, 'mdl_irst');
  s.jammer = sensorRange(parts, 'mdl_jammer', true);

  s.evacSeats = s.evacPods * EVAC_SEATS;
  s.evacPodsNeed = Math.ceil(s.crewCapacity / EVAC_SEATS);   // pods to seat the whole crew
  s.partCount = parts.length;

  // AA value: guided anti-missile launchers count 8 each up to the guidance channels, 4 beyond.
  const guided = Math.min(s.antiMissileLaunchers, s.guidance);
  s.aaValue += 8 * guided + (s.guidance ? 4 * (s.antiMissileLaunchers - guided) : 0);

  // Combat value: active-protection (KAZ) modules add 2 per unit of ship radius.
  const kaz = parts.filter((p) => has(p.module, CATEGORY.KAZ)).length;
  s.combatValue = (fp.total + s.hp / 1000) * (1 + s.massBy.armor / s.mass + (kaz && r ? 2 * kaz / r : 0));

  s.roles = computeRoles(s);
  s.class = computeClass(s);
  return s;
}

// ---- Classification (FUN_14006f150 / FUN_1400712d0 / FUN_140070650, game version 1.16.3) ----

/** Mass classes, upper bounds in kg (inclusive). */
export const MASS_CLASSES = [
  [1e6, 'LIGHT_CORVET', 'LIGHT CORVETTE', 'LT CORVETTE'],
  [2e6, 'CORVET', 'CORVETTE', 'CORVETTE'],
  [3e6, 'HEAVY_CORVET', 'HEAVY CORVETTE', 'HV CORVETTE'],
  [5e6, 'FRIGATE', 'FRIGATE', 'FRIGATE'],
  [7e6, 'HEAVY_FRIGATE', 'HEAVY FRIGATE', 'HV FRIGATE'],
  [10e6, 'LIGHT_CRUISER', 'LIGHT CRUISER', 'LIGHT CRUISER'], // the game uses the long name as abbreviation too
  [20e6, 'CRUISER', 'CRUISER', 'CRUISER'],
  [Infinity, 'HEAVY_CRUISER', 'HEAVY CRUISER', 'HV CRUISER'],
];

export const PURPOSES = {
  1: ['ATTACK', 'ATTACK', 'ATTACK'],
  2: ['INTERCEPTOR', 'INTERCEPTOR', 'INTCP'],
  3: ['CARRIER', 'CARRIER', 'CARRIER'],
  4: ['STRATEGIC', 'STRATEGIC', 'STRAT'],
  5: ['AUXILIARY', 'AUXILIARY', 'AUX'],
};

/** Role ids in the game's order (ties resolve to the earliest), with their English labels. */
export const ROLES = [
  ['role_fighter', 'AIR SUPERIORITY SHIP'],
  ['role_bomber', 'STRIKE SHIP'],
  ['role_interceptor', 'INTERCEPTOR'],
  ['role_aa', 'AA DEFENCE SHIP'],
  ['role_sensor', 'EARLY WARNING SHIP'],
  ['role_tanker', 'TANKER'],
  ['role_carrier', 'AIRCRAFT CARRIER'],
  ['role_tactical', 'MISSILE CARRIER'],
  ['role_strategic', 'NUCLEAR MISSILE CARRIER'],
];

const round = (x) => Math.floor(x + 0.5);

/** Role values (integers) as shown on the new-game ship cards. */
export function computeRoles(s) {
  const v = {
    role_fighter: round((s.firepower.guns + s.firepower.missiles) * 0.25),
    role_bomber: round(s.firepower.bombs * 0.5),
    role_interceptor: round(s.airspeed / (1000 / 9)),               // 1 per 400 km/h
    role_aa: round(s.aaValue / 20),
    role_sensor: round((s.irst + s.radar + s.elint * 0.5) / 200),
    role_tanker: round(s.fuelCapacity / 512000),                     // 1 per 512 t of fuel
    role_carrier: s.crafts,
    role_tactical: (s.nukes - s.nukesNuclear) * 2,
    role_strategic: s.nukesNuclear * 2,
  };
  let best = ROLES[0][0];
  for (const [id] of ROLES) if (v[id] > v[best]) best = id;
  return { values: v, primary: best, primaryLabel: ROLES.find(([id]) => id === best)[1] };
}

/** Purpose code: 1 attack, 2 interceptor, 3 carrier, 4 strategic, 5 auxiliary. */
export function computePurpose(s) {
  const gunDensity = s.price ? (s.firepower.guns / s.price) * 1000 : 0;
  const loadedRangeKm = s.fuelNeed ? (s.fuelTotal / s.fuelNeed) * s.airspeed / 1000 : 0;
  let p = 1;
  if (loadedRangeKm > 2000 && gunDensity < 0.75) p = 5;
  if (s.radar !== 0 && gunDensity < 0.75) p = 5;
  if (s.airspeed > 125) p = 2;
  if (s.crafts !== 0) p = 3;
  if (s.nukes !== 0) p = 4;
  return p;
}

/** Ship class, e.g. { name: 'AUXILIARY LIGHT CRUISER', short: 'AUX LIGHT CRUISER', ... } */
export function computeClass(s) {
  if (s.airspeed === 0) {
    return { purpose: null, size: 'GROUND_VEHICLE', name: 'GROUND VEHICLE', short: 'GROUND VEH' };
  }
  const [, sizeId, sizeName, sizeAbr] = MASS_CLASSES.find(([max]) => s.mass <= max);
  const purpose = computePurpose(s);
  const [purposeId, purposeName, purposeAbr] = PURPOSES[purpose];
  return {
    purpose: purposeId, size: sizeId,
    name: `${purposeName} ${sizeName}`, short: `${purposeAbr} ${sizeAbr}`,
  };
}
