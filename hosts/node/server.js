#!/usr/bin/env node
/*
 * awj-surface — local server host.
 *
 * Ties a controller to a LivePremier: MIDI and OSC in, AWJ out, and a web UI
 * for mapping, learning and driving an on-screen surface when the real one is
 * somewhere else.
 *
 * Zero dependencies by design. This is a tool that has to run on a show laptop
 * at short notice, so `node hosts/node/server.js` with a checkout is the whole
 * install. The web UI is served as plain ES modules with no build step, and it
 * imports the SAME core the engine uses, so the on-screen surface and a real
 * controller go through identical code.
 *
 *   node hosts/node/server.js --device 192.168.2.140 --profile x-touch-mcu
 *
 * Run with no --device and it starts in offline mode: the UI, the mapping
 * editor and the on-screen surface all work, and writes are logged instead of
 * sent. That is the right way to build a show file before you have the frame.
 */

import http from 'node:http';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Engine } from '../../core/engine.js';
import { MidiSurface } from '../../core/surface.js';
import { validate } from '../../core/profile.js';
import { coverage, classify, summarise } from '../../core/coverage.js';
import { toAwj, key, screenGroupParam, layerParam } from '../../core/paths.js';
import * as catalogue from '../../core/catalogue.js';

import { decode } from '../../core/midi/message.js';
import { AwjClient } from './awj.js';
import { DeviceStore } from './store.js';
import { OscPort, oscControlId, oscEvent } from './osc.js';
import { VirtualPort, openPort, listPorts } from './midi.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

/* Enough layers offline to exercise a full bank of eight strips and then some. */
const OFFLINE_LAYERS = 32;

/* ----------------------------------------------------------------- args */

function parseArgs(argv) {
  const opts = {
    device: null,
    port: 8532,
    profile: 'x-touch-mcu',
    oscIn: 8000,
    oscOut: 9000,
    oscHost: null,
    midi: null,
    screen: 'S1',
    hydrate: false,
    readOnly: false,
    pollMs: 2000
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=');
    const next = () => inline ?? argv[++i];
    switch (flag) {
      case '--device': case '-d': opts.device = next(); break;
      case '--port': case '-p': opts.port = Number(next()); break;
      case '--profile': opts.profile = next(); break;
      case '--osc-in': opts.oscIn = Number(next()); break;
      case '--osc-out': opts.oscOut = Number(next()); break;
      case '--osc-host': opts.oscHost = next(); break;
      case '--midi': opts.midi = next(); break;
      case '--screen': opts.screen = next(); break;
      /* Pulling the whole store is exhaustive but slow. Off by default: the
         engine only needs the paths its own bindings touch. */
      case '--hydrate': opts.hydrate = true; break;
      /* Show hardware runs under a standing read-only rule. This does not just
         skip writes — it builds an AWJ client whose write path throws. */
      case '--read-only': case '-r': opts.readOnly = true; break;
      case '--poll': opts.pollMs = Number(next()); break;
      case '--help': case '-h': opts.help = true; break;
      default:
        if (flag.startsWith('-')) throw new Error(`unknown flag ${flag}`);
    }
  }
  return opts;
}

const USAGE = `
awj-surface — MIDI/OSC control for Analog Way LivePremier

  --device, -d <host>   switcher or simulator address (omit for offline mode)
  --port, -p <n>        web UI port (default 8532)
  --profile <id>        controller profile (default x-touch-mcu)
  --midi <name>         MIDI port name; omit to auto-match the profile
  --osc-in <n>          OSC listen port (default 8000)
  --osc-out <n>         OSC feedback port (default 9000)
  --osc-host <ip>       OSC feedback destination (default: whoever last sent)
  --screen <Sn>         screen the surface starts pointed at (default S1)
  --hydrate             pull the entire device store instead of only what is
                        mapped. Exhaustive, but over 100 MB on a large frame.
  --read-only, -r       never emit an AWJ 'replace' — not even the Subscriptions
                        list. Control movements are logged, not sent. Use this
                        against any frame you are not authorised to write to.
  --poll <ms>           read-only mode has no push (subscribing is itself a
                        write), so it re-reads mapped paths on this interval.
                        Default 2000. 0 disables.
`;

