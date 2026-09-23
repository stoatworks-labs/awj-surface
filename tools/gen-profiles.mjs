/*
 * Build the shipped controller profiles.
 *
 * These are written as code rather than by hand because they are mostly eight
 * of the same thing, and a hand-typed JSON file with 8 strips x 5 controls is
 * a transcription-error generator. The MIDI numbers below are the only hand-
 * entered data, and each block says where it came from.
 *
 *   node tools/gen-profiles.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { speedEditorControls } from '../core/hid/surface.js';
import { VENDOR_ID, PRODUCT_ID } from '../core/hid/speed-editor.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'profiles');
mkdirSync(out, { recursive: true });

const range = (n) => Array.from({ length: n }, (_, i) => i);

/*
 * The geometry page: eight parameters that want a continuous control, each
 * with a window narrower than the parameter's own range.
 *
 * Position runs -2,000,000..2,000,000 on the device. Mapped raw onto a fader
 * that is 31,500 units per step, and onto an encoder it is 15,000 units per
 * detent. The windows below are a 4K canvas plus a screen of overscan either
 * side, which is the range anyone actually steers a layer through.
 */
const GEOMETRY = [
  { param: 'position.posH', min: -1920, max: 3840 },
  { param: 'position.posV', min: -1080, max: 2160 },
  { param: 'position.sizeH', min: 0, max: 3840 },
  { param: 'position.sizeV', min: 0, max: 2160 },
  { param: 'cropping.classic.left' },
  { param: 'cropping.classic.right' },
  { param: 'cropping.classic.top' },
  { param: 'cropping.classic.bottom' }
];

/* A knob has 128 positions. Handing it all 482 members of INPUTLAYER_LOGIC
   makes every position four sources wide, so absolute source selection is
   offered over the live inputs only. Relative controls get the full list. */
const LIVE_INPUTS = range(16).map((i) => `LIVE_${i + 1}`);

const layerTarget = (param, extra = {}) => ({
  kind: 'layer', screen: '@selected', preset: '@selected', layer: '@strip', param, ...extra
});
const selectedTarget = (param) => ({
  kind: 'layer', screen: '@selected', preset: '@selected', layer: '@selected', param
});
const groupTarget = (param) => ({ kind: 'screenGroup', screen: '@selected', param });

/* ------------------------------------------------------- Behringer X-Touch */

/*
 * Mackie Control layout, which is what the X-Touch emulates out of the box.
 * MCU has never been published by Mackie; these numbers are the de-facto map
 * every host implements, and Behringer's own MC-mode documentation matches it.
 */
const XTOUCH_NOTES = { rec: 0, solo: 8, mute: 16, select: 24, vpotPress: 32 };

