# Profiles and bindings

A profile is plain JSON in two halves, and the split is the point.

```jsonc
{
  "id": "x-touch-mcu",
  "name": "Behringer X-Touch (Mackie Control mode)",
  "stripCount": 8,
  "match":    { "namePattern": "X-Touch" },
  "feedback": { "protocol": "mcu", "deviceId": 20 },

  "controls": [ /* the hardware. Never changes. */ ],
  "bindings": [ /* the show. This is what MIDI-learn edits. */ ]
}
```

`controls` describes what is physically on the surface — which MIDI message each fader,
encoder and button produces. `bindings` says what those controls are wired to. Keeping
them apart means you can remap an APC40 completely without re-describing an APC40, and
that a binding set can be pointed at a different surface by swapping control ids.

Saved edits land in `profiles/saved/<id>.json` and override the shipped `bindings` only.
Delete that file to get the shipped mapping back.

## Control ids

An id names an address, never a value — a fader at 0 and the same fader at 127 have the
same id, which is what a mapping is keyed on.

| Form | Meaning |
|---|---|
| `note:<ch>:<n>` | note on/off, channel 0-15 |
| `cc:<ch>:<n>` | control change |
| `pb:<ch>` | pitch bend — 14-bit, and how MCU faders work |
| `pp:<ch>:<n>` | polyphonic aftertouch |
| `cp:<ch>` | channel pressure |
| `osc:/some/address` | an OSC address |

Note-off shares its id with note-on. Channels are **zero-based** here, so "MIDI channel
1" in a manual is `0`.

## Controls

```jsonc
{
  "id": "cc:0:16",
  "kind": "encoder",
  "strip": 0,           // which strip it belongs to; enables "@strip" bindings
  "relative": "signed", // encoder encoding: signed | twos | offset
  "tick": 1,            // note-per-click rotaries: direction of this note
  "accelerate": false,  // default true — fast spins move further
  "motorised": true,    // a fader that can be driven back
  "scribble": true,     // this control owns the strip's display
  "ring": 56,           // separate CC for a knob's LED ring
  "on": 5, "off": 0,    // lamp velocities (APC40 colours live here)
  "label": "V-Pot 1",
  "feedback": false     // never send anything to this control
}
```

`kind` is one of:

| kind | produces | notes |
|---|---|---|
| `fader` | absolute 0-1 | 7-bit. Not motorised unless it says so |
| `fader14` | absolute 0-1 | 14-bit pitch bend; MCU faders |
| `knob` | absolute 0-1 | a potentiometer, not an encoder |
| `encoder` | relative ticks | endless; see below |
| `button` | press/release | |
| `touch` | contact | fader-touch notes; suppresses motor drive |

### Encoders come in four flavours and they are not interchangeable

Three put a signed tick count in a CC value byte:

- **`signed`** — bit 6 is the sign. `0x01..0x3F` clockwise, `0x41..0x7F` anticlockwise.
  Mackie Control, so the X-Touch.
- **`twos`** — two's complement. `1..63` clockwise, `127..65` anticlockwise.
- **`offset`** — 64 is centre; above clockwise, below anticlockwise.

The fourth sends **a note per click**, one note number for each direction, with no value
byte at all. Both Elation MIDIcons do this. Declare each direction as its own control
with a `tick` of `1` or `-1`.

Reading one convention as another is the classic runaway-parameter bug. `0x7F` is one
click anticlockwise to a V-Pot, sixty-three anticlockwise as two's complement, and
sixty-three *clockwise* as binary offset.

## Bindings

```jsonc
{
  "control": "cc:0:16",
  "label": "Source",        // shown on scribble strips and in the UI
  "shift": false,           // arm only when the shift modifier matches
  "target": { … },
  "options": { … }
}
```

A control may carry several bindings — one `shift: true` and one `shift: false` is how
eight knobs address sixteen things. A binding with no `shift` key is always armed.

### Targets

**`layer`** — a parameter inside one layer of one screen preset.