/* ---------------------------------------------------------------- state */

class Host {
  constructor(opts) {
    this.opts = opts;
    this.store = new DeviceStore();
    this.awj = null;
    this.osc = null;
    this.port = null;
    this.surface = null;
    this.engine = null;
    this.clients = new Set();
    this.log = [];
    this.learn = null;
    /* Bring-up: what the surface has actually sent, per control. */
    this.seen = new Map();
    this.status = { device: null, awj: false, midi: null, osc: false, offline: !opts.device, readOnly: !!opts.readOnly };
    this.poll = null;
  }

  say(level, message) {
    const entry = { at: new Date().toISOString(), level, message };
    this.log.push(entry);
    if (this.log.length > 400) this.log.shift();
    this.broadcast({ type: 'log', ...entry });
    const tag = level === 'error' ? '!!' : level === 'warn' ? ' !' : '  ';
    process.stderr.write(`${tag} ${message}\n`);
  }

  broadcast(event) {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.clients) {
      try { res.write(frame); } catch { this.clients.delete(res); }
    }
  }

  /* -------------------------------------------------------------- setup */

  async loadProfile(id) {
    const file = join(root, 'profiles', `${id}.json`);
    if (!existsSync(file)) throw new Error(`no such profile: ${id}`);
    const profile = JSON.parse(await readFile(file, 'utf8'));

    /* A saved binding set for this profile overrides the shipped one: the
       hardware description is ours, the mapping is the user's. */
    const saved = join(root, 'profiles', 'saved', `${id}.json`);
    if (existsSync(saved)) {
      profile.bindings = JSON.parse(await readFile(saved, 'utf8'));
      this.say('info', `loaded saved bindings for ${id}`);
    }

    const problems = validate(profile);
    if (problems.length) throw new Error(`profile ${id} is invalid:\n  ${problems.join('\n  ')}`);
    return profile;
  }

  async saveBindings() {
    const dir = join(root, 'profiles', 'saved');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${this.engine.profile.id}.json`),
      JSON.stringify(this.engine.profile.bindings, null, 2) + '\n'
    );
  }

  async start() {
    const profile = await this.loadProfile(this.opts.profile);
    this.engine = new Engine(this.store, profile, {
      selection: { screen: this.opts.screen }
    });
    this.wireEngine();

    await this.connectDevice();
    await this.openMidi(profile);
    await this.openOsc();

    this.engine.refresh();
  }

  wireEngine() {
    this.engine.addEventListener('write', (e) => this.applyWrites(e.detail.writes));
    this.engine.addEventListener('feedback', (e) => {
      this.surface?.render(e.detail);
      this.sendOscFeedback(e.detail);
      this.broadcast({ type: 'feedback', feedback: serialisable(e.detail) });
    });
    this.engine.addEventListener('selection', (e) => {
      this.broadcast({ type: 'selection', selection: e.detail.selection });
      /* The set of watched paths moves with the selection, so the device
         subscription has to move with it too. */
      this.resubscribe();
    });
    this.engine.addEventListener('unresolved', (e) => {
      this.say('warn', `binding not applied: ${e.detail.reason}`);
    });
  }

  applyWrites(writes) {
    for (const w of writes) {
      const path = toAwj(w.path);
      this.broadcast({ type: 'write', path, value: w.value });
      if (!this.awj?.connected) {
        this.say('info', `offline write ${path} = ${JSON.stringify(w.value)}`);
        /* With no device to echo it back, hold the value locally so relative
           encoders and feedback still behave as they would on a real frame. */
        this.store.set(w.path, w.value);
        this.engine.deviceChanged(w.path);
        continue;
      }
      if (this.opts.readOnly) {
        /* Reported, not silently dropped: an operator moving a fader and seeing
           nothing happen deserves to be told why. */
        this.say('warn', `read-only, NOT sent: ${path} = ${JSON.stringify(w.value)}`);
        continue;
      }
      try {
        this.awj.set(w.path, w.value);
      } catch (err) {
        this.say('error', `write failed: ${err.message}`);
      }
    }
  }

  /* ------------------------------------------------------------- device */

  async connectDevice() {
    if (!this.opts.device) {
      this.say('warn', 'no --device given: running offline, writes are logged only');
      this.seedOffline();
      return;
    }
    const host = this.opts.device;
    this.awj = new AwjClient({ host, readOnly: this.opts.readOnly });
    this.awj.on('change', ({ path, value }) => {
      if (this.store.set(path, value)) this.engine.deviceChanged(path);
    });
    this.awj.on('error', (err) => this.say('error', `AWJ: ${err.message}`));
    this.awj.on('close', () => {
      this.status.awj = false;
      this.say('warn', 'AWJ socket closed');
      this.broadcast({ type: 'status', status: this.status });
    });

    try {
      await this.awj.connect();
    } catch (err) {
      this.say('error', `cannot reach ${host}:10606 — ${err.message}`);
      this.say('warn', 'the AWJ port can be disabled in Web RCS security settings, and only five clients may connect at once');
      this.seedOffline();
      return;
    }
    this.status.awj = true;
    if (this.opts.readOnly) {
      this.say('warn', 'READ-ONLY: no replace will be sent, not even Subscriptions');
    }

    try {
      this.status.device = await this.awj.get('DeviceObject/system/$device/@items/1/@props/dev');
      this.say('info', `connected to ${host} (${this.status.device})`);
    } catch {
      this.say('warn', 'connected, but the device would not name itself');
    }

    if (this.opts.hydrate) {
      try {
        await this.store.hydrate(`http://${host}`, { onProgress: (m) => this.say('info', m) });
      } catch (err) {
        this.say('error', `store hydrate failed: ${err.message}`);
      }
    } else {
      await this.seedFromAwj();
    }
    if (this.opts.readOnly) this.startPolling();
    else this.resubscribe();
  }

  /**
   * Keep the mirror fresh without writing anything.
   *
   * A subscription is a `replace` on the Subscriptions path, so read-only mode
   * gets no pushes at all and a value that moves on the device would otherwise
   * stay stale on the surface forever. Re-reading the mapped paths is pure
   * `get`, which is what a standing read-only rule permits.
   *
   * Deliberately serial and unhurried: this shares a five-client AWJ budget
   * with whatever else is on the frame, and monitoring must never be the thing
   * that costs someone a connection.
   */
  startPolling() {
    if (!this.opts.pollMs) {
      this.say('warn', 'read-only with polling disabled: values will not update');
      return;
    }
    const tick = async () => {
      if (!this.awj?.connected) return;
      const paths = this.engine.watchedPaths().filter((p) => p[p.length - 1] !== 'pp');
      for (const path of paths) {
        try {
          if (this.store.set(path, await this.awj.get(path))) this.engine.deviceChanged(path);
        } catch { /* E12 or a timeout; the next pass will try again */ }
      }
    };
    this.poll = setInterval(() => { tick().catch(() => {}); }, this.opts.pollMs);
    this.say('info', `read-only: polling ${this.opts.pollMs} ms (no subscription — that would be a write)`);
  }

  /**
   * Read the values this profile actually needs.
   *
   * Far cheaper than the full store, and it is what makes startup against a
   * real frame quick. Anything not read stays unknown, which the engine
   * already treats as "no position" rather than as zero.
   */
  async seedFromAwj() {
    this.store.seed([]);
    const read = async (paths) => {
      let ok = 0;
      for (const path of paths) {
        try {
          this.store.set(path, await this.awj.get(path));
          ok++;
        } catch (err) {
          /* E12 here means the profile references something this firmware does
             not have — worth saying once, not worth stopping for. */
          if (err.code === 'E12') this.say('warn', `not on this firmware: ${toAwj(path)}`);
        }
      }
      return ok;
    };

    /*
     * Two passes, and the order is not optional.
     *
     * A layer path contains a preset LETTER, and the letter for PREVIEW can
     * only be worked out from the screen group's own state. With an empty
     * mirror every layer binding resolves to nothing, so asking the engine
     * what to read before reading the groups returns almost nothing — the
     * take controls, and that is all.
     *
     * The group props have to be listed explicitly rather than read as a
     * container: AWJ is leaf-read-only and a container read comes back `{}`.
     * The catalogue knows every leaf, which is what it is for.
     */
    const screens = this.screensInScope();
    const groupPaths = [];
    for (const screen of screens) {
      for (const param of catalogue.screenGroupParams) {
        groupPaths.push(screenGroupParam(screen, param.path));
      }
    }
    await read(groupPaths);

    const already = new Set(groupPaths.map(key));
    const rest = this.engine.watchedPaths()
      .filter((p) => p[p.length - 1] !== 'pp' && !already.has(key(p)));
    const ok = await read(rest);
    this.say('info', `seeded ${screens.size} screen group(s) and ${ok} mapped values`);
  }


  /**
   * Stand up a plausible device so the surface works with nothing attached.
   *
   * Without this, offline mode cannot resolve a single layer binding: a layer
   * path needs a preset LETTER, the letter comes from the screen group, and an
   * empty mirror has no group — so every binding reports "preset not read yet"
   * and the surface does nothing at all. That makes the offline mode useless
   * for the thing it exists for, which is building a show file before the
   * frame arrives.
   *
   * The values below are the device's own documented defaults, taken from the
   * catalogue rather than invented, plus the A/B/C preset layout every screen
   * has. It is clearly labelled offline in the UI, so there is no risk of
   * mistaking it for a real read.
   */
  seedOffline() {
    const entries = [];
    for (const screen of this.screensInScope()) {
      for (const param of catalogue.screenGroupParams) {
        const value = param.def ?? (param.type === 'bool' ? false : param.type === 'enum' ? param.values?.[0] : 0);
        entries.push([screenGroupParam(screen, param.path), value]);
      }
      /* The letters and the resting transition are what make PREVIEW and
         PROGRAM resolvable at all. */
      entries.push([screenGroupParam(screen, ['control', 'pp', 'presetUp']), 'B']);
      entries.push([screenGroupParam(screen, ['control', 'pp', 'presetDown']), 'A']);
      entries.push([screenGroupParam(screen, ['control', 'pp', 'presetPrevious']), 'C']);
      entries.push([screenGroupParam(screen, ['status', 'pp', 'transition']), 'AT_DOWN']);

      for (const letter of ['A', 'B', 'C']) {
        for (let layer = 1; layer <= OFFLINE_LAYERS; layer++) {
          for (const param of catalogue.layerParams) {
            if (param.readOnly) continue;
            const value = param.def ?? (param.type === 'bool' ? false : param.type === 'enum' ? param.values?.[0] : 0);
            entries.push([layerParam(screen, letter, layer, param.path), value]);
          }
        }
      }
    }
    this.store.seed(entries);
    this.say('info', `offline: stood up ${OFFLINE_LAYERS} layers of device defaults so the surface is usable`);
  }

  /** Screens this profile can reach: the selected one plus any it can select. */
  screensInScope() {
    const screens = new Set([this.engine.selection.screen]);
    for (const binding of this.engine.profile.bindings ?? []) {
      const t = binding.target;
      if (t.kind === 'action' && t.action === 'selectScreen' && t.value) screens.add(t.value);
      if (t.kind !== 'action' && t.screen && t.screen !== '@selected') screens.add(t.screen);
    }
    return screens;
  }

  resubscribe() {
    if (!this.awj?.connected || this.opts.readOnly) return;
    /* Prefix matching means subscribing to a props bag covers everything in
       it, so the list stays short. */
    const prefixes = new Set();
    for (const path of this.engine.watchedPaths()) {
      const at = path.lastIndexOf('pp');
      prefixes.add(toAwj(at > 0 ? path.slice(0, at + 1) : path));
    }
    this.awj.subscribe([...prefixes]);
  }

  /* --------------------------------------------------------------- MIDI */

  async openMidi(profile, overrideName) {
    if (overrideName !== undefined) this.opts.midi = overrideName || null;
    this.port = await openPort({
      name: this.opts.midi,
      pattern: profile.match?.namePattern
    });
    this.status.midi = {
      name: this.port.name,
      type: this.port.type,
      reason: this.port.reason ?? null,
      candidates: this.port.candidates ?? []
    };
    this.surface = new MidiSurface(profile, (bytes) => this.port.send(bytes));

    this.port.on('message', (bytes) => this.onMidi(bytes));
    /* A virtual port's output is what the browser draws, so forward it. */
    if (this.port instanceof VirtualPort) {
      this.port.on('sent', (bytes) => this.broadcast({ type: 'midi-out', bytes }));
    }

    if (profile.init) {
      for (const bytes of profile.init) this.port.send(Uint8Array.from(bytes));
    }
    this.surface.reset();

    if (this.port.type === 'hardware') {
      this.say('info', `MIDI in: ${this.port.name}${this.port.reason ? ` (${this.port.reason})` : ''}`);
    } else {
      /* Never silent about falling back: a virtual port looks exactly like a
         controller that is plugged in and ignoring you. */
      this.say('warn', `virtual MIDI port — ${this.port.reason ?? 'no hardware matched'}`);
      for (const c of this.port.candidates ?? []) {
        this.say('info', `  available: [${c.index}] ${c.name}   (--midi ${c.index})`);
      }
      this.say('info', 'the on-screen surface drives the virtual port');
    }
  }

  onMidi(bytes) {
    const event = this.surface.handle(bytes);
    if (!event) return;
    this.observe(event, bytes);
    this.broadcast({ type: 'midi-in', bytes: Array.from(bytes), control: event.control, kind: event.kind });
    if (this.learn) { this.finishLearn(event); return; }
    if (event.kind === 'unmapped') return;
    this.engine.input(event);
  }

  /**
   * Record that a control moved.
   *
   * Kept for every control, mapped or not: the useful bring-up question is
   * what the surface actually emits, and a profile transcribed from a manual
   * is exactly the thing being checked. A short sample of raw messages is
   * retained per control so an unknown one can be classified — a handful is
   * plenty to tell a sweeping fader from a relative encoder, and keeping more
   * would grow without bound over a show.
   */
  observe(event, bytes) {
    let hit = this.seen.get(event.control);
    if (!hit) {
      hit = { count: 0, kind: event.kind, transport: event.osc ? 'osc' : 'midi', samples: [] };
      this.seen.set(event.control, hit);
    }
    hit.count++;
    hit.last = Date.now();
    if (hit.samples.length >= 24) return;

    if (event.osc) {
      /* An OSC argument is already a value, so it is recorded as one. There is
         no byte stream to decode and no relative encoding to detect. */
      hit.samples.push({ type: 'osc', value: event.args?.[0] });
      return;
    }
    const decoded = decode(bytes);
    if (decoded) hit.samples.push({ type: decoded.type, value: decoded.value, velocity: decoded.velocity });
  }

  /* ---------------------------------------------------------------- OSC */

  async openOsc() {
    this.osc = new OscPort({
      listenPort: this.opts.oscIn,
      replyPort: this.opts.oscOut,
      replyHost: this.opts.oscHost
    });
    this.osc.on('error', (err) => this.say('error', `OSC: ${err.message}`));
    this.osc.on('message', (msg) => this.onOsc(msg));
    try {
      await this.osc.open();
      this.status.osc = true;
      this.say('info', `OSC listening on ${this.opts.oscIn}, replying to ${this.opts.oscOut}`);
    } catch (err) {
      this.say('error', `OSC port ${this.opts.oscIn} unavailable: ${err.message}`);
    }
  }

  onOsc(msg) {
    const id = oscControlId(msg.address);
    const control = this.engine.controls.get(id);
    /*
     * OSC goes through the same observation path as MIDI, so an OSC surface
     * gets the same bring-up checklist. A TouchOSC layout is every bit as
     * likely to disagree with its profile as a transcribed MIDI chart — more
     * so, since the addresses are whatever whoever drew the layout typed.
     */
    this.observe({ control: id, kind: control?.kind ?? 'unmapped', osc: true, args: msg.args });
    this.broadcast({ type: 'osc-in', address: msg.address, args: msg.args, mapped: !!control });
    if (this.learn) {
      this.finishLearn({ control: id, kind: control ? 'known' : 'unmapped', osc: true, args: msg.args });
      return;
    }
    if (!control) return;
    this.engine.input(oscEvent(control, msg));
  }

  sendOscFeedback(fb) {
    if (!this.status.osc) return;
    const address = fb.control?.startsWith('osc:') ? fb.control.slice(4) : null;
    if (!address) return;
    const value = fb.position ?? (fb.lamp === null || fb.lamp === undefined ? null : (fb.lamp ? 1 : 0));
    if (value === null) return;
    this.osc.send(address, [value]);
  }

  /* -------------------------------------------------------------- learn */

  /**
   * Arm MIDI learn.
   *
   * The next control that moves is bound to `target`. Controls unknown to the
   * profile are added to it on the spot, which is what makes an unlisted
   * surface usable without anyone writing a profile by hand.
   */
  armLearn(request) {
    this.learn = request;
    this.broadcast({ type: 'learn', armed: true, target: request.target });
    this.say('info', 'learn armed: move a control');
  }

  finishLearn(event) {
    const request = this.learn;
    this.learn = null;
    if (!request) return;

    const profile = this.engine.profile;
    let control = this.engine.controls.get(event.control);
    if (!control) {
      control = {
        id: event.control,
        kind: request.kind ?? guessKind(event),
        label: event.control,
        ...(request.strip !== undefined ? { strip: request.strip } : {})
      };
      profile.controls = [...profile.controls, control];
    }

    profile.bindings = [
      ...profile.bindings.filter((b) => b.control !== control.id),
      { control: control.id, target: request.target, ...(request.options ? { options: request.options } : {}) }
    ];

    this.engine.setProfile(profile);
    this.surface.setProfile(profile);
    this.saveBindings().catch((err) => this.say('error', `could not save: ${err.message}`));
    this.broadcast({ type: 'learn', armed: false, control: control.id, profile: profile });
    this.say('info', `learned ${control.id} -> ${request.target.param ?? request.target.action}`);
    this.engine.refresh();
  }
}

