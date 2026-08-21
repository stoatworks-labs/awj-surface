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
 * Open the port a profile asks for.
 *
 * A profile's `match.namePattern` is tried against the attached ports, which is
 * what makes "plug in the X-Touch and it works" possible. Falling back to a
 * virtual port is deliberate: a surface that is not plugged in should not stop
 * the rest of the tool from running.
 */
export async function openPort({ name, pattern } = {}) {
  const backend = await loadBackend();
  if (!backend) return new VirtualPort(name ?? 'Virtual Surface');

  const input = new backend.midi.Input();
  let found = null;
  for (let i = 0; i < input.getPortCount(); i++) {
    const portName = input.getPortName(i);
    if (name ? portName === name : pattern && new RegExp(pattern, 'i').test(portName)) {
      found = { index: i, name: portName };
      break;
    }
  }
  try { input.closePort(); } catch { /* nothing was opened */ }
  if (!found) return new VirtualPort(name ?? pattern ?? 'Virtual Surface');
  return new HardwarePort(backend.midi, found.name, found.index);
}
