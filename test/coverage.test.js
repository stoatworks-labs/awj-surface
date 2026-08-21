/*
 * Profile coverage and control classification.
 *
 * This is the tooling that exists because every shipped profile was
 * transcribed from a manual and none has met its hardware. The tests are about
 * the two answers bring-up needs: what did the profile promise that never
 * arrived, and what arrived that the profile never promised.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { coverage, classify, summarise } from '../core/coverage.js';
import { encodeRelative } from '../core/midi/encoders.js';

const profile = {
  id: 'p',
  controls: [
    { id: 'cc:0:7', kind: 'fader', label: 'Fader 1' },
    { id: 'note:0:51', kind: 'button', label: 'Select 1' },
    { id: 'cc:0:16', kind: 'encoder', label: 'V-Pot 1' }
  ],
  bindings: [{ control: 'cc:0:7', target: { kind: 'layer', param: 'opacity.opacity' } }]
};

test('coverage separates what never arrived from what was never declared', () => {
  const seen = new Map([
    ['cc:0:7', { count: 40 }],
    ['note:0:51', { count: 2 }],
    ['cc:3:99', { count: 7 }]   // a control nobody wrote down
  ]);
  const c = coverage(profile, seen);

  assert.deepEqual(c.stats, { declared: 3, confirmed: 2, missing: 1, unexpected: 1 });
  assert.deepEqual(c.missing.map((m) => m.id), ['cc:0:16'],
    'the V-Pot was declared and never sent — most likely a wrong CC number');
  assert.deepEqual(c.unexpected.map((u) => u.id), ['cc:3:99']);
});

test('coverage reports whether a confirmed control is actually bound', () => {
  const c = coverage(profile, new Map([['note:0:51', { count: 1 }]]));
  const fader = c.expected.find((e) => e.id === 'cc:0:7');
  const button = c.expected.find((e) => e.id === 'note:0:51');
  assert.equal(fader.bound, true);
  assert.equal(button.bound, false, 'seen but unbound is a real state, not an error');
});

test('an empty profile makes everything unexpected', () => {
  const c = coverage({ id: 'x', controls: [], bindings: [] }, new Map([['cc:0:1', { count: 3 }]]));
  assert.equal(c.stats.declared, 0);
  assert.equal(c.stats.unexpected, 1);
});

test('classify tells an encoder from a fader by where the values sit', () => {
  /* The failure this catches: a sign-magnitude encoder read as a fader. It
     never sweeps — it emits small numbers and numbers just above 0x40. */
  const ticks = [1, 1, 2, -1, -1, -3].map((d) => ({ type: 'cc', value: encodeRelative(d, 'signed') }));
  assert.equal(classify(ticks).kind, 'encoder');
  assert.equal(classify(ticks).relative, 'signed');

  const offset = [1, 2, -1, -2, 1].map((d) => ({ type: 'cc', value: encodeRelative(d, 'offset') }));
  assert.equal(classify(offset).relative, 'offset');

  const sweep = Array.from({ length: 20 }, (_, i) => ({ type: 'cc', value: i * 6 }));
  assert.equal(classify(sweep).kind, 'fader');
});

test('classify recognises notes and pitch bend outright', () => {
  assert.equal(classify([{ type: 'noteOn', velocity: 127 }]).kind, 'button');
  assert.equal(classify([{ type: 'noteOff' }]).kind, 'button');
  assert.equal(classify([{ type: 'pitchBend', value: 900 }]).kind, 'fader14');
  assert.equal(classify([]).kind, null);
});

test('summarise reads as a sentence', () => {
  const c = coverage(profile, new Map([['cc:0:7', { count: 1 }], ['cc:9:9', { count: 1 }]]));
  assert.equal(summarise(c), '1/3 controls confirmed, 2 never seen, 1 not in the profile');
});
