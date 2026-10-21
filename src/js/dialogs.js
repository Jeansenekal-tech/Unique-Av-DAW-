// Audio Setup, Quick Setup, export options and the updates dialog.
import { h, select, modal, toast } from './ui.js';
import { MAX_TRACKS } from './state.js';

const daw = window.daw;

export async function audioSetup(app) {
  let devs;
  try {
    devs = await daw.devices();
  } catch (e) {
    return toast(e.message, 'error');
  }
  const settings = await daw.getSettings();
  const cfg = { input: '', output: '', sampleRate: 48000, bufferSize: 256, ...(settings.audio || {}) };
  if (!settings.audio) {
    const di = devs.inputs.find((d) => d.isDefault), dout = devs.outputs.find((d) => d.isDefault);
    cfg.input = di ? di.name : devs.inputs[0]?.name || '';
    cfg.output = dout ? dout.name : devs.outputs[0]?.name || '';
  }
  const devOpts = (list) => [{ value: '', label: 'None' }, ...list.map((d) => ({ value: d.name, label: `${d.name} – ${d.channels} ch` }))];
  const inSel = select(devOpts(devs.inputs), cfg.input, (v) => { cfg.input = v; });
  const outSel = select(devOpts(devs.outputs), cfg.output, (v) => { cfg.output = v; });
  const sr = select([44100, 48000, 88200, 96000].map((v) => ({ value: v, label: `${v / 1000} kHz` })), app.s ? app.s.sampleRate : cfg.sampleRate, (v) => { cfg.sampleRate = Number(v); });
  if (app.s) sr.disabled = true;
  const buf = select([32, 64, 128, 256, 512, 1024, 2048].map((v) => ({ value: v, label: `${v} samples` })), cfg.bufferSize, (v) => { cfg.bufferSize = Number(v); });
  const bits = select([{ value: 16, label: '16-bit' }, { value: 24, label: '24-bit' }, { value: 32, label: '32-bit float' }], app.s ? app.s.recordBits : 24, (v) => { if (app.s) { app.s.recordBits = Number(v); app.markDirty(); } });
  if (!app.s) bits.disabled = true;
  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', width: '560px' } },
    h('div', { class: 'grid2' },
      h('div', { class: 'field' }, h('span', {}, 'Input device'), inSel),
      h('div', { class: 'field' }, h('span', {}, 'Output device'), outSel),
      h('div', { class: 'field' }, h('span', {}, app.s ? 'Sample rate (set by the session)' : 'Sample rate'), sr),
      h('div', { class: 'field' }, h('span', {}, 'Buffer size'), buf),
      h('div', { class: 'field' }, h('span', {}, 'Recording format'), bits),
      h('div', { class: 'field' }, h('span', {}, 'Audio system'), h('div', {}, devs.backend))),
    h('div', { class: 'hint' },
      h('b', {}, 'Dante: '), 'install Dante Virtual Soundcard (or use a Dante interface); it appears here as “Dante Virtual Soundcard” with up to 64 or 128 channels.', h('br'),
      h('b', {}, 'Waves SoundGrid / QRec: '), 'open the SoundGrid driver in SoundGrid Studio or QRec, then choose “SoundGrid” here. Allow microphone access for the SoundGrid Core Audio service in macOS settings.', h('br'),
      h('b', {}, 'Consoles and interfaces: '), 'USB/Thunderbolt consoles (X32, Wing, SQ, dLive, Yamaha, Midas, Soundcraft), MADI, AVB and Thunderbolt interfaces all appear as normal devices.', h('br'),
      h('b', {}, 'Several devices at once: '), 'combine them into an Aggregate Device in Audio MIDI Setup and choose that here.'),
  );
  modal('AUDIO SETUP', body, [
    { label: 'Cancel' },
    { label: 'Apply', primary: true, onClick: async () => {
      const info = await app.openAudio(cfg);
      if (info) toast(`${info.inputChannels} inputs / ${info.outputChannels} outputs at ${info.sampleRate / 1000} kHz`);
      return true;
    } },
  ]);
}

