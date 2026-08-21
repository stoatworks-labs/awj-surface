/*
 * The AWJ protocol client — TCP 10606.
 *
 * The device is one JSON object and writing a property IS the command. Each
 * message is a single JSON object terminated by ASCII 0x04, not a newline, and
 * only two operations exist: `get` and `replace`.
 *
 * Three things about this protocol shape the client:
 *
 *   Replies carry no request id, only the path they answer. Correlation is
 *   therefore by path, and two gets in flight for the same path have to queue.
 *
 *   Writes are answered with nothing at all. Success is silent, so a write is
 *   fire-and-forget and the only way to confirm one is to read it back.
 *
 *   Subscriptions start EMPTY. A freshly connected client is told nothing about
 *   any change until it writes a subscription list, which is the single most
 *   common way to end up with a client that appears connected but dead.
 *
 * There is also a hard limit of five concurrent AWJ clients, and the port can
 * be switched off in the Web RCS security settings — worth checking before
 * blaming the code.
 */

import { Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { toAwj, fromAwj } from '../../core/paths.js';

const EOT = 0x04;
export const AWJ_PORT = 10606;

export class AwjClient extends EventEmitter {
  /**
   * @param readOnly  refuse to emit any `replace` at all, including the
   *                  Subscriptions list. Show hardware runs under a standing
   *                  read-only rule, and a flag that is merely *remembered* is
   *                  not a safeguard — this makes the write path throw.
   */
  constructor({ host, port = AWJ_PORT, timeout = 5000, readOnly = false } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.timeout = timeout;
    this.readOnly = readOnly;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.waiting = new Map();   // awj path -> [resolve, ...]
    this.connected = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      this.socket = socket;
      socket.setNoDelay(true);
      socket.once('error', reject);
      socket.connect(this.port, this.host, () => {
        socket.off('error', reject);
        socket.on('error', (err) => this.emit('error', err));
        socket.on('close', () => {
          this.connected = false;
          this.emit('close');
        });
        this.connected = true;
        resolve(this);
      });
      socket.on('data', (chunk) => this.feed(chunk));
    });
  }

  /** Split the stream on 0x04 and dispatch each complete message. */
  feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let at;
    while ((at = this.buffer.indexOf(EOT)) >= 0) {
      const raw = this.buffer.subarray(0, at).toString('utf8');
      this.buffer = this.buffer.subarray(at + 1);
      if (!raw) continue;
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        this.emit('error', new Error(`unparseable AWJ frame: ${raw.slice(0, 120)}`));
        continue;
      }
      this.dispatch(msg);
    }
  }

  dispatch(msg) {
    if (msg.error) {
      /*
       * E12 means the path does not exist on this firmware. It is not a
       * transport failure — it is the useful answer to "does this path exist",
       * and firmware 6.2 moved several paths the v4.0 guide still documents.
       */
      const path = /Unexpected path "([^"]+)"/.exec(msg.error.message ?? '')?.[1];
      const queue = path ? this.waiting.get(path) : null;
      if (queue?.length) queue.shift()({ error: msg.error });
      else this.emit('protocolError', msg.error);
      return;
    }
    const queue = this.waiting.get(msg.path);
    if (queue?.length) { queue.shift()({ value: msg.value }); return; }
    /*
     * Writing the subscription list echoes it straight back, and it is not a
     * device path — passing it on as a change would put a bogus "Subscriptions"
     * entry into the mirror. It is a useful confirmation, though, so it gets
     * its own event.
     */
    if (msg.path === 'Subscriptions') { this.emit('subscribed', msg.value); return; }
    /* Anything else that is not answering a get is a subscription push. */
    this.emit('change', { path: fromAwj(msg.path), value: msg.value });
  }

  send(obj) {
    if (!this.socket || !this.connected) throw new Error('AWJ socket is not connected');
    /* The terminator is ASCII EOT, not a newline. A newline-terminated
       message leaves the device waiting forever and reports nothing. */
    this.socket.write(JSON.stringify(obj) + String.fromCharCode(EOT));
  }

  /**
   * Read one property.
   *
   * Resolves to the value, or throws on E12. Container reads are legal but
   * always come back `{}` — AWJ is leaf-read-only and the object model cannot
   * be enumerated over it, which is what the catalogue generator is for.
   */
  get(path) {
    const awj = typeof path === 'string' ? path : toAwj(path);
    return new Promise((resolve, reject) => {
      if (!this.waiting.has(awj)) this.waiting.set(awj, []);
      const timer = setTimeout(() => {
        const q = this.waiting.get(awj);
        const at = q.indexOf(settle);
        if (at >= 0) q.splice(at, 1);
        reject(new Error(`AWJ get timed out: ${awj}`));
      }, this.timeout);
      const settle = (result) => {
        clearTimeout(timer);
        if (result.error) reject(Object.assign(new Error(result.error.message), { code: result.error.code }));
        else resolve(result.value);
      };
      this.waiting.get(awj).push(settle);
      this.send({ op: 'get', path: awj });
    });
  }

  /** Write one property. Silent on success, so nothing is returned. */
  set(path, value) {
    this.assertWritable(`write ${typeof path === 'string' ? path : toAwj(path)}`);
    this.send({ op: 'replace', path: typeof path === 'string' ? path : toAwj(path), value });
  }

  /**
   * Guard every outbound `replace`.
   *
   * Throwing rather than quietly dropping is deliberate: a silently discarded
   * write looks exactly like a device that ignored you, and the whole failure
   * mode this protects against is silence — recalls and TAKEs return nothing,
   * so a mistake here is invisible either way.
   */
  assertWritable(what) {
    if (this.readOnly) {
      throw Object.assign(
        new Error(`refusing to ${what}: this client is read-only`),
        { code: 'EREADONLY' }
      );
    }
  }

  /**
   * Replace the subscription list.
   *
   * Matching is by prefix: a change is pushed when its path STARTS WITH one of
   * these strings. Subscribing to a screen's control props therefore covers
   * every property under them.
   */
  subscribe(paths) {
    /*
     * Subscribing is itself a `replace` on the Subscriptions path, so it is a
     * write like any other and is blocked in read-only mode. The cost is that
     * nothing is pushed; poll with `get` instead.
     */
    this.assertWritable('write the Subscriptions list');
    this.send({
      op: 'replace',
      path: 'Subscriptions',
      value: paths.map((p) => (typeof p === 'string' ? p : toAwj(p)))
    });
  }

  /**
   * Does this path exist on this firmware?
   *
   * Unknown paths answer E12, which makes a free existence oracle — useful for
   * diffing a path table against a firmware, though not for inventorying a
   * show: validity is the model's maximum, not what is configured.
   */
  async exists(path) {
    try {
      await this.get(path);
      return true;
    } catch (err) {
      if (err.code === 'E12') return false;
      throw err;
    }
  }

  close() {
    this.connected = false;
    this.socket?.end();
    this.socket?.destroy();
  }
}
