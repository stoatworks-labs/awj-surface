# Notes

Working notes for this repo: status, decisions, and the traps that have actually bitten.
Migrated out of Claude Code's memory on 2026-08-24, so they are written in the first
person and dated by when each thing was learned — that date is usually the useful part.

Cross-cutting notes that are not specific to this repo live in
[fleet-notes](https://github.com/stoatworks-labs/fleet-notes).

*awj-surface — MIDI/OSC control surfaces onto an Analog Way LivePremier; PUBLIC, untagged, hardware-exercised but no physical surface has ever been attached*

`~/projects/video/awj-surface`, **`stoatworks-labs/awj-surface` PUBLIC** (MIT), on the
site since 2026-08-22 at `/software/awj-surface/` and as a member of `/analog-way/`
([analog way page](https://github.com/stoatworks-labs/stoatworks-website/blob/main/docs/NOTES.md) (`stoatworks-website`)). `package.json` says **v0.1.0 and there are no tagged
releases**, so the site records it as In development.

Maps MIDI and OSC controllers onto a LivePremier: faders to layer opacity, encoders
to size and position, buttons to select layers, apply sources, cycle crop and switch
keying. `node hosts/node/server.js --device <ip> --profile x-touch-mcu`, UI on
**8532**. `core/` has no I/O of its own — [livepremier plus](https://github.com/stoatworks-labs/livepremier-plus/blob/main/docs/NOTES.md) (`livepremier-plus`) is a second
host running the same engine in a browser.

**Read-only mode is structural, not a flag.** The AWJ client is built with no
reachable write path (`set()` and `subscribe()` throw), which matters because
**subscribing is itself a `replace`** — see [awj protocol](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_awj_protocol.md) and
**aquilon read only rule** (working-practice note, kept in Claude memory). With no push available it polls instead
(`--poll`, default 2000ms).

Three things it solves that a lookup table cannot:
- **A layer path contains a preset letter, and which letter is on air moves at every
  take.** Bindings say `PREVIEW`/`PROGRAM` and resolve per event against live state.
  The rule was settled by firing a take and re-reading: the letters do **not** move,
  `status/transition` flips, and the whole rule is its `DOWN`/`UP` suffix.
- **Every write is echoed to all clients**, which drives a motor fader into the hand
  that just moved it. Writes are attributed and the echo to the originating control
  is dropped; a change from anywhere else still moves it.
- **A non-motorised fader lies after a bank change**, so those bindings use pickup.

**Exercised end to end on a real Aquilon C** — fader movement → `opacity` write →
TAKE → the preset flip after it, with the frame captured first and all 87 values
verified restored. ⚠️ **No physical control surface has ever been plugged into it.**
The four profiles (X-Touch MCU, APC40, MIDICON PRO, MIDICON-2) come from published
MIDI charts, which are exactly the documents that are quietly wrong — hence the
**Bring-up tab**, which flags declared-but-never-seen controls and sent-but-undeclared
ones, and classifies a sign-magnitude encoder (values clustering either side of
`0x40`) that a profile has mistaken for a fader.

**Tidy-up outstanding:** the README carries **two** AI disclaimers — a one-line
"Built with AI assistance" above the proper blockquote. Convention is one, at the top
(**disclaimer scope** (working-practice note, kept in Claude memory)).

## A second catalogue: Midra 4K / Alta 4K (2026-09-12)

`core/catalogue-mng.json` — 57 layer parameters in 14 groups and 11 take-group
ones, generated from a **live Pulse 4K's** bundle and store (firmware 3.3.10, read
once, read-only, mid-show) with `--bundle`/`--store`. Zero `inferred`: every
property matched a table by signature. The LivePremier catalogue regenerates
byte-identically apart from three new descriptive fields (`platform`, `layerRoot`,
`groupRoot`), which say where a layer and the take group live relative to a
destination so a consumer need not know the platform by name.

What the generator had to learn: the minified export shape, `readOnly:!0`,
double-quoted `type:"int"`, enums scattered as `NAME:{key:"NAME",…}` rather than one
`VAR_ENUMS` blob, and `3e3`. Nothing in the engine changed — `paths.js` and
`preset.js` are still LivePremier's, so the MIDI mapper does not yet drive a Midra.
livepremier-plus vendors the JSON for its Layer panel, where `core/dialect.js`
supplies the roots.