/**
 * What kind of control just moved?
 *
 * Only a guess, and only used when learning a control the profile has never
 * seen. A note is a button until told otherwise; a CC could be a fader or an
 * encoder and the difference is not visible in one message, so it is assumed
 * to be a fader and can be changed in the UI.
 */
function guessKind(event) {
  if (event.control?.startsWith('note:')) return 'button';
  if (event.control?.startsWith('pb:')) return 'fader14';
  if (event.control?.startsWith('osc:')) {
    /*
     * OSC carries no hint of what a control IS — the same address is a fader
     * or a button depending only on how it is declared. The argument is the
     * one clue available: surfaces send booleans, or exactly 0/1, for buttons
     * and a continuous value for anything that slides. Defaulting everything
     * to `fader` made every learned OSC button a fader that could only ever
     * write its maximum.
     */
    const arg = event.args?.[0];
    if (arg === undefined || typeof arg === 'boolean') return 'button';
    if (arg === 0 || arg === 1) return 'button';
    return 'fader';
  }
  return 'fader';
}

/** Feedback events carry the control definition; strip it for the wire. */
const serialisable = (fb) => ({
  control: fb.control,
  binding: fb.binding ?? null,
  position: fb.position ?? null,
  lamp: fb.lamp ?? null,
  value: fb.value ?? null,
  top: fb.top ?? '',
  bottom: fb.bottom ?? '',
  path: fb.path ? toAwj(fb.path) : null
});