function xtouch() {
  const controls = [];
  const bindings = [];

  for (const s of range(8)) {
    controls.push({ id: `pb:${s}`, kind: 'fader14', strip: s, motorised: true, label: `Fader ${s + 1}`, scribble: true });
    controls.push({ id: `note:0:${104 + s}`, kind: 'touch', strip: s, label: `Fader ${s + 1} touch` });
    controls.push({ id: `cc:0:${16 + s}`, kind: 'encoder', strip: s, relative: 'signed', label: `V-Pot ${s + 1}` });
    for (const [name, base] of Object.entries(XTOUCH_NOTES)) {
      controls.push({ id: `note:0:${base + s}`, kind: 'button', strip: s, label: `${name} ${s + 1}` });
    }

    /* Fader = that strip's layer opacity. Motorised, so no pickup dead zone. */
    bindings.push({
      control: `pb:${s}`,
      label: 'Opacity',
      target: layerTarget('opacity.opacity'),
      options: { takeover: 'jump' }
    });

    /* V-Pot steps that strip's source. Relative, so all 482 are reachable. */
    bindings.push({
      control: `cc:0:${16 + s}`, shift: false,
      label: 'Source',
      target: layerTarget('source.inputNum'),
      options: { step: 1 }
    });

    /* Shifted, the V-Pots stop being per-strip and become a geometry page for
       whichever layer is selected — eight knobs, eight parameters. */
    bindings.push({
      control: `cc:0:${16 + s}`, shift: true,
      target: selectedTarget(GEOMETRY[s].param),
      options: { min: GEOMETRY[s].min, max: GEOMETRY[s].max }
    });

    bindings.push({
      control: `note:0:${XTOUCH_NOTES.select + s}`,
      label: 'Select',
      target: { kind: 'action', action: 'selectLayer', value: '@strip' }
    });
    bindings.push({
      control: `note:0:${XTOUCH_NOTES.mute + s}`,
      label: 'Key',
      target: layerTarget('keying.enable'),
      options: { action: 'toggle' }
    });
    bindings.push({
      control: `note:0:${XTOUCH_NOTES.solo + s}`,
      label: 'Aspect',
      target: layerTarget('cropping.classic.aspectOverride'),
      options: { action: 'toggle', wrap: true }
    });
    bindings.push({
      control: `note:0:${XTOUCH_NOTES.rec + s}`,
      label: `Live ${s + 1}`,
      target: layerTarget('source.inputNum'),
      options: { action: 'set', value: `LIVE_${s + 1}` }
    });
  }

  const named = [
    [46, 'Bank left', { kind: 'action', action: 'bank', delta: -1 }],
    [47, 'Bank right', { kind: 'action', action: 'bank', delta: 1 }],
    [50, 'Flip preset', { kind: 'action', action: 'selectPreset', value: 'toggle' }],
    [70, 'Shift', { kind: 'action', action: 'shift' }],
    [94, 'TAKE', groupTarget('control.xTake'), { action: 'trigger' }],
    [93, 'Abort', groupTarget('control.xTakeAbort'), { action: 'trigger' }],
    [91, 'Cut', groupTarget('control.xCut'), { action: 'trigger' }],
    [92, 'Step back', groupTarget('control.xStepBack'), { action: 'trigger' }]
  ];
  for (const [note, label, target, options] of named) {
    controls.push({ id: `note:0:${note}`, kind: 'button', label });
    bindings.push({ control: `note:0:${note}`, label, target, ...(options ? { options } : {}) });
  }

  /* The master fader drives the T-bar, which is the one thing on a switcher
     that genuinely is a fader. Motorised, so it tracks a take in progress. */
  controls.push({ id: 'pb:8', kind: 'fader14', strip: 8, motorised: true, label: 'Master fader' });
  controls.push({ id: 'note:0:112', kind: 'touch', strip: 8, label: 'Master touch' });
  bindings.push({
    control: 'pb:8', label: 'T-bar',
    target: groupTarget('control.tbarPosition'),
    options: { takeover: 'jump' }
  });

  /* Jog wheel. Sign-magnitude like the V-Pots, one CC. */
  controls.push({ id: 'cc:0:60', kind: 'encoder', relative: 'signed', label: 'Jog' });
  bindings.push({
    control: 'cc:0:60', label: 'Take time',
    target: groupTarget('control.takeUpTime'),
    options: { step: 1 }
  });

  return {
    id: 'x-touch-mcu',
    name: 'Behringer X-Touch (Mackie Control mode)',
    stripCount: 8,
    match: { namePattern: 'X-Touch' },
    feedback: { protocol: 'mcu', deviceId: 0x14 },
    notes: 'Set the X-Touch to MC mode. Faders are motorised and scribble strips show the layer each strip is pointed at.',
    verified: false,
    controls,
    bindings
  };
}

/* ------------------------------------------------------------- Akai APC40 */

/*
 * APC40 (mk1). Track controls are per-channel on MIDI channels 1-8; everything
 * global sits on channel 1. LED colours are velocities on the clip grid:
 * 1 green, 2 green blink, 3 red, 4 red blink, 5 yellow, 6 yellow blink.
 */
