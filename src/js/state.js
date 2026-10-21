// Session model, engine synchronisation and undo.

export const MAX_TRACKS = 128;
export const MAX_BUSES = 16;
export const MAX_FX = 6;
export const PEAK_SPP = 1024;
export const MASTER = 0;
export const BROADCAST = 1;

export const COLORS = ['#7aa2ff', '#ff8a7a', '#ffc46b', '#7ee0a8', '#c49bff', '#6fd6e8', '#ff9bd2', '#b8c4e8'];

// Processor catalogue. `params` matches the native layout in native/dsp.c.
export const FX = {
  1: { name: 'EQ', title: 'Parametric EQ', sub: 'HPF / LPF + 4 bands', params: [0, 80, 0, 18000, 1, 1, 100, 0, 0.7, 1, 0, 400, 0, 1, 1, 0, 2500, 0, 1, 1, 2, 8000, 0, 0.7] },
  2: { name: 'Compressor', title: 'Compressor', sub: 'Character compression / 4 models', params: [-18, 3, 10, 120, 6, 0, 0, 1, 0] },
  3: { name: 'Noise Gate', title: 'Noise Gate', sub: 'Gate / Expander', params: [-45, -60, 1, 50, 150, 0, 0, 4] },
  4: { name: 'Limiter', title: 'Limiter', sub: 'Look-ahead brickwall', params: [-1, 80, 0] },
  5: { name: 'Dynamic EQ', title: 'Dynamic EQ', sub: 'Two dynamic bands', params: [1, 250, 1.5, -24, -6, 5, 120, 0, 5000, 2, -30, -6, 2, 80] },
  6: { name: 'Delay', title: 'Delay', sub: 'Stereo / ping-pong', params: [350, 0.35, 0.25, 6000, 0] },
  7: { name: 'Reverb', title: 'Reverb', sub: 'Room / hall', params: [0.6, 0.4, 0.25, 1] },
};

export const PRESETS = [
  { label: 'EQ', fx: [[1]] },
  { label: 'Compressor', fx: [[2]] },
  { label: 'Noise Gate', fx: [[3]] },
  { label: 'Dynamic EQ', fx: [[5]] },
  { label: 'De-esser', fx: [[5, [1, 6500, 2, -30, -8, 1, 60, 0, 10000, 1, -30, -4, 1, 60]]] },
  { label: 'Limiter', fx: [[4]] },
  { label: 'Delay', fx: [[6]] },
  { label: 'Reverb', fx: [[7]] },
  '-',
  { label: 'Channel Strip (Gate + Comp + EQ)', fx: [[3], [2], [1]] },
  { label: 'Drum Smash', fx: [[2, [-28, 8, 1, 60, 3, 8, 1, 0.5, 0]]] },
  { label: 'Vocal Leveler', fx: [[2, [-22, 3, 10, 200, 8, 4, 2, 1, 100]], [1, [1, 90, 0, 18000, 1, 1, 200, -2, 0.7, 1, 0, 350, -2, 1.4, 1, 0, 3000, 2, 1, 1, 2, 10000, 2, 0.7]]] },
  { label: 'Bus Glue', fx: [[2, [-20, 2, 30, 300, 6, 2, 0, 1, 80]]] },
  { label: 'Broadcast Chain', fx: [[2, [-24, 3, 20, 250, 12, 6, 3, 1, 100]], [4, [-1, 100, 0]]] },
];

export const dbToLin = (db) => (!Number.isFinite(db) || db <= -90 ? 0 : 10 ** (db / 20));

let idSeq = 1;
export const newId = (p = 'x') => `${p}${Date.now().toString(36)}${(idSeq++).toString(36)}`;

export function newTrack(i, patch = {}) {
  return {
    id: newId('t'),
    name: `Track ${i + 1}`,
    color: COLORS[i % COLORS.length],
    input: i,
    hwOut: -1,
    armed: false,
    mute: false,
    solo: false,
    phase: false,
    trim: 0,
    fader: 0,
    pan: 0,
    dest: MASTER,
    sends: [],
    inserts: new Array(MAX_FX).fill(null),
    clips: [],
    ...patch,
  };
}

