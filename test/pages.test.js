/*
 * Pages: three wheels that drive position, then size, then crop.
 *
 * Shift gives a control two meanings; a page gives a whole surface as many as
 * the profile lists. The LivePremier Plus desk (lpp-surface-p1) is the reason
 * they exist, so its profile is checked here too: its numbers are the contract
 * with a controller that has not been built yet.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Engine } from '../core/engine.js';
import { MidiSurface } from '../core/surface.js';
import { validate } from '../core/profile.js';
import { layerParam } from '../core/paths.js';
import { FakeStore, deviceFixture, collect, settle } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const p1 = JSON.parse(readFileSync(join(here, '..', 'profiles', 'lpp-surface-p1.json'), 'utf8'));

const paged = {
  id: 'paged',
  stripCount: 8,
  pages: [{ id: 'position', label: 'Position' }, { id: 'size', label: 'Size' }],
  controls: [
    { id: 'cc:0:20', kind: 'encoder', relative: 'twos', accelerate: false },
    { id: 'cc:0:16', kind: 'encoder', relative: 'twos', accelerate: false },
    { id: 'note:0:1', kind: 'button' },
    { id: 'note:0:2', kind: 'button' }
  ],
  bindings: [
    { control: 'cc:0:20', page: 'position', target: { kind: 'layer', layer: '@selected', preset: 'PREVIEW', param: 'position.posH' }, options: { min: -1920, max: 3840, step: 1 } },
    { control: 'cc:0:20', page: 'size', target: { kind: 'layer', layer: '@selected', preset: 'PREVIEW', param: 'position.sizeH' }, options: { min: 0, max: 3840, step: 1 } },
    { control: 'cc:0:16', target: { kind: 'layer', layer: '@selected', preset: 'PREVIEW', param: 'opacity.opacity' } },
    { control: 'note:0:1', target: { kind: 'action', action: 'page', value: 'size' } },
    { control: 'note:0:2', target: { kind: 'action', action: 'page', delta: 1 } }
  ]
};

function rig(profile = paged) {
  const store = new FakeStore(deviceFixture());
  const engine = new Engine(store, profile, { coalesceMs: 5 });
  const writes = [];
  engine.addEventListener('write', (e) => writes.push(...e.detail.writes));
  return { store, engine, writes };
}

test('a profile without pages behaves as it always did', () => {
  const { engine } = rig({ ...paged, pages: undefined, bindings: paged.bindings.slice(2, 3) });
  assert.equal(engine.selection.page, null);
  assert.equal(engine.armed(engine.profile.bindings[0]), true);
});

test('the first page is chosen to start with', () => {
  const { engine } = rig();
  assert.equal(engine.selection.page, 'position');
});

test('a paged binding is live only on its page; an unpaged one on every page', async () => {
  const { engine, writes } = rig();
  engine.input({ control: 'cc:0:20', kind: 'relative', delta: 10 });
  engine.input({ control: 'cc:0:16', kind: 'relative', delta: -6 });
  await settle();
  assert.deepEqual(writes.map((w) => [w.path.slice(-1)[0], w.value]).sort(),
    [['opacity', 250], ['posH', 970]]);

  writes.length = 0;
  engine.input({ control: 'note:0:1', kind: 'button', down: true });
  engine.input({ control: 'cc:0:20', kind: 'relative', delta: 10 });
  engine.input({ control: 'cc:0:16', kind: 'relative', delta: -6 });
  await settle();
  assert.deepEqual(writes.map((w) => [w.path.slice(-1)[0], w.value]).sort(),
    [['opacity', 250], ['sizeH', 1930]]);
});

test('a page button with a delta steps through the pages and wraps', () => {
  const { engine } = rig();
  engine.input({ control: 'note:0:2', kind: 'button', down: true });
  assert.equal(engine.selection.page, 'size');
  engine.input({ control: 'note:0:2', kind: 'button', down: true });
  assert.equal(engine.selection.page, 'position');
});

test('a host chooses a page with showPage, and a page nobody declared is refused', () => {
  const { engine } = rig();
  const selections = collect(engine, 'selection');
  const unresolved = collect(engine, 'unresolved');
  engine.showPage('size');
  assert.equal(engine.selection.page, 'size');
  assert.equal(selections.length, 1);
  engine.showPage('crop');
  assert.equal(engine.selection.page, 'size');
  assert.match(unresolved[0].reason, /no page crop/);
});

test('only the page in view is displayed', () => {
  const { engine } = rig();
  const shown = collect(engine, 'feedback');
  engine.refresh();
  const params = shown.filter((f) => f.control === 'cc:0:20').map((f) => f.path.slice(-1)[0]);
  assert.deepEqual(params, ['posH']);

  shown.length = 0;
  engine.showPage('size');
  const after = shown.filter((f) => f.control === 'cc:0:20').map((f) => f.path.slice(-1)[0]);
  assert.deepEqual(after, ['sizeH']);
});

test('swapping to a profile without the current page falls back to its first', () => {
  const { engine } = rig();
  engine.showPage('size');
  engine.setProfile({ ...paged, pages: [{ id: 'crop' }], bindings: [] });
  assert.equal(engine.selection.page, 'crop');
});

test('validation names a page nobody declared', () => {
  const bad = {
    ...paged,
    pages: [{ id: 'position' }, { id: 'position' }],
    bindings: [
      { ...paged.bindings[0], page: 'nowhere' },
      { control: 'note:0:1', target: { kind: 'action', action: 'page', value: 'elsewhere' } }
    ]
  };
  const problems = validate(bad);
  assert.ok(problems.some((p) => /duplicate page id position/.test(p)));
  assert.ok(problems.some((p) => /bindings\[0\]: no such page nowhere/.test(p)));
  assert.ok(problems.some((p) => /bindings\[1\]: no such page elsewhere/.test(p)));
});

/* ---------------------------------------------------------- the P1 desk */

