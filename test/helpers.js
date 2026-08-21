/*
 * Test doubles.
 *
 * The store is the only thing the engine needs from a device, so a plain
 * nested object with a path getter is a complete stand-in — and it keeps the
 * engine tests free of sockets, timers and firmware.
 */

import { ROOT } from '../core/paths.js';

/** A device mirror backed by a nested object. */
export class FakeStore {
  constructor(root = {}) {
    this.root = { [ROOT]: root };
  }

  get(path) {
    let node = this.root;
    for (const seg of path) {
      if (node == null || typeof node !== 'object') return undefined;
      node = node[seg];
    }
    return node;
  }

  set(path, value) {
    let node = this.root;
    for (let i = 0; i < path.length - 1; i++) {
      const seg = path[i];
      if (node[seg] == null || typeof node[seg] !== 'object') node[seg] = {};
      node = node[seg];
    }
    node[path[path.length - 1]] = value;
  }
}

/**
 * A screen with one preset letter on air and some layers in it.
 *
 * Mirrors the shape confirmed on a real device: three preset memories keyed
 * A/B/C, a layerList keyed 'NATIVE' then '1'..'128', and a separate
 * screenAuxGroup carrying the take controls and the transition state.
 */
export function deviceFixture({ transition = 'AT_DOWN', layers = 8 } = {}) {
  const layer = () => ({
    opacity: { pp: { opacity: 256 } },
    position: { pp: { anchor: 'MIDDLE_CENTER', posH: 960, posV: 540, sizeH: 1920, sizeV: 1080 } },
    source: { pp: { inputNum: 'NONE' } },
    cropping: {
      classic: { pp: { top: 0, bottom: 0, left: 0, right: 0, aspectOverride: 'NONE' } },
      mask: { pp: { top: 0, bottom: 0, left: 0, right: 0 } }
    },
    keying: { pp: { enable: false, source: 'NONE' } }
  });

  const presetItems = {};
  for (const letter of ['A', 'B', 'C']) {
    const items = {};
    for (let i = 1; i <= layers; i++) items[String(i)] = layer();
    presetItems[letter] = { layerList: { items } };
  }

  return {
    screenList: { items: { S1: { presetList: { items: presetItems } } } },
    screenAuxGroupList: {
      items: {
        S1: {
          control: {
            pp: {
              presetUp: 'B', presetDown: 'A', presetPrevious: 'C',
              tbarPosition: 0, takeUpTime: 10, takeDownTime: 10,
              xTake: false, xTakeAbort: false, xCut: false, xStepBack: false,
              xCopyProgramToPreview: false, copyMode: false
            }
          },
          status: { pp: { isUsed: true, transition, take: 'OFF', tbarPosition: 0, isTbarPositionValid: true } }
        }
      }
    }
  };
}

/** Collect the events an EventTarget emits, for assertions. */
export function collect(target, type) {
  const seen = [];
  target.addEventListener(type, (e) => seen.push(e.detail));
  return seen;
}

/** Run the engine's coalescing timer out. */
export const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
