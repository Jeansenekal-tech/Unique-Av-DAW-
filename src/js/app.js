// Application controller: session lifecycle, transport, recording, import /
// export, keyboard shortcuts and the animation loop that drives the meters.
import { h, $, segmented, toast, modal } from './ui.js';
import {
  sync, normalize, newSessionData, newTrack, newBus, History, carve, splitAt, sessionEnd,
  safeName, fmtTime, MAX_TRACKS, MAX_BUSES, PEAK_SPP, MASTER,
} from './state.js';
import { LiveView } from './timeline.js';
import { MixerView } from './mixer.js';
import { BroadcastView } from './broadcast.js';
import { FxWindow } from './fx.js';
import * as dialogs from './dialogs.js';

const daw = window.daw;
const E = (m, ...a) => daw.engine(m, ...a);

export const app = {
  s: null,
  file: null,
  dir: null,
  audioDir: null,
  audio: null,
  source: 0, // 0 = live inputs, 1 = playback (virtual soundcheck)
  mode: 'live',
  st: { pos: 0, playing: 0, recording: 0, ready: 1 },
  sel: { track: -1, clip: null },
  peaks: new Map(),
  hist: new History(),
  dirty: false,
  rec: null,
  views: {},
  fx: null,
  meters: null,
};
window.app = app; // handy in DevTools

// ------------------------------------------------------------------ helpers

app.sr = () => (app.s ? app.s.sampleRate : (app.audio && app.audio.sampleRate) || 48000);

app.markDirty = () => {
  app.dirty = true;
  document.title = `${app.s ? app.s.name : 'Unique AV DAW'} •`;
};

app.undoPoint = (label) => {
  if (app.s) app.hist.push(app.s, label);
};

app.renderAll = () => {
  for (const v of Object.values(app.views)) v.render();
  renderHeader();
};

app.syncTrack = (i) => sync.track(app.s, i);
app.syncBus = (b) => sync.bus(app.s, b);
app.syncClips = (i) => sync.clips(app.s, i, app.audioDir);
app.syncGlobal = () => sync.global(app.s, { source: app.source });

app.setSource = (src) => {
  app.source = src;
  E('setGlobal', { source: src });
  renderSrcSwitch();
  renderHeader();
};

app.setMode = (mode) => {
  app.mode = mode;
  for (const m of ['live', 'mixer', 'broadcast']) $(`#view-${m}`).classList.toggle('active', !!app.s && m === mode);
  $('#welcome').classList.toggle('active', !app.s);
  modesSeg.setValue(mode);
  renderSrcSwitch();
  app.views[mode].render();
};

// ------------------------------------------------------------------ peaks

const peakKey = (c) => `${c.file}#${c.channel || 0}`;
const peakFile = (c) => `${app.audioDir}/.peaks/${c.file}.${c.channel || 0}.pk`;
const pending = new Set();

app.getPeaks = (clip) => {
  const k = peakKey(clip);
  const p = app.peaks.get(k);
  if (p || pending.has(k)) return p || null;
  pending.add(k);
  (async () => {
    let data = await daw.readPeaks(peakFile(clip));
    if (!data) {
      try {
        data = await E('computePeaks', `${app.audioDir}/${clip.file}`, clip.channel || 0);
        daw.writePeaks(peakFile(clip), data);
      } catch {
        data = new Int8Array(0);
      }
    }
    app.peaks.set(k, data);
    pending.delete(k);
    app.views.live.dirtyLanes();
  })();
  return null;
};

// ------------------------------------------------------------------ audio

app.openAudio = async (cfg) => {
  try {
    app.audio = await daw.openAudio({ ...cfg, sampleRate: app.s ? app.s.sampleRate : cfg.sampleRate });
    if (app.s && Math.round(app.audio.sampleRate) !== app.s.sampleRate)
      toast(`The device is running at ${app.audio.sampleRate / 1000} kHz but the session is ${app.s.sampleRate / 1000} kHz. Change the device rate in Audio MIDI Setup.`, 'error');
    if (app.s) {
      await sync.all(app.s, app.audioDir);
      await app.syncGlobal();
      await E('locate', app.st.pos || 0);
      await applyBroadcastDevice();
    }
  } catch (e) {
    app.audio = null;
    toast(e.message, 'error');
  }
  renderHeader();
  app.renderAll();
  return app.audio;
};

