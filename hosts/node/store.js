/*
 * The device mirror.
 *
 * The engine asks for values by path and must get an answer immediately, so
 * something has to hold a copy of the device's state. Two sources fill it:
 *
 *   a snapshot   GET /api/stores/device returns the ENTIRE store as one JSON
 *                document. On a large frame that is well over 100 MB, and the
 *                vendor's own client allows itself two minutes for it.
 *   a stream     AWJ subscription pushes, or the Web RCS socket, thereafter.
 *
 * The ordering between them is the trap. The snapshot is fetched over HTTP
 * while the stream keeps arriving, so changes that predate the fetch are
 * already folded into the snapshot; replaying them would walk state backwards.
 * Frames from the moment the fetch was ISSUED are safe to replay, because
 * applying a write twice is idempotent.
 */

import { EventEmitter } from 'node:events';
import { ROOT, key } from '../../core/paths.js';

export class DeviceStore extends EventEmitter {
  constructor() {
    super();
    this.root = null;
    this.ready = false;
    this.queued = [];
    this.hydrating = false;
  }

  /** Read a value by store path; undefined for anything absent. */
  get(path) {
    let node = this.root;
    for (const seg of path) {
      if (node == null || typeof node !== 'object') return undefined;
      node = node[seg];
    }
    return node;
  }

  /**
   * Apply one write from the device.
   *
   * Missing intermediate objects are created: the device sends values for
   * paths present in its model but not necessarily in our snapshot, and
   * dropping those would leave silent holes in the mirror.
   */
  set(path, value) {
    if (!this.ready) {
      if (this.hydrating) this.queued.push({ path, value });
      return false;
    }
    if (!this.root) this.root = { [ROOT]: {} };
    let node = this.root;
    for (let i = 0; i < path.length - 1; i++) {
      const seg = path[i];
      if (node[seg] == null || typeof node[seg] !== 'object') node[seg] = {};
      node = node[seg];
    }
    const leaf = path[path.length - 1];
    const before = node[leaf];
    if (before === value) return false;
    node[leaf] = value;
    this.emit('change', { path, value, before });
    return true;
  }

  /**
   * Fetch the whole store over HTTP and start applying the stream.
   *
   * Call this AFTER the stream is connected, not before: anything that changes
   * between the two is otherwise lost, and a value that never moves again
   * would stay wrong until the next restart.
   */
  async hydrate(baseUrl, { fetchImpl = fetch, onProgress } = {}) {
    this.hydrating = true;
    this.queued = [];
    onProgress?.('fetching device store');
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/stores/device`);
    if (!res.ok) throw new Error(`store fetch failed: HTTP ${res.status}`);
    const body = await res.json();
    this.root = body?.[ROOT] ? body : { [ROOT]: body };
    this.ready = true;
    this.hydrating = false;

    /* Replay what arrived while the fetch was in flight. */
    const queued = this.queued;
    this.queued = [];
    for (const { path, value } of queued) this.set(path, value);
    onProgress?.(`store ready, replayed ${queued.length} queued change(s)`);
    this.emit('ready');
    return this;
  }

  /**
   * Seed a mirror without the big snapshot.
   *
   * Reading the paths a profile actually uses is far cheaper than 100 MB, and
   * is what makes starting up against a real frame bearable. The cost is that
   * anything not read stays unknown, which the engine already handles: an
   * unknown value has no control position rather than a wrong one.
   */
  seed(entries) {
    this.root ??= { [ROOT]: {} };
    this.ready = true;
    for (const [path, value] of entries) this.set(path, value);
    this.emit('ready');
    return this;
  }

  /** Every leaf path currently held, for diagnostics. */
  size() {
    let n = 0;
    const walk = (node) => {
      if (node == null || typeof node !== 'object') { n++; return; }
      for (const v of Object.values(node)) walk(v);
    };
    walk(this.root);
    return n;
  }

  keyOf = key;
}