function apc40() {
  const controls = [];
  const bindings = [];

  for (const s of range(8)) {
    controls.push({ id: `cc:${s}:7`, kind: 'fader', strip: s, label: `Track fader ${s + 1}` });
    controls.push({ id: `cc:0:${48 + s}`, kind: 'knob', strip: s, ring: 48 + s, label: `Track knob ${s + 1}` });
    controls.push({ id: `cc:0:${16 + s}`, kind: 'knob', strip: s, ring: 16 + s, label: `Device knob ${s + 1}` });
    controls.push({ id: `note:${s}:51`, kind: 'button', strip: s, on: 1, label: `Track select ${s + 1}` });
    controls.push({ id: `note:${s}:50`, kind: 'button', strip: s, on: 1, label: `Activator ${s + 1}` });
    for (const row of range(5)) {
      controls.push({
        id: `note:${s}:${53 + row}`, kind: 'button', strip: s,
        on: row === 0 ? 1 : row === 1 ? 5 : 3, off: 0,
        label: `Clip ${s + 1}/${row + 1}`
      });
    }

    /* Faders are not motorised, so they need pickup or the first touch after a
       bank change slams the layer to wherever the fader is sitting. */
    bindings.push({
      control: `cc:${s}:7`, label: 'Opacity',
      target: layerTarget('opacity.opacity'),
      options: { takeover: 'pickup' }
    });

    /* Track knobs pick a source. Absolute, so the list is trimmed to the live
       inputs — 482 members across 128 knob positions is not selectable. */
    bindings.push({
      control: `cc:0:${48 + s}`, label: 'Source',
      target: layerTarget('source.inputNum'),
      options: { values: LIVE_INPUTS }
    });

    /* Device knobs are the geometry page for the selected layer. */
    bindings.push({
      control: `cc:0:${16 + s}`,
      target: selectedTarget(GEOMETRY[s].param),
      options: { min: GEOMETRY[s].min, max: GEOMETRY[s].max, takeover: 'pickup' }
    });

    bindings.push({
      control: `note:${s}:51`, label: 'Select',
      target: { kind: 'action', action: 'selectLayer', value: '@strip' }
    });
    bindings.push({
      control: `note:${s}:53`, label: 'Select',
      target: { kind: 'action', action: 'selectLayer', value: '@strip' }
    });
    bindings.push({
      control: `note:${s}:54`, label: 'Key',
      target: layerTarget('keying.enable'),
      options: { action: 'toggle' }
    });
    for (const row of [2, 3, 4]) {
      bindings.push({
        control: `note:${s}:${53 + row}`, label: `Live ${row - 1}`,
        target: layerTarget('source.inputNum'),
        options: { action: 'set', value: `LIVE_${row - 1}` }
      });
    }
    bindings.push({
      control: `note:${s}:50`, label: 'Aspect',
      target: layerTarget('cropping.classic.aspectOverride'),
      options: { action: 'toggle', wrap: true }
    });
  }

  controls.push({ id: 'cc:0:14', kind: 'fader', label: 'Master fader' });
  bindings.push({
    control: 'cc:0:14', label: 'T-bar',
    target: groupTarget('control.tbarPosition'),
    options: { takeover: 'pickup' }
  });

  const named = [
    [91, 'TAKE', groupTarget('control.xTake'), { action: 'trigger' }],
    [92, 'Abort', groupTarget('control.xTakeAbort'), { action: 'trigger' }],
    [93, 'Cut', groupTarget('control.xCut'), { action: 'trigger' }],
    [98, 'Shift', { kind: 'action', action: 'shift' }],
    [94, 'Bank up', { kind: 'action', action: 'bank', delta: 1 }],
    [95, 'Bank down', { kind: 'action', action: 'bank', delta: -1 }],
    [80, 'Preset flip', { kind: 'action', action: 'selectPreset', value: 'toggle' }],
    [81, 'Copy to preview', groupTarget('control.xCopyProgramToPreview'), { action: 'trigger' }]
  ];
  for (const [note, label, target, options] of named) {
    controls.push({ id: `note:0:${note}`, kind: 'button', on: 1, label });
    bindings.push({ control: `note:0:${note}`, label, target, ...(options ? { options } : {}) });
  }

  /* Scene launch buttons pick the screen the whole surface is pointed at. */
  for (const i of range(5)) {
    const note = 82 + i;
    controls.push({ id: `note:0:${note}`, kind: 'button', on: 1, label: `Scene ${i + 1}` });
    bindings.push({
      control: `note:0:${note}`, label: `S${i + 1}`,
      target: { kind: 'action', action: 'selectScreen', value: `S${i + 1}` }
    });
  }

  return {
    id: 'apc40',
    name: 'Akai APC40',
    stripCount: 8,
    match: { namePattern: 'APC40' },
    feedback: { protocol: 'generic' },
    /*
     * Mode 0x42 is "alternate Ableton Live mode", in which the host owns every
     * LED. Without it the APC40 lights its own buttons locally and feedback
     * fights the hardware.
     */
    init: [[0xf0, 0x47, 0x00, 0x73, 0x60, 0x00, 0x04, 0x42, 0x08, 0x02, 0x05, 0xf7]],
    notes: 'Faders are not motorised, so bindings use pickup: move a fader to where the parameter already is before it takes control.',
    verified: false,
    controls,
    bindings
  };
}