async function applyBroadcastDevice() {
  if (!app.s) return;
  const bc = app.s.broadcast;
  try {
    await daw.broadcastDevice(bc.device ? { output: bc.device, channel: bc.deviceChannel } : null);
  } catch (e) {
    toast(e.message, 'error');
  }
}
app.applyBroadcastDevice = applyBroadcastDevice;

app.inputOptions = () => {
  const n = app.audio ? app.audio.inputChannels : 0;
  const o = [{ value: -1, label: 'No input' }];
  for (let i = 0; i < Math.max(n, 0); i++) o.push({ value: i, label: `In ${i + 1}` });
  return o;
};

app.outputOptions = (pairs = false, none = 'No output') => {
  const n = app.audio ? app.audio.outputChannels : 0;
  const o = [{ value: -1, label: none }];
  if (pairs) for (let i = 0; i + 1 < n; i += 2) o.push({ value: i, label: `Out ${i + 1}-${i + 2}` });
  else for (let i = 0; i < n; i++) o.push({ value: i, label: `Out ${i + 1}` });
  return o;
};

// ------------------------------------------------------------------ session

async function loadData(data, paths) {
  app.s = normalize(data);
  app.file = paths.file;
  app.dir = paths.dir;
  app.audioDir = data.audioDir || paths.audio;
  app.peaks.clear();
  app.hist = new History();
  app.sel = { track: -1, clip: null };
  app.dirty = false;
  document.title = app.s.name;
  if (app.audio && Math.round(app.audio.sampleRate) !== app.s.sampleRate) {
    const settings = await daw.getSettings();
    await app.openAudio(settings.audio || {});
  }
  await sync.all(app.s, app.audioDir);
  await app.syncGlobal();
  await E('locate', 0);
  await applyBroadcastDevice();
  app.setMode(app.mode);
  app.renderAll();
}

app.newSession = async (template) => {
  if (!(await app.confirmDiscard())) return;
  const p = await daw.newSession();
  if (!p) return;
  const data = newSessionData(p.name, Math.round(app.audio ? app.audio.sampleRate : 48000));
  if (template) {
    data.tracks = (template.tracks || []).map((t) => ({ ...t, clips: [] }));
    if (template.buses) data.buses = template.buses;
    if (template.broadcast) data.broadcast = { ...data.broadcast, ...template.broadcast };
  }
  await loadData(data, p);
  await app.save();
  if (!template && app.audio && app.audio.inputChannels) dialogs.quickSetup(app);
};

app.openSession = async (file) => {
  if (!(await app.confirmDiscard())) return;
  try {
    const r = await daw.openSession(file);
    if (!r) return;
    await loadData(r.data, r);
    toast(`Opened ${r.name}`);
  } catch (e) {
    toast(`Could not open session: ${e.message}`, 'error');
  }
};

app.snapshot = () => ({ ...app.s, savedAt: new Date().toISOString(), app: 'Unique AV DAW' });

app.save = async () => {
  if (!app.s) return;
  await daw.saveSession(app.file, app.snapshot());
  app.dirty = false;
  document.title = app.s.name;
};

app.saveAs = async () => {
  if (!app.s) return;
  const p = await daw.newSession(`${app.s.name} copy`);
  if (!p) return;
  // Audio stays where it is: point the new session at the original files.
  await daw.mkdir(p.audio);
  const data = app.snapshot();
  data.name = p.name;
  data.audioDir = app.audioDir;
  app.s.audioDir = app.audioDir;
  app.file = p.file;
  app.dir = p.dir;
  app.s.name = p.name;
  await daw.saveSession(p.file, data);
  app.dirty = false;
  renderHeader();
  toast(`Saved as ${p.name} (audio files stay in the original session folder)`);
};

app.confirmDiscard = async () => {
  if (!app.s || !app.dirty) return true;
  const r = await daw.message({
    type: 'question',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    message: `Save changes to “${app.s.name}”?`,
  });
  if (r.response === 2) return false;
  if (r.response === 0) await app.save();
  return true;
};

// ------------------------------------------------------------------ tracks

