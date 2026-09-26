// Parser / serializer for HighFleet's text ".seria" format.
//
// Format summary (see decompilation/README.md):
//   {                      object start
//   key=value              scalar property
//   key=<code>             followed by "{" ... "}" => nested object stored under key
//   <number>               bare values (only inside Mesh: vertex coordinates)
//   }                      object end
// A key that appears several times in one object is a list (m_children, m_sprites...).

// Keys that are always lists, even when they occur only once.
const LIST_KEYS = new Set([
  'm_children', 'm_sprites', 'm_slots', 'm_sectors', 'm_spasmcode', 'm_joints',
  'm_stats', 'm_resources', 'm_layers', 'm_tiles',
]);

// 64-bit ids do not fit in a double; keep them as strings.
const isIdKey = (k) => /(^|_|\.)id$/.test(k);

function parseValue(key, raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (!isIdKey(key) && raw !== '' && /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(raw)) {
    return Number(raw);
  }
  return raw;
}

function decode(input) {
  if (typeof input === 'string') return input;
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  // The game writes a few Cyrillic strings in cp1251 (e.g. versionCompatibility).
  try {
    return new TextDecoder('windows-1251').decode(bytes);
  } catch {
    return new TextDecoder('latin1').decode(bytes);
  }
}

function addProp(obj, key, value) {
  if (LIST_KEYS.has(key)) {
    (obj[key] ||= []).push(value);
  } else if (Object.prototype.hasOwnProperty.call(obj, key)) {
    if (!Array.isArray(obj[key]) || !obj.__multi?.has(key)) {
      obj[key] = [obj[key]];
      (obj.__multi ||= new Set()).add(key);
    }
    obj[key].push(value);
  } else {
    obj[key] = value;
  }
}

/**
 * Parse seria text (string, ArrayBuffer or Uint8Array) into nested plain objects.
 * Mesh vertex lists are exposed as `points: [[x, y], ...]`.
 */
export function parseSeria(input) {
  const lines = decode(input).split(/\r?\n/);
  let i = 0;
  const next = () => lines[i++].trim();

  function readObject() {
    const obj = {};
    const bare = [];
    while (i < lines.length) {
      const line = next();
      if (line === '') continue;
      if (line === '}') break;
      if (line === '{') {
        // Anonymous nested object (not produced by the game, tolerate it).
        addProp(obj, '_anon', readObject());
        continue;
      }
      const eq = line.indexOf('=');
      if (eq < 0) {
        bare.push(Number(line));
        continue;
      }
      const key = line.slice(0, eq);
      // Values keep trailing spaces (card texts have them); only the line break goes.
      const raw = lines[i - 1].replace(/\r$/, '').trimStart().slice(eq + 1);
      // Peek: "key=code" followed by "{" means nested object.
      let j = i;
      while (j < lines.length && lines[j].trim() === '') j++;
      if (j < lines.length && lines[j].trim() === '{') {
        i = j + 1;
        addProp(obj, key, readObject());
      } else {
        addProp(obj, key, parseValue(key, raw));
      }
    }
    if (bare.length) {
      obj.points = [];
      for (let k = 0; k + 1 < bare.length; k += 2) obj.points.push([bare[k], bare[k + 1]]);
    }
    delete obj.__multi;
    return obj;
  }

  while (i < lines.length && lines[i].trim() !== '{') i++;
  i++;
  return readObject();
}

// Integer fields whose large values are printed in full.
const INT_KEYS = new Set(['m_code', 'm_meta', 'm_mesh_color', 'm_category']);

// Numbers as the game prints them: C's %g (6 significant digits, exponent below 1e-4 or from 1e6).
function fmt(v, key) {
  if (typeof v !== 'number') return String(v);
  if (Number.isInteger(v) && (Math.abs(v) < 1e6 || INT_KEYS.has(key))) return String(v);
  const r = Number(v.toPrecision(6));
  const e = Math.floor(Math.log10(Math.abs(r)));
  if (e >= -4 && e < 6) return String(r);
  const [m, x] = r.toExponential(5).split('e');
  return `${m.replace(/\.?0+$/, '')}e${x[0]}${x.slice(1).padStart(2, '0')}`;
}

// Nested objects that don't repeat their type code inside (the "key=<code>" line is not kept by the parser).
const CODES = { Mesh: 1073741827 };

/** Serialize an object produced by parseSeria back to seria text. */
export function serializeSeria(root) {
  const out = [];
  function write(obj) {
    out.push('{');
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'points') continue;
      const values = Array.isArray(value) ? value : [value];
      for (const v of values) {
        if (v && typeof v === 'object') {
          out.push(`${key}=${v.m_code ?? CODES[v.m_classname] ?? 0}`);
          write(v);
        } else {
          out.push(`${key}=${fmt(v, key)}`);
        }
      }
    }
    if (obj.points) for (const [x, y] of obj.points) out.push(fmt(x), fmt(y));
    out.push('}');
  }
  write(root);
  return out.join('\n') + '\n';
}

let cp1251;
/**
 * Serialize to the bytes the game writes: CRLF line endings, windows-1251 text (Cyrillic names).
 * Characters cp1251 can't represent become '?'.
 */
export function encodeSeria(root) {
  if (!cp1251) {
    cp1251 = new Map();
    const dec = new TextDecoder('windows-1251');
    for (let b = 0x80; b < 0x100; b++) cp1251.set(dec.decode(new Uint8Array([b])), b);
  }
  const text = serializeSeria(root).replace(/\n/g, '\r\n');
  const out = new Uint8Array(text.length);
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    out[n++] = c < 0x80 ? c : cp1251.get(ch) ?? 0x3f;
  }
  return out.subarray(0, n);
}