/* ------------------------------------------------------ Elation MIDIcon(s) */

/*
 * Both MIDIcons send a NOTE PER CLICK from their rotaries — one note number for
 * clockwise, another for anticlockwise — rather than a relative CC. Each rotary
 * is therefore two controls carrying opposite `tick` values.
 *
 * Both also take feedback by echo: sending a button's own note lights it, and
 * sending a fader's own CC drives its motor. That is exactly the `generic`
 * protocol, so no special-casing is needed.
 */
function midicon({ id, name, faders, master, rows, rotaries, rotaryPress, pageUp, pageDown, blackout, extras = [] }) {
  const controls = [];
  const bindings = [];

  for (const s of range(faders.length)) {
    controls.push({ id: `cc:0:${faders[s]}`, kind: 'fader', strip: s, motorised: true, label: `Playback fader ${s + 1}` });
    bindings.push({
      control: `cc:0:${faders[s]}`, label: 'Opacity',
      target: layerTarget('opacity.opacity'),
      options: { takeover: 'jump' }
    });
  }

  controls.push({ id: `cc:0:${master}`, kind: 'fader', motorised: true, label: 'Master fader' });
  bindings.push({
    control: `cc:0:${master}`, label: 'T-bar',
    target: groupTarget('control.tbarPosition'),
    options: { takeover: 'jump' }
  });

  for (const [rowIndex, row] of rows.entries()) {
    for (const s of range(row.notes.length)) {
      const cid = `note:0:${row.notes[s]}`;
      controls.push({ id: cid, kind: 'button', strip: s, label: `${row.label} ${s + 1}` });
      if (row.role === 'select') {
        bindings.push({ control: cid, label: 'Select', target: { kind: 'action', action: 'selectLayer', value: '@strip' } });
      } else if (row.role === 'key') {
        bindings.push({ control: cid, label: 'Key', target: layerTarget('keying.enable'), options: { action: 'toggle' } });
      } else {
        bindings.push({
          control: cid, label: `Live ${s + 1}`,
          target: layerTarget('source.inputNum'),
          options: { action: 'set', value: `LIVE_${s + 1}` }
        });
      }
    }
  }

  for (const [i, [cw, ccw]] of rotaries.entries()) {
    const geom = GEOMETRY[i % GEOMETRY.length];
    controls.push({ id: `note:0:${cw}`, kind: 'encoder', tick: 1, label: `Rotary ${i + 1} right` });
    controls.push({ id: `note:0:${ccw}`, kind: 'encoder', tick: -1, label: `Rotary ${i + 1} left` });
    for (const cid of [`note:0:${cw}`, `note:0:${ccw}`]) {
      bindings.push({
        control: cid,
        target: selectedTarget(geom.param),
        options: { min: geom.min, max: geom.max }
      });
    }
    if (rotaryPress[i] !== undefined) {
      const pid = `note:0:${rotaryPress[i]}`;
      controls.push({ id: pid, kind: 'button', label: `Rotary ${i + 1} press` });
      bindings.push({
        control: pid, label: 'Reset',
        target: selectedTarget(geom.param),
        options: { action: 'set', value: null, resetToDefault: true }
      });
    }
  }

  for (const [note, label, target] of [
    [pageUp, 'Bank up', { kind: 'action', action: 'bank', delta: 1 }],
    [pageDown, 'Bank down', { kind: 'action', action: 'bank', delta: -1 }],
    ...extras
  ]) {
    controls.push({ id: `note:0:${note}`, kind: 'button', label });
    bindings.push({ control: `note:0:${note}`, label, target });
  }

  /*
   * The BLACKOUT button is described but deliberately left unbound. A button
   * that says BLACKOUT and fires a take, or zeroes an opacity on the live
   * preset, is a trap: the surface would do something irreversible on air that
   * its own legend disagrees with. Bind it deliberately or not at all.
   */
  controls.push({ id: `note:0:${blackout}`, kind: 'button', label: 'Blackout (unbound by design)' });

  return {
    id, name,
    stripCount: faders.length,
    match: { namePattern: name.replace(/Elation /, '') },
    feedback: { protocol: 'generic' },
    notes: 'Rotaries send one note per click, so each is two controls. Faders are motorised and take position by echo.',
    verified: false,
    controls,
    bindings
  };
}


