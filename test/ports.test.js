/*
 * Choosing a MIDI input.
 *
 * The case that matters is the generic one. A profile written for a named
 * surface finds itself by pattern; a generic profile has no pattern, and the
 * original code then matched nothing and silently handed back a virtual port —
 * so an unlisted controller appeared connected and was deaf.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { chooseInput } from '../hosts/node/midi.js';

const ports = [
  { index: 0, name: 'IAC Driver Bus 1' },
  { index: 1, name: 'Akai APC40' },
  { index: 2, name: 'X-Touch INT' }
];

test('a generic profile with one attached port just opens it', () => {
  const only = [{ index: 0, name: 'Some Controller' }];
  const choice = chooseInput(only, {});
  assert.equal(choice.port.name, 'Some Controller');
});

test('a generic profile with several ports refuses to guess', () => {
  const choice = chooseInput(ports, {});
  assert.equal(choice.port, null, 'picking the wrong controller is hard to diagnose');
  assert.equal(choice.candidates.length, 3, 'but it must say what the options were');
  assert.match(choice.reason, /pick one/);
});

test('a profile pattern finds its own surface', () => {
  assert.equal(chooseInput(ports, { pattern: 'X-Touch' }).port.name, 'X-Touch INT');
  assert.equal(chooseInput(ports, { pattern: 'APC40' }).port.name, 'Akai APC40');
});

test('a pattern that matches nothing reports the alternatives', () => {
  const choice = chooseInput(ports, { pattern: 'Launchpad' });
  assert.equal(choice.port, null);
  assert.equal(choice.candidates.length, 3);
});

test('an explicit name beats the profile pattern, exactly or loosely', () => {
  assert.equal(chooseInput(ports, { name: 'Akai APC40' }).port.index, 1, 'exact');
  assert.equal(chooseInput(ports, { name: 'apc' }).port.index, 1, 'case-insensitive substring');
  assert.equal(chooseInput(ports, { name: '2' }).port.index, 2, 'by index, so --midi 2 works');
});

test('an ambiguous name is refused rather than resolved arbitrarily', () => {
  const two = [...ports, { index: 3, name: 'Akai APC40 mkII' }];
  const choice = chooseInput(two, { name: 'akai' });
  assert.equal(choice.port, null);
  assert.equal(choice.candidates.length, 2);
});

test('no ports at all is a reason, not a crash', () => {
  const choice = chooseInput([], { pattern: 'X-Touch' });
  assert.equal(choice.port, null);
  assert.match(choice.reason, /no MIDI inputs/);
});
