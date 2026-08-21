/*
 * The read-only guard.
 *
 * Show hardware runs under a standing read-only rule, and a rule that depends
 * on remembering a flag is not a safeguard. These tests assert that the write
 * path is structurally unreachable — including the subscription list, which is
 * itself a `replace` and is the easy one to forget.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { AwjClient } from '../hosts/node/awj.js';
import { layerParam, screenGroupParam } from '../core/paths.js';

/** A client with a stubbed socket, so nothing needs a device. */
function stubbed({ readOnly }) {
  const client = new AwjClient({ host: '203.0.113.1', readOnly });
  const sent = [];
  client.connected = true;
  client.socket = { write: (data) => sent.push(data) };
  return { client, sent };
}

test('a read-only client refuses to write a property', () => {
  const { client, sent } = stubbed({ readOnly: true });
  assert.throws(
    () => client.set(layerParam('S1', 'A', 1, ['opacity', 'pp', 'opacity']), 0),
    (err) => err.code === 'EREADONLY'
  );
  assert.equal(sent.length, 0, 'nothing may reach the socket');
});

test('a read-only client refuses to write the Subscriptions list', () => {
  const { client, sent } = stubbed({ readOnly: true });
  /* Subscribing looks like a read but is a `replace` on the Subscriptions
     path. Forgetting that is how a "read-only" tool writes to a live frame. */
  assert.throws(
    () => client.subscribe([screenGroupParam('S1', ['control', 'pp'])]),
    (err) => err.code === 'EREADONLY'
  );
  assert.equal(sent.length, 0);
});

test('a read-only client still reads', () => {
  const { client, sent } = stubbed({ readOnly: true });
  client.get(screenGroupParam('S1', ['status', 'pp', 'transition'])).catch(() => {});
  assert.equal(sent.length, 1);
  const msg = JSON.parse(sent[0].slice(0, -1));
  assert.equal(msg.op, 'get');
  assert.equal(msg.path, 'DeviceObject/$screenAuxGroup/@items/S1/status/@props/transition');
});

test('a read-only client never emits the string "replace" at all', () => {
  const { client, sent } = stubbed({ readOnly: true });
  for (const attempt of [
    () => client.set('DeviceObject/$screenAuxGroup/@items/S1/control/@props/xTake', true),
    () => client.subscribe(['DeviceObject'])
  ]) {
    try { attempt(); } catch { /* expected */ }
  }
  client.get(['device']).catch(() => {});
  assert.ok(sent.every((frame) => !frame.includes('replace')),
    'a TAKE or a subscription must never reach the wire in this mode');
});

test('a normal client writes exactly one 0x04-terminated replace', () => {
  const { client, sent } = stubbed({ readOnly: false });
  client.set(screenGroupParam('S1', ['control', 'pp', 'xTake']), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].charCodeAt(sent[0].length - 1), 0x04, 'terminator is EOT, not a newline');
  const msg = JSON.parse(sent[0].slice(0, -1));
  assert.deepEqual(msg, {
    op: 'replace',
    path: 'DeviceObject/$screenAuxGroup/@items/S1/control/@props/xTake',
    value: true
  });
});
