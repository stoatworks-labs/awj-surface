/*
 * Generate core/catalogue.json from a live LivePremier (or the simulator) —
 * or core/catalogue-mng.json from a Midra 4K / Alta 4K.
 *
 * Two sources are joined, because neither is sufficient alone:
 *
 *   GET /api/stores/device   the real tree. Gives exact node names, exact prop
 *                            names and a current value, but no ranges — a store
 *                            dump cannot tell you that opacity stops at 256.
 *   GET /app.<hash>.js       the Web RCS bundle, which carries the generator's
 *                            own `*_ATTRIBUTES` tables: min, max, default,
 *                            type, readOnly and the enum reference for every
 *                            property. This is where ranges come from.
 *
 * Nothing here is hand-written from documentation. If a range is in the output,
 * the device's own front-end bundle said so.
 *
 *   node tools/gen-catalogue.mjs [host] [> core/catalogue.json]
 *   node tools/gen-catalogue.mjs --bundle app.js --store store.json
 *
 * Defaults to 127.0.0.1:3000, i.e. the AW LivePremier Simulator. The file form
 * reads a bundle and a store already captured — the way a box read once, mid-
 * show, can be turned into a catalogue afterwards without going back to it.
 *
 * ## Two bundles, two spellings of the same tables
 *
 * LivePremier's bundle ships unminified: `const OPACITY_ATTRIBUTES = { PP: {
 * opacity: { min: 0, max: 256, type: 'int', ... } } }` and one
 * `const VAR_ENUMS = {...}` blob. Midra 4K / Alta 4K ship the same tables
 * minified: the name survives only in the module's export,
 * `n.d(t,"OPACITY_ATTRIBUTES",(function(){return i}))`, the object follows as
 * `const i={PP:{opacity:{min:0,max:256,type:"int",readOnly:!0,...}}}`, and
 * the enums are scattered as `NAME:{key:"NAME",items:{...},order:[...]}`.
 * Both are read; nothing about the output says which it came from except the
 * `platform` field.
 *
 * ## Two stores, two places for a layer
 *
 * LivePremier keeps a layer at `screenList/items/S1/presetList/items/A/
 * layerList/items/1` and the take group at `screenAuxGroupList/items/S1`.
 * Midra keeps them at `screenList/items/1/presetList/items/UP/liveLayerList/
 * items/1` and `transition/screenList/items/1`. Which layout the store has is
 * read off the store, never off a model name.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const BUNDLE_FILE = flag('--bundle');
const STORE_FILE = flag('--store');
const HOST = argv.find((a) => !a.startsWith('--') && a !== BUNDLE_FILE && a !== STORE_FILE) || '127.0.0.1:3000';
const base = HOST.startsWith('http') ? HOST : `http://${HOST}`;

/* ------------------------------------------------------------------ bundle */

