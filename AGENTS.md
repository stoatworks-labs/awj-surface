# AGENTS.md — awj-surface

Onboarding for an LLM or a newcomer. The *why*; [README.md](README.md) is the *what*.

## The one-paragraph version

A control surface sends positions, movements and presses. An Analog Way LivePremier is
one big JSON object where writing a property *is* the command. This turns the first into
the second, and — because the surfaces in scope have motors, LED rings and displays —
turns device state back into control positions. The hard part is not the mapping table;
it is that the address a binding resolves to keeps moving.

## Mental model

- **The device is one JSON object.** There is no command verb. `xTake = true` is the
  take. Two spellings address the same tree: the store spelling (`device/screenList/…`)
  that the Web RCS WebSocket carries, and the AWJ spelling
  (`DeviceObject/$screen/@items/…`) on TCP 10606. `core/paths.js` converts; everything
  internal speaks store paths because they are arrays and need no escaping.
- **A layer address contains a preset LETTER.** `A`, `B` or `C`. "Preview" is not an
  address, it is a question about device state.
- **The engine is transport-agnostic on both sides.** MIDI, OSC, HID (`core/hid/`) and the on-screen
  surface all reduce to `{control, kind: absolute|relative|button|touch, …}`. AWJ, the
  page WebSocket and offline logging all consume `{path, value}`. That is what lets one
  engine serve a Node server and a Chrome extension.
- **A profile has two halves and they belong to different people.** `controls` describes
  the hardware and never changes. `bindings` is the show, and is what MIDI-learn edits.

## Load-bearing invariants

- **Never resolve a symbolic preset without device state.** `letterFor()` returns `null`
  when the screen group has not been read, and the engine must then write *nothing*.
  Guessing a letter can put a change on air. There is a test for this; keep it.
- **The transition suffix is the whole rule.** `status/transition` has six values —
  `AT_DOWN`, `AT_UP`, `EFFECT_FROM_{DOWN,UP}`, `COPY_FROM_{DOWN,UP}`. The end named by
  the suffix is program. Testing only for `AT_UP` gets all four in-flight states
  backwards, and the failure is invisible for exactly the length of a transition.
- **The letters do not move on a take.** `presetUp`/`presetDown`/`presetPrevious` were
  unchanged across two takes on a simulator; only `transition` flipped. If you ever see
  code re-reading the letters to detect a take, it is wrong.
- **AWJ framing is `0x04`, not newline**, and it is written as
  `String.fromCharCode(EOT)` rather than a literal control character — a raw `0x04` in a
  source file is invisible and fragile across editors.
- **AWJ subscriptions start EMPTY.** A connected client is told nothing until it writes
  a subscription list. This is the most common way to get a client that looks connected
  and is deaf.
- **AWJ is leaf-read-only.** Every container read returns `{}`. You cannot enumerate the
  object model over it — which is why `tools/gen-catalogue.mjs` takes the model from the
  Web RCS bundle and the store dump instead. It reads both bundle shapes — LivePremier's
  unminified `const X_ATTRIBUTES = {…}` and Midra/Alta's minified
  `n.d(t,"X_ATTRIBUTES",…)` with the object bound to a one-letter local — and both store
  layouts (`layerList` under `screenAuxGroupList`'s screens; `liveLayerList` with the
  take group under `transition/`). `--bundle`/`--store` generate from files captured
  earlier, which is how the Midra catalogue was cut from a box that was mid-show.
  ⚠️ The minifier writes `3000` as `3e3`; a mantissa-only number regex gave `takeTime`
  a maximum of 3.
- **`core/` must stay dependency-free and host-free.** No Node APIs, no DOM, no fetch.
  The browser imports it over `/core/…`, the server imports it directly, and the
  extension vendors it. A single `node:` import would break two of the three.
- **Seed the screen group BEFORE asking what to read.** `Engine.watchedPaths()` resolves
  layer bindings, which needs preset letters, which live in the screen group. Ask first
  and you get six paths instead of forty, silently. `Host.seedFromAwj()` does two passes
  for this reason.
- **Never drive a motor fader while it is touched.** Fader-touch notes maintain
  `Engine.touched`, and feedback for a touched strip reports `position: null`.
- **Read-only is structural, not a convention.** `AwjClient({readOnly:true})` makes
  `set()` and `subscribe()` throw `EREADONLY`. Do not "optimise" that into an `if` at
  the call site — the whole point is that no code path reaches the socket with a
  `replace`. Tests in `test/readonly.test.js` assert the string `replace` never reaches
  the wire in that mode.
- **Subscribing IS a write.** `Subscriptions` is set with `op: replace`. Anything
  claiming to be read-only must not subscribe; poll with `get` instead.
- **Layout: the chrome must never scroll.** `body` is `height:100vh; overflow:hidden`
  and both `main` and its sections carry `min-height:0` — a grid/flex child defaults to
  `min-height:auto` and refuses to shrink below its content, which silently defeats
  `overflow:auto` and lets the whole document scroll. That took the header, and with it
  the READ-ONLY indicator, off screen.
