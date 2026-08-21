/*
 * The on-screen controller.
 *
 * This is not a mock of the mapping layer. It imports the same MIDI codec the
 * server uses, encodes real bytes, and posts them to the same virtual port a
 * plugged-in controller would feed. Everything downstream — decode, binding
 * resolution, preset letters, coalescing, the write — is the production path.
 *
 * That is what makes developing against no hardware honest: the only thing
 * being stood in for is the physical surface itself.
 */

import { encode, parseControlId } from '/core/midi/message.js';
import { encodeRelative } from '/core/midi/encoders.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class ScreenSurface {
  constructor(root, { onBytes }) {
    this.root = root;
    this.onBytes = onBytes;
    this.profile = null;
    this.nodes = new Map();     // control id -> {el, kind, set(fb)}
    this.positions = new Map(); // control id -> last known 0..1
  }

  render(profile, selection) {
    this.profile = profile;
    this.nodes.clear();
    this.root.textContent = '';

    const strips = new Map();
    const globals = [];
    for (const control of profile.controls ?? []) {
      if (control.strip === undefined) globals.push(control);
      else {
        if (!strips.has(control.strip)) strips.set(control.strip, []);
        strips.get(control.strip).push(control);
      }
    }

    for (const [index, controls] of [...strips.entries()].sort((a, b) => a[0] - b[0])) {
      this.root.append(this.buildStrip(index, controls, profile, selection));
    }

    if (globals.length) {
      const box = el('div', 'globals');
      /* Touch controls have no visual: a mouse cannot hold a fader the way a
         finger does, and the touch state is driven from the drag itself. */
      for (const control of globals.filter((c) => c.kind !== 'touch')) {
        box.append(this.buildControl(control, profile));
      }
      this.root.append(box);
    }
  }

  buildStrip(index, controls, profile, selection) {
    const box = el('div', 'strip');
    box.dataset.strip = String(index);
    const stripCount = profile.stripCount ?? 8;
    if ((selection?.bank ?? 0) * stripCount + index + 1 === selection?.layer) box.classList.add('selected');

    const scribble = el('div', 'scribble');
    scribble.innerHTML = '<div class="t">&nbsp;</div><div class="b">&nbsp;</div>';
    box.append(scribble);
    box.dataset.scribble = '1';
    this.nodes.set(`strip:${index}`, { el: scribble, kind: 'scribble' });

    for (const control of controls) {
      if (control.kind === 'touch') continue;
      box.append(this.buildControl(control, profile));
    }
    return box;
  }

  buildControl(control, profile) {
    switch (control.kind) {
      case 'fader':
      case 'fader14': return this.buildFader(control, profile);
      case 'knob':
      case 'encoder': return this.buildKnob(control);
      case 'button': return this.buildButton(control);
      default: return el('span');
    }
  }

  /* ----------------------------------------------------------- widgets */

  buildFader(control, profile) {
    const wrap = el('div', 'fader');
    if (control.motorised) wrap.classList.add('motor');
    wrap.title = control.label ?? control.id;
    wrap.append(el('div', 'track'));
    const thumb = el('div', 'thumb');
    wrap.append(thumb);

    const put = (norm) => {
      const n = clamp01(norm);
      this.positions.set(control.id, n);
      thumb.style.bottom = `${4 + n * (150 - 24)}px`;
    };
    put(0);

    /*
     * A drag is a touch: on a real MCU surface the fader reports contact, and
     * the engine uses that to stop driving the motor into the operator's hand.
     * Reproducing it here means the hold-off logic is exercised for real.
     */
    const touchId = this.touchFor(control, profile);
    const move = (event) => {
      const box = wrap.getBoundingClientRect();
      const norm = clamp01(1 - (event.clientY - box.top - 12) / (box.height - 24));
      put(norm);
      this.sendAbsolute(control, norm);
    };
    wrap.addEventListener('pointerdown', (event) => {
      wrap.setPointerCapture(event.pointerId);
      wrap.classList.add('touched');
      if (touchId) this.sendNote(touchId, true);
      move(event);
    });
    wrap.addEventListener('pointermove', (event) => {
      if (wrap.hasPointerCapture(event.pointerId)) move(event);
    });
    wrap.addEventListener('pointerup', (event) => {
      wrap.releasePointerCapture(event.pointerId);
      wrap.classList.remove('touched');
      if (touchId) this.sendNote(touchId, false);
    });

    this.nodes.set(control.id, { el: wrap, kind: 'fader', set: (fb) => { if (fb.position !== null) put(fb.position); } });
    return wrap;
  }

  /** The fader-touch control that shares this strip, if the profile has one. */
  touchFor(control, profile) {
    return (profile.controls ?? []).find(
      (c) => c.kind === 'touch' && c.strip === control.strip
    )?.id ?? null;
  }

  buildKnob(control) {
    const wrap = el('div', 'knob');
    wrap.title = control.label ?? control.id;
    wrap.innerHTML = `<svg viewBox="0 0 40 40">
      <circle cx="20" cy="20" r="15" fill="none" stroke="var(--line)" stroke-width="3"/>
      <circle class="arc" cx="20" cy="20" r="15" fill="none" stroke="var(--accent)" stroke-width="3"
              stroke-dasharray="0 94.2" transform="rotate(-90 20 20)" stroke-linecap="round"/>
      <circle cx="20" cy="20" r="8" fill="var(--panel-2)"/>
    </svg>`;
    const arc = wrap.querySelector('.arc');
    const put = (norm) => {
      if (norm === null) { arc.setAttribute('stroke-dasharray', '0 94.2'); return; }
      this.positions.set(control.id, norm);
      arc.setAttribute('stroke-dasharray', `${clamp01(norm) * 94.2} 94.2`);
    };
    put(null);

    let last = null;
    wrap.addEventListener('pointerdown', (event) => {
      wrap.setPointerCapture(event.pointerId);
      last = event.clientY;
    });
    wrap.addEventListener('pointermove', (event) => {
      if (!wrap.hasPointerCapture(event.pointerId)) return;
      const dy = last - event.clientY;
      if (Math.abs(dy) < 4) return;
      last = event.clientY;
      if (control.kind === 'encoder') this.sendRelative(control, Math.sign(dy));
      else {
        const next = clamp01((this.positions.get(control.id) ?? 0) + dy / 200);
        put(next);
        this.sendAbsolute(control, next);
      }
    });
    wrap.addEventListener('pointerup', (event) => wrap.releasePointerCapture(event.pointerId));

    this.nodes.set(control.id, { el: wrap, kind: 'knob', set: (fb) => put(fb.position) });
    return wrap;
  }

  buildButton(control) {
    const btn = el('button', 'btn');
    btn.textContent = control.label ?? control.id;
    btn.title = control.id;
    btn.addEventListener('pointerdown', () => this.sendNote(control.id, true));
    btn.addEventListener('pointerup', () => this.sendNote(control.id, false));
    btn.addEventListener('pointerleave', (event) => { if (event.buttons) this.sendNote(control.id, false); });

    this.nodes.set(control.id, {
      el: btn,
      kind: 'button',
      set: (fb) => btn.classList.toggle('lit', fb.lamp === true)
    });
    return btn;
  }

  /* -------------------------------------------------------------- send */

  sendAbsolute(control, norm) {
    const addr = parseControlId(control.id);
    if (!addr) return;
    if (addr.kind === 'pb') {
      this.onBytes(encode({ type: 'pitchBend', channel: addr.channel, value: Math.round(norm * 16383) }));
    } else if (addr.kind === 'cc') {
      this.onBytes(encode({ type: 'cc', channel: addr.channel, controller: addr.controller, value: Math.round(norm * 127) }));
    }
  }

  sendRelative(control, delta) {
    const addr = parseControlId(control.id);
    if (!addr) return;
    /* A note-per-click rotary (both Elation MIDIcons) has no value byte: the
       note number IS the direction, so only the matching one is sent. */
    if (addr.kind === 'note') {
      if (Math.sign(control.tick ?? 1) !== Math.sign(delta)) return;
      this.sendNote(control.id, true);
      this.sendNote(control.id, false);
      return;
    }
    this.onBytes(encode({
      type: 'cc', channel: addr.channel, controller: addr.controller,
      value: encodeRelative(delta, control.relative ?? 'signed')
    }));
  }

  sendNote(controlId, down) {
    const addr = parseControlId(controlId);
    if (addr?.kind !== 'note') return;
    this.onBytes(encode({
      type: down ? 'noteOn' : 'noteOff',
      channel: addr.channel, note: addr.note, velocity: down ? 127 : 0
    }));
  }

  /* ---------------------------------------------------------- feedback */

  apply(fb) {
    this.nodes.get(fb.control)?.set?.(fb);

    /*
     * The scribble strip belongs to the strip, not to a control, so several
     * controls would otherwise fight over it and the last button to report
     * would win — leaving a fader strip labelled after a button. Only the
     * control the profile marks as owning the display writes it, exactly as on
     * real MCU hardware.
     */
    const control = (this.profile?.controls ?? []).find((c) => c.id === fb.control);
    if (control?.strip === undefined || !control.scribble) return;
    const cell = this.nodes.get(`strip:${control.strip}`);
    if (!cell || (!fb.top && !fb.bottom)) return;
    cell.el.querySelector('.t').textContent = fb.top || ' ';
    cell.el.querySelector('.b').textContent = fb.bottom || ' ';
  }

  /** Mark which strip the selected layer is on. */
  markSelection(selection, profile) {
    const stripCount = profile.stripCount ?? 8;
    for (const box of this.root.querySelectorAll('.strip')) {
      const index = Number(box.dataset.strip);
      box.classList.toggle(
        'selected',
        selection.bank * stripCount + index + 1 === selection.layer
      );
    }
  }
}

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}
