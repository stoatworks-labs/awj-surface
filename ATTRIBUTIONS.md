# Attributions

AWJ Surface is built on other people's work. This file lists what that work is, who did
it, and what it is doing here.

It is generated — the master lists live in the `stoatworks-backend` repo and are
pushed out by `scripts/sync-attributions.py`. Edit it there, not here.

## Code we derived from other people's work

Someone else solved this first, and this project would not exist in its current form without their work.

### blackmagic-misc — Sylvain "tnt" Munaut

<https://github.com/smunaut/blackmagic-misc>  
Licence: Apache-2.0 (SPDX header in bmd.py; the repo has no LICENSE file, so GitHub does not detect it)  
Copyright: 2021 Sylvain Munaut

Blackmagic has never published the DaVinci Resolve Speed Editor's HID protocol, and the panel reports nothing until a challenge-response handshake completes. The handshake, the report formats and the jog modes in core/hid/speed-editor.js come from Munaut's reverse engineering in bmd.py, and the authentication tests use vectors produced by running bmd.py itself.

### node-blackmagic-controller — Julian Waller

<https://github.com/Julusian/node-blackmagic-controller>  
Licence: MIT  
Copyright: 2024 Julian Waller

The Speed Editor's key and LED tables in core/hid/speed-editor.js follow node-blackmagic-controller, the library Bitfocus Companion drives the panel with.

## Third-party code this project uses

Libraries, SDKs and frameworks the project is built on or bundles.

### The npm ecosystem

<https://www.npmjs.com>  
Licence: predominantly MIT  
Copyright: the individual package authors

npm dependencies, resolved and pinned in the lockfile.

Build tooling, test runners and the libraries the front ends are assembled from. The exact set and versions for any build are in that repo's lockfile, which is the authoritative list.

The full transitive dependency set for any build is pinned in this repo's lockfile,
which is the authoritative list. What is named above is the layers a reader would
want to know about, not every package that has ever been resolved.

## Work we checked ourselves against

No code was taken from these — but they were how we knew we had it right, and that is worth saying out loud.

### Analog Way AWJ Protocol Programmer's Guide — Analog Way

awj-surface controls Analog Way LivePremier (Aquilon) processors. It is not affiliated with or endorsed by Analog Way, and redistributes no part of their software, firmware or documentation. The guide documents the port, the wire format and the framing; every parameter range in core/catalogue.json is the device's own statement about itself, read from the device at generation time and verified on the wire.

## Standards and published specifications

What the implementation is measured against.

- **Mackie Control (MCU)** — The de-facto map every DAW implements. Never formally published by Mackie; the numbers were confirmed against a real surface's behaviour and against other open implementations.
- **Akai APC40** — From Akai's published communications documentation.
- **JLCooper MIDIcon 2 / Pro** — From JLCooper's published documentation.

## Getting this wrong

If your work is here and the description is inaccurate, the licence is wrong, or you would rather not be listed — open an issue and it will be fixed.
