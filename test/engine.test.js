/*
 * The engine, end to end.
 *
 * These are behaviour tests, not unit tests: each one is a thing an operator
 * does at a surface, and the assertion is the write that reaches the device.
 * The awkward cases — a take moving the target out from under a fader, a bank
 * change repointing eight faders at once, the device echoing our own write
 * back at us — are the reason this layer exists at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Engine } from '../core/engine.js';
import { MidiSurface } from '../core/surface.js';
import { toAwj, layerParam, screenGroupParam } from '../core/paths.js';
import { encode } from '../core/midi/message.js';
import * as mcu from '../core/midi/mcu.js';
import { FakeStore, deviceFixture, collect, settle } from './helpers.js';

/** A tiny profile with one of each kind of control. */
const profile = {
  id: 'test',
  stripCount: 8,
  feedback: { protocol: 'mcu' },
  controls: [
    { id: 'pb:0', kind: 'fader14', strip: 0, motorised: true, scribble: true },
    { id: 'pb:1', kind: 'fader14', strip: 1, motorised: true },
    { id: 'note:0:104', kind: 'touch', strip: 0 },
    { id: 'cc:0:16', kind: 'encoder', strip: 0, relative: 'signed', accelerate: false },
    { id: 'note:0:24', kind: 'button', strip: 0 },
    { id: 'note:0:16', kind: 'button', strip: 0 },
    { id: 'note:0:94', kind: 'button' },
    { id: 'note:0:70', kind: 'button' },
    { id: 'note:0:47', kind: 'button' }
  ],
  bindings: [
    { control: 'pb:0', target: { kind: 'layer', layer: '@strip', preset: 'PREVIEW', param: 'opacity.opacity' }, options: { takeover: 'jump' } },
    { control: 'pb:1', target: { kind: 'layer', layer: '@strip', preset: 'PREVIEW', param: 'opacity.opacity' }, options: { takeover: 'jump' } },
    { control: 'cc:0:16', shift: false, target: { kind: 'layer', layer: '@strip', preset: 'PREVIEW', param: 'source.inputNum' }, options: { step: 1 } },
    { control: 'cc:0:16', shift: true, target: { kind: 'layer', layer: '@selected', preset: 'PREVIEW', param: 'position.posH' }, options: { min: 0, max: 3840 } },
    { control: 'note:0:24', target: { kind: 'action', action: 'selectLayer', value: '@strip' } },
    { control: 'note:0:16', target: { kind: 'layer', layer: '@strip', preset: 'PREVIEW', param: 'keying.enable' }, options: { action: 'toggle' } },
    { control: 'note:0:94', target: { kind: 'screenGroup', param: 'control.xTake' }, options: { action: 'trigger' } },
    { control: 'note:0:70', target: { kind: 'action', action: 'shift' } },
    { control: 'note:0:47', target: { kind: 'action', action: 'bank', delta: 1 } }
  ]
};

function rig(opts = {}) {
  const store = new FakeStore(deviceFixture(opts));
  const engine = new Engine(store, profile, { coalesceMs: 5, ...opts });
  const writes = [];
  engine.addEventListener('write', (e) => writes.push(...e.detail.writes));
  return { store, engine, writes };
}

/** Apply the writes an engine produced back into the store, as a device would. */
function applyWrites(store, engine, writes) {
  for (const w of writes) {
    store.set(w.path, w.value);
    engine.deviceChanged(w.path);
  }
  writes.length = 0;
}

/* --------------------------------------------------------------- writing */

test('a fader writes the layer opacity of the preview preset', async () => {
  const { engine, writes } = rig();
  /* Deliberately not full: the fixture already sits at 256, and the engine
     drops a write that would not change anything. */
  engine.input({ control: 'pb:0', kind: 'absolute', value: 0.5 });
  await settle();

  assert.equal(writes.length, 1);
  assert.equal(writes[0].value, 128, 'half a fader is half of 256, not of 255');
  assert.equal(
    toAwj(writes[0].path),
    'DeviceObject/$screen/@items/S1/$preset/@items/B/$layer/@items/1/opacity/@props/opacity',
    'AT_DOWN means the UP preset (B) is preview'
  );
});

