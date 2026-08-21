/*
 * MIDI ports.
 *
 * Node has no MIDI in its standard library, and every binding that provides it
 * is a native module needing a compiler. That is a heavy dependency for a tool
 * whose whole point is to be droppable onto a show laptop, so it is optional:
 * if a binding is installed it is used, and if not, the virtual port still
 * carries the on-screen surface and the tests.
 *
 * This is not a fallback for missing hardware so much as the primary path for
 * developing without any. A virtual port is byte-for-byte the same interface a
 * real one presents, so nothing above this file can tell the difference.
 */

import { EventEmitter } from 'node:events';

/**
 * A port with no hardware behind it.
 *
 * `receive` injects bytes as though a controller had sent them; anything the
 * host sends out is emitted as `sent` for an emulator to draw. The on-screen
 * surface in the web UI is exactly this, wired to a browser.
 */
export class VirtualPort extends EventEmitter {
  constructor(name = 'Virtual Surface') {
    super();
    this.name = name;
    this.type = 'virtual';
    this.open = true;
  }

  /** Called by the host to drive the surface. */
  send(bytes) {
    if (!this.open) return;
    this.emit('sent', Array.from(bytes));
  }

  /** Called by an emulator to act as though a control was moved. */
  receive(bytes) {
    if (!this.open) return;
    this.emit('message', bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
  }

  close() {
    this.open = false;
    this.emit('close');
  }
}

/*
 * Bindings are tried in order of how well they behave, and all are optional.
 * `@julusian/midi` is the maintained fork of node-midi and the one most likely
 * to build on a current Node; `easymidi` wraps it with a friendlier surface.
 */
const BACKENDS = ['@julusian/midi', 'midi'];

/**
 * Load a native MIDI binding, or return null.
 *
 * Never throws: not having MIDI hardware support is an ordinary state for this
 * tool, not an error, and the caller carries on with virtual ports.
 */
export async function loadBackend() {
  for (const name of BACKENDS) {
    try {
      const mod = await import(name);
      return { name, midi: mod.default ?? mod };
    } catch {
      /* Not installed, or built for another Node ABI. Try the next. */
    }
  }
  return null;
}

/** A real hardware port, if a binding is available. */
export class HardwarePort extends EventEmitter {
  constructor(midi, name, index) {
    super();
    this.name = name;
    this.type = 'hardware';
    this.open = true;
    this.input = new midi.Input();
    this.output = new midi.Output();
    /*
     * Surfaces with scribble strips and LED rings are configured over SysEx,
     * and node-midi ignores SysEx by default. Without this the X-Touch's LCDs
     * never light and the failure is completely silent.
     */
    this.input.ignoreTypes(false, true, true);
    this.input.on('message', (_delta, message) => this.emit('message', Uint8Array.from(message)));
    this.input.openPort(index);
    const outIndex = findPort(this.output, name) ?? index;
    this.output.openPort(outIndex);
  }

  send(bytes) {
    if (this.open) this.output.sendMessage(Array.from(bytes));
  }

  close() {
    this.open = false;
    try { this.input.closePort(); this.output.closePort(); } catch { /* already gone */ }
    this.emit('close');
  }
}

function findPort(port, name) {
  for (let i = 0; i < port.getPortCount(); i++) {
    if (port.getPortName(i) === name) return i;
  }
  return null;
}

/** List the hardware inputs currently attached. */
export async function listPorts() {
  const backend = await loadBackend();
  if (!backend) return { backend: null, ports: [] };
  const input = new backend.midi.Input();
  const ports = [];
  for (let i = 0; i < input.getPortCount(); i++) ports.push({ index: i, name: input.getPortName(i) });
  input.closePort?.();
  return { backend: backend.name, ports };
}

/**
 * Decide which attached port to open.
 *
 * Pure, so it can be tested without a MIDI binding or any hardware.
 *
 * The generic case is the one that matters. A profile written for a specific
 * surface carries a `match.namePattern` and finds itself; a *generic* profile
 * carries none, and the original code then matched nothing and silently handed
 * back a virtual port — so plugging in an unlisted controller and choosing the
 * generic profile produced a surface that looked connected and was deaf.
 *
 * With nothing to match on:
 *   one port   open it. There is no ambiguity and no reason to ask.
 *   several    do not guess. Which controller is "the" controller is the
 *              user's call, and picking the wrong one wastes their time in a
 *              way that is hard to diagnose. Report the candidates instead.
 *   none       virtual, as before.
 *
 * `name` accepts an exact name, a case-insensitive substring, or an index, so
 * `--midi 1` and `--midi apc` both work.
 */
export function chooseInput(ports, { name, pattern } = {}) {
  if (!ports.length) return { port: null, reason: 'no MIDI inputs attached' };

  if (name !== undefined && name !== null && name !== '') {
    const exact = ports.find((p) => p.name === name);
    if (exact) return { port: exact };
    if (/^\d+$/.test(String(name))) {
      const byIndex = ports[Number(name)];
      if (byIndex) return { port: byIndex };
    }
    const needle = String(name).toLowerCase();
    const partial = ports.filter((p) => p.name.toLowerCase().includes(needle));
    if (partial.length === 1) return { port: partial[0] };
    if (partial.length > 1) {
      return { port: null, reason: `"${name}" matches ${partial.length} ports`, candidates: partial };
    }
    return { port: null, reason: `no MIDI input matches "${name}"`, candidates: ports };
  }

  if (pattern) {
    const re = new RegExp(pattern, 'i');
    const hit = ports.filter((p) => re.test(p.name));
    if (hit.length) return { port: hit[0] };
    return { port: null, reason: `no MIDI input matches /${pattern}/i`, candidates: ports };
  }

  if (ports.length === 1) return { port: ports[0], reason: 'the only input attached' };
  return {
    port: null,
    reason: `${ports.length} MIDI inputs attached — pick one`,
    candidates: ports
  };
}

/**
 * Open a port, or fall back to a virtual one.
 *
 * Falling back is deliberate: a surface that is not plugged in must not stop
 * the rest of the tool from running. What the fallback must never do is be
 * silent about it, so the reason travels back on the port itself.
 */
export async function openPort({ name, pattern } = {}) {
  const backend = await loadBackend();
  if (!backend) {
    const port = new VirtualPort(name ?? 'Virtual Surface');
    port.reason = 'no MIDI binding installed (npm i @julusian/midi to enable hardware)';
    return port;
  }

  const input = new backend.midi.Input();
  const ports = [];
  for (let i = 0; i < input.getPortCount(); i++) ports.push({ index: i, name: input.getPortName(i) });
  try { input.closePort(); } catch { /* nothing was opened */ }

  const choice = chooseInput(ports, { name, pattern });
  if (!choice.port) {
    const port = new VirtualPort(name ?? pattern ?? 'Virtual Surface');
    port.reason = choice.reason;
    port.candidates = choice.candidates ?? [];
    return port;
  }
  const port = new HardwarePort(backend.midi, choice.port.name, choice.port.index);
  port.reason = choice.reason ?? null;
  port.candidates = ports;
  return port;
}