/* -------------------------------------------------------------------- OSC */

/*
 * A default OSC layout, laid out to suit a TouchOSC-style template.
 *
 * OSC controls are declared exactly like MIDI ones — the id is the address
 * with an `osc:` prefix, and everything above the transport is unchanged. The
 * addresses are chosen to be typed easily into a layout editor rather than to
 * mirror the device's own path names, which are far too long for a fader
 * label.
 *
 * Feedback goes back out to the same address, which is what every OSC surface
 * expects, so a fader on a tablet tracks the switcher like a motorised one.
 */
function osc() {
  const controls = [];
  const bindings = [];

  for (const s of range(8)) {
    const fader = `osc:/awj/layer/${s + 1}/opacity`;
    controls.push({ id: fader, kind: 'fader', strip: s, motorised: true, label: `Layer ${s + 1} opacity` });
    bindings.push({
      control: fader, label: 'Opacity',
      target: layerTarget('opacity.opacity'),
      options: { takeover: 'jump' }
    });

    const select = `osc:/awj/layer/${s + 1}/select`;
    controls.push({ id: select, kind: 'button', strip: s, label: `Select layer ${s + 1}` });
    bindings.push({ control: select, label: 'Select', target: { kind: 'action', action: 'selectLayer', value: '@strip' } });

    const key = `osc:/awj/layer/${s + 1}/key`;
    controls.push({ id: key, kind: 'button', strip: s, label: `Key layer ${s + 1}` });
    bindings.push({ control: key, label: 'Key', target: layerTarget('keying.enable'), options: { action: 'toggle' } });
  }

  for (const [i, geom] of GEOMETRY.entries()) {
    const id = `osc:/awj/selected/${geom.param.split('.').pop()}`;
    controls.push({ id, kind: 'fader', label: geom.param, strip: undefined });
    bindings.push({
      control: id,
      target: selectedTarget(geom.param),
      options: { min: geom.min, max: geom.max, takeover: 'jump' }
    });
  }

  const named = [
    ['/awj/take', 'TAKE', groupTarget('control.xTake'), { action: 'trigger' }],
    ['/awj/cut', 'Cut', groupTarget('control.xCut'), { action: 'trigger' }],
    ['/awj/abort', 'Abort', groupTarget('control.xTakeAbort'), { action: 'trigger' }],
    ['/awj/preset', 'Preset flip', { kind: 'action', action: 'selectPreset', value: 'toggle' }],
    ['/awj/bank/up', 'Bank up', { kind: 'action', action: 'bank', delta: 1 }],
    ['/awj/bank/down', 'Bank down', { kind: 'action', action: 'bank', delta: -1 }]
  ];
  for (const [address, label, target, options] of named) {
    controls.push({ id: `osc:${address}`, kind: 'button', label });
    bindings.push({ control: `osc:${address}`, label, target, ...(options ? { options } : {}) });
  }

  controls.push({ id: 'osc:/awj/tbar', kind: 'fader', motorised: true, label: 'T-bar' });
  bindings.push({
    control: 'osc:/awj/tbar', label: 'T-bar',
    target: groupTarget('control.tbarPosition'),
    options: { takeover: 'jump' }
  });

  return {
    id: 'osc-default',
    name: 'OSC (TouchOSC and similar)',
    stripCount: 8,
    feedback: { protocol: 'generic' },
    notes: 'Send to the server\'s --osc-in port; feedback returns to --osc-out on the same addresses. OSC is UDP, so this profile only works in the local-server host.',
    verified: false,
    controls,
    bindings
  };
}