export function newBus(kind, name, patch = {}) {
  return {
    id: newId('b'),
    kind,
    name,
    color: kind === 'master' ? '#e8ecff' : kind === 'broadcast' ? '#ff6b8b' : '#9db1ff',
    fader: 0,
    pan: 0,
    mute: false,
    hwOut: kind === 'master' ? 0 : -1,
    inserts: new Array(MAX_FX).fill(null),
    ...patch,
  };
}

export function newSessionData(name, sampleRate = 48000) {
  return {
    version: 1,
    name,
    sampleRate,
    recordBits: 24,
    take: 1,
    tracks: [],
    buses: [newBus('master', 'MASTER'), newBus('broadcast', 'BROADCAST')],
    broadcast: {
      followMaster: true,
      device: '',
      deviceChannel: 0,
      target: -16,
      recordProgram: false,
      destinations: [],
    },
    loop: { on: false, start: 0, end: 0 },
    markers: [],
    view: { spp: 2400, x0: 0, trackHeight: 46 },
  };
}

// Brings older or hand-edited sessions up to the current shape.
export function normalize(s) {
  const d = newSessionData(s.name || 'Session', s.sampleRate || 48000);
  const out = { ...d, ...s, broadcast: { ...d.broadcast, ...(s.broadcast || {}) }, view: { ...d.view, ...(s.view || {}) }, loop: { ...d.loop, ...(s.loop || {}) } };
  out.tracks = (s.tracks || []).map((t, i) => {
    const n = newTrack(i, t);
    n.inserts = [...(t.inserts || []), ...new Array(MAX_FX).fill(null)].slice(0, MAX_FX);
    return n;
  });
  out.buses = (s.buses && s.buses.length >= 2 ? s.buses : d.buses).map((b) => {
    const n = newBus(b.kind, b.name, b);
    n.inserts = [...(b.inserts || []), ...new Array(MAX_FX).fill(null)].slice(0, MAX_FX);
    return n;
  });
  return out;
}

// ------------------------------------------------------------------ engine sync

const E = (m, ...a) => window.daw.engine(m, ...a);

export const sync = {
  counts(s) {
    return E('setCounts', s.tracks.length, s.buses.length);
  },
  global(s, extra = {}) {
    return E('setGlobal', {
      anySolo: s.tracks.some((t) => t.solo) ? 1 : 0,
      loopOn: s.loop.on ? 1 : 0,
      loopStart: s.loop.start,
      loopEnd: s.loop.end,
      broadcastChannel: s.broadcast.deviceChannel || 0,
      ...extra,
    });
  },
  track(s, i) {
    const t = s.tracks[i];
    if (!t) return null;
    return E('setTrack', i, {
      input: t.input,
      hwOut: t.hwOut,
      mute: t.mute ? 1 : 0,
      solo: t.solo ? 1 : 0,
      phase: t.phase ? 1 : 0,
      dest: t.dest < s.buses.length ? t.dest : MASTER,
      trim: dbToLin(t.trim),
      fader: dbToLin(t.fader),
      pan: t.pan,
      sends: t.sends.filter((x) => x.bus < s.buses.length).map((x) => ({ bus: x.bus, level: dbToLin(x.level), pre: x.pre ? 1 : 0 })),
    });
  },
  bus(s, b) {
    const B = s.buses[b];
    if (!B) return null;
    const bc = s.broadcast;
    const isBc = B.kind === 'broadcast';
    return E('setBus', b, {
      fader: dbToLin(B.fader),
      pan: B.pan,
      mute: B.mute ? 1 : 0,
      hwOut: B.hwOut,
      toMaster: B.kind === 'group' || B.kind === 'aux' ? 1 : 0,
      feedMaster: isBc && bc.followMaster ? 1 : 0,
      tap: isBc ? 1 : 0,
      toBcDevice: isBc && bc.device ? 1 : 0,
    });
  },
  inserts(s, kind, i) {
    const list = kind === 'bus' ? s.buses[i].inserts : s.tracks[i].inserts;
    return Promise.all(list.map((fx, slot) => E('setInsert', kind, i, slot, fx ? { type: fx.type, on: fx.on ? 1 : 0, params: fx.params } : { type: 0, on: 0, params: [] })));
  },
  insert(s, kind, i, slot) {
    const fx = (kind === 'bus' ? s.buses[i] : s.tracks[i]).inserts[slot];
    return E('setInsert', kind, i, slot, fx ? { type: fx.type, on: fx.on ? 1 : 0, params: fx.params } : { type: 0, on: 0, params: [] });
  },
  clips(s, i, audioDir) {
    const t = s.tracks[i];
    return E('setClips', i, t.clips.filter((c) => !c.muted).map((c) => ({
      path: `${audioDir}/${c.file}`,
      start: c.start,
      offset: c.offset,
      length: c.length,
      channel: c.channel || 0,
      gain: dbToLin(c.gain || 0),
    })));
  },
  async all(s, audioDir) {
    await sync.counts(s);
    await sync.global(s);
    for (let i = 0; i < s.tracks.length; i++) {
      await sync.track(s, i);
      await sync.inserts(s, 'track', i);
      await sync.clips(s, i, audioDir);
    }
    for (let b = 0; b < s.buses.length; b++) {
      await sync.bus(s, b);
      await sync.inserts(s, 'bus', b);
    }
  },
};

