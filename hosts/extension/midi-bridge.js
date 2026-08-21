/*
 * Service-worker half of the MIDI bridge.
 *
 * The service worker owns the offscreen document's lifetime and relays between
 * it and the content script. It does no MIDI itself — it cannot: an MV3 worker
 * has a WorkerNavigator, which has no requestMIDIAccess.
 *
 * Add to the extension's background service worker with:
 *
 *   import { installMidiBridge } from './transports/midi-bridge.js';
 *   installMidiBridge();
 */

const OFFSCREEN_PATH = 'src/transports/offscreen-midi.html';

let creating = null;

/**
 * Make sure the offscreen document exists.
 *
 * Only one may exist per extension, and creating a second throws, so this is
 * guarded both by a live check and by a shared promise — the worker can be
 * woken by two messages at once and would otherwise race with itself.
 */
async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
  });
  if (existing.length) return;

  if (creating) { await creating; return; }
  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    /*
     * There is no MIDI reason in the enum. USER_MEDIA is the closest honest
     * fit — this document exists to hold a device handle open — and the reason
     * is documentation for the user, not a capability grant.
     */
    reasons: ['USER_MEDIA'],
    justification: 'Web MIDI requires a secure context, which a content script on an http:// Web RCS does not have.'
  });
  try {
    await creating;
  } finally {
    creating = null;
  }
}

export function installMidiBridge() {
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg?.target !== 'wru-midi-worker') return false;

    (async () => {
      await ensureOffscreen();
      switch (msg.type) {
        case 'connect': {
          const result = await chrome.runtime.sendMessage({
            target: 'wru-midi-offscreen', type: 'connect'
          });
          if (result?.error) { respond(result); return; }
          const opened = await chrome.runtime.sendMessage({
            target: 'wru-midi-offscreen', type: 'open', pattern: msg.pattern
          });
          respond({ ...result, ...opened });
          return;
        }
        case 'send':
          /*
           * Deliberately not awaited. Feedback is a stream — motor positions,
           * LED rings, scribble text — and round-tripping every message
           * through the worker would add latency to the one thing that must
           * feel immediate.
           */
          chrome.runtime.sendMessage({ target: 'wru-midi-offscreen', type: 'send', bytes: msg.bytes });
          respond({ ok: true });
          return;
        default: {
          const result = await chrome.runtime.sendMessage({ ...msg, target: 'wru-midi-offscreen' });
          respond(result);
        }
      }
    })();
    return true;
  });
}