app.addTracks = async (list, replace = false) => {
  app.undoPoint('Add tracks');
  if (replace) app.s.tracks = [];
  for (const t of list) {
    if (app.s.tracks.length >= MAX_TRACKS) {
      toast(`The maximum is ${MAX_TRACKS} tracks`, 'error');
      break;
    }
    app.s.tracks.push(newTrack(app.s.tracks.length, t));
  }
  await app.resyncStructure();
};

app.removeTrack = async (i) => {
  if (app.rec) return toast('Stop recording first', 'error');
  app.undoPoint('Delete track');
  app.s.tracks.splice(i, 1);
  app.sel.track = -1;
  await app.resyncStructure();
};

app.addBus = async (kind) => {
  if (app.s.buses.length >= MAX_BUSES) return toast(`The maximum is ${MAX_BUSES} buses`, 'error');
  app.undoPoint('Add bus');
  const n = app.s.buses.filter((b) => b.kind === kind).length + 1;
  app.s.buses.push(newBus(kind, kind === 'group' ? `GROUP ${n}` : `AUX ${n}`));
  await app.resyncStructure();
};

app.removeBus = async (b) => {
  if (b <= 1) return;
  app.undoPoint('Delete bus');
  app.s.buses.splice(b, 1);
  for (const t of app.s.tracks) {
    if (t.dest === b) t.dest = MASTER;
    else if (t.dest > b) t.dest--;
    t.sends = t.sends.filter((x) => x.bus !== b).map((x) => (x.bus > b ? { ...x, bus: x.bus - 1 } : x));
  }
  await app.resyncStructure();
};

// Full engine resync after tracks/buses were added, removed or reordered.
app.resyncStructure = async () => {
  await sync.all(app.s, app.audioDir);
  await app.syncGlobal();
  await E('locate', app.st.pos || 0);
  app.markDirty();
  app.renderAll();
};

// ------------------------------------------------------------------ transport

app.locate = async (pos) => {
  pos = Math.max(0, Math.round(pos));
  app.st.pos = pos;
  await E('locate', pos);
  app.views.live.dirtyOverlay();
};

app.play = async () => {
  if (!app.s) return;
  await E('play');
};

app.stop = async () => {
  if (app.rec) await app.stopRecording();
  await E('stop');
};

app.togglePlay = async () => {
  if (app.st.playing) await app.stop();
  else await app.play();
};

app.record = async () => {
  if (app.rec) return app.stop();
  if (!app.s) return toast('Create or open a session first', 'error');
  if (!app.audio || !app.audio.inputChannels) return toast('Choose an input device in Audio Setup', 'error');
  if (app.source === 1) return toast('Switch to RECORD mode to record inputs', 'error');
  const armed = app.s.tracks.map((t, i) => (t.armed ? i : -1)).filter((i) => i >= 0);
  if (!armed.length) return toast('Arm at least one track (● button) to record', 'error');
  const take = app.s.take || 1;
  app.s.take = take + 1;
  const used = new Set();
  for (let i = 0; i < app.s.tracks.length; i++) {
    let recordPath = '';
    if (app.s.tracks[i].armed) {
      const base = `${String(i + 1).padStart(2, '0')} ${safeName(app.s.tracks[i].name)} T${take}`;
      let name = `${base}.wav`;
      for (let k = 2; used.has(name) || (await daw.exists(`${app.audioDir}/${name}`)); k++) name = `${base}-${k}.wav`;
      used.add(name);
      recordPath = `${app.audioDir}/${name}`;
    }
    await E('setTrack', i, { recordPath });
  }
  try {
    await E('recordStart', { bits: app.s.recordBits || 24 });
  } catch (e) {
    return toast(e.message, 'error');
  }
  app.rec = { take, tracks: armed, peaks: new Map(armed.map((i) => [i, new Int8Array(0)])), lastPeaks: 0 };
  daw.keepAwake(true);
  app.markDirty();
};

