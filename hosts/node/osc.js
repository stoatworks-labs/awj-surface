/*
 * OSC 1.0 — codec and UDP transport.
 *
 * OSC is the reason the local server exists. It is a UDP protocol, and neither
 * a browser page nor a Manifest V3 extension can open a UDP socket: Chrome's
 * `chrome.sockets.udp` went away with Chrome Apps and was never replaced. So
 * MIDI can live in the extension, and OSC cannot live anywhere but here.
 *
 * Implemented by hand rather than pulled from a package because the wire format
 * is small and completely specified: strings and blobs are null-terminated and
 * padded to a multiple of four, numbers are big-endian, and the type tag string
 * says what follows.
 */

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';

const pad4 = (n) => (n + 3) & ~3;

/* ------------------------------------------------------------- decoding */

function readString(buf, at) {
  let end = at;
  while (end < buf.length && buf[end] !== 0) end++;
  if (end >= buf.length) throw new Error('unterminated OSC string');
  return { value: buf.toString('ascii', at, end), next: at + pad4(end - at + 1) };
}

/**
 * Decode one OSC packet.
 *
 * Bundles are flattened to their messages. Their time tags are read but not
 * honoured — a control surface wants the newest value now, and holding
 * messages for a future timestamp would add latency to the one thing that
 * must not have any.
 */
export function decodePacket(buf) {
  if (buf.length >= 8 && buf.toString('ascii', 0, 7) === '#bundle') {
    const out = [];
    let at = 16; // 8 bytes of '#bundle\0' + 8 bytes of time tag
    while (at + 4 <= buf.length) {
      const size = buf.readInt32BE(at);
      at += 4;
      if (size <= 0 || at + size > buf.length) break;
      out.push(...decodePacket(buf.subarray(at, at + size)));
      at += size;
    }
    return out;
  }

  const { value: address, next } = readString(buf, 0);
  if (!address.startsWith('/')) throw new Error(`not an OSC address: ${address}`);
  const args = [];
  if (next >= buf.length) return [{ address, args }];

  const { value: tags, next: argsAt } = readString(buf, next);
  let at = argsAt;
  for (const tag of tags.slice(1)) {
    switch (tag) {
      case 'i': args.push(buf.readInt32BE(at)); at += 4; break;
      case 'f': args.push(buf.readFloatBE(at)); at += 4; break;
      case 'd': args.push(buf.readDoubleBE(at)); at += 8; break;
      case 'h': args.push(Number(buf.readBigInt64BE(at))); at += 8; break;
      case 's':
      case 'S': { const s = readString(buf, at); args.push(s.value); at = s.next; break; }
      case 'b': {
        const size = buf.readInt32BE(at);
        args.push(Buffer.from(buf.subarray(at + 4, at + 4 + size)));
        at += 4 + pad4(size);
        break;
      }
      /* These carry no payload — the tag IS the value. */
      case 'T': args.push(true); break;
      case 'F': args.push(false); break;
      case 'N': args.push(null); break;
      case 'I': args.push(Infinity); break;
      default: throw new Error(`unsupported OSC type tag '${tag}' in ${address}`);
    }
  }
  return [{ address, args }];
}

/* ------------------------------------------------------------- encoding */

function writeString(str) {
  const raw = Buffer.from(String(str), 'ascii');
  const out = Buffer.alloc(pad4(raw.length + 1));
  raw.copy(out);
  return out;
}

/**
 * Encode one OSC message.
 *
 * Numbers go out as floats unless they are exact integers, which is what every
 * OSC surface expects for a 0..1 control and keeps integer parameters integral.
 */
export function encodeMessage(address, args = []) {
  const parts = [writeString(address)];
  let tags = ',';
  const payload = [];
  for (const arg of args) {
    if (typeof arg === 'boolean') { tags += arg ? 'T' : 'F'; continue; }
    if (arg === null) { tags += 'N'; continue; }
    if (typeof arg === 'string') { tags += 's'; payload.push(writeString(arg)); continue; }
    if (Buffer.isBuffer(arg)) {
      tags += 'b';
      const size = Buffer.alloc(4);
      size.writeInt32BE(arg.length);
      const body = Buffer.alloc(pad4(arg.length));
      arg.copy(body);
      payload.push(size, body);
      continue;
    }
    if (Number.isInteger(arg)) {
      tags += 'i';
      const b = Buffer.alloc(4);
      b.writeInt32BE(arg);
      payload.push(b);
      continue;
    }
    tags += 'f';
    const b = Buffer.alloc(4);
    b.writeFloatBE(arg);
    payload.push(b);
  }
  return Buffer.concat([parts[0], writeString(tags), ...payload]);
}

/* ------------------------------------------------------------ transport */

export class OscPort extends EventEmitter {
  /**
   * @param listenPort  UDP port to receive on (TouchOSC's default send is 8000)
   * @param replyPort   UDP port to send feedback to (TouchOSC listens on 9000)
   * @param replyHost   where to send feedback; defaults to whoever last sent
   */
  constructor({ listenPort = 8000, replyPort = 9000, replyHost = null } = {}) {
    super();
    this.listenPort = listenPort;
    this.replyPort = replyPort;
    this.replyHost = replyHost;
    this.socket = null;
    /*
     * Most OSC surfaces are configured with a destination but roam between
     * addresses (a tablet on wifi). Remembering where the last message came
     * from means feedback follows the surface without reconfiguration.
     */
    this.lastSender = null;
  }

  open() {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.socket = socket;
      socket.once('error', reject);
      socket.on('message', (buf, rinfo) => {
        this.lastSender = rinfo.address;
        let messages;
        try {
          messages = decodePacket(buf);
        } catch (err) {
          this.emit('error', err);
          return;
        }
        for (const m of messages) this.emit('message', m, rinfo);
      });
      socket.bind(this.listenPort, () => {
        socket.off('error', reject);
        socket.on('error', (err) => this.emit('error', err));
        resolve(this);
      });
    });
  }

  send(address, args = []) {
    const host = this.replyHost ?? this.lastSender;
    if (!this.socket || !host) return false;
    this.socket.send(encodeMessage(address, args), this.replyPort, host);
    return true;
  }

  close() {
    this.socket?.close();
    this.socket = null;
  }
}

/*
 * OSC addresses are control ids, prefixed so they cannot collide with a MIDI
 * one. That is the whole integration: an OSC control is declared in a profile
 * exactly like a fader, and everything above this file is unchanged.
 */
export const oscControlId = (address) => `osc:${address}`;
export const oscAddress = (controlId) =>
  controlId.startsWith('osc:') ? controlId.slice(4) : null;

/**
 * Turn an OSC message into a control event.
 *
 * `kind` comes from the profile, as it does for MIDI: the same `/layer/1/x`
 * address is an absolute position if it is declared a fader and a press if it
 * is declared a button, and only the profile can say which.
 */
export function oscEvent(control, message) {
  const arg = message.args[0];
  switch (control?.kind) {
    case 'button':
      /* A button surface may send 1/0, true/false, or a bare address with no
         argument at all for a momentary tap. All three mean "pressed". */
      return { control: control.id, kind: 'button', down: arg === undefined ? true : !!arg };
    case 'encoder':
      return { control: control.id, kind: 'relative', delta: Number(arg) || 0 };
    case 'fader':
    case 'fader14':
    case 'knob':
    default:
      return { control: control.id, kind: 'absolute', value: Math.max(0, Math.min(1, Number(arg) || 0)) };
  }
}
