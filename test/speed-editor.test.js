/*
 * The Speed Editor's HID protocol and its surface adapter.
 *
 * The auth vectors were produced by running bmd_kbd_auth from Sylvain
 * Munaut's bmd.py — the implementation that has been answering real panels
 * since 2021 — so this checks the port against it, not against itself.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  authResponse, authPacket, authenticate, decodeReport,
  ledReport, jogLedReport, jogModeReport, KEYS, REPORT, JOG_MODE
} from '../core/hid/speed-editor.js';
import { SpeedEditorSurface, speedEditorControls } from '../core/hid/surface.js';
import { validate } from '../core/profile.js';
import { Engine } from '../core/engine.js';
import { readFileSync } from 'node:fs';
import { FakeStore, deviceFixture, collect, settle } from './helpers.js';

const profile = JSON.parse(readFileSync(new URL('../profiles/speed-editor.json', import.meta.url)));

test('auth response matches bmd.py', () => {
  const vectors = [
    [0x0n, 0x3ae1206f97c10bc8n],
    [0x1n, 0x2b9ab32bebf244c6n],
    [0x0123456789abcdefn, 0xe5c7b689e9967608n],
    [0xfedcba9876543210n, 0xc4a7da4761c769e8n],
    [0xdeadbeefcafef00dn, 0x6a04b6fcff2b4b21n],
    [0x7n, 0x751bf623f42e0aden],
    [0xffffffffffffffffn, 0x61a3f6474ff236c6n],
    [0x8000000000000006n, 0x7d7ff8188135a889n]
  ];
  for (const [challenge, response] of vectors) {
    assert.equal(authResponse(challenge), response, `challenge 0x${challenge.toString(16)}`);
  }
});

test('the handshake runs the four steps and returns the lease', async () => {
  const sent = [];
  const challenge = 0x0123456789abcdefn;
  const replies = [authPacket(0, challenge), authPacket(2, 0n), Uint8Array.of(6, 0x04, 0x58, 0x02, 0, 0, 0, 0, 0, 0)];
  const lease = await authenticate({
    sendFeature: async (b) => { sent.push([...b]); },
    getFeature: async (id, len) => { assert.equal(id, REPORT.AUTH); assert.equal(len, 10); return replies.shift(); }
  });
  assert.equal(lease, 600);
  assert.deepEqual(sent.map((b) => b[1]), [0, 1, 3]);
  assert.deepEqual(sent[2], [...authPacket(3, authResponse(challenge))]);
});

test('a refused handshake throws', async () => {
  const replies = [authPacket(0, 5n), authPacket(2), Uint8Array.of(6, 0x00, 0, 0, 0, 0, 0, 0, 0, 0)];
  await assert.rejects(authenticate({ sendFeature: async () => {}, getFeature: async () => replies.shift() }));
});

test('input reports decode', () => {
  assert.deepEqual(decodeReport(Uint8Array.of(4, 0x0f, 0, 0x33, 0, 0, 0, 0, 0, 0, 0, 0, 0)),
    { type: 'keys', codes: [0x0f, 0x33] });
  assert.deepEqual(decodeReport(Uint8Array.of(3, 0, 0xfe, 0xff, 0xff, 0xff, 0xff)),
    { type: 'jog', mode: 0, value: -2 });
  assert.deepEqual(decodeReport(Uint8Array.of(7, 1, 80)), { type: 'battery', charging: true, level: 80 });
  assert.equal(decodeReport(Uint8Array.of(9, 1)), null);
});

test('output reports are the bytes bmd.py writes', () => {
  assert.deepEqual([...ledReport((1 << 14) | 1)], [2, 0x01, 0x40, 0, 0]);
  assert.deepEqual([...jogLedReport(0b101)], [4, 0b101]);
  assert.deepEqual([...jogModeReport(JOG_MODE.RELATIVE)], [3, 0, 0, 0, 0, 0, 0xff]);
});

test('every key code and lamp bit is unique', () => {
  assert.equal(new Set(KEYS.map((k) => k.code)).size, KEYS.length);
  const leds = KEYS.filter((k) => k.led !== undefined).map((k) => k.led);
  assert.equal(new Set(leds).size, leds.length);
  assert.deepEqual([...leds].sort((a, b) => a - b), Array.from({ length: 18 }, (_, i) => i));
});

test('the shipped profile is valid and covers every control', () => {
  assert.deepEqual(validate(profile), []);
  assert.deepEqual(profile.controls, speedEditorControls());
});

const keys = (...codes) => {
  const b = new Uint8Array(13); b[0] = 4;
  codes.forEach((c, i) => { b[1 + 2 * i] = c; });
  return b;
};
const jog = (v) => { const b = new Uint8Array(7); b[0] = 3; new DataView(b.buffer).setInt32(2, v, true); return b; };

test('key reports become presses and releases, several at once', () => {
  const s = new SpeedEditorSurface(profile);
  assert.deepEqual(s.handle(keys(0x0f)), [{ control: 'key:cut', kind: 'button', down: true }]);
  assert.deepEqual(s.handle(keys(0x0f, 0x33)), [{ control: 'key:cam1', kind: 'button', down: true }]);
  assert.deepEqual(s.handle(keys()), [
    { control: 'key:cut', kind: 'button', down: false },
    { control: 'key:cam1', kind: 'button', down: false }
  ]);
});

test('the jog-mode keys pick the wheel face, light it, and reach nothing else', () => {
  const sent = [];
  const s = new SpeedEditorSurface(profile, (b) => sent.push([...b]));
  assert.deepEqual(s.handle(jog(512)), [{ control: 'jog:jog', kind: 'relative', delta: 1 }]);
  assert.deepEqual(s.handle(keys(0x1c)), []);
  assert.deepEqual(sent, [[4, 0b010]]);
  assert.deepEqual(s.handle(keys()), []);
  assert.deepEqual(s.handle(jog(-1024)), [{ control: 'jog:shtl', kind: 'relative', delta: -2 }]);
});

test('slow wheel movement accumulates rather than rounding away', () => {
  const s = new SpeedEditorSurface(profile);
  assert.deepEqual(s.handle(jog(200)), []);
  assert.deepEqual(s.handle(jog(200)), []);
  assert.deepEqual(s.handle(jog(200)), [{ control: 'jog:jog', kind: 'relative', delta: 1 }]);
  assert.equal(s.residue, 88);
});

test('lamps become one LED report, sent only on change', () => {
  const sent = [];
  const s = new SpeedEditorSurface(profile, (b) => sent.push([...b]));
  s.render({ control: 'key:cam1', lamp: true });
  s.render({ control: 'key:cam1', lamp: true });
  s.render({ control: 'key:cut', lamp: true });
  s.render({ control: 'key:in', lamp: true });           // no lamp on that key
  s.render({ control: 'key:cam1', lamp: false });
  assert.deepEqual(sent, [[2, 0, 0x40, 0, 0], [2, 0x02, 0x40, 0, 0], [2, 0x02, 0, 0, 0]]);
});

test('end to end: CAM 3 puts LIVE_3 on the selected preview layer', async () => {
  const store = new FakeStore(deviceFixture({ transition: 'AT_DOWN' }));
  const engine = new Engine(store, profile, { coalesceMs: 5 });
  const writes = collect(engine, 'write');
  const s = new SpeedEditorSurface(profile);
  for (const ev of s.handle(keys(0x35))) engine.input(ev);
  await settle();
  assert.equal(writes.length, 1);
  const [w] = writes[0].writes;
  assert.equal(w.value, 'LIVE_3');
  // AT_DOWN: A is on air, so preview is B.
  assert.equal(w.path.join('/'), 'device/screenList/items/S1/presetList/items/B/layerList/items/1/source/pp/inputNum');
});