app.stopRecording = async () => {
  if (!app.rec) return;
  const rec = app.rec;
  const takes = await E('recordStop');
  app.undoPoint('Record');
  for (const tk of takes) {
    const t = app.s.tracks[tk.track];
    if (!t || tk.length <= 0) continue;
    const file = tk.path.split(/[\\/]/).pop();
    carve(t, tk.start, tk.start + tk.length);
    const clip = { id: `c${Date.now().toString(36)}${tk.track}`, file, start: tk.start, offset: 0, length: tk.length, channel: 0, gain: 0, take: rec.take };
    t.clips.push(clip);
    const peaks = await E('getRecordPeaks', tk.track, 0);
    app.peaks.set(`${file}#0`, peaks);
    daw.writePeaks(peakFile(clip), peaks);
    await app.syncClips(tk.track);
  }
  app.rec = null;
  daw.keepAwake(false);
  await app.save(); // protect the takes immediately
  app.views.live.render();
  const dropped = app.st.recDropped;
  toast(dropped ? `Recording saved – ${dropped} samples were dropped (disk too slow?)` : `Take ${rec.take} saved (${takes.length} tracks)`, dropped ? 'error' : '');
};

app.toggleLoop = async () => {
  if (!app.s) return;
  const L = app.s.loop;
  if (!L.on && L.end <= L.start) {
    const end = sessionEnd(app.s);
    L.start = 0;
    L.end = end || app.sr() * 60;
  }
  L.on = !L.on;
  await app.syncGlobal();
  app.markDirty();
  renderHeader();
  app.views.live.dirtyOverlay();
};

// ------------------------------------------------------------------ editing

app.splitAtPlayhead = async () => {
  if (!app.s) return;
  const targets = app.sel.track >= 0 ? [app.sel.track] : app.s.tracks.map((_, i) => i);
  app.undoPoint('Split');
  for (const i of targets) if (splitAt(app.s.tracks[i], app.st.pos)) await app.syncClips(i);
  app.markDirty();
  app.views.live.render();
};

app.deleteSelectedClip = async () => {
  const c = app.sel.clip;
  if (!c) return;
  app.undoPoint('Delete clip');
  const t = app.s.tracks[c.track];
  t.clips = t.clips.filter((x) => x.id !== c.id);
  app.sel.clip = null;
  await app.syncClips(c.track);
  app.markDirty();
  app.views.live.render();
};

async function undoRedo(redo) {
  if (!app.s || app.rec) return;
  const label = redo ? app.hist.step(app.s, app.hist.redo, app.hist.undo) : app.hist.step(app.s, app.hist.undo, app.hist.redo);
  if (!label) return;
  await app.resyncStructure();
  toast(`${redo ? 'Redo' : 'Undo'} ${label}`);
}

app.importAudio = async () => {
  if (!app.s) return toast('Create or open a session first', 'error');
  let files;
  try {
    files = await daw.importAudio(app.audioDir, app.s.sampleRate);
  } catch (e) {
    return toast(e.message, 'error');
  }
  if (!files.length) return;
  const at = app.st.pos || 0;
  const list = [];
  for (const f of files)
    for (let c = 0; c < f.channels; c++)
      list.push({ name: f.channels > 1 ? `${f.name} ${c === 0 ? 'L' : c === 1 ? 'R' : c + 1}` : f.name, input: -1, pan: f.channels === 2 ? (c === 0 ? -1 : 1) : 0, clips: [{ id: `c${Date.now().toString(36)}${list.length}`, file: f.file, start: at, offset: 0, length: f.frames, channel: c, gain: 0 }] });
  await app.addTracks(list);
  toast(`Imported ${files.length} file(s)`);
};

app.exportMix = async (stems) => {
  if (!app.s) return;
  if (app.rec) return toast('Stop recording first', 'error');
  const L = app.s.loop;
  const end = sessionEnd(app.s);
  if (!end) return toast('There is nothing to export yet', 'error');
  const opts = await dialogs.exportOptions(app, stems, { start: L.on ? L.start : 0, end: L.on ? L.end : end });
  if (!opts) return;
  const target = await daw.exportPick({ stems, defaultDir: `${app.dir}/Mixdowns`, name: app.s.name });
  if (!target) return;
  try {
    await E('stop');
    const r = await daw.exportRun({ ...opts, name: app.s.name, ...(stems ? { stemDir: target } : { path: target }) });
    if (r.done) toast(`Exported ${r.path.split(/[\\/]/).pop()}`);
    else toast('Export cancelled');
  } catch (e) {
    toast(e.message, 'error');
  }
};

