/*
 * Web MIDI, in an offscreen document.
 *
 * This file exists because of one constraint that decides the whole extension
 * architecture:
 *
 *   navigator.requestMIDIAccess() is a SECURE-CONTEXT API, and a Web RCS is
 *   served over plain HTTP on a LAN address. A content script inherits the
 *   page's context, so it cannot use a secure-context API even though the rest
 *   of the extension can. Web MIDI is therefore unavailable in the content
 *   script — in either world — and no amount of permissions changes that.
 *
 * An MV3 service worker cannot do it either: its `navigator` is a
 * WorkerNavigator, which has no requestMIDIAccess at all.
 *
 * What is left is an offscreen document: a real DOM context on the
 * chrome-extension:// origin, which IS a secure context. It runs invisibly for
 * the life of the extension and relays MIDI to and from the service worker.
 *
 * The one wrinkle: an offscreen document is invisible, so it cannot show a
 * permission prompt. SysEx access must therefore be granted once from a
 * VISIBLE extension page (the options page — see options-midi.js). Permission
 * is per-origin and persists, so the offscreen document inherits it from then
 * on. Requesting sysex here first and falling back keeps a fresh install
 * working, with scribble strips and LED rings dark until the grant happens.
 */

const ports = { inputs: new Map(), outputs: new Map() };
let access = null;

/** Ask for MIDI, preferring SysEx but never failing for the lack of it. */
async function connect() {
  try {
    access = await navigator.requestMIDIAccess({ sysex: true });
    return { sysex: true };
  } catch (err) {
    try {
      access = await navigator.requestMIDIAccess({ sysex: false });
      /*
       * Without SysEx an MCU surface still works as a controller, but its
       * scribble strips and any surface configuration are unreachable. Worth
       * reporting rather than leaving the user to wonder why the LCDs are
       * blank.
       */
      return { sysex: false, reason: err.message };
    } catch (fatal) {
      return { error: fatal.message };
    }
  }
}

function index() {
  ports.inputs.clear();
  ports.outputs.clear();
  for (const input of access.inputs.values()) ports.inputs.set(input.id, input);
  for (const output of access.outputs.values()) ports.outputs.set(output.id, output);
  return {
    inputs: [...ports.inputs.values()].map((p) => ({ id: p.id, name: p.name, manufacturer: p.manufacturer })),
    outputs: [...ports.outputs.values()].map((p) => ({ id: p.id, name: p.name, manufacturer: p.manufacturer }))
  };
}

let openInput = null;
let openOutput = null;

/**
 * Open the first port matching `pattern`, or the named one.
 *
 * Input and output are matched separately by name: a surface presents them as
 * two ports and their ids are unrelated, so pairing by id would open the wrong
 * output on some drivers.
 */
function open({ pattern, inputName, outputName }) {
  const match = (list, name) => {
    if (name) return [...list.values()].find((p) => p.name === name) ?? null;
    if (!pattern) return null;
    const re = new RegExp(pattern, 'i');
    return [...list.values()].find((p) => re.test(p.name)) ?? null;
  };

  openInput = match(ports.inputs, inputName);
  openOutput = match(ports.outputs, outputName ?? inputName);

  if (openInput) {
    openInput.onmidimessage = (event) => {
      chrome.runtime.sendMessage({
        target: 'wru-midi', type: 'midi-in', bytes: Array.from(event.data)
      });
    };
  }
  return {
    input: openInput ? { id: openInput.id, name: openInput.name } : null,
    output: openOutput ? { id: openOutput.id, name: openOutput.name } : null
  };
}

function send(bytes) {
  if (!openOutput) return false;
  try {
    openOutput.send(bytes);
    return true;
  } catch (err) {
    /* A surface unplugged mid-show throws here rather than going quiet. */
    chrome.runtime.sendMessage({ target: 'wru-midi', type: 'midi-error', message: err.message });
    return false;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.target !== 'wru-midi-offscreen') return false;
  (async () => {
    switch (msg.type) {
      case 'connect': {
        const result = await connect();
        if (result.error) { respond(result); return; }
        /* Surfaces are hot-plugged constantly. Re-index and tell the worker. */
        access.onstatechange = () => chrome.runtime.sendMessage({
          target: 'wru-midi', type: 'ports', ports: index()
        });
        respond({ ...result, ports: index() });
        return;
      }
      case 'open': respond(open(msg)); return;
      case 'send': respond({ ok: send(Uint8Array.from(msg.bytes)) }); return;
      default: respond({ error: `unknown message ${msg.type}` });
    }
  })();
  return true; // keep the channel open for the async respond
});
