> Built with AI assistance ([Claude Code](https://claude.com/claude-code)).

# awj-surface

> **AI-assisted project. Status: field testing.** This codebase was created with
> [Claude](https://claude.com/claude-code) (Anthropic), directed and reviewed by a human
> author. The parameter model and every path in it were read from a live LivePremier, and
> the whole chain — a fader movement through to an `opacity` write, a TAKE, and the preset
> flip that follows it — has been **exercised end to end on a real Aquilon C**, with the
> frame captured beforehand and every one of 87 values verified restored afterwards.
>
> **The catalogue is verified against real hardware.** On 2026-09-09 the whole thing was
> re-checked against a second Aquilon C (`NLC_C`, firmware 6.2.73): all **421 paths** the
> catalogue generates — 86 parameters across three preset letters and two layer kinds —
> were issued at the box and **every one answered, with no `E12`**. A layer `opacity`
> write round-tripped and restored on that frame too. The paths are not a transcription
> of a manual; they are what a device answers.
>
> But **no physical control surface has ever been plugged into it.** The controller maps
> come from published documentation, not from hardware. Treat a first run with a real
> APC40, X-Touch or MIDIcon as bring-up.

Map MIDI and OSC controllers onto an Analog Way **LivePremier** (Aquilon) switcher.
Faders to layer opacity, encoders to size and position, buttons to select layers, apply
sources, cycle crop modes and switch keying — with the surface following the switcher,
not just driving it.

```bash
node hosts/node/server.js --device 192.168.2.140 --profile x-touch-mcu
```

Then open <http://127.0.0.1:8532>.

## Read-only mode

Against show hardware you usually want to watch, not drive:

```bash
node hosts/node/server.js --device 192.168.2.142 --read-only
```

This is not a flag that skips writes. The AWJ client is built with **no reachable write
path** — `set()` and `subscribe()` throw, so a `replace` cannot reach the wire even by
mistake. That includes the **Subscriptions list**, which looks like a read and is not:
subscribing is a `replace` on the `Subscriptions` path. Because of that there is no
push, so read-only mode **polls** the mapped paths instead (`--poll <ms>`, default 2000)
using nothing but `get`.

Control movements are logged as `read-only, NOT sent:` rather than silently dropped, and
the header shows `READ-ONLY` in amber, because "will this control reach the switcher?"
must be answerable at a glance.

Run it with no `--device` and everything still works offline: the mapping editor, the
on-screen surface, and writes logged instead of sent. That is how you build a show file
before the frame arrives.

## Bring-up: checking a profile against real hardware

Every shipped profile was transcribed from a manual, and a MIDI implementation chart is
exactly the kind of document that is quietly wrong — a note number off by one, a channel
that is 1-based in the manual and 0-based on the wire, an encoder that turns out to send
notes rather than a CC.

The **Bring-up** tab turns "touch everything and see" into a checklist. Plug the surface
in, sweep every control, and it reports:

- **Declared by the profile** — each control, and whether it has actually been seen.
  Anything still `never` is usually a wrong number in the transcription.
- **Sent, but not in the profile** — controls the manual left out, each with a guess at
  what it is.

That guess is the useful part. A sign-magnitude encoder read as a fader is the single
most common way a transcribed profile is wrong, and it does not look wrong — it looks
like a parameter that runs away. The classifier spots it because an encoder never sweeps:
its values cluster either side of `0x40`.

```
Sent, but not in the profile
  cc:3:99   x10   fader              sweeps a wide range of values — absolute
  cc:0:80   x5    encoder (signed)   values cluster either side of 0x40 — relative
```

## What it does

- **Bidirectional.** Motorised faders track the device, LED rings follow encoders,
  button lamps show what the layer actually holds, and X-Touch scribble strips name the
  layer each strip is pointed at. A surface that only sends is half a surface.
- **MIDI-learn plus JSON profiles.** Four controllers ship mapped from their published
  MIDI charts; anything else is learned by touching a control. Profiles are plain JSON,
  so they diff and they travel.
- **A parameter catalogue with real limits.** 67 layer parameters and 19 screen
  controls, each with the device's own type, range and enum members — generated from
  the switcher, not typed from a PDF.
- **Host-agnostic.** `core/` has no I/O of its own. This repo's local server is
  one host; [LivePremier Plus](https://github.com/stoatworks-labs/livepremier-plus)
  is another, running the same engine in a browser.

## The three things that make this harder than a lookup table

**A layer path contains a preset *letter*, and the letter moves.** A screen holds three
preset memories keyed `A`, `B`, `C`. Nothing addresses "preview" — you address a letter,
and which letter is on air changes at every take. Bindings therefore say `PREVIEW` or
`PROGRAM` and are resolved per event against live device state. Get this wrong and a
preview fader silently becomes a live one halfway through a show.

The rule, confirmed by firing a take and re-reading: the letters do **not** move.
`status/transition` flips, and every one of its six values names the end the T-bar is at
or came from — so the whole rule is the `DOWN`/`UP` suffix.

**Every write comes back.** The device echoes changes to all clients, so naive feedback
drives a motor fader into the hand that just moved it. Writes are attributed, and the
echo to the originating control is dropped — while a change from anywhere else (the
vendor UI, a second surface) still moves it.

**A fader that is not motorised lies.** After a bank change it sits where the last layer
left it, and the first touch would slam the new layer to that value. Non-motorised
bindings use pickup: no write until the control crosses the value it is steering.

## Controllers

| Profile | Surface | Feedback | Source of the map |
|---|---|---|---|
| `x-touch-mcu` | Behringer X-Touch, MC mode | motor faders, LED rings, scribble strips | de-facto Mackie Control |
| `apc40` | Akai APC40 | button LED colours, knob rings | published APC40 chart |
| `midicon-pro` | Elation MIDICON PRO | motor faders, button LEDs | [Elation's manual](https://cdb.s3.amazonaws.com/ItemRelatedFiles/9908/ELATION%20MIDICON%20PRO%20-%20USER%20MANUAL.pdf) |
| `midicon-2` | Elation MIDICON-2 | motor faders, button LEDs | [Elation's manual](http://cdb.s3.amazonaws.com/ItemRelatedFiles/10522/elation_midicon-2_user_manual_010517.pdf) |
| `speed-editor` | Blackmagic DaVinci Resolve Speed Editor (USB/Bluetooth **HID**) | key lamps, jog-mode lamps | reverse-engineered: [smunaut/blackmagic-misc](https://github.com/smunaut/blackmagic-misc), [node-blackmagic-controller](https://github.com/Julusian/node-blackmagic-controller) |
| `osc-default` | TouchOSC and similar | values returned on the same address | — |
| `generic-learn` | anything | as declared | learned |

Both MIDIcons send **one note per rotary click** rather than a relative CC, so each
rotary is two controls in its profile. Both take feedback by echo — send a fader's own
CC back and the motor moves — which is the same `generic` protocol the APC40 uses for
its LEDs.

The **Speed Editor is not MIDI.** It is an HID device that says nothing until the host
answers a challenge, and it wants that answer again every few minutes. `core/hid/` has the
protocol (`speed-editor.js`: auth, report decoding, LED reports) and the adapter
(`surface.js`: `SpeedEditorSurface`, the HID counterpart of `MidiSurface`). Both are bytes
only, with no transport. The Node host here doesn't drive the Speed Editor, because that
would need `node-hid` and this repo has no runtime dependencies. LivePremier Plus drives it
from the page over WebHID. Its wheel has three faces, chosen with JOG / SHTL / SCRL: the
profile binds `jog:jog`, `jog:shtl` and `jog:scrl` separately, and SNAP is shift. Quit
DaVinci Resolve before using it, because both would hear every key.

Regenerate them with `node tools/gen-profiles.mjs`.

### Generic devices

Anything that speaks MIDI or OSC works, whether or not it has a profile here.

**MIDI.** Start on `generic-learn`, pick the input from the header (or `--midi`, which
takes an exact name, a case-insensitive substring, or an index — `--midi apc` and
`--midi 1` both work), then bind controls by touching them. A profile with a
`match.namePattern` finds its own port; a generic one has nothing to match on, so with a
single input attached it just opens it, and with several it **refuses to guess** and
lists them rather than picking the wrong controller.

**OSC.** Send to `--osc-in` from any layout — TouchOSC, a lighting desk, Companion. The
addresses are yours: `osc-default` is only a starting layout, and learn binds whatever
address arrives. Feedback goes back out on the same address, so a tablet fader tracks the
switcher.

Both go through the same **Bring-up** view, and both get classified. OSC carries no hint
of what a control *is* — the same address is a fader or a button depending only on how
it is declared — so the value shape decides: only ever `0`/`1` or booleans is a button,
anything that visits the middle is a fader.

If no MIDI binding is installed there is no hardware I/O at all; the header says so and
the on-screen surface still works. `npm i @julusian/midi` enables it.

## The parameter catalogue

`core/catalogue.json` is generated from a device, joining two sources because neither is
enough alone:

- `GET /api/stores/device` — the real tree, with exact node and property names, but no
  ranges. A store dump cannot tell you that `opacity` stops at **256**.
- the application the device serves to a browser, which carries the device's own
  published attribute tables: min, max, default, type, `readOnly` and the enum
  reference for every property.

```bash
node tools/gen-catalogue.mjs 192.168.2.140 > core/catalogue.json
```

Nothing in it is hand-written. Every range is the device's own statement about itself,
which is why `opacity` is 0–256 and not 0–255, `posH` is ±2,000,000, and
`source.inputNum` has 482 members.

## Ranges, and why bindings narrow them

`position.posH` runs ±2,000,000. Mapped raw onto a 7-bit fader that is **31,500 pixels
per step**. A binding may therefore narrow the range, and the narrowed range is clamped
to the parameter's own so a profile cannot ask for the impossible:

```json
{ "control": "cc:0:16",
  "target": { "kind": "layer", "layer": "@selected", "preset": "PREVIEW", "param": "position.posH" },
  "options": { "min": -1920, "max": 3840 } }
```

The same idea trims an absolute source knob to the 16 live inputs, because 482 members
across 128 knob positions is not selectable.

## OSC needs the server

OSC is UDP. A browser cannot open a UDP socket and neither can a Manifest V3 extension —
`chrome.sockets.udp` went away with Chrome Apps. **MIDI can live in the extension; OSC
cannot live anywhere but the local server.** There is no workaround, only a different
host.

```bash
node hosts/node/server.js --device 192.168.2.140 --profile osc-default \
     --osc-in 8000 --osc-out 9000
```

Feedback returns to the same address it arrived on, so a tablet fader tracks the
switcher.

## In the browser

[LivePremier Plus](https://github.com/stoatworks-labs/livepremier-plus) vendors
this `core/` and runs it as a MIDI Mapping panel inside the vendor's own Web RCS,
driving the device over the page's existing WebSocket so no extra client is
opened.

That host used to be a Chrome extension, and a drop-in kit for it lived here.
It is gone, along with the constraint that shaped it: `requestMIDIAccess` is a
secure-context API, and a Web RCS served over plain HTTP is not a secure
context, so an extension needed an offscreen document to reach Web MIDI at all.
LivePremier Plus is a local proxy, so its page is served from loopback — which
*is* a secure context — and Web MIDI is simply available.

## Running without hardware

There is no MIDI binding in the dependency list, because there are no dependencies. If
`@julusian/midi` or `midi` happens to be installed it is used; otherwise the server
opens a **virtual port**, and the on-screen surface in the web UI drives it.

That surface is not a mock of the mapping. It imports the same MIDI codec the server
does, encodes real bytes, and posts them to the same port a controller would feed — so
decode, binding resolution, preset letters, coalescing and the write are all the
production path. Only the physical surface is stood in for.

## Tests

```bash
npm test
```

65 tests, no dependencies, no build step, Node 18+. The AWJ path strings are asserted as
literals because each was issued against a device and answered with a value rather than
an `E12`; if a refactor changes one, the device stops responding. Originally that device
was a simulator; as of 2026-09-09 all 421 generated paths have been re-issued against a
physical Aquilon C on firmware 6.2.73 and answered there too.

<!-- attributions:start -->
This project is built on other people's work — see [ATTRIBUTIONS.md](ATTRIBUTIONS.md).
<!-- attributions:end -->

## Licence

MIT — see [LICENSE](LICENSE).

Not affiliated with Analog Way, Behringer, Akai, Elation or Blackmagic Design. "LivePremier", "Aquilon",
"X-Touch", "APC40", "MIDICON", "DaVinci Resolve" and "Speed Editor" are their respective owners' marks.
