/*
 * The OSC codec.
 *
 * OSC is small and completely specified, so this is mostly about the padding
 * rules — every string and blob is null-terminated and padded to a multiple of
 * four, and getting that wrong produces packets that decode as garbage rather
 * than as errors.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeMessage, decodePacket, oscEvent, oscControlId, oscAddress } from '../hosts/node/osc.js';

const round = (address, args) => decodePacket(encodeMessage(address, args))[0];

test('messages round-trip with their argument types intact', () => {
  const msg = round('/awj/layer/1/opacity', [0.25]);
  assert.equal(msg.address, '/awj/layer/1/opacity');
  assert.equal(Math.abs(msg.args[0] - 0.25) < 1e-6, true);

  /* Exact integers go out as int32 and must come back as integers, or an int
     parameter would arrive as 63.99999 and round the wrong way. */
  assert.deepEqual(round('/awj/layer/1/source', [7]).args, [7]);
  assert.deepEqual(round('/awj/name', ['LIVE_3']).args, ['LIVE_3']);
});

test('booleans and null are carried by the type tag alone', () => {
  /* T, F and N have no payload — the tag IS the value. A decoder that expects
     four bytes for them walks off the end of every following argument. */
  assert.deepEqual(round('/awj/key', [true]).args, [true]);
  assert.deepEqual(round('/awj/key', [false]).args, [false]);
  assert.deepEqual(round('/awj/key', [null]).args, [null]);
  assert.deepEqual(round('/awj/mixed', [true, 3, false, 'x']).args, [true, 3, false, 'x']);
});

test('padding holds for every address length', () => {
  /* The interesting cases are addresses whose length is exactly a multiple of
     four, where the terminator forces a whole extra word of padding. */
  for (const address of ['/a', '/ab', '/abc', '/abcd', '/abcde', '/abcdef', '/abcdefg']) {
    const buf = encodeMessage(address, [1]);
    assert.equal(buf.length % 4, 0, `${address} is not word-aligned`);
    assert.equal(decodePacket(buf)[0].address, address);
  }
});

test('a message with no arguments decodes', () => {
  /* A momentary button on some surfaces sends a bare address. */
  assert.deepEqual(round('/awj/take', []), { address: '/awj/take', args: [] });
});

test('bundles are flattened to their messages', () => {
  const inner = [encodeMessage('/awj/take', [1]), encodeMessage('/awj/layer/2/opacity', [0.5])];
  const parts = [Buffer.from('#bundle\0', 'ascii'), Buffer.alloc(8)];
  for (const msg of inner) {
    const size = Buffer.alloc(4);
    size.writeInt32BE(msg.length);
    parts.push(size, msg);
  }
  const messages = decodePacket(Buffer.concat(parts));
  assert.equal(messages.length, 2);
  assert.equal(messages[0].address, '/awj/take');
  assert.equal(messages[1].address, '/awj/layer/2/opacity');
});

test('a blob keeps its length across the padding', () => {
  const blob = Buffer.from([1, 2, 3, 4, 5]);
  const out = round('/awj/blob', [blob]);
  assert.deepEqual(Array.from(out.args[0]), [1, 2, 3, 4, 5]);
});

test('rubbish is rejected rather than silently mis-decoded', () => {
  assert.throws(() => decodePacket(Buffer.from('not an address', 'ascii')));
});

test('an OSC address is a control id, so profiles treat it like a fader', () => {
  assert.equal(oscControlId('/awj/take'), 'osc:/awj/take');
  assert.equal(oscAddress('osc:/awj/take'), '/awj/take');
  assert.equal(oscAddress('cc:0:7'), null, 'MIDI ids are not OSC addresses');
});

test('the profile decides what an address means, not the message', () => {
  const address = '/awj/layer/1/x';
  const msg = { address, args: [1] };

  /* The same message is a press or a full-scale position depending only on how
     the control was declared — exactly as for MIDI. */
  assert.deepEqual(
    oscEvent({ id: oscControlId(address), kind: 'button' }, msg),
    { control: 'osc:/awj/layer/1/x', kind: 'button', down: true }
  );
  assert.deepEqual(
    oscEvent({ id: oscControlId(address), kind: 'fader' }, msg),
    { control: 'osc:/awj/layer/1/x', kind: 'absolute', value: 1 }
  );
  assert.deepEqual(
    oscEvent({ id: oscControlId(address), kind: 'encoder' }, { address, args: [-2] }),
    { control: 'osc:/awj/layer/1/x', kind: 'relative', delta: -2 }
  );
});

test('a bare address is a press, and an out-of-range fader is clamped', () => {
  const control = { id: 'osc:/awj/take', kind: 'button' };
  assert.equal(oscEvent(control, { address: '/awj/take', args: [] }).down, true);
  assert.equal(oscEvent(control, { address: '/awj/take', args: [0] }).down, false);

  const fader = { id: 'osc:/awj/x', kind: 'fader' };
  assert.equal(oscEvent(fader, { address: '/awj/x', args: [3] }).value, 1);
  assert.equal(oscEvent(fader, { address: '/awj/x', args: [-3] }).value, 0);
});
