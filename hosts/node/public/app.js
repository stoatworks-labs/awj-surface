/*
 * The web UI.
 *
 * Server-sent events downstream, plain POSTs upstream. No WebSocket server is
 * involved, which keeps the host at zero dependencies — implementing RFC 6455
 * by hand to push a few hundred bytes a second would be a poor trade.
 */

import { ScreenSurface } from '/surface.js';

const $ = (id) => document.getElementById(id);

const state = {
  profile: null,
  selection: null,
  catalogue: null,
  status: null,
  learning: null
};

const surface = new ScreenSurface($('surface'), {
  onBytes: (bytes) => post('/api/midi', { bytes: Array.from(bytes) })
});

/* ------------------------------------------------------------------- api */

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function boot() {
  const data = await (await fetch('/api/state')).json();
  state.profile = data.profile;
  state.selection = data.selection;
  state.catalogue = data.catalogue;
  state.status = data.status;

  const profiles = await (await fetch('/api/profiles')).json();
  $('profile').innerHTML = profiles
    .map((id) => `<option ${id === data.profile.id ? 'selected' : ''}>${id}</option>`)
    .join('');

  /* 24 screens is the model maximum; which are configured is a separate
     question the device will not answer over a leaf-only protocol. */
  $('sel-screen').innerHTML = Array.from({ length: 24 }, (_, i) =>
    `<option ${`S${i + 1}` === data.selection.screen ? 'selected' : ''}>S${i + 1}</option>`).join('');

  fillParamPicker();
  for (const entry of data.log) appendLog(entry);
  renderAll();
  listen();
}

function listen() {
  const events = new EventSource('/api/events');
  events.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case 'feedback': surface.apply(msg.feedback); markActive(msg.feedback); break;
      case 'selection':
        state.selection = msg.selection;
        syncSelectionInputs();
        surface.markSelection(state.selection, state.profile);
        renderBindings();
        break;
      case 'status': state.status = msg.status; renderStatus(); break;
      case 'log': appendLog(msg); break;
      case 'write': appendLog({ level: 'write', message: `${msg.path} = ${JSON.stringify(msg.value)}` }); break;
      case 'learn':
        state.learning = msg.armed ? msg.target : null;
        if (msg.profile) { state.profile = msg.profile; renderAll(); }
        renderLearn();
        break;
      case 'midi-in':
        /* Only while the tab is open, and throttled: a fader sweep is
           hundreds of messages a second and the table need not chase it. */
        if (!$('tab-monitor').hidden) scheduleCoverage();
        break;
      case 'coverage-reset':
        if (!$('tab-monitor').hidden) renderCoverage();
        break;
      case 'osc-in':
        appendLog({ level: msg.mapped ? 'info' : 'warn', message: `OSC ${msg.address} ${JSON.stringify(msg.args)}${msg.mapped ? '' : ' (unmapped)'}` });
        break;
    }
  };
  events.onerror = () => renderStatus({ lost: true });
}

/* --------------------------------------------------------------- render */

function renderAll() {
  renderStatus();
  surface.render(state.profile, state.selection);
  surface.markSelection(state.selection, state.profile);
  renderBindings();
  syncSelectionInputs();
  $('surface-kind').textContent =
    `${state.profile.name ?? state.profile.id} · ${state.profile.feedback?.protocol ?? 'generic'} feedback`;
}

function renderStatus({ lost = false } = {}) {
  const s = state.status ?? {};
  set('dot-awj', s.awj && !lost ? 'on' : s.offline ? 'idle' : '');
  /* Read-only is the loudest thing on the bar. Someone glancing at this while
     a show is up must be able to tell in one look whether moving a control
     will reach the frame. */
  $('lbl-device').textContent = s.offline
    ? 'offline'
    : `${s.device ?? 'no device'}${s.readOnly ? ' · READ-ONLY' : ''}`;
  $('lbl-device').classList.toggle('ro', !!s.readOnly);
  set('dot-midi', s.midi ? (s.midi.type === 'hardware' ? 'on' : 'idle') : '');
  $('lbl-midi').textContent = s.midi ? s.midi.name : 'no MIDI';
  set('dot-osc', s.osc ? 'on' : '');
  $('lbl-osc').textContent = s.osc ? 'OSC' : 'OSC off';
}

