/*
 * Paths, preset resolution, value scaling and the MIDI codec.
 *
 * The AWJ strings asserted here are not invented: each was issued against a
 * running AW LivePremier Simulator (NLC_CMAX, firmware 6.2.73) and answered
 * with a value rather than an E12 "unexpected path" error. If a refactor
 * changes one of them, the device stops responding — hence testing the exact
 * strings and not merely that the builder is self-consistent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { toAwj, fromAwj, layerParam, screenGroupParam, startsWith, key } from '../core/paths.js';
import { resolve, letterFor } from '../core/preset.js';
import {
  fromAbsolute, fromRelative, fromButton, toAbsolute, toLamp, rangeOf, Pickup
} from '../core/value.js';
import { decode, encode, controlId, parseControlId } from '../core/midi/message.js';
import { decodeRelative, encodeRelative, Accelerator } from '../core/midi/encoders.js';
import * as mcu from '../core/midi/mcu.js';
import { layerSpec, groupSpec } from '../core/catalogue.js';

/* --------------------------------------------------------------- paths */

test('layer paths render to the AWJ spelling the device answers', () => {
  assert.equal(
    toAwj(layerParam('S1', 'A', 1, ['opacity', 'pp', 'opacity'])),
    'DeviceObject/$screen/@items/S1/$preset/@items/A/$layer/@items/1/opacity/@props/opacity'
  );
  assert.equal(
    toAwj(layerParam('S1', 'A', 1, ['cropping', 'classic', 'pp', 'aspectOverride'])),
    'DeviceObject/$screen/@items/S1/$preset/@items/A/$layer/@items/1/cropping/classic/@props/aspectOverride'
  );
  assert.equal(
    toAwj(layerParam('S1', 'B', 12, ['keying', 'pp', 'enable'])),
    'DeviceObject/$screen/@items/S1/$preset/@items/B/$layer/@items/12/keying/@props/enable'
  );
});

test('screen group paths render to the documented take path', () => {
  assert.equal(
    toAwj(screenGroupParam('S1', ['control', 'pp', 'xTake'])),
    'DeviceObject/$screenAuxGroup/@items/S1/control/@props/xTake'
  );
});

test('AWJ conversion round-trips', () => {
  for (const p of [
    layerParam('S3', 'C', 7, ['position', 'pp', 'sizeH']),
    screenGroupParam('S9', ['status', 'pp', 'transition'])
  ]) {
    assert.deepEqual(fromAwj(toAwj(p)), p);
  }
});

test('the List suffix is a store spelling only', () => {
  /* AWJ answers E12 for $timerList and serves $timer. */
  assert.equal(toAwj(['device', 'timerList', 'items', '1']), 'DeviceObject/$timer/@items/1');
  assert.equal(toAwj(['device', 'screenAuxGroupList']), 'DeviceObject/$screenAuxGroup');
});

test('startsWith and key behave as path predicates', () => {
  const p = layerParam('S1', 'A', 1, ['opacity', 'pp', 'opacity']);
  assert.ok(startsWith(p, ['device', 'screenList', 'items', 'S1']));
  assert.ok(!startsWith(p, ['device', 'screenList', 'items', 'S2']));
  assert.equal(key(['a', 'b']), 'a/b');
});

/* -------------------------------------------------------------- presets */

test('preset letters resolve from the transition suffix, not the letters', () => {
  const group = (transition) => ({
    control: { pp: { presetUp: 'B', presetDown: 'A', presetPrevious: 'C' } },
    status: { pp: { transition } }
  });

  /* Confirmed on hardware: a TAKE leaves presetUp/presetDown untouched and
     flips status.transition. Every in-flight state names the end it came
     from, so the whole rule is the DOWN/UP suffix. */
  assert.deepEqual(resolve(group('AT_DOWN')).program, 'A');
  assert.deepEqual(resolve(group('AT_DOWN')).preview, 'B');
  assert.deepEqual(resolve(group('AT_UP')).program, 'B');
  assert.deepEqual(resolve(group('AT_UP')).preview, 'A');

  for (const t of ['EFFECT_FROM_DOWN', 'COPY_FROM_DOWN']) {
    assert.equal(resolve(group(t)).program, 'A', `${t} should hold program at the down preset`);
    assert.equal(resolve(group(t)).settled, false);
  }
  for (const t of ['EFFECT_FROM_UP', 'COPY_FROM_UP']) {
    assert.equal(resolve(group(t)).program, 'B', `${t} should hold program at the up preset`);
    assert.equal(resolve(group(t)).settled, false);
  }
});

test('an unread group resolves to nothing rather than guessing', () => {
  assert.equal(resolve(undefined), null);
  assert.equal(resolve({ control: { pp: {} }, status: { pp: {} } }), null);
  assert.equal(letterFor('PREVIEW', undefined), null);
});