/* ---------------------------------------------------------------- generic */

/* An empty surface. Everything arrives as `unmapped` and MIDI-learn fills it
   in, which is the only honest starting point for a controller whose map is
   not published. */
/* ------------------------------------- Blackmagic DaVinci Resolve Speed Editor */

/*
 * Not MIDI: a USB/Bluetooth HID panel, driven through core/hid/. Its keys are
 * named, not numbered, and carry an edit suite's legends, so each binding
 * gets a label saying what it does here. Nine CAM keys with lamps are the
 * obvious source bus; the wheel's three faces are chosen with JOG / SHTL /
 * SCRL, and SNAP is shift.
 */
function speedEditor() {
  const controls = speedEditorControls();
  const bindings = [];
  const key = (name, label, target, extra = {}) =>
    bindings.push({ control: `key:${name}`, label, target, ...extra });

  for (const n of range(9)) {
    key(`cam${n + 1}`, `Live ${n + 1}`, selectedTarget('source.inputNum'),
      { options: { action: 'set', value: `LIVE_${n + 1}` } });
  }
  const layerKeys = ['smart-insert', 'append', 'ripple-owr', 'close-up', 'place-on-top', 'src-owr', 'in', 'out'];
  layerKeys.forEach((name, i) =>
    key(name, `Layer ${i + 1}`, { kind: 'action', action: 'selectLayer', value: i + 1 }));

  key('cut', 'Cut', groupTarget('control.xCut'), { options: { action: 'trigger' } });
  key('dis', 'Take', groupTarget('control.xTake'), { options: { action: 'trigger' } });
  key('stop-play', 'Take', groupTarget('control.xTake'), { options: { action: 'trigger' } });
  key('smth-cut', 'Abort', groupTarget('control.xTakeAbort'), { options: { action: 'trigger' } });
  key('trans', 'Flip preset', { kind: 'action', action: 'selectPreset', value: 'toggle' });
  key('snap', 'Shift', { kind: 'action', action: 'shift' });
  key('live-owr', 'Key', selectedTarget('keying.enable'), { options: { action: 'toggle' } });
  key('source', 'Screen S1', { kind: 'action', action: 'selectScreen', value: 'S1' });
  key('timeline', 'Screen S2', { kind: 'action', action: 'selectScreen', value: 'S2' });

  const geo = (param) => GEOMETRY.find((g) => g.param === param);
  const wheel = (face, label, target, options, shift) =>
    bindings.push({ control: `jog:${face}`, label, target, options, shift });
  wheel('jog', 'Opacity', selectedTarget('opacity.opacity'), {}, false);
  wheel('shtl', 'Position H', selectedTarget('position.posH'), { min: geo('position.posH').min, max: geo('position.posH').max }, false);
  wheel('scrl', 'Position V', selectedTarget('position.posV'), { min: geo('position.posV').min, max: geo('position.posV').max }, false);
  wheel('jog', 'T-bar', groupTarget('control.tbarPosition'), {}, true);
  wheel('shtl', 'Size H', selectedTarget('position.sizeH'), { min: geo('position.sizeH').min, max: geo('position.sizeH').max }, true);
  wheel('scrl', 'Size V', selectedTarget('position.sizeV'), { min: geo('position.sizeV').min, max: geo('position.sizeV').max }, true);

  return {
    id: 'speed-editor',
    name: 'DaVinci Resolve Speed Editor',
    transport: 'hid',
    stripCount: 8,
    match: { vendorId: VENDOR_ID, productId: PRODUCT_ID },
    feedback: { protocol: 'speed-editor' },
    notes: 'USB or Bluetooth HID, not MIDI: needs a browser with WebHID. The panel only talks after a handshake, which the host repeats before it lapses. Quit DaVinci Resolve first — both would hear every key and fight over the lamps. JOG / SHTL / SCRL choose what the wheel moves; SNAP is shift.',
    verified: false,
    controls,
    bindings
  };
}