const set = (id, cls) => { $(id).className = `dot ${cls}`; };

function syncSelectionInputs() {
  $('sel-screen').value = state.selection.screen;
  $('sel-preset').value = state.selection.preset;
  $('sel-layer').value = state.selection.layer;
  $('sel-bank').value = state.selection.bank;
  $('resolved').innerHTML =
    `${state.selection.screen} / <b>${state.selection.preset}</b> / layer <b>${state.selection.layer}</b>` +
    (state.selection.shift ? ' / <b>SHIFT</b>' : '');
}

function renderBindings() {
  const filter = $('filter').value.toLowerCase();
  const rows = [];
  for (const [index, binding] of (state.profile.bindings ?? []).entries()) {
    const control = (state.profile.controls ?? []).find((c) => c.id === binding.control);
    const target = binding.target;
    const what = target.kind === 'action'
      ? `${target.action}${target.value !== undefined ? ` = ${target.value}` : ''}`
      : target.param;
    const where = target.kind === 'action' ? ''
      : target.kind === 'screenGroup' ? (target.screen ?? '@selected')
        : `${target.preset ?? '@selected'} · ${target.layer ?? '@selected'}`;
    const text = `${binding.control} ${control?.label ?? ''} ${what}`.toLowerCase();
    if (filter && !text.includes(filter)) continue;

    rows.push(`<tr data-binding="${esc(binding.id ?? `${binding.control}#${index}`)}">
      <td class="mono">${esc(control?.label ?? binding.control)}<br><span style="opacity:.55">${esc(binding.control)}</span></td>
      <td>${esc(what)}${binding.shift !== undefined ? ` <span style="opacity:.5">[${binding.shift ? 'shift' : 'plain'}]</span>` : ''}</td>
      <td class="mono">${esc(where)}</td>
      <td class="mono" data-value></td>
      <td><button data-remove="${index}" title="Remove">&times;</button></td>
    </tr>`);
  }
  $('bindings').tBodies[0].innerHTML = rows.join('') ||
    '<tr><td colspan="5" style="color:var(--dim)">No bindings. Pick a parameter below and press Learn.</td></tr>';
}

/** Show live values in the mapping table, so it doubles as a state readout. */
function markActive(fb) {
  const row = $('bindings').querySelector(`tr[data-binding="${cssEscape(fb.binding ?? fb.control)}"]`);
  if (!row) return;
  const cell = row.querySelector('[data-value]');
  if (cell) cell.textContent = fb.value === null || fb.value === undefined ? '' : String(fb.value);
  row.classList.add('active');
  clearTimeout(row._t);
  row._t = setTimeout(() => row.classList.remove('active'), 400);
}

function fillParamPicker() {
  const suggested = new Set(state.catalogue.suggested);
  const opt = (p) => `<option value="${esc(p.id)}">${esc(p.id)}${p.readOnly ? ' (read-only)' : ''}</option>`;
  const layer = state.catalogue.layer.filter((p) => !p.readOnly);
  $('add-param').innerHTML =
    `<optgroup label="Common">${layer.filter((p) => suggested.has(p.id)).map(opt).join('')}</optgroup>` +
    `<optgroup label="Screen / take">${state.catalogue.screenGroup.filter((p) => !p.readOnly).map(opt).join('')}</optgroup>` +
    `<optgroup label="All layer parameters">${layer.filter((p) => !suggested.has(p.id)).map(opt).join('')}</optgroup>`;
}

function renderLearn() {
  const armed = !!state.learning;
  $('learn-banner').hidden = !armed;
  $('learn-cancel').hidden = !armed;
  if (armed) $('learn-target').textContent = state.learning.param ?? state.learning.action ?? '?';
}

function appendLog({ level = 'info', message }) {
  const line = document.createElement('div');
  line.className = level;
  line.textContent = message;
  $('log').append(line);
  while ($('log').childElementCount > 300) $('log').firstElementChild.remove();
  $('log').parentElement.scrollTop = $('log').parentElement.scrollHeight;
}

let coverageTimer = null;
function scheduleCoverage() {
  if (coverageTimer) return;
  coverageTimer = setTimeout(() => { coverageTimer = null; renderCoverage(); }, 400);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cssEscape = (s) => (window.CSS?.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&'));

/* --------------------------------------------------------------- events */

$('profile').addEventListener('change', async (event) => {
  const res = await post('/api/profile', { id: event.target.value });
  if (res.profile) { state.profile = res.profile; renderAll(); }
});

for (const [id, field] of [['sel-screen', 'screen'], ['sel-preset', 'preset'], ['sel-layer', 'layer'], ['sel-bank', 'bank']]) {
  $(id).addEventListener('change', async (event) => {
    const raw = event.target.value;
    const value = field === 'layer' || field === 'bank' ? Number(raw) : raw;
    const res = await post('/api/selection', { [field]: value });
    state.selection = res.selection;
    syncSelectionInputs();
    surface.markSelection(state.selection, state.profile);
    renderBindings();
  });
}

$('filter').addEventListener('input', renderBindings);

$('bindings').addEventListener('click', async (event) => {
  const at = event.target.dataset.remove;
  if (at === undefined) return;
  /* Remove by position, not by control: several bindings can share a control
     and removing them all would take the shifted layer with the plain one. */
  const bindings = state.profile.bindings.filter((_, i) => i !== Number(at));
  const res = await post('/api/binding', { bindings });
  if (res.problems) { appendLog({ level: 'error', message: res.problems.join('; ') }); return; }
  state.profile.bindings = bindings;
  renderBindings();
});

$('add-learn').addEventListener('click', () => {
  const param = $('add-param').value;
  const isGroup = state.catalogue.screenGroup.some((p) => p.id === param);
  const target = isGroup
    ? { kind: 'screenGroup', screen: '@selected', param }
    : { kind: 'layer', screen: '@selected', preset: $('add-preset').value, layer: $('add-layer').value, param };
  post('/api/learn', { target });
});

$('learn-cancel').addEventListener('click', () => post('/api/learn', { cancel: true }));

/* ------------------------------------------------------------- bring-up */

/*
 * The coverage view answers two questions and they are different failures:
 * a declared control that never arrives is usually a wrong number in the
 * transcribed map, while an arriving control nobody declared is a control the
 * manual left out.
 */
async function renderCoverage() {
  const report = await (await fetch('/api/coverage')).json();

  const summary = $('cov-summary');
  summary.textContent = report.summary;
  summary.classList.toggle('good', report.stats.missing === 0 && report.stats.declared > 0);
  summary.classList.toggle('bad', report.stats.missing > 0);

  $('cov-expected').tBodies[0].innerHTML = report.expected.length
    ? report.expected.map((c) => `<tr>
        <td class="mono">${esc(c.label)}<br><span style="opacity:.55">${esc(c.id)}</span></td>
        <td class="mono">${esc(c.kind)}${c.bound ? '' : ' <span style="opacity:.5">(unbound)</span>'}</td>
        <td class="mono">${c.seen
          ? `<span class="hit">yes</span> &times;${c.count}`
          : '<span class="never">never</span>'}</td>
      </tr>`).join('')
    : '<tr><td colspan="3" style="color:var(--dim)">This profile declares no controls — everything will show up below.</td></tr>';

  $('cov-unexpected').tBodies[0].innerHTML = report.unexpected.length
    ? report.unexpected.map((u) => `<tr>
        <td class="mono">${esc(u.id)}</td>
        <td class="mono">${u.count}</td>
        <td>${esc(u.guess?.kind ?? '?')}${u.guess?.relative ? ` <span style="opacity:.6">(${esc(u.guess.relative)})</span>` : ''}
            <br><span style="opacity:.55;font-size:11px">${esc(u.guess?.why ?? '')}</span></td>
      </tr>`).join('')
    : '<tr><td colspan="3" style="color:var(--dim)">Nothing unexpected so far.</td></tr>';
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('on', t === tab);
    const monitor = tab.dataset.tab === 'monitor';
    $('tab-monitor').hidden = !monitor;
    $('tab-map').hidden = monitor;
    if (monitor) renderCoverage();
  });
}

$('cov-refresh').addEventListener('click', renderCoverage);
$('cov-reset').addEventListener('click', async () => {
  await post('/api/coverage/reset', {});
  renderCoverage();
});

boot().catch((err) => appendLog({ level: 'error', message: `startup failed: ${err.message}` }));