export function quickSetup(app) {
  const s = app.s;
  if (!s) return;
  const nIn = app.audio ? app.audio.inputChannels : 0;
  const nOut = app.audio ? app.audio.outputChannels : 0;
  const v = { count: Math.min(Math.max(nIn, 1), MAX_TRACKS), first: 1, mapIn: nIn > 0, mapOut: nOut > 0, outFirst: 1, arm: true, replace: s.tracks.length > 0 && !s.tracks.some((t) => t.clips.length), prefix: 'Input' };
  const num = (key, max) => {
    const e = h('input', { type: 'number', min: 1, max, value: v[key] });
    e.addEventListener('input', () => { v[key] = Math.max(1, Math.min(max, Number(e.value) || 1)); });
    return e;
  };
  const chk = (key, label) => {
    const c = h('input', { type: 'checkbox' });
    c.checked = v[key];
    c.onchange = () => { v[key] = c.checked; };
    return h('label', { class: 'check' }, c, label);
  };
  const pre = h('input', { type: 'text', value: v.prefix });
  pre.oninput = () => { v.prefix = pre.value; };
  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', width: '520px' } },
    h('div', { class: 'hint' }, `Creates one track per input channel and patches each one to the matching output, so the tracks play straight back to the console for virtual soundcheck. Your device has ${nIn} inputs and ${nOut} outputs.`),
    h('div', { class: 'grid2' },
      h('div', { class: 'field' }, h('span', {}, 'Number of tracks'), num('count', MAX_TRACKS)),
      h('div', { class: 'field' }, h('span', {}, 'Track name prefix'), pre),
      h('div', { class: 'field' }, h('span', {}, 'First input'), num('first', Math.max(nIn, 1))),
      h('div', { class: 'field' }, h('span', {}, 'First output (virtual soundcheck)'), num('outFirst', Math.max(nOut, 1)))),
    chk('mapIn', 'Map inputs in order (track 1 ← input 1, …)'),
    chk('mapOut', 'Map outputs in order for virtual soundcheck (track 1 → output 1, …)'),
    chk('arm', 'Arm all tracks for recording'),
    chk('replace', 'Replace existing tracks'),
  );
  modal('QUICK SETUP', body, [
    { label: 'Cancel' },
    { label: 'Create Tracks', primary: true, onClick: async () => {
      const list = [];
      for (let k = 0; k < v.count; k++) {
        const inp = v.mapIn ? v.first - 1 + k : -1;
        const out = v.mapOut ? v.outFirst - 1 + k : -1;
        list.push({ name: `${v.prefix || 'Input'} ${k + 1}`, input: inp < nIn ? inp : -1, hwOut: out < nOut ? out : -1, armed: v.arm });
      }
      if (v.replace && s.tracks.some((t) => t.clips.length)) {
        const r = await daw.message({ type: 'warning', buttons: ['Replace', 'Cancel'], message: 'Replace tracks that have recordings on them?', detail: 'The audio files stay in the session folder.' });
        if (r.response !== 0) return false;
      }
      await app.addTracks(list, v.replace);
      toast(`Created ${list.length} tracks`);
      return true;
    } },
  ]);
}