// ------------------------------------------------------------------ header

const modesSeg = segmented([
  { value: 'live', label: 'LIVE', title: 'Record and virtual soundcheck (⌘1)' },
  { value: 'mixer', label: 'MIXER', title: 'Mix inputs or recordings (⌘2)' },
  { value: 'broadcast', label: 'BROADCAST', title: 'Live stream audio out (⌘3)' },
], 'live', (v) => app.setMode(v));
$('#modes').append(modesSeg);

function renderSrcSwitch() {
  const el = $('#srcSwitch');
  el.replaceChildren();
  if (!app.s) return;
  const labels = app.mode === 'live'
    ? [['RECORD', 'Inputs are live and record to disk'], ['VIRTUAL SOUNDCHECK', 'Tracks play back to their outputs']]
    : [['LIVE INPUTS', 'The mixer hears the live inputs'], ['PLAYBACK', 'The mixer hears the recorded tracks']];
  const seg = segmented([
    { value: '0', label: labels[0][0] },
    { value: '1', label: labels[1][0] },
  ], String(app.source), async (v) => {
    if (app.rec) {
      seg.setValue('0');
      return toast('Stop recording before switching to playback', 'error');
    }
    app.setSource(Number(v));
  });
  el.append(seg, h('div', { class: 'cap' }, labels[app.source][1]));
}

function renderHeader() {
  $('#sessName').textContent = app.s ? app.s.name : 'No session';
  const a = app.audio;
  const dev = a ? (a.inputName === a.outputName || !a.outputName ? a.inputName || a.outputName : `${a.inputName || '—'} → ${a.outputName}`) : 'No audio device';
  $('#sessSub').textContent = a ? `${dev} · ${a.inputChannels} in / ${a.outputChannels} out · ${(a.sampleRate / 1000).toFixed(1)} kHz` : dev;
  $('#tLoop').classList.toggle('on', !!(app.s && app.s.loop.on));
  $('#tRec').classList.toggle('armed', !!(app.s && app.s.tracks.some((t) => t.armed)));
  renderSrcSwitch();
}
app.renderHeader = renderHeader;

$('#tStart').onclick = () => app.locate(0);
$('#tStop').onclick = async () => {
  if (!app.st.playing && !app.rec) await app.locate(0);
  else await app.stop();
};
$('#tPlay').onclick = () => app.togglePlay();
$('#tLoop').onclick = () => app.toggleLoop();
$('#tRec').onclick = () => app.record();
$('#btnSetup').onclick = () => dialogs.audioSetup(app);
$('#updateBadge').onclick = () => dialogs.updates(app);

// ------------------------------------------------------------------ status bar

let disk = null;
async function refreshDisk() {
  if (app.dir) disk = await daw.diskFree(app.dir);
}
setInterval(refreshDisk, 5000);

function renderStatus() {
  const s = app.s, st = app.st, a = app.audio;
  const items = [];
  if (a) items.push(h('span', {}, `${(a.sampleRate / 1000).toFixed(1)} kHz · buffer ${a.bufferSize} · ${a.backend}`));
  if (s) items.push(h('span', {}, `${s.recordBits === 32 ? '32-bit float' : `${s.recordBits}-bit`} BWF`));
  if (s && disk) {
    const armed = s.tracks.filter((t) => t.armed).length || 1;
    const bytesPerSec = armed * s.sampleRate * (s.recordBits / 8);
    const secs = disk.free / bytesPerSec;
    const hrs = secs / 3600;
    items.push(h('span', { class: hrs < 1 ? 'bad' : hrs < 3 ? 'warn' : '' }, `Disk ${(disk.free / 1e9).toFixed(1)} GB free · ${hrs >= 100 ? '99+' : hrs.toFixed(1)} h for ${armed} track${armed > 1 ? 's' : ''}`));
  }
  if (s) items.push(h('span', {}, `${s.tracks.length} tracks · ${s.tracks.filter((t) => t.armed).length} armed`));
  if (st.xruns) items.push(h('span', { class: 'warn' }, `${st.xruns} disk underruns`));
  if (st.recDropped) items.push(h('span', { class: 'bad' }, `${st.recDropped} samples dropped while recording`));
  if (app.rec) items.push(h('span', { class: 'bad' }, `● RECORDING take ${app.rec.take} · ${fmtTime(st.pos - st.recStart, app.sr())}`));
  items.push(h('span', { class: 'sp' }, app.source === 1 ? 'VIRTUAL SOUNDCHECK – tracks feed their outputs' : 'LIVE INPUTS'));
  $('#status').replaceChildren(...items);
}

