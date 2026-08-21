/*
 * The content-script half: bind a MIDI surface to a Web RCS session.
 *
 * Drop this into webrcs-unleashed as `src/transports/midi-surface.js`. It is
 * written against that extension's own shapes — a `Session` wrapping a
 * `PageSocketTransport`, and a `DeviceStore` mirroring the model — and it adds
 * the surface engine on top without touching either.
 *
 * The division of labour, which is forced rather than chosen:
 *
 *   here            the engine, the profile, value scaling, feedback. All of
 *                   it is ordinary JavaScript and runs happily in the page.
 *   offscreen doc   Web MIDI, and only Web MIDI, because requestMIDIAccess is
 *                   a secure-context API and a Web RCS is served over plain
 *                   HTTP. See offscreen-midi.js for the full reasoning.
 *
 * Writes go out over the page's own WebSocket via the existing transport, so
 * the extension still opens no connection of its own and the device's client
 * count — and AWJ's five-client budget — are untouched.
 */

import { Engine } from '../core/awj-surface/engine.js';
import { MidiSurface } from '../core/awj-surface/surface.js';

/** Message channel names, shared with the service worker. */
const TO_WORKER = 'wru-midi-worker';
const FROM_WORKER = 'wru-midi';

export class MidiSurfaceController {
  /**
   * @param session  the extension's Session (wrapping PageSocketTransport)
   * @param store    the extension's DeviceStore
   * @param profile  a controller profile
   */
  constructor(session, store, profile, options = {}) {
    this.session = session;
    this.store = store;
    this.engine = new Engine(store, profile, options);
    this.surface = new MidiSurface(profile, (bytes) => this.sendMidi(bytes));
    this.listeners = [];
    this.wire();
  }

  wire() {
    this.engine.addEventListener('write', (event) => {
      for (const write of event.detail.writes) {
        /*
         * The page socket takes exactly the shape the engine produces — a
         * store path array and a value — because both are addressing the same
         * object model in the same spelling. No translation, and no AWJ.
         */
        this.session.send({ path: write.path, value: write.value });
      }
    });

    this.engine.addEventListener('feedback', (event) => this.surface.render(event.detail));

    /*
     * The store's change events are what close the loop: another operator's
     * tab, the vendor UI in this tab, or the device itself moving a parameter
     * all arrive the same way, and all of them move the surface.
     */
    const onChange = (event) => this.engine.deviceChanged(event.detail.path);
    this.store.addEventListener('change', onChange);
    this.listeners.push(() => this.store.removeEventListener('change', onChange));

    const onMessage = (msg) => {
      if (msg?.target !== FROM_WORKER) return;
      if (msg.type === 'midi-in') this.onMidi(Uint8Array.from(msg.bytes));
      if (msg.type === 'ports') this.onPorts?.(msg.ports);
    };
    chrome.runtime.onMessage.addListener(onMessage);
    this.listeners.push(() => chrome.runtime.onMessage.removeListener(onMessage));
  }

  onMidi(bytes) {
    const event = this.surface.handle(bytes);
    if (!event) return;
    if (this.learning) { this.finishLearn(event); return; }
    if (event.kind === 'unmapped') { this.onUnmapped?.(event); return; }
    this.engine.input(event);
  }

  sendMidi(bytes) {
    chrome.runtime.sendMessage({ target: TO_WORKER, type: 'send', bytes: Array.from(bytes) });
  }

  /** Ask the worker to bring up MIDI and open the profile's surface. */
  async connect() {
    const result = await chrome.runtime.sendMessage({
      target: TO_WORKER,
      type: 'connect',
      pattern: this.engine.profile.match?.namePattern
    });
    if (result?.error) return result;
    if (this.engine.profile.init) {
      for (const bytes of this.engine.profile.init) this.sendMidi(Uint8Array.from(bytes));
    }
    this.surface.reset();
    this.engine.refresh();
    return result;
  }

  /**
   * Arm MIDI learn: the next control that moves is bound to `target`.
   *
   * Controls the profile has never seen are added to it here, which is what
   * makes an unlisted surface usable without hand-writing a profile.
   */
  learn(target, { kind, strip } = {}) {
    this.learning = { target, kind, strip };
  }

  finishLearn(event) {
    const { target, kind, strip } = this.learning;
    this.learning = null;
    const profile = this.engine.profile;

    let control = this.engine.controls.get(event.control);
    if (!control) {
      control = {
        id: event.control,
        kind: kind ?? (event.control.startsWith('note:') ? 'button' : 'fader'),
        label: event.control,
        ...(strip !== undefined ? { strip } : {})
      };
      profile.controls = [...profile.controls, control];
    }
    profile.bindings = [
      ...profile.bindings.filter((b) => b.control !== control.id),
      { control: control.id, target }
    ];

    this.engine.setProfile(profile);
    this.surface.setProfile(profile);
    this.onLearned?.(control, profile);
    this.engine.refresh();
  }

  /** Persist the binding set. Uses the extension's own storage, not a file. */
  async save() {
    await chrome.storage.local.set({
      [`surface:${this.engine.profile.id}`]: this.engine.profile.bindings
    });
  }

  async restore() {
    const key = `surface:${this.engine.profile.id}`;
    const saved = (await chrome.storage.local.get(key))[key];
    if (!saved) return false;
    this.engine.setProfile({ ...this.engine.profile, bindings: saved });
    this.surface.setProfile(this.engine.profile);
    this.engine.refresh();
    return true;
  }

  destroy() {
    this.surface.reset();
    for (const off of this.listeners) off();
    this.listeners = [];
  }
}
