# Dropping the surface engine into webRCS unleashed

These files add MIDI control to the [webRCS unleashed](../../../webrcs-unleashed)
extension. They are kept here rather than in that repo so the two can be worked
on independently — copy them in when you want them.

Nothing here duplicates the engine. The extension imports the same `core/`
modules the local server uses.

## The constraint that decides the architecture

`navigator.requestMIDIAccess()` is a **secure-context API**, and a Web RCS is
served over plain HTTP on a LAN address. A content script inherits the page's
context, so — as MDN puts it — a content script running in an insecure context
cannot use a Web API that requires a secure context, even though the rest of the
extension can. Neither world helps: `MAIN` is the page, and `ISOLATED` still
takes its secure-context flag from the page.

An MV3 service worker cannot do it either. Its `navigator` is a
`WorkerNavigator`, which has no `requestMIDIAccess` at all.

What is left is an **offscreen document**: a real DOM context on the
`chrome-extension://` origin, which *is* a secure context.

```
 Web RCS page  (http://frame/)          extension origin (chrome-extension://)
 ┌───────────────────────────────┐      ┌──────────────────────────────────────┐
 │ ws-hook.js      MAIN world    │      │  service worker                      │
 │   the page's own WebSocket    │      │    midi-bridge.js                    │
 │                               │      │      owns the offscreen document     │
 │ loader.js       ISOLATED      │      │            ▲          │              │
 │   Session + DeviceStore       │      │            │          ▼              │
 │   midi-surface.js  ◄──────────┼──────┼────────────┘   offscreen-midi.html   │
 │     Engine + MidiSurface      │ msgs │                  Web MIDI lives here │
 └───────────────┬───────────────┘      └──────────────────────────────────────┘
                 │ writes ride the page's existing socket
                 ▼
            the switcher
```

Writes go out over the page's own WebSocket through the extension's existing
`PageSocketTransport`, so the extension still opens no connection of its own —
the device's client count and AWJ's five-client budget stay untouched.

## OSC is not possible here

OSC is UDP. A browser cannot open a UDP socket, and neither can MV3:
`chrome.sockets.udp` was a Chrome Apps API and died with them. There is no
workaround, only a different host — use the local server for OSC.

## Installing

1. Copy the shared engine in, as a subdirectory so it is obviously vendored:

   ```
   awj-surface/core/            ->  webrcs-unleashed/src/core/awj-surface/
   ```

   Keep `catalogue.json` with it. Everything else in `core/` is dependency-free
   ES modules with no build step, which is why this is a copy and not a bundler
   step.

2. Copy the host files:

   | from | to |
   |---|---|
   | `surface-transport.js` | `src/transports/midi-surface.js` |
   | `midi-bridge.js` | `src/transports/midi-bridge.js` |
   | `offscreen-midi.js` | `src/transports/offscreen-midi.js` |
   | `offscreen-midi.html` | `src/transports/offscreen-midi.html` |
   | `options-midi.js` | `src/options/midi.js` |

3. Merge `manifest.patch.json` into the extension's `manifest.json`.

4. Wire it up where the session already exists:

   ```js
   import { MidiSurfaceController } from './transports/midi-surface.js';
   import profile from './profiles/x-touch-mcu.json' with { type: 'json' };

   const surface = new MidiSurfaceController(session, store, profile);
   await surface.restore();          // saved bindings, if any
   const midi = await surface.connect();
   if (midi.error) console.warn('[wru] no MIDI:', midi.error);
   else if (!midi.sysex) console.warn('[wru] no SysEx: scribble strips stay blank');
   ```

## Granting SysEx, once

An offscreen document is invisible, so it cannot show a permission prompt.
SysEx has to be granted from a **visible** extension page — that is what
`options-midi.js` is for. Permission is per-origin and persists, so once it has
been granted on the extension's own origin the offscreen document inherits it.

Until then `offscreen-midi.js` falls back to non-SysEx access. The surface still
works as a controller; what you lose is everything that travels as SysEx, which
on an X-Touch means the scribble strips.

## What is not verified

None of this has run against real hardware — there is no controller here to test
with. The engine and the protocol layer are exercised against a live LivePremier
simulator and by 50 unit tests, but the extension wiring above is written from
the documented behaviour of the Chrome APIs and has not been loaded into a
browser. Treat the first run as a bring-up, not a regression.