// ------------------------------------------------------------------ main loop

let busy = false;
let lastStatus = 0;
async function frame() {
  requestAnimationFrame(frame);
  if (busy) return;
  busy = true;
  try {
    const st = await E('getState');
    app.st = st;
    const meters = await E('getMeters');
    app.meters = meters;
    $('#clock').textContent = fmtTime(st.pos, st.sampleRate || app.sr());
    const cs = $('#clockState');
    const state = app.rec ? 'RECORDING' : st.playing ? (st.ready ? (app.source ? 'SOUNDCHECK' : 'PLAYING') : 'LOADING') : 'READY';
    cs.textContent = state;
    cs.className = app.rec ? 'rec' : st.playing ? 'play' : '';
    $('#tPlay').classList.toggle('on', !!st.playing);
    $('#tRec').classList.toggle('on', !!app.rec);
    const cpu = Math.round(st.cpu * 100);
    $('#cpu').textContent = `DSP ${cpu}%`;
    $('#cpu').classList.toggle('hot', cpu > 80);
    if (app.rec && performance.now() - app.rec.lastPeaks > 300) {
      app.rec.lastPeaks = performance.now();
      for (const i of app.rec.tracks) {
        const old = app.rec.peaks.get(i);
        const add = await E('getRecordPeaks', i, old.length);
        if (add.length) {
          const n = new Int8Array(old.length + add.length);
          n.set(old);
          n.set(add, old.length);
          app.rec.peaks.set(i, n);
        }
      }
      app.views.live.dirtyLanes();
    }
    if (app.s) app.views[app.mode].tick(meters, st);
    if (app.fx) app.fx.tick();
    if (performance.now() - lastStatus > 500) {
      lastStatus = performance.now();
      renderStatus();
    }
  } catch (e) {
    console.error(e);
  } finally {
    busy = false;
  }
}

// ------------------------------------------------------------------ keyboard & menus

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
  if (!app.s) return;
  const mod = e.metaKey || e.ctrlKey;
  if (e.code === 'Space') { e.preventDefault(); app.togglePlay(); }
  else if (e.key === 'Home' || e.key === 'Enter') app.locate(0);
  else if (!mod && (e.key === 'r' || e.key === 'R') && !e.repeat) app.record();
  else if (!mod && (e.key === 'l' || e.key === 'L')) app.toggleLoop();
  else if (!mod && (e.key === 's' || e.key === 'S')) app.splitAtPlayhead();
  else if (e.key === 'Backspace' || e.key === 'Delete') app.deleteSelectedClip();
  else if (!mod && (e.key === '=' || e.key === '+')) app.views.live.zoom(1);
  else if (!mod && e.key === '-') app.views.live.zoom(-1);
});

const menu = {
  newSession: () => app.newSession(),
  newFromTemplate: async () => {
    const t = await daw.pickTemplate();
    if (t) app.newSession(t);
  },
  openSession: (f) => app.openSession(f),
  save: () => app.save(),
  saveAs: () => app.saveAs(),
  saveTemplate: async () => {
    if (!app.s) return;
    const t = JSON.parse(JSON.stringify({ tracks: app.s.tracks.map((x) => ({ ...x, clips: [] })), buses: app.s.buses, broadcast: { ...app.s.broadcast, destinations: app.s.broadcast.destinations.map((d) => ({ ...d, key: '' })) } }));
    const f = await daw.saveTemplate(t);
    if (f) toast('Template saved');
  },
  importAudio: () => app.importAudio(),
  exportMix: () => app.exportMix(false),
  exportStems: () => app.exportMix(true),
  reveal: () => app.file && daw.reveal(app.file),
  audioSetup: () => dialogs.audioSetup(app),
  updates: () => dialogs.updates(app),
  undo: () => undoRedo(false),
  redo: () => undoRedo(true),
  split: () => app.splitAtPlayhead(),
  deleteClip: () => app.deleteSelectedClip(),
  quickSetup: () => app.s && dialogs.quickSetup(app),
  addTrack: () => app.s && app.addTracks([{}]),
  addBus: () => app.s && app.addBus('aux'),
  armAll: (on) => {
    if (!app.s) return;
    app.s.tracks.forEach((t) => { t.armed = on; });
    app.markDirty();
    app.renderAll();
  },
  mode: (m) => app.s && app.setMode(m),
  zoom: (d) => app.views.live.zoom(d),
  requestClose: async () => {
    if (app.rec) {
      const r = await daw.message({ type: 'warning', buttons: ['Keep Recording', 'Stop and Quit'], message: 'A recording is in progress.' });
      if (r.response === 0) return;
      await app.stopRecording();
    }
    if (await app.confirmDiscard()) daw.confirmClose();
  },
};
daw.onMenu(({ cmd, arg }) => menu[cmd] && menu[cmd](arg));