/* ----------------------------------------------------------------- HTTP */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': MIME['.json'], 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function createServer(host) {
  const publicDir = join(here, 'public');

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    try {
      if (path === '/api/events') return sse(host, res);

      if (path === '/api/state') {
        return json(res, 200, {
          status: host.status,
          selection: host.engine.selection,
          profile: host.engine.profile,
          catalogue: {
            device: catalogue.meta.device,
            suggested: catalogue.SUGGESTED,
            layer: catalogue.layerParams,
            screenGroup: catalogue.screenGroupParams
          },
          log: host.log.slice(-80)
        });
      }

      if (path === '/api/profiles') {
        const files = await readdir(join(root, 'profiles'));
        return json(res, 200, files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')));
      }

      if (path === '/api/ports') return json(res, 200, await listPorts());

      if (path === '/api/coverage') {
        const report = coverage(host.engine.profile, host.seen);
        /* Guess at what each unknown control is, so bring-up ends with
           something you can paste into a profile rather than a list of hex. */
        for (const item of report.unexpected) {
          item.guess = classify(host.seen.get(item.id)?.samples ?? []);
        }
        return json(res, 200, { ...report, summary: summarise(report) });
      }

      if (req.method === 'POST') {
        const body = await readBody(req);
        switch (path) {
          case '/api/midi':
            /* The on-screen surface sends real MIDI bytes, so it goes through
               exactly the same decode path as a plugged-in controller. */
            host.port.receive?.(Uint8Array.from(body.bytes));
            return json(res, 200, { ok: true });
          case '/api/input':
            host.engine.input(body);
            return json(res, 200, { ok: true });
          case '/api/coverage/reset':
            host.seen.clear();
            host.broadcast({ type: 'coverage-reset' });
            return json(res, 200, { ok: true });
          case '/api/learn':
            if (body.cancel) { host.learn = null; host.broadcast({ type: 'learn', armed: false }); }
            else host.armLearn(body);
            return json(res, 200, { ok: true });
          case '/api/binding': {
            const profile = host.engine.profile;
            profile.bindings = body.bindings;
            const problems = validate(profile);
            if (problems.length) return json(res, 400, { problems });
            host.engine.setProfile(profile);
            host.surface.setProfile(profile);
            await host.saveBindings();
            host.resubscribe();
            host.engine.refresh();
            return json(res, 200, { ok: true });
          }
          case '/api/port': {
            /* Switching input at runtime, so a generic surface can be picked
               from the UI rather than by restarting with a flag. */
            host.port?.close();
            await host.openMidi(host.engine.profile, body.name);
            host.broadcast({ type: 'status', status: host.status });
            host.engine.refresh();
            return json(res, 200, { ok: true, midi: host.status.midi });
          }
          case '/api/profile': {
            const profile = await host.loadProfile(body.id);
            host.engine.setProfile(profile);
            host.surface.setProfile(profile);
            host.surface.reset();
            host.resubscribe();
            host.engine.refresh();
            return json(res, 200, { ok: true, profile });
          }
          case '/api/selection':
            Object.assign(host.engine.selection, body);
            host.engine.refresh();
            host.resubscribe();
            return json(res, 200, { ok: true, selection: host.engine.selection });
          default:
            return json(res, 404, { error: 'no such endpoint' });
        }
      }

      /*
       * Static files, from two roots.
       *
       * `/core/...` is served straight out of the shared core so the browser
       * imports the very same modules the server does — the on-screen surface
       * encodes MIDI with the same codec, and scales values with the same
       * catalogue. Serving a copy would let the two drift, which is exactly
       * the bug this layout exists to prevent.
       */
      const fromCore = path.startsWith('/core/');
      const base = fromCore ? join(root, 'core') : publicDir;
      const rel = fromCore ? path.slice('/core'.length) : path === '/' ? '/index.html' : path;
      const file = normalize(join(base, rel));
      if (!file.startsWith(base)) return json(res, 403, { error: 'nope' });
      if (!existsSync(file)) return json(res, 404, { error: 'not found' });
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch (err) {
      json(res, 500, { error: err.message });
    }
  });
}

function sse(host, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });
  res.write('retry: 2000\n\n');
  host.clients.add(res);
  res.on('close', () => host.clients.delete(res));
  /* Bring a fresh page up to date immediately. */
  res.write(`data: ${JSON.stringify({ type: 'status', status: host.status })}\n\n`);
  host.engine.refresh();
}

/* ----------------------------------------------------------------- main */

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const host = new Host(opts);
await host.start();

const server = createServer(host);
server.listen(opts.port, () => {
  process.stderr.write(`\n  awj-surface  http://127.0.0.1:${opts.port}\n\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    host.surface?.reset();
    clearInterval(host.poll);
    host.awj?.close();
    host.osc?.close();
    host.port?.close();
    server.close();
    process.exit(0);
  });
}