- **Never silently fall back to a virtual port.** A virtual port looks exactly like a
  controller that is plugged in and ignoring you. `openPort` attaches a `reason` and the
  candidate list, and the UI shows both. With nothing to match on and several inputs
  attached, `chooseInput` refuses to guess rather than opening the wrong controller.
- **A `<select>` change is not proof a human changed it.** Browsers restore form values
  across a reload and can fire `change` while doing so, which had the page silently
  switching the running profile. Both pickers compare against known state first.
- **`null` position is not zero.** It means "no value" and a host must leave the control
  alone — blank the LED ring, do not drive it to the bottom.

## Where the numbers came from

| Fact | Source |
|---|---|
| Parameter ranges, types, enums | the device's own attribute tables, as served to a browser |
| Node and property names | `GET /api/stores/device`, cross-checked simulator vs real frame (identical) |
| AWJ framing, subscriptions, E12 | *LivePremier AWJ Protocol Programmer's Guide v4.0*, verified on the wire |
| Preset letters and the flip | fired a take on a simulator and re-read |
| Mackie Control numbers | the de-facto map every host implements; never published by Mackie |
| APC40 map | published APC40 documentation |
| MIDIcon PRO / MIDICON-2 maps | Elation's own user manuals |

Firmware matters: v4.0 of the guide is behind in places. `$screenGroup` is **gone** on
6.2 (`$screenAuxGroup` only), and the guide's own subscription example would fail as
printed. Any path table must be firmware-tagged.

## What is verified and what is not

**Verified against AW LivePremier Simulator 6.2.73 (`NLC_CMAX`):** AWJ connect, get,
E12 existence probing, subscribe, push, write, read-back. The full chain from a browser
fader drag to an `opacity` write on the device. The preset flip — dragging the same
fader before and after a take wrote `B` then `A`, leaving the other untouched. OSC from
a real UDP packet through to three correct writes including windowed range arithmetic.

**Verified on a real Aquilon C (`NLC_C`, 2026-08-21), with permission:** every layer
path resolves (zero E12); the preset letters and the DOWN/UP rule behave exactly as on
the simulator; a TAKE fired from the surface flipped `transition` and the same fader then
addressed the other letter. The generated catalogue is **identical** between simulator
and hardware. Note the firmware differs: `system/$device/@items/1/@props/{updater,serial}`
and the whole `$input/@items/<n>` subtree are **E12 on hardware** though the simulator
serves them — never build on a sim-only path.

**Not verified:** any physical control surface. No APC40, X-Touch or MIDIcon has ever
been connected. The controller maps are transcribed from documentation and the feedback
paths are exercised only by unit tests and the on-screen surface.

**The standing rule:** work against a real Aquilon C is **read-only by default**; any
`replace`, TAKE or memory recall needs the owner's explicit per-run permission, asked and
answered first. The 2026-08-21 hardware test was done that way — permission, full
capture, restore, then verifying all 87 values matched. A granted write is for that one
test, never a standing lift. Use `--read-only` for everything else; it enforces the rule
by construction rather than by memory.

## Layout

```
core/            the engine. No dependencies, no host APIs, no build step.
  paths.js       store <-> AWJ spelling, and the layer address
  preset.js      PREVIEW/PROGRAM -> A|B|C  (read this one first)
  catalogue.*    what is mappable and what its limits are (generated)
  catalogue-mng.json  the same, generated from a Midra 4K / Alta 4K (a Pulse 4K,
                 3.3.10). Not yet wired into the engine — paths.js and preset.js
                 are LivePremier's — but consumers that speak both (livepremier-
                 plus) vendor it from here
  value.js       scaling both ways, plus pickup
  profile.js     profile schema and validation
  surface.js     MIDI <-> normalised control events
  engine.js      bindings, selection, writes, feedback
  coverage.js    profile-vs-reality checklist for hardware bring-up
  midi/          message codec, relative encoders, Mackie Control
hosts/node/      local server: AWJ, OSC, HTTP+SSE, web UI
profiles/        generated controller profiles; saved/ holds user edits
tools/           the two generators
```

## Related work in this fleet

- **livepremier-plus** — a local proxy that vendors this `core/` and runs it in
  the browser as a MIDI Mapping panel. It syncs from here; do not edit the copy
  there. OSC cannot work in that host (no UDP in a browser) — it is server-only.
- **webrcs-timeline** — cue-stack sequencing for the same platform, Rust.
- **aquilon-vpu-map** — reads the VPU allocation over AWJ, read-only.
- **openrcs** — the *older* LiveCore/Midra platform. Different protocol entirely
  (ASCII mnemonics on TCP 10500). Nothing here applies there.

## Notes

`docs/NOTES.md` carries this repo's working notes — current status, decisions
already made, and the traps that have actually bitten. Read it before changing
anything non-obvious. Cross-cutting fleet knowledge lives in
[fleet-notes](https://github.com/stoatworks-labs/fleet-notes).
