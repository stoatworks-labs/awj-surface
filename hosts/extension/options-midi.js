/*
 * The MIDI section of the options page.
 *
 * Its only real job is to be VISIBLE. Web MIDI's SysEx permission needs a user
 * prompt, and an offscreen document cannot show one — so the grant has to
 * happen on a page the user can actually see. Permission is per-origin and
 * persists, so this is a once-ever step and the offscreen document inherits it
 * from then on.
 *
 * Without SysEx a surface still controls the switcher. What is lost is anything
 * carried as SysEx, which on an X-Touch means the scribble strips.
 */

const el = (id) => document.getElementById(id);

export async function initMidiOptions() {
  const status = el('midi-status');
  const list = el('midi-ports');

  el('midi-grant').addEventListener('click', async () => {
    status.textContent = 'requesting…';
    try {
      /* Requested here, on the extension's own origin, where a prompt can be
         shown. The offscreen document never asks for itself. */
      const access = await navigator.requestMIDIAccess({ sysex: true });
      status.textContent = 'granted, including SysEx';
      render(access, list);
      access.onstatechange = () => render(access, list);
    } catch (err) {
      try {
        const access = await navigator.requestMIDIAccess({ sysex: false });
        status.textContent = 'granted without SysEx — scribble strips will stay blank';
        render(access, list);
      } catch (fatal) {
        status.textContent = `denied: ${fatal.message}`;
      }
    }
  });
}

function render(access, list) {
  const rows = [];
  for (const input of access.inputs.values()) rows.push(`<li>in · ${input.name}</li>`);
  for (const output of access.outputs.values()) rows.push(`<li>out · ${output.name}</li>`);
  list.innerHTML = rows.join('') || '<li>no MIDI ports attached</li>';
}