test('a literal preset letter is passed straight through', () => {
  const group = {
    control: { pp: { presetUp: 'B', presetDown: 'A' } },
    status: { pp: { transition: 'AT_DOWN' } }
  };
  assert.equal(letterFor('C', group), 'C');
  assert.equal(letterFor('PREVIEW', group), 'B');
  assert.equal(letterFor('PROGRAM', group), 'A');
});

/* --------------------------------------------------------------- values */

test('opacity reaches its real maximum of 256, not 255', () => {
  const spec = layerSpec('opacity.opacity');
  assert.equal(spec.max, 256);
  assert.equal(fromAbsolute(spec, 1), 256);
  assert.equal(fromAbsolute(spec, 0), 0);
  assert.equal(fromAbsolute(spec, 0.5), 128);
  /* And back: a full fader reads as a full fader. */
  assert.equal(toAbsolute(spec, 256), 1);
});

test('a binding window narrows a range but cannot exceed it', () => {
  const spec = layerSpec('position.posH');
  assert.deepEqual(rangeOf(spec, { min: 0, max: 3840 }), { min: 0, max: 3840 });
  /* The parameter itself stops at +/-2,000,000; a profile asking for more is
     clamped rather than allowed to send an out-of-range write. */
  assert.deepEqual(rangeOf(spec, { min: -1e9, max: 1e9 }), { min: -2000000, max: 2000000 });
  assert.equal(fromAbsolute(spec, 0.5, { min: 0, max: 3840 }), 1920);
});

test('enums step and wrap over the device list', () => {
  const spec = layerSpec('cropping.classic.aspectOverride');
  assert.deepEqual(spec.values, ['NONE', '1_1', 'CENTERED', 'FULLSCREEN', 'CROPPED']);
  assert.equal(fromRelative(spec, 1, 'NONE'), '1_1');
  assert.equal(fromRelative(spec, -1, 'NONE'), 'NONE', 'clamps at the bottom without wrap');
  assert.equal(fromRelative(spec, -1, 'NONE', { wrap: true }), 'CROPPED');
  assert.equal(fromAbsolute(spec, 1), 'CROPPED');
  assert.equal(toAbsolute(spec, 'CROPPED'), 1);
  assert.equal(toAbsolute(spec, 'NOT_A_MEMBER'), null);
});

test('a trimmed value list keeps an absolute knob usable', () => {
  const spec = layerSpec('source.inputNum');
  assert.equal(spec.values.length, 482);
  const live = Array.from({ length: 16 }, (_, i) => `LIVE_${i + 1}`);
  assert.equal(fromAbsolute(spec, 0, { values: live }), 'LIVE_1');
  assert.equal(fromAbsolute(spec, 1, { values: live }), 'LIVE_16');
});

test('buttons toggle, set, trigger and reset', () => {
  const key = layerSpec('keying.enable');
  assert.equal(fromButton(key, true, false), true);
  assert.equal(fromButton(key, true, true), false);
  assert.equal(fromButton(key, false, true), undefined, 'release writes nothing');

  const src = layerSpec('source.inputNum');
  assert.equal(fromButton(src, true, 'NONE', { action: 'set', value: 'LIVE_3' }), 'LIVE_3');

  const take = groupSpec('control.xTake');
  assert.equal(fromButton(take, true, false, { action: 'trigger' }), true);
  assert.equal(fromButton(take, false, true, { action: 'trigger' }), undefined,
    'an x-action is write-true-to-fire and needs no matching false');

  const posH = layerSpec('position.posH');
  assert.equal(fromButton(posH, true, 1234, { resetToDefault: true }), posH.def);
});

test('momentary writes on press and restores on release only if told to', () => {
  const key = layerSpec('keying.enable');
  assert.equal(fromButton(key, true, false, { action: 'momentary', value: true }), true);
  assert.equal(fromButton(key, false, true, { action: 'momentary', value: true }), undefined);
  assert.equal(
    fromButton(key, false, true, { action: 'momentary', value: true, releaseValue: false }),
    false
  );
});

test('lamps show whether a set-button holds the value it writes', () => {
  const src = layerSpec('source.inputNum');
  const binding = { action: 'set', value: 'LIVE_3' };
  assert.equal(toLamp(src, 'LIVE_3', binding), true);
  assert.equal(toLamp(src, 'LIVE_4', binding), false);
  assert.equal(toLamp(src, undefined, binding), null, 'unknown is not "off"');
});

test('pickup holds off until the control crosses the value', () => {
  const p = new Pickup('pickup');
  assert.equal(p.allows(0.9, 0.2), false, 'far away, no write');
  assert.equal(p.allows(0.6, 0.2), false, 'still above');
  assert.equal(p.allows(0.1, 0.2), true, 'crossed, latch');
  assert.equal(p.allows(0.9, 0.2), true, 'latched, tracks freely');
  p.reset();
  assert.equal(p.allows(0.9, 0.2), false, 'reset unlatches');
});

test('a motorised fader jumps because it is already in agreement', () => {
  const p = new Pickup('jump');
  assert.equal(p.allows(0.9, 0.1), true);
});

