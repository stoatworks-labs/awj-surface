# Attributions

## The switcher

awj-surface controls Analog Way **LivePremier** (Aquilon) processors. It is
**not affiliated with or endorsed by Analog Way**, and redistributes no part of
their software, firmware or documentation.

The control protocol is documented openly by Analog Way in the **AWJ Protocol
Programmer's Guide**, which covers the port, the wire format and the framing.
Every parameter range in `core/catalogue.json` is the device's own statement
about itself, read from the device at generation time and verified on the wire.
Nothing of Analog Way's is contained in this repository.

## Control surfaces

Controller profiles describe publicly documented surfaces by their message
numbers:

- **Mackie Control (MCU)** — the de-facto map every DAW implements. Never
  formally published by Mackie; the numbers here were confirmed against a real
  surface's behaviour and against other open implementations.
- **Akai APC40** — from Akai's published communications documentation.
- **JLCooper MIDIcon 2 / Pro** — from JLCooper's published documentation.

- **Blackmagic DaVinci Resolve Speed Editor** — not documented by Blackmagic.
  `core/hid/` reimplements two open-source works. The authentication, report
  formats and jog modes come from Sylvain Munaut's reverse engineering,
  [blackmagic-misc](https://github.com/smunaut/blackmagic-misc) `bmd.py`
  (Apache-2.0, © 2021 Sylvain Munaut). The key and lamp tables were checked
  against Julian Waller's
  [node-blackmagic-controller](https://github.com/Julusian/node-blackmagic-controller)
  (MIT, © 2024 Julian Waller). The auth tests use vectors produced by running
  `bmd.py` itself.

No manufacturer firmware, software or documentation is redistributed. A profile
is a list of numbers describing what a controller sends, written here in its
own words.

## Runtime

**Node.js** (MIT). The project has **no runtime npm dependencies**.