const generic = () => ({
  id: 'generic-learn',
  name: 'Generic (learn everything)',
  stripCount: 8,
  feedback: { protocol: 'generic' },
  notes: 'Start here for any surface without a shipped profile. Move a control and it appears; assign it and it is saved.',
  verified: false,
  controls: [],
  bindings: []
});

/* -------------------------------------------------------------------- run */

const profiles = [
  xtouch(),
  apc40(),
  midicon({
    id: 'midicon-pro',
    name: 'Elation MIDICON PRO',
    faders: [1, 2, 3, 4, 5, 6, 7, 8],
    master: 9,
    rows: [
      { label: 'Playback >', role: 'select', notes: [86, 87, 88, 89, 90, 91, 92, 93] },
      { label: 'Playback <', role: 'key', notes: [94, 95, 96, 97, 98, 99, 100, 101] },
      { label: 'Playback n', role: 'source', notes: [102, 103, 104, 105, 106, 107, 108, 109] }
    ],
    rotaries: [[113, 114], [115, 116], [117, 118], [119, 120]],
    rotaryPress: [121, 122, 123, 124],
    pageUp: 111,
    pageDown: 112,
    blackout: 110,
    extras: [
      [39, 'Screen S1', { kind: 'action', action: 'selectScreen', value: 'S1' }],
      [40, 'Screen S2', { kind: 'action', action: 'selectScreen', value: 'S2' }],
      [41, 'Screen S3', { kind: 'action', action: 'selectScreen', value: 'S3' }],
      [42, 'Screen S4', { kind: 'action', action: 'selectScreen', value: 'S4' }],
      [84, 'Shift', { kind: 'action', action: 'shift' }],
      [85, 'Preset flip', { kind: 'action', action: 'selectPreset', value: 'toggle' }]
    ]
  }),
  midicon({
    id: 'midicon-2',
    name: 'Elation MIDICON-2',
    faders: [1, 2, 3, 4, 5, 6, 7, 8],
    master: 9,
    rows: [
      { label: 'Playback top', role: 'select', notes: [41, 42, 43, 44, 45, 46, 47, 48] },
      { label: 'Playback bottom', role: 'key', notes: [49, 50, 51, 52, 53, 54, 55, 56] }
    ],
    rotaries: [[86, 87], [88, 89], [90, 91], [92, 93], [94, 95], [96, 97], [98, 99], [100, 101]],
    rotaryPress: [68, 69, 70, 71, 72, 73, 74, 75],
    pageUp: 57,
    pageDown: 58,
    blackout: 67
  }),
  osc(),
  speedEditor(),
  generic()
];

for (const p of profiles) {
  writeFileSync(join(out, `${p.id}.json`), JSON.stringify(p, null, 2) + '\n');
  process.stderr.write(`${p.id}: ${p.controls.length} controls, ${p.bindings.length} bindings\n`);
}