export function exportOptions(app, stems, range) {
  return new Promise((resolve) => {
    const sr = app.sr();
    const v = { bits: 24, mp3: false, start: range.start, end: range.end };
    const bits = select([{ value: 16, label: '16-bit WAV' }, { value: 24, label: '24-bit WAV' }, { value: 32, label: '32-bit float WAV' }], 24, (x) => { v.bits = Number(x); });
    const mp3 = h('input', { type: 'checkbox' });
    mp3.onchange = () => { v.mp3 = mp3.checked; };
    const secs = ((range.end - range.start) / sr).toFixed(1);
    const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', width: '440px' } },
      h('div', { class: 'hint' }, `${stems ? 'Exports every track as a stereo stem (post fader and plugins) plus the full mix' : 'Exports the master mix'} from ${(range.start / sr).toFixed(1)} s to ${(range.end / sr).toFixed(1)} s (${secs} s). ${app.s.loop.on ? 'Range = the loop.' : 'Turn on the loop to export only part of the session.'} Export runs faster than real time; live audio pauses until it finishes.`),
      h('div', { class: 'field' }, h('span', {}, 'Format'), bits),
      stems ? null : h('label', { class: 'check' }, mp3, 'Also make an MP3 (320 kb/s)'),
    );
    let done = false;
    modal(stems ? 'EXPORT STEMS' : 'EXPORT MIX', body, [
      { label: 'Cancel', onClick: () => { done = true; resolve(null); } },
      { label: 'Export…', primary: true, onClick: () => { done = true; resolve(v); } },
    ]);
    setTimeout(() => { if (!document.querySelector('.overlay') && !done) resolve(null); }, 0);
  });
}

// ------------------------------------------------------------------ updates

let updEl = null;
let updState = null;

export function onUpdateStatus(st) {
  updState = st;
  if (updEl && updEl.isConnected) renderUpdates();
}

function renderUpdates() {
  const st = updState || {};
  const cfg = st.config || {};
  const status = {
    idle: 'Not checked yet',
    checking: 'Checking…',
    uptodate: `You have the latest version (${st.current}).`,
    available: `Version ${st.latest} is available.`,
    downloading: `Downloading ${st.latest}… ${Math.round((st.progress || 0) * 100)}%`,
    ready: `Version ${st.latest} is ready. Restart to install it.`,
    installing: 'Installing…',
    error: `Update check failed: ${st.error}`,
  }[st.status] || '';
  const auto = h('input', { type: 'checkbox' });
  auto.checked = cfg.auto !== false;
  const dl = h('input', { type: 'checkbox' });
  dl.checked = cfg.autoDownload !== false;
  const url = h('input', { type: 'url', value: cfg.url || '', placeholder: st.feedUrl || '' });
  const save = async () => {
    const c = { auto: auto.checked, autoDownload: dl.checked, url: url.value.trim() };
    await daw.setSettings({ updates: c });
    updState = await daw.updateConfigure(c);
    renderUpdates();
  };
  auto.onchange = save;
  dl.onchange = save;
  url.onchange = save;
  updEl.replaceChildren(
    h('div', { style: { fontSize: '14px', fontWeight: 600 } }, `Unique AV DAW ${st.current || ''}`),
    h('div', { class: 'hint', style: { fontSize: '12px', color: st.status === 'error' ? '#ffb3bb' : undefined } }, status),
    st.notes && (st.status === 'available' || st.status === 'ready') ? h('div', { class: 'hint', style: { whiteSpace: 'pre-wrap' } }, st.notes) : null,
    h('div', { style: { display: 'flex', gap: '8px' } },
      h('button', { onclick: async () => { updState = await daw.updateCheck(); renderUpdates(); } }, 'Check Now'),
      st.status === 'available' ? h('button', { onclick: () => daw.updateDownload() }, st.supported ? 'Download' : 'Open Download Page') : null,
      st.status === 'ready' ? h('button', { class: 'primary', onclick: async () => { const r = await daw.updateInstall(); if (!r.ok) toast(r.message, 'error'); } }, 'Restart & Install') : null),
    h('label', { class: 'check' }, auto, 'Check for updates automatically'),
    h('label', { class: 'check' }, dl, 'Download updates in the background'),
    h('div', { class: 'field' }, h('span', {}, 'Update URL (leave empty for the default)'), url),
    h('div', { class: 'hint' }, 'Updates install when you restart, never during a recording or a live stream.'),
  );
}

export async function updates() {
  updState = await daw.updateStatus();
  updEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', width: '480px' } });
  renderUpdates();
  modal('UPDATES', updEl, [{ label: 'Close' }]);
}