test('pickup latches when the parameter has never been read', () => {
  const p = new Pickup('pickup');
  assert.equal(p.allows(0.5, null), true);
});

/* ----------------------------------------------------------------- MIDI */

test('note-on at velocity zero is a note-off', () => {
  assert.deepEqual(decode(Uint8Array.from([0x90, 60, 0])), { type: 'noteOff', channel: 0, note: 60, velocity: 0 });
  assert.equal(decode(Uint8Array.from([0x90, 60, 127])).type, 'noteOn');
});

test('a control keeps one identity whatever it is doing', () => {
  const press = decode(Uint8Array.from([0x93, 51, 127]));
  const release = decode(Uint8Array.from([0x93, 51, 0]));
  assert.equal(controlId(press), controlId(release));
  assert.equal(controlId(press), 'note:3:51');
  assert.deepEqual(parseControlId('note:3:51'), { kind: 'note', channel: 3, note: 51 });
});

test('every message type survives an encode/decode round trip', () => {
  const cases = [
    { type: 'noteOn', channel: 2, note: 64, velocity: 100 },
    { type: 'cc', channel: 5, controller: 7, value: 64 },
    { type: 'pitchBend', channel: 3, value: 9001 },
    { type: 'channelPressure', channel: 0, value: 12 },
    { type: 'programChange', channel: 1, program: 5 }
  ];
  for (const c of cases) assert.deepEqual(decode(encode(c)), c);
});

test('sysex is carried without its framing bytes', () => {
  const msg = { type: 'sysex', data: [0x00, 0x00, 0x66, 0x14, 0x12, 0x00, 65] };
  assert.deepEqual(decode(encode(msg)), msg);
});

test('all three relative conventions round-trip and disagree as expected', () => {
  for (const mode of ['signed', 'twos', 'offset']) {
    for (const d of [-63, -7, -1, 1, 7, 63]) {
      assert.equal(decodeRelative(encodeRelative(d, mode), mode), d, `${mode} ${d}`);
    }
    assert.equal(decodeRelative(encodeRelative(0, mode), mode), 0);
  }
  /* The conventions are genuinely incompatible, and 0x7F shows it best: one
     click anticlockwise on a Mackie V-Pot, sixty-three clicks anticlockwise
     read as two's complement, sixty-three CLOCKWISE read as binary offset.
     Same byte, opposite direction, sixty-three times the distance — this is
     the classic runaway-parameter bug. */
  assert.equal(decodeRelative(0x7f, 'signed'), -63);
  assert.equal(decodeRelative(0x7f, 'twos'), -1);
  assert.equal(decodeRelative(0x7f, 'offset'), 63);
});

test('acceleration multiplies fast ticks and leaves slow ones alone', () => {
  const a = new Accelerator();
  assert.equal(a.apply(1, 1000), 1, 'first tick is never accelerated');
  assert.equal(a.apply(1, 100000), 1, 'a long gap resets to unity');
  let fast = 0;
  for (let t = 0; t < 20; t++) fast = a.apply(1, 100000 + t * 5);
  assert.ok(fast > 1, 'a fast spin moves further per detent');
  assert.ok(fast <= 12, 'but is capped');
});

test('MCU faders are 14-bit and drive their own motors', () => {
  const msg = mcu.faderMessage(3, 1);
  assert.deepEqual(Array.from(encode(msg)), [0xe3, 0x7f, 0x7f]);
  assert.equal(mcu.faderValue(decode(encode(mcu.faderMessage(0, 0.25)))).toFixed(3), '0.250');
});

test('an unset V-Pot ring is blank, not zero', () => {
  assert.equal(mcu.ringMessage(0, null).value & 0x0f, 0, 'no value lights nothing');
  assert.equal(mcu.ringMessage(0, 0).value & 0x0f, 1, 'a real zero lights the first LED');
  assert.equal(mcu.ringMessage(0, 1).value & 0x0f, 11);
  assert.equal(mcu.ringMessage(2, 0.5).controller, mcu.VPOT_RING_CC_BASE + 2);
});

test('scribble strips are addressed by offset into one shared buffer', () => {
  const [top, bottom] = mcu.scribbleMessage(2, 'Opacity', 'L5');
  assert.deepEqual(top.data.slice(0, 6), [0x00, 0x00, 0x66, 0x14, 0x12, 14]);
  assert.equal(bottom.data[5], 14 + 56, 'the second row is 56 characters further on');
  assert.equal(top.data.length, 6 + 7, 'exactly one seven-character cell');
  assert.equal(String.fromCharCode(...bottom.data.slice(6)), 'L5     ', 'padded to the cell');
});

test('fader touch and V-Pot CCs resolve to strip numbers', () => {
  assert.equal(mcu.faderTouch(104), 0);
  assert.equal(mcu.faderTouch(111), 7);
  assert.equal(mcu.faderTouch(60), null);
  assert.equal(mcu.vpotStrip(16), 0);
  assert.equal(mcu.vpotStrip(24), null);
});