```jsonc
{ "kind": "layer",
  "screen":  "@selected",   // or "S3"
  "preset":  "PREVIEW",     // or "PROGRAM", or a literal "A" | "B" | "C"
  "layer":   "@strip",      // or "@selected", or a number
  "param":   "opacity.opacity" }
```

`@strip` is what makes a bank of eight faders useful: each control declares its strip
index once, and one binding then covers all eight. The bank offset shifts the whole set,
so eight faders reach 128 layers.

**`preset` is not cosmetic.** `PREVIEW` and `PROGRAM` are resolved per event against
live device state, because which preset letter is on air changes at every take. A
literal letter is passed through untouched — which is what you want when deliberately
editing a memory that is neither on air nor cued.

**`screenGroup`** — the take controls and transition times.

```jsonc
{ "kind": "screenGroup", "screen": "@selected", "param": "control.xTake" }
```

**`action`** — surface state rather than the device. These never write anything.

| action | |
|---|---|
| `selectLayer` | `value`: a layer number or `"@strip"` |
| `selectScreen` | `value`: `"S3"` |
| `selectPreset` | `value`: `"PREVIEW"`, `"PROGRAM"` or `"toggle"` |
| `bank` | `delta`: `1` / `-1`, or `value` to set outright |
| `shift` | held while the button is down |

### Options

```jsonc
{
  "min": -1920, "max": 3840,   // narrow the range this control works over
  "step": 1,                   // relative: units (or list positions) per detent
  "wrap": true,                // relative on an enum: wrap past the ends
  "values": ["LIVE_1", "…"],   // restrict an enum to a usable subset
  "action": "toggle",          // buttons: toggle | set | momentary | trigger
  "value": "LIVE_3",           // what `set`/`momentary` writes
  "releaseValue": false,       // momentary: what to restore, if anything
  "resetToDefault": true,      // write the device's own stated default
  "takeover": "pickup"         // pickup | jump
}
```

**Narrow the range.** `position.posH` runs ±2,000,000 on the device. Mapped raw onto a
7-bit fader that is 31,500 pixels per step — useless. `min`/`max` are clamped to the
parameter's own range, so a profile cannot ask for something the device would reject.

**Trim enum lists.** `source.inputNum` has 482 members. Across 128 knob positions that
is four sources per position. `values` restricts an absolute control to a subset; a
relative one can reach the whole list one step at a time and does not need it.

**Takeover.** `pickup` (the default for anything without a motor) suppresses writes until
the control passes through the value it is steering. Without it, the first touch after a
bank change slams the new layer to wherever the fader happens to be sitting. Motorised
controls default to `jump`, because the parameter drives them and they already agree.

**Buttons.** `trigger` writes `true` and nothing on release — the device's `x`-prefixed
properties are fire-on-true and need no matching `false`. `toggle` inverts a bool or
steps an enum. `set` writes `value`. `momentary` writes on press and, only if
`releaseValue` is given, restores on release.

## Feedback protocols

**`generic`** — a control is lit by sending its own message back. Nearly every
class-compliant surface works this way: note-on to a button's note sets its LED, a CC
back to a knob sets its ring, and a CC back to a motorised fader moves it. Both MIDIcons
and the APC40 use this.

**`mcu`** — Mackie Control. Nothing shares an address with its control: faders are pitch
bend, V-Pot rings live on CC 48-55 while the V-Pots are on 16-23, and text goes out as
SysEx. `deviceId` is `0x14` for a Mackie Control (what an X-Touch emulates) and `0x15`
for an extender.

A `null` position means *no value* and is not the same as zero — a host blanks the LED
ring rather than driving it to the bottom, so an unassigned control looks unassigned.

## Parameter ids

Dotted node paths within a layer: `opacity.opacity`, `position.sizeH`,
`cropping.classic.left`, `cropping.mask.top`, `keying.enable`, `source.inputNum`. Screen
group parameters are `control.xTake`, `control.tbarPosition`, `control.takeUpTime` and
so on.

The full list, with each parameter's type, range and enum members, is
`core/catalogue.json` — generated from the device rather than typed from documentation.
The mapping UI's picker is built from it, so anything the device exposes is mappable
whether or not it appears in the shipped profiles.