test('the P1 desk profile is valid', () => {
  assert.deepEqual(validate(p1), []);
});

test('P1: four encoders on CC 16-19 and three wheels on CC 20-22, twos, channel 1', () => {
  const byId = new Map(p1.controls.map((c) => [c.id, c]));
  for (const cc of [16, 17, 18, 19, 20, 21, 22]) {
    const c = byId.get(`cc:0:${cc}`);
    assert.ok(c, `CC ${cc} declared`);
    assert.equal(c.kind, 'encoder');
    assert.equal(c.relative, 'twos');
  }
  for (const n of [96, 97, 98, 99]) assert.equal(byId.get(`note:0:${n}`)?.kind, 'button');
});

test('P1: the keypad is declared for bring-up and bound to nothing', () => {
  const keys = p1.controls.filter((c) => c.label.startsWith('Keypad '));
  assert.equal(keys.length, 45);
  const notes = keys.map((c) => Number(c.id.split(':')[2]));
  assert.equal(Math.min(...notes), 24);
  assert.equal(Math.max(...notes), 72);
  /* A big key answers on its first switch only: TAKE 54 (not 55, 64, 65),
     Please 63 (not 73), 0 at 70 (not 71). */
  for (const silent of [55, 64, 65, 71, 73]) assert.ok(!notes.includes(silent), `note ${silent} is a second switch`);
  assert.equal(keys.find((c) => c.id === 'note:0:54').label, 'Keypad TAKE');
  const bound = new Set(p1.bindings.map((b) => b.control));
  for (const k of keys) assert.ok(!bound.has(k.id), `${k.label} is the Console's, not the engine's`);
});

test('P1: a twos CC on wheel A moves the selected layer one pixel a count, on preview', async () => {
  const { engine, writes } = rig(p1);
  const surface = new MidiSurface(p1, () => {});
  engine.input(surface.handle(new Uint8Array([0xB0, 20, 5])));      // +5
  engine.input(surface.handle(new Uint8Array([0xB0, 21, 125])));    // -3
  await settle();
  const got = Object.fromEntries(writes.map((w) => [w.path.slice(-1)[0], [w.path.includes('B') ? 'B' : 'not preview', w.value]]));
  assert.deepEqual(got, { posH: ['B', 965], posV: ['B', 537] });
});

test('P1: on the Size page wheel C grows a layer and keeps it 16:9', async () => {
  const { engine, writes } = rig(p1);
  engine.showPage('size');
  engine.input({ control: 'cc:0:22', kind: 'relative', delta: 2 });
  await settle();
  const got = Object.fromEntries(writes.map((w) => [w.path.slice(-1)[0], w.value]));
  assert.deepEqual(got, { sizeH: 1952, sizeV: 1098 });
});

test('P1: an encoder push puts its parameter back to the device default', async () => {
  const { store, engine, writes } = rig(p1);
  store.set(layerParam('S1', 'B', 1, ['opacity', 'pp', 'opacity']), 100);
  engine.input({ control: 'note:0:96', kind: 'button', down: true });
  await settle();
  assert.deepEqual(writes.map((w) => w.value), [256]);
});

test('P1: every page names a wheel that exists, and nothing reaches program', () => {
  const pages = new Set(p1.pages.map((p) => p.id));
  assert.deepEqual([...pages], ['position', 'size', 'opacity', 'crop', 'source', 'border']);
  for (const b of p1.bindings) {
    if (b.target.kind === 'layer') assert.equal(b.target.preset, '@selected');
    if (b.page) assert.ok(['cc:0:20', 'cc:0:21', 'cc:0:22'].includes(b.control), b.control);
  }
});

test('P1: Speed sets the take time both ways, so the next take goes at it either way', async () => {
  const { engine, writes } = rig(p1);
  engine.input({ control: 'cc:0:19', kind: 'relative', delta: -2 });
  await settle();
  const got = Object.fromEntries(writes.map((w) => [w.path.slice(-1)[0], w.value]));
  assert.deepEqual(got, { takeUpTime: 8, takeDownTime: 8 });
});