daw.onProgress((p) => {
  const el = $('#progress');
  el.classList.toggle('hidden', !p);
  if (!p) return;
  el.querySelector('.p-label').textContent = p.label;
  el.querySelector('.p-bar i').style.width = `${Math.round((p.value || 0) * 100)}%`;
  el.querySelector('.p-cancel').classList.toggle('hidden', !p.cancel);
});
$('#progress .p-cancel').onclick = () => E('exportCancel');

daw.onUpdateStatus((st) => {
  $('#updateBadge').classList.toggle('hidden', st.status !== 'ready' && st.status !== 'available');
  $('#updateBadge').textContent = st.status === 'ready' ? `Update ${st.latest} ready – restart` : `Update ${st.latest} available`;
  dialogs.onUpdateStatus(st);
});

// ------------------------------------------------------------------ welcome

async function renderWelcome() {
  const s = await daw.getSettings();
  const recent = (s.recent || []).slice(0, 6);
  $('#welcome').replaceChildren(
    h('h1', {}, 'UNIQUE AV ', h('span', {}, 'DAW')),
    h('div', { class: 'tag' }, 'Live multitrack recording · virtual soundcheck · mixing · broadcast'),
    h('div', { class: 'actions' },
      h('button', { class: 'primary', onclick: () => app.newSession() }, 'New Session'),
      h('button', { onclick: () => app.openSession() }, 'Open Session…'),
      h('button', { onclick: () => dialogs.audioSetup(app) }, 'Audio Setup…')),
    recent.length ? h('div', { class: 'recent' }, h('div', {}, 'RECENT SESSIONS'), ...recent.map((f) => h('div', { onclick: () => app.openSession(f) }, f.split(/[\\/]/).pop().replace(/\.uavdaw$/, '')))) : null,
    h('div', { class: 'modes3' },
      h('div', {}, h('b', {}, 'LIVE'), h('span', {}, 'Record every input of your console or stagebox, then flip to virtual soundcheck.')),
      h('div', {}, h('b', {}, 'MIXER'), h('span', {}, 'Full channel strips: EQ, compressor models, gate, dynamic EQ, sends and groups.')),
      h('div', {}, h('b', {}, 'BROADCAST'), h('span', {}, 'A separate broadcast mix with loudness metering, out to RTMP, SRT or Icecast.'))),
  );
}

// ------------------------------------------------------------------ boot

(async function boot() {
  app.views.live = new LiveView(app, $('#view-live'));
  app.views.mixer = new MixerView(app, $('#view-mixer'));
  app.views.broadcast = new BroadcastView(app, $('#view-broadcast'));
  app.openFx = (kind, index, slot) => {
    if (app.fx) app.fx.close();
    app.fx = new FxWindow(app, kind, index, slot);
  };
  await renderWelcome();
  const settings = await daw.getSettings();
  daw.updateConfigure(settings.updates || {});
  await app.openAudio(settings.audio || {});
  app.setMode('live');
  renderHeader();
  setInterval(() => {
    if (app.s && app.dirty) daw.autosave(app.file, app.snapshot());
  }, 60000);
  requestAnimationFrame(frame);
  if (!settings.audio && !(await daw.appInfo()).nullAudio) dialogs.audioSetup(app);
})();

export { E, modal };