test('a take moves preview to the other letter and the same fader follows', async () => {
  const { store, engine, writes } = rig();

  engine.input({ control: 'pb:0', kind: 'absolute', value: 0.5 });
  await settle();
  assert.match(toAwj(writes[0].path), /@items\/B\//, 'preview is B while resting down');
  writes.length = 0;

  /* Fire the take, then let the device report the flip. */
  store.set(['device', 'screenAuxGroupList', 'items', 'S1', 'status', 'pp', 'transition'], 'AT_UP');

  engine.input({ control: 'pb:0', kind: 'absolute', value: 0.25 });
  await settle();
  assert.match(toAwj(writes[0].path), /@items\/A\//,
    'after the take the same fader must address A, or a preview fader becomes a live one');
});

test('a screen-group binding writes the documented take path', async () => {
  const { engine, writes } = rig();
  engine.input({ control: 'note:0:94', kind: 'button', down: true });
  await settle();
  assert.equal(toAwj(writes[0].path), 'DeviceObject/$screenAuxGroup/@items/S1/control/@props/xTake');
  assert.equal(writes[0].value, true);

  /* Releasing must not write false: these are fire-on-true actions. */
  writes.length = 0;
  engine.input({ control: 'note:0:94', kind: 'button', down: false });
  await settle();
  assert.equal(writes.length, 0);
});

test('a trigger fires every time, though the device left the last one at true', async () => {
  const { store, engine, writes } = rig();
  engine.input({ control: 'note:0:94', kind: 'button', down: true });
  await settle();
  assert.equal(writes.length, 1);
  /* The device echoes the take and leaves xTake at true, as a LivePremier does. */
  applyWrites(store, engine, writes);
  engine.input({ control: 'note:0:94', kind: 'button', down: false });
  engine.input({ control: 'note:0:94', kind: 'button', down: true });
  await settle();
  assert.equal(writes.length, 1, 'the second TAKE was dropped as redundant');
  assert.equal(writes[0].value, true);
});

test('nothing is written while the preset letters are unknown', async () => {
  const store = new FakeStore({});
  const engine = new Engine(store, profile, { coalesceMs: 5 });
  const writes = collect(engine, 'write');
  const unresolved = collect(engine, 'unresolved');

  engine.input({ control: 'pb:0', kind: 'absolute', value: 1 });
  await settle();
  assert.equal(writes.length, 0, 'guessing a preset letter could put a change on air');
  assert.equal(unresolved.length, 1);
});

test('a redundant write is dropped', async () => {
  const { engine, writes } = rig();
  /* Opacity already sits at 256. */
  engine.input({ control: 'pb:0', kind: 'absolute', value: 1 });
  await settle();
  writes.length = 0;
  engine.input({ control: 'pb:0', kind: 'absolute', value: 1 });
  await settle();
  assert.equal(writes.length, 0);
});

test('a fader sweep coalesces to one write per path', async () => {
  const { engine, writes } = rig();
  /* Sweep down from the resting value, so every step is a real change. */
  for (let i = 100; i >= 0; i--) engine.input({ control: 'pb:0', kind: 'absolute', value: i / 100 });
  await settle();
  assert.equal(writes.length, 1, 'the device does not need every intermediate position');
  assert.equal(writes[0].value, 0, 'and the value that survives is the newest');
});

test('two faders in one window produce two writes, not one', async () => {
  const { engine, writes } = rig();
  engine.input({ control: 'pb:0', kind: 'absolute', value: 0.5 });
  engine.input({ control: 'pb:1', kind: 'absolute', value: 0.25 });
  await settle();
  assert.equal(writes.length, 2);
  assert.deepEqual(writes.map((w) => w.value).sort((a, b) => a - b), [64, 128]);
});

/* ------------------------------------------------------------- selection */

test('strip bindings address one layer each, and banking shifts all of them', async () => {
  const { engine, writes } = rig();
  engine.input({ control: 'pb:1', kind: 'absolute', value: 0.5 });
  await settle();
  assert.match(toAwj(writes[0].path), /\$layer\/@items\/2\//, 'strip 1 is layer 2');
  writes.length = 0;

  engine.input({ control: 'note:0:47', kind: 'button', down: true });
  engine.input({ control: 'pb:1', kind: 'absolute', value: 0.25 });
  await settle();
  assert.match(toAwj(writes[0].path), /\$layer\/@items\/10\//, 'one bank on, strip 1 is layer 10');
});

test('a select button repoints the selected-layer bindings', async () => {
  const { engine, writes } = rig();
  engine.input({ control: 'note:0:70', kind: 'button', down: true });   // shift
  engine.input({ control: 'cc:0:16', kind: 'relative', delta: 1 });
  await settle();
  assert.match(toAwj(writes[0].path), /\$layer\/@items\/1\/position/, 'selection starts at layer 1');
});

test('shift picks between two bindings on one control', async () => {
  const { engine, writes } = rig();

  engine.input({ control: 'cc:0:16', kind: 'relative', delta: 1 });
  await settle();
  assert.match(toAwj(writes[0].path), /source\/@props\/inputNum$/, 'unshifted steps the source');
  writes.length = 0;

  engine.input({ control: 'note:0:70', kind: 'button', down: true });
  engine.input({ control: 'cc:0:16', kind: 'relative', delta: 1 });
  await settle();
  assert.match(toAwj(writes[0].path), /position\/@props\/posH$/, 'shifted becomes geometry');
});

test('an encoder steps the source list one member at a time', async () => {
  const { store, engine, writes } = rig();
  engine.input({ control: 'cc:0:16', kind: 'relative', delta: 1 });
  await settle();
  assert.equal(writes[0].value, 'LIVE_1', 'NONE is followed by LIVE_1');
  applyWrites(store, engine, writes);

  engine.input({ control: 'cc:0:16', kind: 'relative', delta: 3 });
  await settle();
  assert.equal(writes[0].value, 'LIVE_4');
});

/* -------------------------------------------------------------- feedback */

test('feedback reports a position for faders and a lamp for buttons', () => {
  const { store, engine } = rig();
  store.set(layerParam('S1', 'B', 1, ['opacity', 'pp', 'opacity']), 128);
  store.set(layerParam('S1', 'B', 1, ['keying', 'pp', 'enable']), true);

  const fb = collect(engine, 'feedback');
  engine.refresh();

  const fader = fb.find((f) => f.control === 'pb:0');
  assert.equal(fader.position, 0.5, 'half opacity is a half-height fader');
  assert.equal(fader.top, 'Opacity');
  assert.equal(fader.bottom, 'L1', 'the strip names the layer it is pointed at');

  const key = fb.find((f) => f.control === 'note:0:16');
  assert.equal(key.lamp, true);
});

test('an unread parameter has no position, which is not the same as zero', () => {
  const store = new FakeStore(deviceFixture());
  const engine = new Engine(store, profile, { coalesceMs: 5 });
  store.set(layerParam('S1', 'B', 2, ['opacity', 'pp', 'opacity']), undefined);

  const fb = collect(engine, 'feedback');
  engine.refresh();
  assert.equal(fb.find((f) => f.control === 'pb:1').position, null);
});

test('a control is not fed its own echo back', async () => {
  const { store, engine, writes } = rig();
  const fb = [];
  engine.addEventListener('feedback', (e) => fb.push(e.detail));

  engine.input({ control: 'pb:0', kind: 'absolute', value: 0.5 });
  await settle();
  applyWrites(store, engine, writes);

  assert.equal(fb.filter((f) => f.control === 'pb:0').length, 0,
    'driving a motor back at the hand that just moved it fights the operator');
});

test('but a change from anywhere else does reach the control', () => {
  const { store, engine } = rig();
  const fb = collect(engine, 'feedback');

  /* Somebody else — the vendor UI, a second surface — moves the parameter. */
  const path = layerParam('S1', 'B', 1, ['opacity', 'pp', 'opacity']);
  store.set(path, 64);
  engine.deviceChanged(path);

  const seen = fb.find((f) => f.control === 'pb:0');
  assert.ok(seen, 'a motor fader must follow the device');
  assert.equal(seen.position, 0.25);
});

test('a touched fader is never driven', () => {
  const { store, engine } = rig();
  const fb = collect(engine, 'feedback');

  engine.input({ control: 'note:0:104', kind: 'touch', down: true });
  const path = layerParam('S1', 'B', 1, ['opacity', 'pp', 'opacity']);
  store.set(path, 64);
  engine.deviceChanged(path);
  assert.equal(fb.find((f) => f.control === 'pb:0').position, null, 'motor must not fight a finger');

  fb.length = 0;
  engine.input({ control: 'note:0:104', kind: 'touch', down: false });
  engine.deviceChanged(path);
  assert.equal(fb.find((f) => f.control === 'pb:0').position, 0.25, 'and resumes on release');
});

test('selection changes reset pickup so a fader cannot slam a new layer', async () => {
  /* Sixteen layers, so that banking on actually lands somewhere real: against
     an absent layer the value is unknown and pickup correctly latches. */
  const store = new FakeStore(deviceFixture({ layers: 16 }));
  const engine = new Engine(store, {
    ...profile,
    bindings: profile.bindings.map((b) =>
      b.control === 'pb:0' ? { ...b, options: { takeover: 'pickup' } } : b)
  }, { coalesceMs: 5 });
  const writes = [];
  engine.addEventListener('write', (e) => writes.push(...e.detail.writes));

  /* Latch the fader at the top, where the parameter already is. */
  engine.input({ control: 'pb:0', kind: 'absolute', value: 1 });
  await settle();
  writes.length = 0;

  /* Now point everything at a different layer and move the fader a little. */
  engine.input({ control: 'note:0:47', kind: 'button', down: true });
  engine.input({ control: 'pb:0', kind: 'absolute', value: 0.2 });
  await settle();
  assert.equal(writes.length, 0, 'a fader at 20% must not drag a full layer down to 20%');
});

/* --------------------------------------------------------------- surface */

test('the surface decodes each controller convention to one event shape', () => {
  const s = new MidiSurface({
    id: 's', controls: [
      { id: 'cc:0:7', kind: 'fader' },
      { id: 'pb:2', kind: 'fader14', strip: 2 },
      { id: 'cc:0:16', kind: 'encoder', relative: 'signed', accelerate: false },
      { id: 'note:0:113', kind: 'encoder', tick: 1 },
      { id: 'note:0:114', kind: 'encoder', tick: -1 },
      { id: 'note:0:51', kind: 'button' },
      { id: 'note:0:104', kind: 'touch', strip: 0 }
    ], bindings: []
  });

  assert.deepEqual(s.handle(encode({ type: 'cc', channel: 0, controller: 7, value: 127 })),
    { control: 'cc:0:7', kind: 'absolute', value: 1 });
  assert.equal(s.handle(encode(mcu.faderMessage(2, 0.5))).kind, 'absolute');
  assert.deepEqual(s.handle(encode({ type: 'cc', channel: 0, controller: 16, value: 0x41 })),
    { control: 'cc:0:16', kind: 'relative', delta: -1 });

  /* Both Elation MIDIcons send a note per click rather than a relative CC. */
  assert.deepEqual(s.handle(encode({ type: 'noteOn', channel: 0, note: 113, velocity: 127 })),
    { control: 'note:0:113', kind: 'relative', delta: 1 });
  assert.deepEqual(s.handle(encode({ type: 'noteOn', channel: 0, note: 114, velocity: 127 })),
    { control: 'note:0:114', kind: 'relative', delta: -1 });
  assert.equal(s.handle(encode({ type: 'noteOff', channel: 0, note: 113, velocity: 0 })), null,
    'the click ending is not a second click');

  assert.deepEqual(s.handle(encode({ type: 'noteOn', channel: 0, note: 51, velocity: 127 })),
    { control: 'note:0:51', kind: 'button', down: true });
  assert.equal(s.handle(encode({ type: 'noteOn', channel: 0, note: 104, velocity: 127 })).kind, 'touch');
});

test('an unknown control is reported rather than dropped, so learn can see it', () => {
  const s = new MidiSurface({ id: 's', controls: [], bindings: [] });
  const ev = s.handle(encode({ type: 'cc', channel: 3, controller: 42, value: 9 }));
  assert.equal(ev.kind, 'unmapped');
  assert.equal(ev.control, 'cc:3:42');
});

test('MCU feedback goes out on the right addresses', () => {
  const sent = [];
  const s = new MidiSurface({
    id: 's', feedback: { protocol: 'mcu' },
    controls: [
      { id: 'pb:0', kind: 'fader14', strip: 0, scribble: true },
      { id: 'cc:0:16', kind: 'encoder', strip: 0 },
      { id: 'note:0:24', kind: 'button' }
    ], bindings: []
  }, (b) => sent.push(Array.from(b)));

  s.render({ control: 'pb:0', position: 1, top: 'Opacity', bottom: 'L1' });
  assert.deepEqual(sent[0], [0xe0, 0x7f, 0x7f], 'the fader message IS the motor command');
  assert.equal(sent[1][0], 0xf0, 'and the scribble strip follows as sysex');

  sent.length = 0;
  s.render({ control: 'cc:0:16', position: 0.5 });
  assert.equal(sent[0][1], mcu.VPOT_RING_CC_BASE, 'the ring is a different CC from the V-Pot');

  sent.length = 0;
  s.render({ control: 'note:0:24', lamp: true });
  assert.deepEqual(sent[0], [0x90, 24, 127]);
});

test('generic feedback echoes a control on its own address', () => {
  const sent = [];
  const s = new MidiSurface({
    id: 's', feedback: { protocol: 'generic' },
    controls: [
      { id: 'note:0:53', kind: 'button', on: 5 },
      { id: 'cc:0:48', kind: 'knob', ring: 56 },
      { id: 'cc:0:7', kind: 'fader' },
      { id: 'cc:0:1', kind: 'fader', motorised: true }
    ], bindings: []
  }, (b) => sent.push(Array.from(b)));

  s.render({ control: 'note:0:53', lamp: true });
  assert.deepEqual(sent[0], [0x90, 53, 5], 'the APC40 lamp colour is the velocity');

  sent.length = 0;
  s.render({ control: 'cc:0:48', position: 1 });
  assert.deepEqual(sent[0], [0xb0, 56, 127], 'the knob ring can be a separate CC');

  sent.length = 0;
  s.render({ control: 'cc:0:7', position: 1 });
  assert.equal(sent.length, 0, 'a fader with no motor cannot be driven');

  s.render({ control: 'cc:0:1', position: 1 });
  assert.deepEqual(sent[0], [0xb0, 1, 127], 'a motorised one can — this is how a MIDIcon tracks');
});

test('a scribble strip is not rewritten when its text has not changed', () => {
  const sent = [];
  const s = new MidiSurface({
    id: 's', feedback: { protocol: 'mcu' },
    controls: [{ id: 'pb:0', kind: 'fader14', strip: 0, scribble: true }], bindings: []
  }, (b) => sent.push(Array.from(b)));

  s.render({ control: 'pb:0', position: 0.1, top: 'Opacity', bottom: 'L1' });
  const first = sent.length;
  s.render({ control: 'pb:0', position: 0.2, top: 'Opacity', bottom: 'L1' });
  assert.equal(sent.length, first + 1, 'only the fader moved; the LCD would visibly flicker');
});
