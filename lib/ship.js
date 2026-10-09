// Ship model: flattens a parsed .seria design into a list of parts (Bodies).

const IDENTITY = { x: 0, y: 0, angle: 0, stage: 0 };

/**
 * Collect every Body in the tree together with its parent transform.
 * Children of a Frame are stored in the Frame's local coordinates, so the Frame's
 * m_position / m_angle must be applied to them (top-level Bodies are in world space).
 */
function collectBodies(node, parent = IDENTITY, out = []) {
  if (node.m_classname === 'Body') out.push({ body: node, parent });
  let xf = parent;
  if (node.m_classname === 'Body') xf = { ...parent, stage: parent.stage + (node.m_stage ?? 0) };
  if (node.m_classname === 'Frame') {
    const c = Math.cos(parent.angle), s = Math.sin(parent.angle);
    const lx = node['m_position.x'] ?? 0, ly = node['m_position.y'] ?? 0;
    xf = {
      x: parent.x + lx * c - ly * s,
      y: parent.y + lx * s + ly * c,
      angle: parent.angle + (node.m_angle ?? 0),
      stage: parent.stage + (node.m_stage ?? 0),
    };
  }
  for (const c of node.m_children || []) collectBodies(c, xf, out);
  return out;
}

function findCreature(node) {
  if (node.m_classname === 'Creature') return node;
  for (const c of node.m_children || []) {
    const r = findCreature(c);
    if (r) return r;
  }
  return null;
}

/** Polygon area (shoelace). */
function polyArea(points) {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

export class Part {
  constructor(body, parent = IDENTITY) {
    this.raw = body;
    this.oid = body.m_oid ?? null;
    this.name = body.m_name ?? '';
    const lx = body['m_position.x'] ?? 0, ly = body['m_position.y'] ?? 0;
    const c = Math.cos(parent.angle), s = Math.sin(parent.angle);
    this.x = parent.x + lx * c - ly * s;
    this.y = parent.y + lx * s + ly * c;
    this.angle = parent.angle + (body.m_angle ?? 0);
    this.scaleX = body['m_scale.x'] ?? 1;
    this.scaleY = body['m_scale.y'] ?? 1;
    this.inFrame = parent !== IDENTITY;
    this.stage = body.m_stage ?? 0;
    /** Stage of the enclosing Frame / Bodies, added to this body's when drawing. */
    this.baseStage = parent.stage ?? 0;
    /** Height level (m_floor): hull raised by its neighbours, and what is mounted on it (see hull.js). */
    this.floor = body.m_floor ?? 0;
    this.mesh = body.m_mesh?.points ?? [];
    this.mass = body.m_mass ?? (body.m_density ?? 0) * polyArea(this.mesh);
    this.sprites = (body.m_sprites || []).map((s) => ({
      name: s.m_animation_name,
      stage: s.m_stage ?? 0,
      x: s['m_position.x'] ?? 0,
      y: s['m_position.y'] ?? 0,
      angle: s.m_angle ?? 0,
      sx: s['m_scale.x'] ?? 1,
      sy: s['m_scale.y'] ?? 1,
      frame: s.m_frame ?? 0,
      type: s.m_type ?? 0,
      /** Self-lit share (m_ambient): 1 = no lighting, shadows or stage shading (the bridge's emblem). */
      ambient: s.m_ambient ?? 0,
    }));
  }

  /** Mesh vertices in world coordinates. */
  worldMesh() {
    const c = Math.cos(this.angle), s = Math.sin(this.angle);
    return this.mesh.map(([x, y]) => [this.x + x * c - y * s, this.y + x * s + y * c]);
  }
}

export class Ship {
  /** @param {object} root parsed seria root (from parseSeria) */
  constructor(root) {
    this.raw = root;
    /** Every Body in the design, including helper bodies without a module (antenna segments...). */
    this.bodies = collectBodies(root).map(({ body, parent }) => new Part(body, parent));
    /** Bodies that are ship modules (have an m_oid). */
    this.parts = this.bodies.filter((p) => p.oid);
    this.creature = findCreature(root);
    this.name = this.creature?.m_ship_name ?? root.m_name ?? '';
  }
}