/** Walk from the `{` at `i` to its matching `}`, respecting strings. */
function balanced(s, i) {
  let depth = 0, j = i, quote = null;
  while (j < s.length) {
    const c = s[j];
    if (quote) {
      if (c === '\\') { j += 2; continue; }
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return s.slice(i, j + 1);
    j++;
  }
  throw new Error('unbalanced brace');
}

/* The bundle is ~22 MB on one line in places. Regex over the whole thing is
   fine in V8; it is BSD grep that cannot cope. */
async function fetchBundle() {
  if (BUNDLE_FILE) {
    process.stderr.write(`bundle ${BUNDLE_FILE}\n`);
    return readFileSync(BUNDLE_FILE, 'utf8');
  }
  const index = await (await fetch(`${base}/`)).text();
  const m = index.match(/\/app\.[0-9a-f]+\.js/);
  if (!m) throw new Error('no app.<hash>.js in index.html');
  process.stderr.write(`bundle ${m[0]}\n`);
  return (await (await fetch(base + m[0]))).text();
}

/*
 * Every `const NAME_ATTRIBUTES = {...}` in the bundle, as raw source.
 *
 * Names are NOT unique: the bundle carries several distinct `SOURCE_ATTRIBUTES`
 * for the different `source` nodes in the model, and webpack concatenates them
 * all. Keeping only the last one silently attributes an input's `source` table
 * to a layer's. So every table is kept, and the right one is chosen later by
 * matching its property names against the node's — see `chooseTable`.
 */
function attributeTables(js) {
  const out = new Map();
  const add = (name, src) => {
    if (!out.has(name)) out.set(name, []);
    out.get(name).push(src);
  };
  for (const m of js.matchAll(/const ([A-Z0-9_]+)_ATTRIBUTES\s*=\s*\{/g)) {
    const open = js.indexOf('{', m.index + m[0].length - 1);
    add(m[1], balanced(js, open));
  }
  /*
   * The minified shape. The table's name is in the export declaration and its
   * object is bound to a one-letter local somewhere after it in the same
   * module, so the local's first `{PP:` object after the export is the table.
   * Modules export several tables at once (`n.d(t,"A_ATTRIBUTES",…)n.d(t,
   * "B_ATTRIBUTES",…)` then `const i={…},o={…}`), which is why the search is
   * for the named local and not for the next object literal.
   */
  for (const m of js.matchAll(/n\.d\(t,"([A-Z0-9_]+)_ATTRIBUTES",\(function\(\)\{return (\w+)\}\)\)/g)) {
    const local = m[2];
    const decl = new RegExp(`(?:const|let|var|,)\\s*${local}=\\{`, 'g');
    decl.lastIndex = m.index;
    let d;
    while ((d = decl.exec(js))) {
      const open = js.indexOf('{', d.index + d[0].length - 1);
      const body = balanced(js, open);
      if (body.includes('PP:')) { add(m[1], body); break; }
      /* Some other `i={…}` in between; keep looking, but not for ever. */
      if (d.index - m.index > 200000) break;
    }
  }
  return out;
}

/** The generated VAR_ENUMS blob: every enum's members, in device order. */
function varEnums(js) {
  const at = js.indexOf('const VAR_ENUMS={');
  /* Unminified: one blob. Minified: the same `NAME:{key:"NAME",…}` entries,
     double-quoted, spread through the bundle — so the scan is the same, over
     the whole file, and the key having to equal the name is what keeps it
     from picking up anything that merely looks like one. */
  const body = at >= 0 ? balanced(js, js.indexOf('{', at)) : js;
  const out = {};
  for (const m of body.matchAll(/([A-Z][A-Z0-9_]*):\{key:['"]([A-Z0-9_]+)['"]/g)) {
    if (m[1] !== m[2]) continue;
    const sub = balanced(body, body.indexOf('{', m.index));
    const order = sub.match(/order:\[([^\]]*)\]/);
    /* Prefer the explicit `order` array: it is the device's own ordering, and
       it quotes members that are not valid identifiers (PE_ASPECTOUT's '1_1'),
       which a bare key scan would drop. */
    out[m[2]] = order
      ? order[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
      : [...sub.matchAll(/['"]?([A-Za-z0-9_]+)['"]?:['"]([^'"]*)['"]/g)].map((x) => x[2]);
  }
  if (Object.keys(out).length === 0) throw new Error('no enums found in the bundle');
  return out;
}

/*
 * Parse one property's descriptor out of an attributes table.
 *
 * The tables are real JavaScript, not JSON: enum bounds are webpack-mangled
 * member expressions like `_do_vars_var_enums__WEBPACK_IMPORTED_MODULE_0__
 * /* .VAR_ENUMS *\/ .J.ANCHOR.items.MIDDLE_CENTER`. Rather than evaluate that,
 * the enum NAME is pulled out by pattern and resolved against VAR_ENUMS.
 */
function parseProps(src) {
  const props = {};
  /* Top-level keys of the PP object only. */
  const ppAt = src.indexOf('PP:');
  if (ppAt < 0) return props;
  const pp = balanced(src, src.indexOf('{', ppAt));
  let i = 1;
  while (i < pp.length) {
    const m = /(?:^|[,{])\s*(\w+):\s*\{/.exec(pp.slice(i - 1));
    if (!m) break;
    const nameAt = i - 1 + m.index;
    const open = pp.indexOf('{', nameAt + m[0].length - 1);
    const body = balanced(pp, open);
    const d = { name: m[1] };
    /* The minifier writes 3000 as `3e3` and a billion as `1e9`; reading the
       mantissa alone gave takeTime a maximum of 3. */
    const num = (k) => {
      const r = new RegExp(`\\b${k}:\\s*(-?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)\\b`).exec(body);
      return r ? Number(r[1]) : undefined;
    };
    d.type = (/\btype:\s*['"](\w+)['"]/.exec(body) || [])[1];
    d.subType = (/\bsubType:\s*['"](\w+)['"]/.exec(body) || [])[1];
    /* `true` in the unminified bundle, `!0` in the minified one. */
    d.readOnly = /\breadOnly:\s*(?:true|!0)\b/.test(body);
    d.min = num('min');
    d.max = num('max');
    d.def = num('def');
    d.capacity = num('capacity');
    const en = /enum:\s*[^,]*?\.([A-Z][A-Z0-9_]*)\s*,/.exec(body);
    if (en) d.enum = en[1];
    if (d.type === 'enum' || d.subType === 'enum') {
      /* Enum bounds are member expressions, so min/max came back undefined.
         Recover the member NAMES; the resolver turns them into indices. */
      const b = /min:\s*[^,]*?\.items\.([A-Z0-9_]+)/.exec(body);
      const t = /max:\s*[^,]*?\.items\.([A-Z0-9_]+)/.exec(body);
      const f = /def:\s*[^,]*?\.items\.([A-Z0-9_]+)/.exec(body);
      if (b) d.minMember = b[1];
      if (t) d.maxMember = t[1];
      if (f) d.defMember = f[1];
      delete d.min; delete d.max; delete d.def;
    }
    for (const k of Object.keys(d)) if (d[k] === undefined) delete d[k];
    props[m[1]] = d;
    i = open + body.length + 1;
  }
  return props;
}

/* Node name in the store -> attributes table name in the bundle. The rule is
   SCREAMING_SNAKE of the camelCase node name; only the irregulars are listed. */
const TABLE_OVERRIDES = { cutNFill: 'CUT_N_FILL', stereo3d: 'STEREO3D' };
const tableName = (node) =>
  TABLE_OVERRIDES[node] || node.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();

const sameKeys = (a, b) =>
  a.length === b.length && a.every((k) => b.includes(k));

/*
 * Pick the attributes table describing this node.
 *
 * The node's own name is only a hint. What actually identifies a table is its
 * set of property names, so the name is used to narrow the candidates and the
 * signature decides. Several nodes are structurally identical to a sibling and
 * carry no table of their own — a layer's `border/shadow` is described by
 * EDGE_ATTRIBUTES, `timing/opening` and `timing/closing` share one table — and
 * those resolve through the whole-bundle signature search.
 *
 * Returns null rather than guessing when nothing matches exactly, which leaves
 * the property marked `inferred` in the output instead of giving it a range
 * that was never stated.
 */
function chooseTable(node, propNames, tables) {
  const named = tables.get(tableName(node)) || [];
  for (const src of named) {
    if (sameKeys(propNames, Object.keys(parseProps(src)))) return src;
  }
  let hit = null, count = 0;
  for (const list of tables.values()) {
    for (const src of list) {
      if (sameKeys(propNames, Object.keys(parseProps(src)))) { hit = src; count++; }
    }
  }
  /* Several tables with the same signature cannot be told apart from here, and
     picking one at random would be worse than reporting no range at all. */
  return count === 1 ? hit : null;
}

/* ------------------------------------------------------------------- store */

/**
 * Walk a real object from the store into flat parameter descriptors.
 *
 * `pp` is the property bag; every other object key is a child node. The child
 * node's name is what selects the attributes table, which is why this walks the
 * store rather than the bundle's module list — the store is the thing whose
 * spelling the wire actually uses.
 */
function walk(node, tables, enums, trail = [], out = []) {
  for (const [k, v] of Object.entries(node)) {
    if (k === 'pp') {
      const table = chooseTable(trail[trail.length - 1] ?? '', Object.keys(v), tables);
      const attrs = table ? parseProps(table) : {};
      for (const [prop, value] of Object.entries(v)) {
        const a = attrs[prop] || {};
        const members = a.enum ? enums[a.enum] : undefined;
        const p = {
          id: [...trail, prop].join('.'),
          path: [...trail, 'pp', prop],
          type: a.type || (typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? 'int' : 'string'),
          readOnly: !!a.readOnly
        };
        if (a.subType) p.subType = a.subType;
        if (a.capacity) p.capacity = a.capacity;
        if (members) {
          p.enum = a.enum;
          p.values = members;
          if (a.minMember || a.maxMember) {
            const lo = members.indexOf(a.minMember ?? members[0]);
            const hi = members.indexOf(a.maxMember ?? members[members.length - 1]);
            if (lo >= 0 && hi >= lo) p.values = members.slice(lo, hi + 1);
          }
          if (a.defMember) p.def = a.defMember;
        } else {
          if (a.min !== undefined) p.min = a.min;
          if (a.max !== undefined) p.max = a.max;
          if (a.def !== undefined) p.def = a.def;
        }
        if (!a.type) p.inferred = true;
        out.push(p);
      }
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      walk(v, tables, enums, [...trail, k], out);
    }
  }
  return out;
}

/* -------------------------------------------------------------------- main */

const js = await fetchBundle();
const tables = attributeTables(js);
const enums = varEnums(js);
process.stderr.write(`${[...tables.values()].reduce((n, l) => n + l.length, 0)} attribute tables, ${Object.keys(enums).length} enums\n`);

let store;
if (STORE_FILE) {
  process.stderr.write(`store ${STORE_FILE}\n`);
  store = JSON.parse(readFileSync(STORE_FILE, 'utf8')).device;
} else {
  process.stderr.write('fetching /api/stores/device (can be >100 MB)\n');
  store = (await (await fetch(`${base}/api/stores/device`)).json()).device;
}

/*
 * Which layout this store has, read off the store.
 *
 * `screenAuxGroupList` exists on LivePremier and nowhere else; `transition/
 * screenList` is Midra's and Alta's. The first screen in each list is the
 * template — its layers all have the same shape — and the take group is
 * whatever that platform calls the node with `xTake` in it.
 */
let layout;
if (store.screenAuxGroupList) {
  const screen = store.screenList.items.S1;
  const presetKey = Object.keys(screen.presetList.items)[0];
  layout = {
    platform: 'livepremier',
    device: store.system?.deviceList?.items?.['1']?.pp?.dev ?? null,
    firmware: store.system?.deviceList?.items?.['1']?.pp?.updater ?? null,
    presetKeys: Object.keys(screen.presetList.items),
    layerKeys: Object.keys(screen.presetList.items[presetKey].layerList.items).slice(0, 4).concat('…'),
    layer: screen.presetList.items[presetKey].layerList.items['1'],
    /* The store spelling of where a layer and the take group live, relative to
       a destination, so a consumer can address them without knowing the
       platform by name. */
    layerRoot: ['presetList', 'items', '<preset>', 'layerList', 'items', '<layer>'],
    groupRoot: ['screenAuxGroupList', 'items', '<destination>'],
    group: store.screenAuxGroupList.items.S1
  };
} else if (store.transition?.screenList) {
  const screen = store.screenList.items['1'];
  const presetKey = Object.keys(screen.presetList.items)[0];
  layout = {
    platform: 'midra',
    device: store.system?.pp?.dev ?? null,
    firmware: store.system?.version?.pp?.updater ?? null,
    presetKeys: Object.keys(screen.presetList.items),
    layerKeys: Object.keys(screen.presetList.items[presetKey].liveLayerList.items),
    layer: screen.presetList.items[presetKey].liveLayerList.items['1'],
    layerRoot: ['presetList', 'items', '<preset>', 'liveLayerList', 'items', '<layer>'],
    groupRoot: ['transition', 'screenList', 'items', '<destination>'],
    group: store.transition.screenList.items['1']
  };
} else {
  throw new Error('this store has neither screenAuxGroupList nor transition/screenList — not a Web RCS store this tool knows');
}

const catalogue = {
  generatedFrom: STORE_FILE ? `file:${STORE_FILE}` : base,
  platform: layout.platform,
  device: layout.device,
  firmware: layout.firmware,
  presetKeys: layout.presetKeys,
  layerKeys: layout.layerKeys,
  layerRoot: layout.layerRoot,
  groupRoot: layout.groupRoot,
  layer: walk(layout.layer, tables, enums),
  screenGroup: walk(layout.group, tables, enums),
  enums: {}
};
for (const p of catalogue.layer.concat(catalogue.screenGroup)) {
  if (p.enum && !catalogue.enums[p.enum]) catalogue.enums[p.enum] = enums[p.enum];
}

const json = JSON.stringify(catalogue, null, 2);
if (process.env.OUT) writeFileSync(process.env.OUT, json + '\n');
else process.stdout.write(json + '\n');
process.stderr.write(`layer params: ${catalogue.layer.length}, screen group: ${catalogue.screenGroup.length}\n`);