// ------------------------------------------------------------------ undo

export class History {
  constructor() {
    this.undo = [];
    this.redo = [];
  }

  snapshot(s) {
    return JSON.stringify({ tracks: s.tracks, buses: s.buses, loop: s.loop, markers: s.markers });
  }

  push(s, label) {
    this.undo.push({ label, data: this.snapshot(s) });
    if (this.undo.length > 100) this.undo.shift();
    this.redo = [];
  }

  step(s, from, to) {
    const e = from.pop();
    if (!e) return null;
    to.push({ label: e.label, data: this.snapshot(s) });
    Object.assign(s, JSON.parse(e.data));
    return e.label;
  }
}

// ------------------------------------------------------------------ clip helpers

// Removes the [start, end) range from a track's clips, splitting where needed.
export function carve(track, start, end) {
  const out = [];
  for (const c of track.clips) {
    const cs = c.start, ce = c.start + c.length;
    if (ce <= start || cs >= end) { out.push(c); continue; }
    if (cs < start) out.push({ ...c, id: newId('c'), length: start - cs });
    if (ce > end) out.push({ ...c, id: newId('c'), start: end, offset: c.offset + (end - cs), length: ce - end });
  }
  track.clips = out;
}

export function splitAt(track, pos) {
  const out = [];
  let did = false;
  for (const c of track.clips) {
    if (pos > c.start && pos < c.start + c.length) {
      out.push({ ...c, length: pos - c.start });
      out.push({ ...c, id: newId('c'), start: pos, offset: c.offset + (pos - c.start), length: c.start + c.length - pos });
      did = true;
    } else out.push(c);
  }
  track.clips = out;
  return did;
}

export function sessionEnd(s) {
  let end = 0;
  for (const t of s.tracks) for (const c of t.clips) end = Math.max(end, c.start + c.length);
  return end;
}

export function safeName(s) {
  return String(s || 'Track').replace(/[^\w\- ]+/g, '').trim().slice(0, 40) || 'Track';
}

export function fmtTime(samples, sr, frac = false) {
  const t = Math.max(0, samples / sr);
  const hh = Math.floor(t / 3600), mm = Math.floor((t % 3600) / 60), ss = Math.floor(t % 60);
  const base = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return frac ? `${base}.${String(Math.floor((t % 1) * 100)).padStart(2, '0')}` : base;
}
